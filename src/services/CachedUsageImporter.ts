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
};

type CacheIndex = {
  schemaVersion: number;
  parserVersion: string;
  updatedAt: string;
  files: Record<SourceFileCacheKey, CachedFileEntry>;
  sourceRoots: Record<string, CachedSourceRoot>;
  historicalFill?: Partial<Record<UsageProvider, { complete: boolean; checkedAt?: string }>>;
};

type CachedUsageRecord = Omit<UsageRecord, "raw">;

type ShardItem = {
  sourceRootId: string;
  sourceFileId: string;
  record: CachedUsageRecord;
};

type LoadProviderResult = {
  importResult: AdapterImportResult;
  skippedHistoricalFiles: number;
  parsedFiles: number;
};

type RangeReadResult = {
  records: UsageRecord[];
  errors: ImportIssue[];
};

type ProgressReporter = (state?: Partial<CachedUsageState>, options?: { flush?: boolean }) => Promise<void>;

export class CachedUsageImporter {
  private writeQueue: Promise<unknown> = Promise.resolve();

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
    await fs.rm(this.cacheRootPath, { recursive: true, force: true });
  }

  private async loadForRangeUnlocked(input: {
    sources: CachedUsageSource[];
    range: TimeRange;
    forceReparse?: boolean;
    onProgress?: (progress: CachedUsageProgress, cache: CachedUsageState) => Promise<void>;
  }): Promise<CachedUsageLoadResult> {
    await fs.mkdir(this.cacheRootPath, { recursive: true });
    const index = await this.readIndex();
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
      const loaded = await this.loadProvider(index, source, input.range, progress, report, forced);
      imports.push(loaded.importResult);
      parsedFiles += loaded.parsedFiles;
      if (loaded.skippedHistoricalFiles > 0) {
        historicalComplete = false;
      }
      if (loaded.importResult.errors.some((error) => error.code === "cache_write_failed" || error.code === "cache_read_failed")) {
        rangeComplete = false;
      }
    }

    index.updatedAt = new Date().toISOString();
    await this.writeIndex(index);
    progress.currentProvider = undefined;
    progress.currentPath = undefined;
    await report(cacheState({ status: parsedFiles > 0 ? (forced ? "rebuilding" : "cold") : historicalComplete ? "warm" : "partial", rangeComplete, historicalComplete }), {
      flush: true,
    });

    return {
      imports,
      cache: {
        status: parsedFiles > 0 ? (forced ? "rebuilding" : "cold") : historicalComplete ? "warm" : "partial",
        rangeComplete,
        historicalComplete,
      },
    };
  }

  private async loadProvider(
    index: CacheIndex,
    source: CachedUsageSource,
    range: TimeRange,
    progress: CachedUsageProgress,
    report: ProgressReporter,
    forceReparse: boolean,
  ): Promise<LoadProviderResult> {
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
      return { importResult, skippedHistoricalFiles: 0, parsedFiles: 0 };
    }

    progress.filesTotal += listed.files.length;
    await report({ rangeComplete: false }, { flush: true });
    const sourceRootId = sourceRootHash(source.provider, source.sourcePath, process.platform);
    index.sourceRoots[sourceRootId] = {
      provider: source.provider,
      sourceRootId,
      platform: process.platform,
      lastScannedAt: new Date().toISOString(),
    };

    const activeFileKeys = new Set(listed.files.map((file) => sourceFileKey(source.provider, sourceRootId, sourceFileHash(sourceRootId, file.filePath))));
    await this.removeDeletedFiles(index, sourceRootId, activeFileKeys);

    let skippedHistoricalFiles = 0;
    let parsedFiles = 0;
    for (const file of listed.files) {
      progress.filesChecked += 1;
      progress.currentProvider = source.provider;
      progress.currentPath = file.filePath;
      const sourceFileId = sourceFileHash(sourceRootId, file.filePath);
      const fileKey = sourceFileKey(source.provider, sourceRootId, sourceFileId);
      const cached = index.files[fileKey];
      const fingerprintUnchanged = Boolean(cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size);
      if (!forceReparse && shouldSkipFileForRange(file, cached, fingerprintUnchanged, range)) {
        skippedHistoricalFiles += 1;
        await report({ historicalComplete: false, rangeComplete: false });
        continue;
      }
      if (!forceReparse && fingerprintUnchanged) {
        await report({ rangeComplete: false });
        continue;
      }
      parsedFiles += 1;
      progress.filesParsed += 1;
      await report({ status: forceReparse ? "rebuilding" : "cold", rangeComplete: false });
      const parsed = await source.adapter.importUsageFile(file.filePath);
      const entry = await this.writeParsedFile(index, source, file, sourceRootId, sourceFileId, fileKey, parsed);
      index.files[fileKey] = entry;
      await report({ status: forceReparse ? "rebuilding" : "cold", rangeComplete: false });
    }

    index.historicalFill = {
      ...index.historicalFill,
      [source.provider]: { complete: skippedHistoricalFiles === 0, checkedAt: new Date().toISOString() },
    };

    const activeRootIds = new Set([sourceRootId]);
    const rangeRead = await this.readRecordsForRange(source.provider, activeRootIds, range, progress, report);
    const diagnostics = diagnosticsForActiveRoot(index, source.provider, sourceRootId);
    const importResult: AdapterImportResult = {
      provider: source.provider,
      records: rangeRead.records,
      warnings: [...listed.warnings, ...diagnostics.warnings],
      errors: [...listed.errors, ...diagnostics.errors, ...rangeRead.errors],
      sourceMeta: [...listed.sourceMeta, ...diagnostics.sourceMeta],
    };
    if (source.issue) {
      importResult.warnings = importResult.warnings.filter((warning) => warning.code !== "missing_path");
      importResult.warnings.push(source.issue);
    }

    return { importResult, skippedHistoricalFiles, parsedFiles };
  }

  private async writeParsedFile(
    index: CacheIndex,
    source: CachedUsageSource,
    file: UsageFileRef,
    sourceRootId: string,
    sourceFileId: string,
    fileKey: SourceFileCacheKey,
    parsed: AdapterImportResult,
  ): Promise<CachedFileEntry> {
    const previous = index.files[fileKey];
    if (previous) {
      await this.removeRecordsForFile(previous);
    }
    const records = parsed.records.map((record) => stripRaw(record, sourceFileId));
    const grouped = groupRecordsByUtcShard(records);
    const shardKeys = [...grouped.keys()].sort();
    for (const shardKey of shardKeys) {
      const existing = await this.readShard(source.provider, shardKey, { recoverCorrupt: true });
      const kept = existing.filter((item) => item.sourceRootId !== sourceRootId || item.sourceFileId !== sourceFileId);
      const fileRecords = grouped.get(shardKey) ?? [];
      await this.writeShard(
        source.provider,
        shardKey,
        kept.concat(fileRecords.map((record) => ({ sourceRootId, sourceFileId, record }))),
      );
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
    };
  }

  private async removeDeletedFiles(index: CacheIndex, sourceRootId: string, activeFileKeys: Set<SourceFileCacheKey>): Promise<void> {
    const deleted = Object.entries(index.files).filter(([, entry]) => entry.sourceRootId === sourceRootId && !activeFileKeys.has(entry.fileKey));
    for (const [fileKey, entry] of deleted) {
      await this.removeRecordsForFile(entry);
      delete index.files[fileKey as SourceFileCacheKey];
    }
  }

  private async removeRecordsForFile(entry: CachedFileEntry): Promise<void> {
    for (const shardKey of entry.shardKeys) {
      const existing = await this.readShard(entry.provider, shardKey, { recoverCorrupt: true });
      const kept = existing.filter((item) => item.sourceRootId !== entry.sourceRootId || item.sourceFileId !== entry.sourceFileId);
      await this.writeShard(entry.provider, shardKey, kept);
    }
  }

  private async readRecordsForRange(
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
    for (const shardKey of touchedUtcShardKeys(range)) {
      let shard: ShardItem[];
      try {
        shard = await this.readShard(provider, shardKey);
      } catch (error) {
        errors.push(cacheReadIssue(provider, shardKey, error));
        await report({ rangeComplete: false });
        continue;
      }
      for (const item of shard) {
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

  private async readIndex(): Promise<CacheIndex> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath(), "utf8")) as Partial<CacheIndex>;
      if (parsed.schemaVersion === cacheSchemaVersion && parsed.parserVersion === jsonUsageParserVersion && parsed.files && parsed.sourceRoots) {
        return {
          schemaVersion: cacheSchemaVersion,
          parserVersion: jsonUsageParserVersion,
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
          files: parsed.files as Record<SourceFileCacheKey, CachedFileEntry>,
          sourceRoots: parsed.sourceRoots,
          historicalFill: parsed.historicalFill,
        };
      }
    } catch {
      // Missing or incompatible cache is treated as cold start.
    }
    return {
      schemaVersion: cacheSchemaVersion,
      parserVersion: jsonUsageParserVersion,
      updatedAt: new Date().toISOString(),
      files: {},
      sourceRoots: {},
    };
  }

  private async writeIndex(index: CacheIndex): Promise<void> {
    await writeJsonAtomic(this.indexPath(), index);
  }

  private async readShard(provider: UsageProvider, shardKey: string, options: { recoverCorrupt?: boolean } = {}): Promise<ShardItem[]> {
    let content: string;
    try {
      content = await fs.readFile(this.shardPath(provider, shardKey), "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return [];
      }
      throw error;
    }

    try {
      const parsed = JSON.parse(content) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ShardItem[];
      }
      throw new Error("Cache shard is not an array.");
    } catch (error) {
      if (options.recoverCorrupt) {
        return [];
      }
      throw error;
    }
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
    message: `Failed to read cached usage shard ${shardKey}: ${errorMessage(error)}`,
    provider,
  };
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

function shouldSkipFileForRange(file: UsageFileRef, cached: CachedFileEntry | undefined, fingerprintUnchanged: boolean, range: TimeRange): boolean {
  if (fingerprintUnchanged && cached?.records === 0) {
    return true;
  }
  if (fingerprintUnchanged && cached?.fileSpanUtcStart && cached.fileSpanUtcEnd) {
    return !cachedFileTouchesRange(cached, range);
  }
  if (!cached && file.pathDateKey) {
    return file.pathDateKey < shiftDateKey(range.startDate, -1) || file.pathDateKey > shiftDateKey(range.endDate, 1);
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

function groupRecordsByUtcShard(records: CachedUsageRecord[]): Map<string, CachedUsageRecord[]> {
  const groups = new Map<string, CachedUsageRecord[]>();
  for (const record of records) {
    const timestamp = recordTimestamp(record);
    if (!timestamp) {
      continue;
    }
    const key = utcDateKey(new Date(timestamp));
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  }
  return groups;
}

function touchedUtcShardKeys(range: TimeRange): string[] {
  const start = new Date(range.start);
  const end = new Date(range.end);
  const keys: string[] = [];
  let cursor = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  while (cursor <= endDay) {
    keys.push(utcDateKey(new Date(cursor)));
    cursor += 86_400_000;
  }
  return keys;
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
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
