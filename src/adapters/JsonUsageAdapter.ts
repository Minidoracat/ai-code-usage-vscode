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

const parserVersion = "local-json-v2";
const maxDirectoryDepth = 6;
const maxFilesPerSource = 10_000;

export abstract class JsonUsageAdapter implements UsageAdapter {
  public abstract readonly provider: UsageProvider;

  public constructor(private readonly configuredPath?: string) {}

  public async importUsage(options?: { usagePath?: string }): Promise<AdapterImportResult> {
    const usagePath = options?.usagePath ?? this.configuredPath;
    const readAt = new Date().toISOString();
    const result: AdapterImportResult = {
      provider: this.provider,
      records: [],
      warnings: [],
      errors: [],
      sourceMeta: [],
    };

    if (!usagePath) {
      result.warnings.push(issue("warning", "missing_path", `${this.provider} usage path is not configured.`, undefined, this.provider));
      return result;
    }

    const files = await this.collectFiles(usagePath, result, readAt);
    for (const file of files) {
      await this.readFile(file, result, readAt);
    }

    return result;
  }

  private async collectFiles(usagePath: string, result: AdapterImportResult, readAt: string): Promise<string[]> {
    try {
      const stat = await fs.stat(usagePath);
      if (stat.isDirectory()) {
        const meta = sourceMeta(usagePath, "directory", readAt);
        result.sourceMeta.push(meta);
        const files = await this.collectDirectoryFiles(usagePath, 0, result);
        if (files.length === 0) {
          result.warnings.push(issue("warning", "empty_directory", "No JSON or JSONL usage files were found.", usagePath, this.provider));
        }
        if (files.length >= maxFilesPerSource) {
          result.warnings.push(issue("warning", "source_file_limit", `Only the first ${maxFilesPerSource} usage files were imported.`, usagePath, this.provider));
        }
        return files;
      }
      if (stat.isFile()) {
        return [usagePath];
      }
      result.errors.push(issue("error", "unsupported_path", "Usage path is neither a file nor a directory.", usagePath, this.provider));
      return [];
    } catch (error) {
      result.errors.push(issue("error", "path_unreadable", errorMessage(error), usagePath, this.provider));
      return [];
    }
  }

  private async collectDirectoryFiles(directoryPath: string, depth: number, result: AdapterImportResult): Promise<string[]> {
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

    const files: string[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFilesPerSource) {
        break;
      }
      const fullPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.collectDirectoryFiles(fullPath, depth + 1, result)));
      } else if (entry.isFile() && isUsageFileName(entry.name)) {
        files.push(fullPath);
      }
    }

    return files.slice(0, maxFilesPerSource);
  }

  private async readFile(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    const kind = sourceKind(filePath);
    const meta = sourceMeta(filePath, kind, readAt);
    result.sourceMeta.push(meta);

    let content = "";
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      result.errors.push(issue("error", "file_unreadable", errorMessage(error), filePath, this.provider));
      return;
    }

    if (content.trim().length === 0) {
      result.warnings.push(issue("warning", "empty_file", "Usage file is empty.", filePath, this.provider));
      return;
    }

    if (kind === "jsonl") {
      this.readJsonLines(content, filePath, meta, result);
      return;
    }

    this.readJson(content, filePath, meta, result);
  }

  private readJson(content: string, filePath: string, meta: SourceMeta, result: AdapterImportResult): void {
    try {
      const parsed = JSON.parse(content) as unknown;
      const rows = rowsFromJson(parsed);
      if (rows.length === 0) {
        result.warnings.push(issue("warning", "no_records", "JSON source did not contain usage records.", filePath, this.provider));
      }
      const context = createFileContext(filePath);
      rows.forEach((row, index) => {
        this.addRecord(row, filePath, meta, result, index + 1, context);
      });
    } catch (error) {
      result.errors.push(issue("error", "malformed_json", errorMessage(error), filePath, this.provider));
    }
  }

  private readJsonLines(content: string, filePath: string, meta: SourceMeta, result: AdapterImportResult): void {
    const lines = content.split(/\r?\n/);
    const context = createFileContext(filePath);
    lines.forEach((line, index) => {
      if (!line.trim()) {
        return;
      }
      try {
        this.addRecord(JSON.parse(line) as unknown, filePath, meta, result, index + 1, context);
      } catch (error) {
        result.errors.push(issue("error", "malformed_jsonl", errorMessage(error), filePath, this.provider, index + 1));
      }
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
    const model = firstString(object, ["model", "message.model", "response.model", "payload.model"]) ?? context.model;
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

function createFileContext(filePath: string): FileContext {
  const extension = path.extname(filePath);
  return {
    sessionId: path.basename(filePath, extension),
  };
}

function updateFileContext(context: FileContext, object: Record<string, unknown>): void {
  const model = firstString(object, ["model", "message.model", "response.model", "payload.model", "payload.collaboration_mode.settings.model"]);
  if (model) {
    context.model = model;
  }
  const sessionId = firstString(object, ["sessionId", "session_id", "conversationId", "conversation_id", "uuid", "payload.id", "payload.session_id"]);
  if (sessionId) {
    context.sessionId = sessionId;
  }
}

function normalizeCost(object: Record<string, unknown>) {
  const costUsd = firstNumber(object, ["costUsd", "costUSD", "cost_usd", "totalCostUsd", "totalCostUSD", "total_cost_usd", "billing.costUsd", "billing.costUSD", "billing.cost_usd"]);
  if (typeof costUsd !== "number") {
    return undefined;
  }
  return {
    amount: costUsd,
    currency: "USD",
    source: "imported" as const,
  };
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
    parserVersion,
    readAt,
  };
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
