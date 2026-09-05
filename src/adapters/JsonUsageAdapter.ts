import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AdapterImportResult,
  ImportIssue,
  SourceKind,
  SourceMeta,
  TokenBreakdown,
  UsageAdapter,
  UsageProvider,
  UsageRecord,
} from "../domain/types";
import { streamJsonlLines } from "./jsonlStream";

// Bump whenever parsing or diagnostic semantics change so stale caches (and
// their persisted warnings) invalidate automatically on upgrade.
export const jsonUsageParserVersion = "local-json-v5-incremental";
const maxDirectoryDepth = 6;
const maxFilesPerSource = 10_000;
const directoryReadConcurrency = 8;
const fileStatConcurrency = 32;
const modelContextPaths = ["model", "message.model", "response.model", "payload.model", "payload.collaboration_mode.settings.model"];

export type UsageFileRef = {
  filePath: string;
  mtimeMs: number;
  size: number;
  pathDateKey?: string;
};

export type UsageFileListResult = {
  provider: UsageProvider;
  sourcePath?: string;
  files: UsageFileRef[];
  warnings: ImportIssue[];
  errors: ImportIssue[];
  sourceMeta: SourceMeta[];
};

export type UsageFileParseOutcome = {
  result: AdapterImportResult;
  /** Adapter-specific resumable parse state, JSON-serializable for the cache. */
  state?: unknown;
  /** True when `result` holds only the records appended since `prior`. */
  appended?: boolean;
};

export abstract class JsonUsageAdapter implements UsageAdapter {
  public abstract readonly provider: UsageProvider;

  public constructor(private readonly configuredPath?: string) {}

  public async importUsage(options?: { usagePath?: string }): Promise<AdapterImportResult> {
    const listed = await this.listUsageFiles(options);
    const usagePath = options?.usagePath ?? this.configuredPath;
    const readAt = new Date().toISOString();
    const result: AdapterImportResult = {
      provider: this.provider,
      records: [],
      warnings: [...listed.warnings],
      errors: [...listed.errors],
      sourceMeta: [...listed.sourceMeta],
    };

    if (!usagePath) {
      return result;
    }

    for (const file of listed.files) {
      await this.readFile(file.filePath, result, readAt);
    }

    return result;
  }

  public async listUsageFiles(options?: { usagePath?: string }): Promise<UsageFileListResult> {
    const usagePath = options?.usagePath ?? this.configuredPath;
    const readAt = new Date().toISOString();
    const result: UsageFileListResult = {
      provider: this.provider,
      sourcePath: usagePath,
      files: [],
      warnings: [],
      errors: [],
      sourceMeta: [],
    };

    if (!usagePath) {
      result.warnings.push(issue("warning", "missing_path", `${this.provider} usage path is not configured.`, undefined, this.provider));
      return result;
    }

    result.files = await this.collectFiles(usagePath, result, readAt);
    return result;
  }

  public async importUsageFile(filePath: string, readAt = new Date().toISOString()): Promise<AdapterImportResult> {
    const result: AdapterImportResult = {
      provider: this.provider,
      records: [],
      warnings: [],
      errors: [],
      sourceMeta: [],
    };
    await this.readFile(filePath, result, readAt);
    return result;
  }

  /**
   * Like importUsageFile, but lets adapters resume append-only files from a
   * prior parse state instead of re-reading the whole file. The base
   * implementation has no incremental support and always parses fully.
   */
  public async importUsageFileWithState(filePath: string, _prior?: unknown, readAt = new Date().toISOString()): Promise<UsageFileParseOutcome> {
    return { result: await this.importUsageFile(filePath, readAt) };
  }

  private async collectFiles(usagePath: string, result: UsageFileListResult, readAt: string): Promise<UsageFileRef[]> {
    try {
      const stat = await fs.stat(usagePath);
      if (stat.isDirectory()) {
        const meta = sourceMeta(usagePath, "directory", readAt);
        result.sourceMeta.push(meta);
        const files = await this.collectDirectoryFiles(usagePath, 0, result, new AsyncLimiter(fileStatConcurrency));
        if (files.length === 0) {
          result.warnings.push(issue("warning", "empty_directory", "No JSON or JSONL usage files were found.", usagePath, this.provider));
        }
        if (files.length >= maxFilesPerSource) {
          result.warnings.push(issue("warning", "source_file_limit", `Only the first ${maxFilesPerSource} usage files were imported.`, usagePath, this.provider));
        }
        return files;
      }
      if (stat.isFile()) {
        return [usageFileRef(usagePath, stat)];
      }
      result.errors.push(issue("error", "unsupported_path", "Usage path is neither a file nor a directory.", usagePath, this.provider));
      return [];
    } catch (error) {
      result.errors.push(issue("error", "path_unreadable", errorMessage(error), usagePath, this.provider));
      return [];
    }
  }

  private async collectDirectoryFiles(
    directoryPath: string,
    depth: number,
    result: UsageFileListResult,
    statLimiter: AsyncLimiter,
  ): Promise<UsageFileRef[]> {
    if (depth > maxDirectoryDepth) {
      return [];
    }

    let entries;
    try {
      entries = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      result.errors.push(issue("error", "directory_unreadable", errorMessage(error), directoryPath, this.provider));
      return [];
    }

    const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
    const fileEntries = sortedEntries.filter((entry) => entry.isFile() && isUsageFileName(entry.name));
    const directoryEntries = sortedEntries.filter((entry) => entry.isDirectory());
    const fileRefs = (
      await mapWithConcurrency(fileEntries, fileStatConcurrency, async (entry) => {
        const fullPath = path.join(directoryPath, entry.name);
        try {
          return await statLimiter.run(async () => usageFileRef(fullPath, await fs.stat(fullPath)));
        } catch (error) {
          result.errors.push(issue("error", "file_unreadable", errorMessage(error), fullPath, this.provider));
          return undefined;
        }
      })
    ).filter((file): file is UsageFileRef => Boolean(file));

    const files = fileRefs.slice(0, maxFilesPerSource);
    if (files.length < maxFilesPerSource) {
      const directoryFiles = await mapWithConcurrency(directoryEntries, directoryReadConcurrency, (entry) =>
        this.collectDirectoryFiles(path.join(directoryPath, entry.name), depth + 1, result, statLimiter),
      );
      for (const nestedFiles of directoryFiles) {
        files.push(...nestedFiles);
        if (files.length >= maxFilesPerSource) {
          break;
        }
      }
    }

    return files.slice(0, maxFilesPerSource);
  }

  protected async readFile(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    const kind = sourceKind(filePath);
    const meta = sourceMeta(filePath, kind, readAt);
    result.sourceMeta.push(meta);

    if (kind === "jsonl") {
      await this.readJsonLinesStreaming(filePath, meta, result);
      return;
    }

    // Whole-file JSON is the easiest target for read-during-write tearing
    // (truncated exports, half-written files). Read with a stability check:
    // if the file fingerprint changes between the pre-read stat and the
    // post-read stat, wait briefly and retry once; only report a hard error
    // when the file is stable and genuinely malformed.
    const outcome = await this.readTextStable(filePath);
    if (!outcome.ok) {
      result.warnings.push(issue("warning", "file_transient", "Usage file changed while reading; skipped for this refresh (will retry on next refresh).", filePath, this.provider));
      return;
    }
    const content = outcome.content;

    if (content.trim().length === 0) {
      result.warnings.push(issue("warning", "empty_file", "Usage file is empty.", filePath, this.provider));
      return;
    }

    this.readJson(content, filePath, meta, result);
  }

  /**
   * Reads a small text file with a before/after stat stability check and one
   * retry after a short delay. Returns { ok: true, content } when stable,
   * or { ok: false } when the file is still being written between attempts.
   */
/** Reads a text file with a before/after stat stability check and one retry. */
  private async readTextStable(filePath: string): Promise<{ ok: true; content: string } | { ok: false }> {
    const readOnce = async () => {
      const before = await statOrUndefined(filePath);
      let content: string | undefined;
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        return { before, after: undefined, content: undefined };
      }
      const after = await statOrUndefined(filePath);
      return { before, after, content };
    };

    const first = await readOnce();
    if (statStable(first.before, first.after)) {
      return { ok: true, content: first.content as string };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await readOnce();
    if (statStable(second.before, second.after)) {
      return { ok: true, content: second.content as string };
    }
    return { ok: false };
  }

  private readJson(content: string, filePath: string, meta: SourceMeta, result: AdapterImportResult): void {
    try {
      const parsed = JSON.parse(content) as unknown;
      const rows = rowsFromJson(parsed);
      if (rows.length === 0) {
        result.warnings.push(issue("warning", "no_records", "JSON source did not contain usage records.", filePath, this.provider));
      }
      const context = createFileContext(filePath, inferSingleModel(rows));
      rows.forEach((row, index) => {
        this.addRecord(row, filePath, meta, result, index + 1, context);
      });
    } catch (error) {
      result.errors.push(issue("error", "malformed_json", errorMessage(error), filePath, this.provider));
    }
  }

  private async readJsonLinesStreaming(filePath: string, meta: SourceMeta, result: AdapterImportResult): Promise<void> {
    // Streaming reads can also tear on files written concurrently (e.g. codex
    // compaction rewriting a rollout in place). Parse into a local buffer
    // first and compare pre/post-read stats after every attempt: an unstable
    // fingerprint means the snapshot may be partial even when every line
    // parsed, so retry once and otherwise skip the file entirely - no records,
    // no diagnostics - so torn reads never land in the cache.
    type Attempt = { rows: Array<{ line: number; row: unknown }>; errors: ImportIssue[]; sawContent: boolean };
    const attempt = async (): Promise<Attempt> => {
      const rows: Array<{ line: number; row: unknown }> = [];
      const errors: ImportIssue[] = [];
      const collectLine = (line: string, lineNumber: number): void => {
        if (!line.trim()) {
          return;
        }
        try {
          rows.push({ line: lineNumber, row: JSON.parse(line) as unknown });
        } catch (error) {
          errors.push(issue("error", "malformed_jsonl", errorMessage(error), filePath, this.provider, lineNumber));
        }
      };
      const stream = await streamJsonlLines(filePath, collectLine);
      const sawContent = stream.sawContent;
      if (stream.partialTail !== undefined) {
        collectLine(stream.partialTail, stream.lineCount + 1);
      }
      return { rows, errors, sawContent };
    };

    let out: Attempt | undefined;
    for (let tries = 0; tries < 2; tries += 1) {
      if (tries > 0) {
        // Give the writer a moment to finish the record before retrying.
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const before = await statOrUndefined(filePath);
      let candidate: Attempt;
      try {
        candidate = await attempt();
      } catch (error) {
        result.errors.push(issue("error", "file_unreadable", errorMessage(error), filePath, this.provider));
        return;
      }
      const after = await statOrUndefined(filePath);
      if (statStable(before, after)) {
        out = candidate;
        break;
      }
    }
    if (!out) {
      // Still being written: treat as transient and skip both records and
      // diagnostics so the next refresh (with a changed fingerprint) reparses
      // the completed file cleanly.
      result.warnings.push(issue("warning", "file_transient", "Usage file is being written while imported; skipping diagnostics for this refresh.", filePath, this.provider));
      return;
    }
    result.errors.push(...out.errors);

    if (!out.sawContent) {
      result.warnings.push(issue("warning", "empty_file", "Usage file is empty.", filePath, this.provider));
      return;
    }

    const context = createFileContext(filePath, inferSingleModel(out.rows.map((entry) => entry.row)));
    out.rows.forEach(({ line, row }) => {
      this.addRecord(row, filePath, meta, result, line, context);
    });
  }

  private addRecord(
    row: unknown,
    filePath: string,
    meta: SourceMeta,
    result: AdapterImportResult,
    line: number,
    context: FileContext,
  ): boolean {
    const object = asObject(row);
    if (!object) {
      result.warnings.push(issue("warning", "record_not_object", "Usage record is not an object.", filePath, this.provider, line));
      return false;
    }

    updateFileContext(context, object);
    const tokens = normalizeTokens(object);
    const model = firstString(object, modelContextPaths) ?? context.model;
    const cost = normalizeCost(object);
    const hasUsageSignal = hasNonZeroTokenUsage(tokens) || Boolean(cost);
    if (!hasUsageSignal) {
      return false;
    }

    const provider = stringField(object, "provider");
    if (provider && provider !== this.provider) {
      result.warnings.push(issue("warning", "provider_mismatch", `Record provider '${provider}' was imported by ${this.provider}.`, filePath, this.provider, line));
    }
    if (Object.keys(tokens).length === 0) {
      result.warnings.push(issue("warning", "missing_tokens", "Usage record has no token counts.", filePath, this.provider, line));
    }
    result.records.push({
      provider: this.provider,
      model,
      sessionId: firstString(object, ["sessionId", "session_id", "conversationId", "conversation_id", "chatId", "chat_id"]) ?? context.sessionId,
      startedAt: normalizeIso(firstString(object, ["startedAt", "started_at", "timestamp", "createdAt", "created_at"])),
      endedAt: normalizeIso(firstString(object, ["endedAt", "ended_at", "completedAt", "completed_at"])),
      observedAt: normalizeIso(firstString(object, ["observedAt", "observed_at", "timestamp", "createdAt", "created_at"])) ?? meta.readAt,
      tokens,
      cost,
      source: meta,
      raw: row,
    });
    return true;
  }
}

function hasNonZeroTokenUsage(tokens: TokenBreakdown): boolean {
  return Object.values(tokens).some((count) => typeof count === "number" && count > 0);
}

function rowsFromJson(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  const object = asObject(value);
  if (!object) {
    return [];
  }
  const records = object["records"];
  if (Array.isArray(records)) {
    return records;
  }
  const messages = object["messages"];
  if (Array.isArray(messages)) {
    return messages;
  }
  const entries = object["entries"];
  if (Array.isArray(entries)) {
    return entries;
  }
  return [value];
}

function normalizeTokens(object: Record<string, unknown>): TokenBreakdown {
  const nested = asObject(object["tokens"]);
  const usage =
    asObject(objectAt(object, "payload.info.last_token_usage")) ??
    asObject(object["usage"]) ??
    objectAt(object, "message.usage") ??
    objectAt(object, "response.usage") ??
    objectAt(object, "payload.usage");
  const source = nested ?? usage ?? object;
  const cacheCreation = asObject(source["cache_creation"]);
  const tokens: TokenBreakdown = {};
  addNumber(tokens, "input", source["input"] ?? source["inputTokens"] ?? source["input_tokens"]);
  addNumber(tokens, "output", source["output"] ?? source["outputTokens"] ?? source["output_tokens"]);
  addNumber(tokens, "cachedInput", source["cachedInput"] ?? source["cached_input"] ?? source["cachedInputTokens"] ?? source["cached_input_tokens"]);
  addNumber(tokens, "cacheRead", source["cacheRead"] ?? source["cache_read"] ?? source["cache_read_input_tokens"]);
  addNumber(
    tokens,
    "cacheWrite5m",
    source["cacheWrite5m"] ??
      source["cache_write_5m"] ??
      source["cacheWrite"] ??
      source["cache_write"] ??
      source["ephemeral_5m_input_tokens"] ??
      cacheCreation?.["ephemeral_5m_input_tokens"] ??
      source["cache_creation_input_tokens"],
  );
  addNumber(
    tokens,
    "cacheWrite1h",
    source["cacheWrite1h"] ?? source["cache_write_1h"] ?? source["ephemeral_1h_input_tokens"] ?? cacheCreation?.["ephemeral_1h_input_tokens"],
  );
  return tokens;
}

type FileContext = {
  sessionId: string;
  model?: string;
};

function createFileContext(filePath: string, model?: string): FileContext {
  const extension = path.extname(filePath);
  return {
    model,
    sessionId: path.basename(filePath, extension),
  };
}

function updateFileContext(context: FileContext, object: Record<string, unknown>): void {
  const model = firstString(object, modelContextPaths);
  if (model) {
    context.model = model;
  }
  // pi transcripts open with {"type":"session","id":"<uuid>"}; same-named files in
  // different session directories must not collapse into one session.
  const headerId = object["type"] === "session" ? object["id"] : undefined;
  const sessionId =
    (typeof headerId === "string" && headerId ? headerId : undefined) ??
    firstString(object, ["sessionId", "session_id", "conversationId", "conversation_id", "uuid", "payload.id", "payload.session_id"]);
  if (sessionId) {
    context.sessionId = sessionId;
  }
}

function inferSingleModel(rows: unknown[]): string | undefined {
  const models = new Set<string>();
  for (const row of rows) {
    const object = asObject(row);
    if (!object) {
      continue;
    }
    const model = firstString(object, modelContextPaths);
    if (model) {
      models.add(model);
      if (models.size > 1) {
        return undefined;
      }
    }
  }
  return [...models][0];
}

function normalizeCost(object: Record<string, unknown>) {
  const costUsd = firstNumber(object, ["costUsd", "costUSD", "cost_usd", "totalCostUsd", "totalCostUSD", "total_cost_usd", "billing.costUsd", "billing.costUSD", "billing.cost_usd"]);
  if (typeof costUsd === "number") {
    return {
      amount: costUsd,
      currency: "USD",
      source: "imported" as const,
    };
  }
  // pi agent session records (omp, pi CLI, vscode-pi) carry their real billed cost as
  // message.usage.cost.{total,currency}. Prefer the imported total so the
  // dashboard shows what the subscription actually billed.
  const usageCost = objectAt(object, "message.usage.cost");
  const total = typeof usageCost?.["total"] === "number" && Number.isFinite(usageCost["total"]) ? (usageCost["total"] as number) : undefined;
  if (usageCost && typeof total === "number") {
    const rawCurrency = usageCost["currency"];
    const currency = typeof rawCurrency === "string" && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : "USD";
    return {
      amount: total,
      currency,
      source: "imported" as const,
    };
  }
  return undefined;
}

function addNumber(tokens: TokenBreakdown, key: keyof TokenBreakdown, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    tokens[key] = value;
  }
}

function sourceKind(filePath: string): SourceKind {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".jsonl") {
    return "jsonl";
  }
  if (extension === ".json") {
    return "json";
  }
  return "unknown";
}

function isUsageFileName(name: string): boolean {
  return /\.(json|jsonl)$/i.test(name) && !/\.meta\.json$/i.test(name);
}

function sourceMeta(sourcePath: string, sourceKindValue: SourceKind, readAt: string): SourceMeta {
  return {
    sourcePath,
    sourceKind: sourceKindValue,
    schemaVersion: "local-usage-v2",
    parserVersion: jsonUsageParserVersion,
    readAt,
  };
}

function usageFileRef(filePath: string, stat: { mtimeMs: number; size: number }): UsageFileRef {
  return {
    filePath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    pathDateKey: dateKeyFromPath(filePath),
  };
}

function dateKeyFromPath(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]+/);
  for (let index = 0; index <= parts.length - 3; index += 1) {
    const year = parts[index];
    const month = parts[index + 1];
    const day = parts[index + 2];
    if (/^\d{4}$/.test(year ?? "") && /^\d{2}$/.test(month ?? "") && /^\d{2}$/.test(day ?? "")) {
      return `${year}-${month}-${day}`;
    }
  }
  return undefined;
}

function issue(
  severity: "warning" | "error",
  code: string,
  message: string,
  sourcePath?: string,
  provider?: UsageProvider,
  line?: number,
): ImportIssue {
  return { severity, code, message, sourcePath, provider, line };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function stringField(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectAt(object: Record<string, unknown>, pathValue: string): Record<string, unknown> | undefined {
  let current: unknown = object;
  for (const segment of pathValue.split(".")) {
    const currentObject = asObject(current);
    if (!currentObject) {
      return undefined;
    }
    current = currentObject[segment];
  }
  return asObject(current);
}

function valueAt(object: Record<string, unknown>, pathValue: string): unknown {
  let current: unknown = object;
  for (const segment of pathValue.split(".")) {
    const currentObject = asObject(current);
    if (!currentObject) {
      return undefined;
    }
    current = currentObject[segment];
  }
  return current;
}

function firstString(object: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = key.includes(".") ? valueAt(object, key) : object[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function firstNumber(object: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = key.includes(".") ? valueAt(object, key) : object[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function numberField(object: Record<string, unknown>, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Stats a file, returning undefined when it cannot be read. */
async function statOrUndefined(filePath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** True when both stats exist and the file fingerprint did not change. */
function statStable(before: { size: number; mtimeMs: number } | undefined, after: { size: number; mtimeMs: number } | undefined): boolean {
  return Boolean(before && after && before.size === after.size && before.mtimeMs === after.mtimeMs);
}

class AsyncLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  public constructor(private readonly limit: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item === undefined) {
        break;
      }
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}
