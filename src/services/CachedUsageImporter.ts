import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { JsonUsageAdapter, UsageFileRef } from "../adapters/JsonUsageAdapter";
import { jsonUsageParserVersion } from "../adapters/JsonUsageAdapter";
import type { AdapterImportResult, ImportIssue, SourceMeta, TimeRange, UsageProvider, UsageRecord } from "../domain/types";

const cacheSchemaVersion = 1;
const progressReportIntervalMs = 100;
const progressFileStep = 50;
const progressParsedFileStep = 10;
const progressRecordStep = 1_000;

export type CacheStatus = "cold" | "warm" | "partial" | "rebuilding";

export type CachedUsageProgress = {
  filesTotal: number;
  filesChecked: number;
  filesParsed: number;
  recordsLoaded: number;
  currentProvider?: UsageProvider;
  currentPath?: string;
};

export type CachedUsageState = {
  status: CacheStatus;
  rangeComplete: boolean;
  historicalComplete: boolean;
};

export type CachedUsageLoadResult = {
  imports: AdapterImportResult[];
  cache: CachedUsageState;
  /** Per configured source: what the scan found, independent of the selected range. */
  sources: CachedSourceSummary[];
};

export type CachedSourceSummary = {
  provider: UsageProvider;
  sourcePath: string;
  /** Usage files found under the configured path. */
  files: number;
  /** Records parsed from those files so far (all dates, not just the range). */
  cachedRecords: number;
  /** True once every found file has been parsed at least once. */
  complete: boolean;
};

export type CachedUsageSource = {
  provider: UsageProvider;
  sourcePath: string;
  adapter: JsonUsageAdapter;
  issue?: ImportIssue;
};

type SourceFileCacheKey = `${UsageProvider}:${string}:${string}`;

type CachedSourceRoot = {
  provider: UsageProvider;
  sourceRootId: string;
  platform: NodeJS.Platform;
  lastScannedAt?: string;
};

type CachedFileEntry = {
  provider: UsageProvider;
  sourceRootId: string;
  fileKey: SourceFileCacheKey;
  sourceFileId: string;
  mtimeMs: number;
  size: number;
  shardKeys: string[];
  records: number;
  fileSpanUtcStart?: string;
  fileSpanUtcEnd?: string;
  diagnostics: {
    warnings: ImportIssue[];
    errors: ImportIssue[];
    sourceMeta: SourceMeta[];
  };
  lastReadAt: string;
  /** Adapter-specific resumable parse state for append-only files. */
  parseState?: unknown;
};

type CacheIndex = {
  schemaVersion: number;
  parserVersion: string;
  updatedAt: string;
  files: Record<SourceFileCacheKey, CachedFileEntry>;
  sourceRoots: Record<string, CachedSourceRoot>;
  historicalFill?: Partial<Record<UsageProvider, { complete: boolean; checkedAt?: string }>>;
};

/**
 * Tracks whether the index changed structurally during a load so the ~1.5MB
 * index.json is only rewritten when file entries, source roots, or fill state
 * actually changed — not on every auto-refresh tick.
 */
type IndexSession = {
  index: CacheIndex;
  dirty: boolean;
  corruptionIssues: ImportIssue[];
};

type ShardCacheEntry = {
  items: ShardItem[];
  dirty: boolean;
};

type CachedUsageRecord = Omit<UsageRecord, "raw">;

type ShardItem = {
  sourceRootId: string;
  sourceFileId: string;
  /**
   * Ordinal of the record within its source file at parse time. Makes
   * incremental appends idempotent: re-appending after a crash first drops
   * items at or past the resume ordinal.
   */
  seq?: number;
  record: CachedUsageRecord;
};

type LoadProviderResult = {
  importResult: AdapterImportResult;
  skippedHistoricalFiles: number;
  parsedFiles: number;
  files: number;
  cachedRecords: number;
};

type RangeReadResult = {
  records: UsageRecord[];
  errors: ImportIssue[];
};

type ProgressReporter = (state?: Partial<CachedUsageState>, options?: { flush?: boolean }) => Promise<void>;

// Upper bound on shards held in memory. Keeps steady-state range reads from
// re-parsing shard JSON off disk every refresh while bounding resident memory
// during full rebuilds (oldest shards flush + evict as the scan moves forward).
const shardCacheCapacity = 48;

export class CachedUsageImporter {
  private writeQueue: Promise<unknown> = Promise.resolve();
  // In-memory shard store, LRU-ordered by Map insertion (re-inserted on access).
  // Authoritative while this process is the only writer; foreign writers are
  // detected via the index stamp below and invalidate the whole store.
  private readonly shardCache = new Map<string, ShardCacheEntry>();
  // index.json updatedAt as last read or written by this process. A different
  // value on disk means another extension host (a second VS Code window on the
  // same profile) wrote the cache, so the in-memory shards may be stale.
  private lastSeenIndexStamp?: string;

  public constructor(private readonly cacheRootPath: string) {}

  public async loadForRange(input: {
    sources: CachedUsageSource[];
    range: TimeRange;
    forceReparse?: boolean;
    onProgress?: (progress: CachedUsageProgress, cache: CachedUsageState) => Promise<void>;
  }): Promise<CachedUsageLoadResult> {
    const queued = this.writeQueue.then(
      () => this.loadForRangeUnlocked(input),
      () => this.loadForRangeUnlocked(input),
    );
    this.writeQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  public async clear(): Promise<void> {
    this.shardCache.clear();
    await fs.rm(this.cacheRootPath, { recursive: true, force: true });
  }

  private async loadForRangeUnlocked(input: {
    sources: CachedUsageSource[];
    range: TimeRange;
    forceReparse?: boolean;
    onProgress?: (progress: CachedUsageProgress, cache: CachedUsageState) => Promise<void>;
  }): Promise<CachedUsageLoadResult> {
    await fs.mkdir(this.cacheRootPath, { recursive: true });
    const { index, reset } = await this.readIndex();
    if (reset || (this.lastSeenIndexStamp !== undefined && index.updatedAt !== this.lastSeenIndexStamp)) {
      // Cold start, schema change, or another extension host wrote the cache:
      // drop in-memory shards so reads and incremental appends use the
      // authoritative on-disk state instead of a stale snapshot.
      this.shardCache.clear();
    }
    this.lastSeenIndexStamp = index.updatedAt;
    const session: IndexSession = { index, dirty: reset, corruptionIssues: [] };
    const progress: CachedUsageProgress = {
      filesTotal: 0,
      filesChecked: 0,
      filesParsed: 0,
      recordsLoaded: 0,
    };
    let historicalComplete = true;
    let parsedFiles = 0;
    let rangeComplete = true;
    const imports: AdapterImportResult[] = [];
    const sources: CachedSourceSummary[] = [];
    const forced = Boolean(input.forceReparse);

    const cacheState = (state: Partial<CachedUsageState> = {}): CachedUsageState => ({
      status: parsedFiles > 0 ? (forced ? "rebuilding" : "cold") : historicalComplete ? "warm" : "partial",
      rangeComplete,
      historicalComplete,
      ...state,
    });
    const emitProgress = createProgressEmitter(progress, input.onProgress);
    const report: ProgressReporter = (state = {}, options = {}) => emitProgress(cacheState(state), options);

    for (const source of input.sources) {
      progress.currentProvider = source.provider;
      progress.currentPath = source.sourcePath;
      await report({ rangeComplete: false }, { flush: true });
      const loaded = await this.loadProvider(session, source, input.range, progress, report, forced);
      imports.push(loaded.importResult);
      sources.push({
        provider: source.provider,
        sourcePath: source.sourcePath,
        files: loaded.files,
        cachedRecords: loaded.cachedRecords,
        complete: loaded.skippedHistoricalFiles === 0,
      });
      parsedFiles += loaded.parsedFiles;
      if (loaded.skippedHistoricalFiles > 0) {
        historicalComplete = false;
      }
      if (loaded.importResult.errors.some((error) => error.code === "cache_write_failed" || error.code === "cache_read_failed")) {
        rangeComplete = false;
      }
    }

    if (session.dirty) {
      index.updatedAt = new Date().toISOString();
      await this.writeIndex(index);
      this.lastSeenIndexStamp = index.updatedAt;
    }
    progress.currentProvider = undefined;
    progress.currentPath = undefined;
    await report(cacheState({ status: parsedFiles > 0 ? (forced ? "rebuilding" : "cold") : historicalComplete ? "warm" : "partial", rangeComplete, historicalComplete }), {
      flush: true,
    });

    return {
      imports,
      sources,
      cache: {
        status: parsedFiles > 0 ? (forced ? "rebuilding" : "cold") : historicalComplete ? "warm" : "partial",
        rangeComplete,
        historicalComplete,
      },
    };
  }

  private async loadProvider(
    session: IndexSession,
    source: CachedUsageSource,
    range: TimeRange,
    progress: CachedUsageProgress,
    report: ProgressReporter,
    forceReparse: boolean,
  ): Promise<LoadProviderResult> {
    const index = session.index;
    const listed = await source.adapter.listUsageFiles({ usagePath: source.sourcePath });
    if (!source.sourcePath) {
      const importResult: AdapterImportResult = {
        provider: source.provider,
        records: [],
        warnings: [...listed.warnings],
        errors: [...listed.errors],
        sourceMeta: [...listed.sourceMeta],
      };
      if (source.issue) {
        importResult.warnings = importResult.warnings.filter((warning) => warning.code !== "missing_path");
        importResult.warnings.push(source.issue);
      }
      return { importResult, skippedHistoricalFiles: 0, parsedFiles: 0, files: 0, cachedRecords: 0 };
    }

    progress.filesTotal += listed.files.length;
    await report({ rangeComplete: false }, { flush: true });
    const sourceRootId = sourceRootHash(source.provider, source.sourcePath, process.platform);
    if (!index.sourceRoots[sourceRootId]) {
      index.sourceRoots[sourceRootId] = {
        provider: source.provider,
        sourceRootId,
        platform: process.platform,
        lastScannedAt: new Date().toISOString(),
      };
      session.dirty = true;
    }

    const activeFileKeys = new Set(listed.files.map((file) => sourceFileKey(source.provider, sourceRootId, sourceFileHash(sourceRootId, file.filePath))));
    await this.removeDeletedFiles(session, sourceRootId, activeFileKeys);

    let skippedHistoricalFiles = 0;
    let parsedFiles = 0;
    for (const file of listed.files) {
      progress.filesChecked += 1;
      progress.currentProvider = source.provider;
      progress.currentPath = file.filePath;
      const sourceFileId = sourceFileHash(sourceRootId, file.filePath);
      const fileKey = sourceFileKey(source.provider, sourceRootId, sourceFileId);
      const cached = index.files[fileKey];
      // A cached read failure is never "up to date": retry it on every refresh
      // even when size/mtime did not move (a fixed permission bit does not
      // bump either).
      const cachedReadFailed = Boolean(cached && readFailed(cached.diagnostics));
      const fingerprintUnchanged = Boolean(cached && !cachedReadFailed && cached.mtimeMs === file.mtimeMs && cached.size === file.size);
      const skip = forceReparse ? false : shouldSkipFileForRange(source.provider, file, cached, fingerprintUnchanged, range);
      if (skip === "backlog") {
        // Never parsed and pruned for this range: real historical backlog.
        skippedHistoricalFiles += 1;
        await report({ historicalComplete: false, rangeComplete: false });
        continue;
      }
      if (skip === "parsed") {
        // Fully parsed before and unchanged; nothing to do for this range.
        await report({ rangeComplete: false });
        continue;
      }
      if (!forceReparse && fingerprintUnchanged) {
        await report({ rangeComplete: false });
        continue;
      }
      parsedFiles += 1;
      progress.filesParsed += 1;
      await report({ status: forceReparse ? "rebuilding" : "cold", rangeComplete: false });
      const resumablePrior = !forceReparse && cached && file.size > cached.size ? cached.parseState : undefined;
      const outcome = await source.adapter.importUsageFileWithState(file.filePath, resumablePrior);
      if (readFailed(outcome.result) && cached) {
        // The file was still changing or could not be read: keep the cached
        // records and fingerprint so the next refresh retries it instead of
        // evicting its records, but surface this refresh's diagnostics.
        index.files[fileKey] = {
          ...cached,
          diagnostics: {
            ...cached.diagnostics,
            warnings: outcome.result.warnings.map((warning) => sanitizeIssueForCache(warning, sourceFileId)),
            errors: outcome.result.errors.map((error) => sanitizeIssueForCache(error, sourceFileId)),
          },
        };
        session.dirty = true;
        continue;
      }
      const entry =
        outcome.appended && cached
          ? await this.appendParsedFile(session, source, file, cached, sourceRootId, sourceFileId, outcome.result, outcome.state)
          : await this.writeParsedFile(session, source, file, sourceRootId, sourceFileId, fileKey, outcome.result, outcome.state);
      index.files[fileKey] = entry;
      session.dirty = true;
      await report({ status: forceReparse ? "rebuilding" : "cold", rangeComplete: false });
    }

    const fillComplete = skippedHistoricalFiles === 0;
    if (index.historicalFill?.[source.provider]?.complete !== fillComplete) {
      index.historicalFill = {
        ...index.historicalFill,
        [source.provider]: { complete: fillComplete, checkedAt: new Date().toISOString() },
      };
      session.dirty = true;
    }

    const activeRootIds = new Set([sourceRootId]);
    const rangeRead = await this.readRecordsForRange(session, source.provider, activeRootIds, range, progress, report);
    await this.flushDirtyShards();
    const corruptionErrors = session.corruptionIssues.filter((item) => item.provider === source.provider);
    session.corruptionIssues = session.corruptionIssues.filter((item) => item.provider !== source.provider);
    const diagnostics = diagnosticsForActiveRoot(index, source.provider, sourceRootId);
    const importResult: AdapterImportResult = {
      provider: source.provider,
      records: rangeRead.records,
      warnings: [...listed.warnings, ...diagnostics.warnings],
      errors: [...listed.errors, ...diagnostics.errors, ...rangeRead.errors, ...corruptionErrors],
      sourceMeta: [...listed.sourceMeta, ...diagnostics.sourceMeta],
    };
    if (source.issue) {
      importResult.warnings = importResult.warnings.filter((warning) => warning.code !== "missing_path");
      importResult.warnings.push(source.issue);
    }

    const cachedRecords = Object.values(index.files)
      .filter((entry) => entry.provider === source.provider && entry.sourceRootId === sourceRootId)
      .reduce((total, entry) => total + entry.records, 0);
    return { importResult, skippedHistoricalFiles, parsedFiles, files: listed.files.length, cachedRecords };
  }

  private async writeParsedFile(
    session: IndexSession,
    source: CachedUsageSource,
    file: UsageFileRef,
    sourceRootId: string,
    sourceFileId: string,
    fileKey: SourceFileCacheKey,
    parsed: AdapterImportResult,
    parseState?: unknown,
  ): Promise<CachedFileEntry> {
    const previous = session.index.files[fileKey];
    const records = parsed.records.map((record) => stripRaw(record, sourceFileId));
    const grouped = groupRecordsByUtcShard(records, 0);
    const shardKeys = [...grouped.keys()].sort();

    // Shards the file used to touch but no longer does need this file's old
    // records removed; shards in the new set are cleaned by the idempotent
    // filter below, so they skip the extra pass entirely.
    if (previous) {
      for (const shardKey of previous.shardKeys) {
        if (grouped.has(shardKey)) {
          continue;
        }
        const shard = await this.loadShard(session, source.provider, shardKey);
        const kept = shard.items.filter((item) => item.sourceRootId !== sourceRootId || item.sourceFileId !== sourceFileId);
        if (kept.length !== shard.items.length) {
          shard.items = kept;
          shard.dirty = true;
        }
      }
    }
    for (const shardKey of shardKeys) {
      const shard = await this.loadShard(session, source.provider, shardKey);
      const kept = shard.items.filter((item) => item.sourceRootId !== sourceRootId || item.sourceFileId !== sourceFileId);
      const fileRecords = grouped.get(shardKey) ?? [];
      shard.items = kept.concat(fileRecords.map(({ record, seq }) => ({ sourceRootId, sourceFileId, seq, record })));
      shard.dirty = true;
    }

    return {
      provider: source.provider,
      sourceRootId,
      fileKey,
      sourceFileId,
      mtimeMs: file.mtimeMs,
      size: file.size,
      shardKeys,
      records: records.length,
      fileSpanUtcStart: earliest(records.map(recordTimestamp)),
      fileSpanUtcEnd: latest(records.map(recordTimestamp)),
      diagnostics: {
        warnings: parsed.warnings.map((warning) => sanitizeIssueForCache(warning, sourceFileId)),
        errors: parsed.errors.map((error) => sanitizeIssueForCache(error, sourceFileId)),
        sourceMeta: parsed.sourceMeta.map((meta) => sanitizeSourceMetaForCache(meta, sourceFileId)),
      },
      lastReadAt: new Date().toISOString(),
      parseState,
    };
  }

  /**
   * Merges an incremental (append-only) parse into the file's existing cache
   * entry: appended records join their shards, the shard-key set is the union
   * of old and new, spans widen, and diagnostics accumulate. Items at or past
   * the resume ordinal are dropped first so a crash between shard flush and
   * index write cannot double-count the same appended records.
   */
  private async appendParsedFile(
    session: IndexSession,
    source: CachedUsageSource,
    file: UsageFileRef,
    previous: CachedFileEntry,
    sourceRootId: string,
    sourceFileId: string,
    parsed: AdapterImportResult,
    parseState?: unknown,
  ): Promise<CachedFileEntry> {
    const records = parsed.records.map((record) => stripRaw(record, sourceFileId));
    const grouped = groupRecordsByUtcShard(records, previous.records);

    for (const [shardKey, fileRecords] of grouped) {
      const shard = await this.loadShard(session, source.provider, shardKey);
      const kept = shard.items.filter(
        (item) =>
          item.sourceRootId !== sourceRootId ||
          item.sourceFileId !== sourceFileId ||
          item.seq === undefined ||
          item.seq < previous.records,
      );
      shard.items = kept.concat(fileRecords.map(({ record, seq }) => ({ sourceRootId, sourceFileId, seq, record })));
      shard.dirty = true;
    }

    const spans = records.map(recordTimestamp);
    return {
      ...previous,
      mtimeMs: file.mtimeMs,
      size: file.size,
      shardKeys: [...new Set([...previous.shardKeys, ...grouped.keys()])].sort(),
      records: previous.records + records.length,
      fileSpanUtcStart: earliest([previous.fileSpanUtcStart, ...spans]),
      fileSpanUtcEnd: latest([previous.fileSpanUtcEnd, ...spans]),
      diagnostics: {
        // A file that has grown past its empty stage should not keep warning
        // about being empty.
        warnings: previous.diagnostics.warnings
          .filter((warning) => warning.code !== "empty_file")
          .concat(parsed.warnings.map((warning) => sanitizeIssueForCache(warning, sourceFileId))),
        errors: previous.diagnostics.errors.concat(parsed.errors.map((error) => sanitizeIssueForCache(error, sourceFileId))),
        sourceMeta: previous.diagnostics.sourceMeta,
      },
      lastReadAt: new Date().toISOString(),
      parseState,
    };
  }

  private async removeDeletedFiles(session: IndexSession, sourceRootId: string, activeFileKeys: Set<SourceFileCacheKey>): Promise<void> {
    const deleted = Object.entries(session.index.files).filter(([, entry]) => entry.sourceRootId === sourceRootId && !activeFileKeys.has(entry.fileKey));
    for (const [fileKey, entry] of deleted) {
      await this.removeRecordsForFile(session, entry);
      delete session.index.files[fileKey as SourceFileCacheKey];
      session.dirty = true;
    }
  }

  private async removeRecordsForFile(session: IndexSession, entry: CachedFileEntry): Promise<void> {
    for (const shardKey of entry.shardKeys) {
      const shard = await this.loadShard(session, entry.provider, shardKey);
      const kept = shard.items.filter((item) => item.sourceRootId !== entry.sourceRootId || item.sourceFileId !== entry.sourceFileId);
      if (kept.length !== shard.items.length) {
        shard.items = kept;
        shard.dirty = true;
      }
    }
  }

  private async readRecordsForRange(
    session: IndexSession,
    provider: UsageProvider,
    activeRootIds: Set<string>,
    range: TimeRange,
    progress: CachedUsageProgress,
    report: ProgressReporter,
  ): Promise<RangeReadResult> {
    const records: UsageRecord[] = [];
    const errors: ImportIssue[] = [];
    const start = new Date(range.start).getTime();
    const end = new Date(range.end).getTime();
    const touched = touchedUtcShardKeys(range);
    if (touched.truncated) {
      errors.push({
        severity: "error",
        code: "cache_read_failed",
        message: `Range spans more than ${maxTouchedShardKeys} days; only the most recent ${maxTouchedShardKeys} days were read.`,
        provider,
      });
    }
    for (const shardKey of touched.keys) {
      const shard = await this.loadShard(session, provider, shardKey);
      for (const item of shard.items) {
        if (!activeRootIds.has(item.sourceRootId)) {
          continue;
        }
        const timestamp = recordTimestamp(item.record);
        if (!timestamp) {
          continue;
        }
        const value = new Date(timestamp).getTime();
        if (value >= start && value <= end) {
          records.push(item.record);
          progress.recordsLoaded += 1;
        }
      }
      await report({ rangeComplete: false });
    }
    return { records, errors };
  }

  /**
   * Returns the in-memory shard, loading it from disk on first access. A shard
   * that fails to parse is recovered as empty: every index entry referencing it
   * is purged so the affected files re-import on the next load, and a
   * cache_read_failed issue is queued so the UI sees the partial state.
   */
  private async loadShard(session: IndexSession, provider: UsageProvider, shardKey: string): Promise<ShardCacheEntry> {
    const cacheKey = `${provider}:${shardKey}`;
    const cached = this.shardCache.get(cacheKey);
    if (cached) {
      this.shardCache.delete(cacheKey);
      this.shardCache.set(cacheKey, cached);
      return cached;
    }

    let items: ShardItem[] = [];
    let recovered = false;
    try {
      items = await this.readShardFromDisk(provider, shardKey);
      if (items.length === 0 && this.indexReferencesShard(session, provider, shardKey)) {
        // The shard file is gone (or empty) but index entries still claim
        // records in it — e.g. a crash between shard flush and index write.
        // Purge those entries so the affected files re-import next load.
        this.purgeEntriesForShard(session, provider, shardKey);
        session.corruptionIssues.push(cacheReadIssue(provider, shardKey, new Error("Shard file is missing but still referenced by the cache index.")));
      }
    } catch (error) {
      this.purgeEntriesForShard(session, provider, shardKey);
      session.corruptionIssues.push(cacheReadIssue(provider, shardKey, error));
      items = [];
      // Dirty so the next flush replaces the unreadable shard file on disk.
      recovered = true;
    }
    const entry: ShardCacheEntry = { items, dirty: recovered };
    this.shardCache.set(cacheKey, entry);
    await this.evictOverCapacity();
    return entry;
  }

  private indexReferencesShard(session: IndexSession, provider: UsageProvider, shardKey: string): boolean {
    return Object.values(session.index.files).some((entry) => entry.provider === provider && entry.records > 0 && entry.shardKeys.includes(shardKey));
  }

  private purgeEntriesForShard(session: IndexSession, provider: UsageProvider, shardKey: string): void {
    for (const [fileKey, entry] of Object.entries(session.index.files)) {
      if (entry.provider === provider && entry.shardKeys.includes(shardKey)) {
        delete session.index.files[fileKey as SourceFileCacheKey];
        session.dirty = true;
      }
    }
  }

  private async evictOverCapacity(): Promise<void> {
    while (this.shardCache.size > shardCacheCapacity) {
      const oldest = this.shardCache.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      const entry = this.shardCache.get(oldest);
      this.shardCache.delete(oldest);
      if (entry?.dirty) {
        const [provider, shardKey] = splitShardCacheKey(oldest);
        await this.writeShard(provider, shardKey, entry.items);
      }
    }
  }

  private async flushDirtyShards(): Promise<void> {
    for (const [cacheKey, entry] of this.shardCache) {
      if (!entry.dirty) {
        continue;
      }
      const [provider, shardKey] = splitShardCacheKey(cacheKey);
      await this.writeShard(provider, shardKey, entry.items);
      entry.dirty = false;
    }
  }

  private async readIndex(): Promise<{ index: CacheIndex; reset: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(), "utf8")) as Partial<CacheIndex>;
      if (parsed.schemaVersion === cacheSchemaVersion && parsed.parserVersion === jsonUsageParserVersion && parsed.files && parsed.sourceRoots) {
        return {
          index: {
            schemaVersion: cacheSchemaVersion,
            parserVersion: jsonUsageParserVersion,
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
            files: parsed.files as Record<SourceFileCacheKey, CachedFileEntry>,
            sourceRoots: parsed.sourceRoots,
            historicalFill: parsed.historicalFill,
          },
          reset: false,
        };
      }
    } catch {
      // Missing or incompatible cache is treated as cold start.
    }
    await fs.rm(path.join(this.cacheRootPath, "records"), { recursive: true, force: true });
    return {
      index: {
        schemaVersion: cacheSchemaVersion,
        parserVersion: jsonUsageParserVersion,
        updatedAt: new Date().toISOString(),
        files: {},
        sourceRoots: {},
      },
      reset: true,
    };
  }

  private async writeIndex(index: CacheIndex): Promise<void> {
    await writeJsonAtomic(this.indexPath(), index);
  }

  private async readShardFromDisk(provider: UsageProvider, shardKey: string): Promise<ShardItem[]> {
    let content: string;
    try {
      content = await fs.readFile(this.shardPath(provider, shardKey), "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as ShardItem[];
    }
    throw new Error("Cache shard is not an array.");
  }

  private async writeShard(provider: UsageProvider, shardKey: string, items: ShardItem[]): Promise<void> {
    const shardPath = this.shardPath(provider, shardKey);
    if (items.length === 0) {
      await fs.rm(shardPath, { force: true });
      return;
    }
    await writeJsonAtomic(shardPath, items);
  }

  private indexPath(): string {
    return path.join(this.cacheRootPath, "index.json");
  }

  private shardPath(provider: UsageProvider, shardKey: string): string {
    return path.join(this.cacheRootPath, "records", provider, `${shardKey}.json`);
  }
}

/**
 * True when a parse produced no trustworthy snapshot of the file (still being
 * written, unreadable, or in a state the adapter cannot read yet). Such
 * results must not replace cached records and must be retried next refresh.
 */
function readFailed(result: Pick<AdapterImportResult, "warnings" | "errors">): boolean {
  return result.warnings.some((item) => item.code === "file_transient" || item.code === "wal_unsupported")
    || result.errors.some((item) => item.code === "file_unreadable");
}

function diagnosticsForActiveRoot(index: CacheIndex, provider: UsageProvider, sourceRootId: string): Pick<AdapterImportResult, "warnings" | "errors" | "sourceMeta"> {
  const entries = Object.values(index.files).filter((entry) => entry.provider === provider && entry.sourceRootId === sourceRootId);
  return {
    warnings: entries.flatMap((entry) => entry.diagnostics.warnings),
    errors: entries.flatMap((entry) => entry.diagnostics.errors),
    sourceMeta: entries.flatMap((entry) => entry.diagnostics.sourceMeta),
  };
}

function cacheReadIssue(provider: UsageProvider, shardKey: string, error: unknown): ImportIssue {
  return {
    severity: "error",
    code: "cache_read_failed",
    message: `Failed to read cached usage shard ${shardKey}: ${errorMessage(error)}. Affected files were scheduled for re-import.`,
    provider,
  };
}

function splitShardCacheKey(cacheKey: string): [UsageProvider, string] {
  const separator = cacheKey.indexOf(":");
  return [cacheKey.slice(0, separator) as UsageProvider, cacheKey.slice(separator + 1)];
}

function createProgressEmitter(
  progress: CachedUsageProgress,
  onProgress: ((progress: CachedUsageProgress, cache: CachedUsageState) => Promise<void>) | undefined,
): (state: CachedUsageState, options?: { flush?: boolean }) => Promise<void> {
  let lastReportAt = 0;
  let lastFilesChecked = 0;
  let lastFilesParsed = 0;
  let lastRecordsLoaded = 0;

  return async (state, options = {}) => {
    if (!onProgress) {
      return;
    }

    const now = Date.now();
    const shouldReport =
      options.flush ||
      now - lastReportAt >= progressReportIntervalMs ||
      progress.filesChecked - lastFilesChecked >= progressFileStep ||
      progress.recordsLoaded - lastRecordsLoaded >= progressRecordStep ||
      progress.filesParsed - lastFilesParsed >= progressParsedFileStep;
    if (!shouldReport) {
      return;
    }

    lastReportAt = now;
    lastFilesChecked = progress.filesChecked;
    lastFilesParsed = progress.filesParsed;
    lastRecordsLoaded = progress.recordsLoaded;
    await onProgress({ ...progress }, state);
  };
}

const coldSkipMtimeSlackMs = 86_400_000;

/**
 * "parsed": the file is cached, unchanged, and cannot contribute to this range
 * (known empty, or its span misses the range) — nothing left to read.
 * "backlog": never parsed and pruned for this range — still owed to history.
 */
function shouldSkipFileForRange(
  provider: UsageProvider,
  file: UsageFileRef,
  cached: CachedFileEntry | undefined,
  fingerprintUnchanged: boolean,
  range: TimeRange,
): "parsed" | "backlog" | false {
  if (fingerprintUnchanged && cached?.records === 0 && cached.diagnostics.errors.length === 0) {
    return "parsed";
  }
  if (fingerprintUnchanged && cached?.fileSpanUtcStart && cached.fileSpanUtcEnd) {
    return cachedFileTouchesRange(cached, range) ? false : "parsed";
  }
  if (!cached) {
    // Cold pruning. A session file cannot contain records earlier than its
    // path date (sessions append forward), so files dated after the range end
    // are skippable. A file last written before the range start cannot contain
    // in-range records either (records observe past activity only); the 1-day
    // slack absorbs clock skew and local-vs-UTC offsets. Skipped files are
    // counted as historical backlog and get parsed when a range needs them.
    if (file.pathDateKey && file.pathDateKey > shiftDateKey(range.endDate, 1)) {
      return "backlog";
    }
    if (file.mtimeMs < new Date(range.start).getTime() - coldSkipMtimeSlackMs) {
      return "backlog";
    }
  }
  if (provider === "codex") {
    return false;
  }
  if (!cached && file.pathDateKey) {
    return file.pathDateKey < shiftDateKey(range.startDate, -1) || file.pathDateKey > shiftDateKey(range.endDate, 1) ? "backlog" : false;
  }
  return false;
}

function cachedFileTouchesRange(cached: CachedFileEntry, range: TimeRange): boolean {
  if (cached.fileSpanUtcStart && cached.fileSpanUtcEnd) {
    return spansOverlap(cached.fileSpanUtcStart, cached.fileSpanUtcEnd, range.start, range.end);
  }
  return true;
}

function spansOverlap(leftStart: string, leftEnd: string, rightStart: string, rightEnd: string): boolean {
  return new Date(leftStart).getTime() <= new Date(rightEnd).getTime() && new Date(leftEnd).getTime() >= new Date(rightStart).getTime();
}

function groupRecordsByUtcShard(records: CachedUsageRecord[], seqBase: number): Map<string, Array<{ record: CachedUsageRecord; seq: number }>> {
  const groups = new Map<string, Array<{ record: CachedUsageRecord; seq: number }>>();
  records.forEach((record, index) => {
    const timestamp = recordTimestamp(record);
    if (!timestamp) {
      return;
    }
    const key = utcDateKey(new Date(timestamp));
    const item = { record, seq: seqBase + index };
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  });
  return groups;
}

// Hard ceiling on shard-key enumeration (~11 years). Defends against
// degenerate ranges (e.g. a mistyped year like 0202) enumerating hundreds of
// thousands of shard lookups. Enumeration walks backwards from the range end
// so a truncated range keeps the most recent days — the ones that can
// actually hold data — and drops the ancient end.
const maxTouchedShardKeys = 4_000;

function touchedUtcShardKeys(range: TimeRange): { keys: string[]; truncated: boolean } {
  const start = new Date(range.start);
  const end = new Date(range.end);
  const keys: string[] = [];
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  let cursor = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor >= startDay && keys.length < maxTouchedShardKeys) {
    keys.push(utcDateKey(new Date(cursor)));
    cursor -= 86_400_000;
  }
  keys.reverse();
  return { keys, truncated: cursor >= startDay };
}

function utcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) {
    return dateKey;
  }
  return utcDateKey(new Date(Date.UTC(year, month - 1, day + days)));
}

function sourceRootHash(provider: UsageProvider, sourcePath: string, platform: NodeJS.Platform): string {
  return shortHash(provider, normalizeNativePath(sourcePath, platform), platform);
}

function sourceFileHash(sourceRootId: string, filePath: string): string {
  return shortHash(sourceRootId, normalizeNativePath(filePath, process.platform));
}

function sourceFileKey(provider: UsageProvider, sourceRootId: string, sourceFileId: string): SourceFileCacheKey {
  return `${provider}:${sourceRootId}:${sourceFileId}`;
}

function normalizeNativePath(value: string, platform: NodeJS.Platform): string {
  const normalized = path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

function stripRaw(record: UsageRecord, sourceFileId: string): CachedUsageRecord {
  const { raw: _raw, ...rest } = record;
  return {
    ...rest,
    source: sanitizeSourceMetaForCache(rest.source, sourceFileId),
  };
}

function sanitizeIssueForCache(issue: ImportIssue, sourceFileId: string): ImportIssue {
  return {
    ...issue,
    sourcePath: issue.sourcePath ? cacheSourcePath(sourceFileId) : undefined,
  };
}

function sanitizeSourceMetaForCache(meta: SourceMeta, sourceFileId: string): SourceMeta {
  return {
    ...meta,
    sourcePath: cacheSourcePath(sourceFileId),
  };
}

function cacheSourcePath(sourceFileId: string): string {
  return `cache:${sourceFileId}`;
}

function recordTimestamp(record: Pick<UsageRecord, "startedAt" | "observedAt">): string | undefined {
  return record.startedAt ?? record.observedAt;
}

function earliest(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
