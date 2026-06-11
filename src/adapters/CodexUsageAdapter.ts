import path from "node:path";
import type { AdapterImportResult, ImportIssue, SourceKind, SourceMeta, TokenBreakdown, UsageProvider, UsageRecord } from "../domain/types";
import { JsonUsageAdapter, jsonUsageParserVersion } from "./JsonUsageAdapter";
import type { UsageFileParseOutcome } from "./JsonUsageAdapter";
import { streamJsonlLines, tailMatches } from "./jsonlStream";

const modelContextPaths = ["model", "message.model", "response.model", "payload.model", "payload.collaboration_mode.settings.model"];

type CodexFileContext = {
  sessionId: string;
  currentModel?: string;
  models: Set<string>;
  lastTotalUsage?: CodexTokenCounts;
};

/**
 * Resumable parse state for append-only Codex rollout files. Persisted in the
 * usage cache so a grown file only has its appended tail parsed. The context
 * carries everything line-order-dependent: the model set (for end-of-file
 * model backfill), the session id, and the running total_token_usage needed
 * for delta computation.
 */
export type CodexParseState = {
  parsedBytes: number;
  tailHash: string;
  lineCount: number;
  allowIncremental: boolean;
  context: {
    sessionId: string;
    currentModel?: string;
    models: string[];
    lastTotalUsage?: CodexTokenCounts;
  };
};

type PendingCodexRecord = Omit<UsageRecord, "model"> & {
  model?: string;
};

type CodexTokenCounts = {
  input?: number;
  cachedInput?: number;
  output?: number;
};

export class CodexUsageAdapter extends JsonUsageAdapter {
  public readonly provider = "codex" as const;

  protected override async readFile(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    if (sourceKind(filePath) !== "jsonl") {
      await super.readFile(filePath, result, readAt);
      return;
    }
    await this.parseJsonl(filePath, result, readAt, undefined);
  }

  public override async importUsageFileWithState(filePath: string, prior?: unknown, readAt = new Date().toISOString()): Promise<UsageFileParseOutcome> {
    if (sourceKind(filePath) !== "jsonl") {
      return { result: await this.importUsageFile(filePath, readAt) };
    }

    const resume = validateCodexParseState(prior);
    if (resume && resume.allowIncremental && (await tailMatches(filePath, resume.parsedBytes, resume.tailHash))) {
      const appendedResult = this.emptyResult();
      const state = await this.parseJsonl(filePath, appendedResult, readAt, resume);
      if (state) {
        return { result: appendedResult, state, appended: true };
      }
      // The appended segment invalidated the resume context (e.g. a new model
      // appeared, changing the historical backfill); fall through to a full
      // parse with a fresh result.
    }

    const fullResult = this.emptyResult();
    const state = await this.parseJsonl(filePath, fullResult, readAt, undefined);
    return { result: fullResult, state };
  }

  private emptyResult(): AdapterImportResult {
    return { provider: this.provider, records: [], warnings: [], errors: [], sourceMeta: [] };
  }

  /**
   * Parses a rollout file, either fully (resume undefined) or from the byte
   * offset captured in `resume`. Returns the next parse state, or undefined
   * when a resumed parse turned out to be invalid and the caller must reparse
   * the whole file.
   */
  private async parseJsonl(
    filePath: string,
    result: AdapterImportResult,
    readAt: string,
    resume: CodexParseState | undefined,
  ): Promise<CodexParseState | undefined> {
    const meta = sourceMeta(filePath, "jsonl", readAt);
    result.sourceMeta.push(meta);
    const context: CodexFileContext = resume
      ? {
          sessionId: resume.context.sessionId,
          currentModel: resume.context.currentModel,
          models: new Set(resume.context.models),
          lastTotalUsage: resume.context.lastTotalUsage ? { ...resume.context.lastTotalUsage } : undefined,
        }
      : {
          sessionId: path.basename(filePath, path.extname(filePath)),
          models: new Set(),
        };
    const records: PendingCodexRecord[] = [];
    const handleLine = (line: string, lineNumber: number): void => {
      if (!line.trim() || isPrefilteredCodexLine(line)) {
        return;
      }
      const row = parseJsonLine(line, filePath, lineNumber, result, this.provider);
      if (row === undefined) {
        return;
      }
      this.addCodexRecord(row, filePath, meta, result, lineNumber, context, records);
    };

    let stream;
    try {
      stream = await streamJsonlLines(filePath, handleLine, {
        start: resume?.parsedBytes ?? 0,
        lineNumberBase: resume?.lineCount ?? 0,
      });
    } catch (error) {
      result.errors.push(issue("error", "file_unreadable", errorMessage(error), filePath, this.provider));
      return undefined;
    }

    // Parity with the previous reader, which emitted the unterminated last
    // line: process it in both full and resume mode so a crashed session's
    // final record still counts. A processed tail poisons incremental resume
    // (the completed line would be parsed a second time), so it disables it —
    // the next change then takes the idempotent full-reparse path.
    let processedPartialTail = false;
    if (stream.partialTail !== undefined) {
      handleLine(stream.partialTail, (resume?.lineCount ?? 0) + stream.lineCount + 1);
      processedPartialTail = true;
    }

    if (!resume && !stream.sawContent) {
      result.warnings.push(issue("warning", "empty_file", "Usage file is empty.", filePath, this.provider));
      return {
        parsedBytes: stream.parsedBytes,
        tailHash: stream.tailHash,
        lineCount: stream.lineCount,
        allowIncremental: true,
        context: serializeCodexContext(context),
      };
    }

    if (resume && !modelsUnchanged(resume.context.models, context.models)) {
      // Any change to the model set (including 0 -> 1) alters the model
      // backfill applied to records parsed earlier, so the whole file must be
      // reparsed for those records to come out right.
      return undefined;
    }

    const inferredModel = context.models.size === 1 ? [...context.models][0] : undefined;
    result.records.push(
      ...records.map((record) => ({
        ...record,
        model: record.model ?? inferredModel,
        sessionId: record.sessionId ?? context.sessionId,
      })),
    );

    return {
      parsedBytes: stream.parsedBytes,
      tailHash: stream.tailHash,
      lineCount: (resume?.lineCount ?? 0) + stream.lineCount,
      allowIncremental: !processedPartialTail,
      context: serializeCodexContext(context),
    };
  }

  private addCodexRecord(
    row: unknown,
    filePath: string,
    meta: SourceMeta,
    result: AdapterImportResult,
    line: number,
    context: CodexFileContext,
    records: PendingCodexRecord[],
  ): void {
    const object = asObject(row);
    if (!object) {
      result.warnings.push(issue("warning", "record_not_object", "Usage record is not an object.", filePath, this.provider, line));
      return;
    }

    this.updateContext(object, context);
    const payload = asObject(object["payload"]);
    const usage = this.usageForRecord(object, payload, context);
    if (object["type"] === "event_msg" && payload?.["type"] === "token_count" && !usage) {
      const info = payload["info"];
      if (info === null || info === undefined) {
        // Rate-limit-only heartbeats ship `info: null` by design; they carry no token usage and are not import issues.
        return;
      }
      result.warnings.push(issue("warning", "missing_tokens", "Codex token_count event has info but no token usage payload.", filePath, this.provider, line));
      return;
    }
    if (!usage) {
      return;
    }

    const tokens = tokensFromCodexCounts(usage);
    if (!hasNonZeroTokenUsage(tokens)) {
      return;
    }

    records.push({
      provider: this.provider,
      model: firstString(object, modelContextPaths) ?? context.currentModel,
      sessionId: firstString(object, ["sessionId", "session_id", "conversationId", "conversation_id", "uuid", "payload.id", "payload.session_id"]) ?? context.sessionId,
      startedAt: normalizeIso(firstString(object, ["startedAt", "started_at", "timestamp", "createdAt", "created_at"])),
      endedAt: normalizeIso(firstString(object, ["endedAt", "ended_at", "completedAt", "completed_at"])),
      observedAt: normalizeIso(firstString(object, ["observedAt", "observed_at", "timestamp", "createdAt", "created_at"])) ?? meta.readAt,
      tokens,
      source: meta,
      raw: row,
    });
  }

  private usageForRecord(object: Record<string, unknown>, payload: Record<string, unknown> | undefined, context: CodexFileContext): CodexTokenCounts | undefined {
    if (object["type"] === "event_msg" && payload) {
      const totalUsage = countsFromCodexUsage(asObject(valueAt(payload, "info.total_token_usage")));
      if (totalUsage) {
        const delta = deltaCounts(totalUsage, context.lastTotalUsage);
        context.lastTotalUsage = totalUsage;
        return delta;
      }
      const lastUsage = countsFromCodexUsage(asObject(valueAt(payload, "info.last_token_usage")));
      if (lastUsage) {
        return lastUsage;
      }
      return undefined;
    }

    const genericUsage = asObject(object["usage"]) ?? asObject(valueAt(object, "message.usage")) ?? asObject(valueAt(object, "response.usage")) ?? asObject(valueAt(object, "payload.usage"));
    return countsFromCodexUsage(genericUsage);
  }

  private updateContext(object: Record<string, unknown>, context: CodexFileContext): void {
    const model = firstString(object, modelContextPaths);
    if (model) {
      context.currentModel = model;
      context.models.add(model);
    }
    const sessionId = firstString(object, ["sessionId", "session_id", "conversationId", "conversation_id", "uuid", "payload.id", "payload.session_id"]);
    if (sessionId) {
      context.sessionId = sessionId;
    }
  }
}

// Rollout bulk lines (assistant output, tool transcripts) carry no usage or
// context fields and account for ~90% of file bytes. Lines whose top-level
// type marks them as bulk are skipped before JSON.parse unless they mention a
// field the parser would actually read (conservative substring guard).
const prefilterSkippableTypes = new Set(["compacted", "response_item"]);
const prefilterContextPattern = /"(model|usage|sessionId|session_id|conversationId|conversation_id|uuid)"\s*:/;

function isPrefilteredCodexLine(line: string): boolean {
  const typeIndex = line.indexOf('"type":"');
  if (typeIndex === -1 || typeIndex > 80) {
    return false;
  }
  const typeEnd = line.indexOf('"', typeIndex + 8);
  if (typeEnd === -1) {
    return false;
  }
  const type = line.slice(typeIndex + 8, typeEnd);
  if (!prefilterSkippableTypes.has(type)) {
    return false;
  }
  return !prefilterContextPattern.test(line);
}

function serializeCodexContext(context: CodexFileContext): CodexParseState["context"] {
  return {
    sessionId: context.sessionId,
    currentModel: context.currentModel,
    models: [...context.models].sort(),
    lastTotalUsage: context.lastTotalUsage ? { ...context.lastTotalUsage } : undefined,
  };
}

function modelsUnchanged(prior: string[], current: Set<string>): boolean {
  if (prior.length !== current.size) {
    return false;
  }
  return prior.every((model) => current.has(model));
}

function validateCodexParseState(value: unknown): CodexParseState | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Partial<CodexParseState>;
  const context = candidate.context;
  if (
    !Number.isSafeInteger(candidate.parsedBytes) ||
    (candidate.parsedBytes as number) < 0 ||
    typeof candidate.tailHash !== "string" ||
    !Number.isSafeInteger(candidate.lineCount) ||
    (candidate.lineCount as number) < 0 ||
    typeof candidate.allowIncremental !== "boolean" ||
    typeof context !== "object" ||
    context === null ||
    typeof context.sessionId !== "string" ||
    (context.currentModel !== undefined && typeof context.currentModel !== "string") ||
    !Array.isArray(context.models) ||
    context.models.some((model) => typeof model !== "string") ||
    !validOptionalCounts(context.lastTotalUsage)
  ) {
    return undefined;
  }
  return candidate as CodexParseState;
}

function validOptionalCounts(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (["input", "cachedInput", "output"] as const).every((key) => {
    const count = (value as Record<string, unknown>)[key];
    return count === undefined || (typeof count === "number" && Number.isFinite(count));
  });
}

function parseJsonLine(
  line: string,
  filePath: string,
  lineNumber: number,
  result: AdapterImportResult,
  provider: UsageProvider,
): unknown | undefined {
  const trimmed = line.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    if (trimmed.startsWith("\\{")) {
      try {
        return JSON.parse(trimmed.slice(1)) as unknown;
      } catch {
        // Fall through to the original parse error for the actionable diagnostic.
      }
    }
    result.errors.push(issue("error", "malformed_jsonl", errorMessage(error), filePath, provider, lineNumber));
    return undefined;
  }
}

function countsFromCodexUsage(usage: Record<string, unknown> | undefined): CodexTokenCounts | undefined {
  if (!usage) {
    return undefined;
  }
  const rawInput = numberValue(usage["input_tokens"] ?? usage["inputTokens"] ?? usage["input"]);
  const cachedInput = numberValue(usage["cached_input_tokens"] ?? usage["cachedInputTokens"] ?? usage["cachedInput"] ?? usage["cached_input"]);
  const output = numberValue(usage["output_tokens"] ?? usage["outputTokens"] ?? usage["output"]);
  if (rawInput === undefined && cachedInput === undefined && output === undefined) {
    return undefined;
  }
  return {
    input: rawInput,
    cachedInput,
    output,
  };
}

function deltaCounts(current: CodexTokenCounts, previous: CodexTokenCounts | undefined): CodexTokenCounts {
  if (!previous) {
    return current;
  }
  return {
    input: deltaNumber(current.input, previous.input),
    cachedInput: deltaNumber(current.cachedInput, previous.cachedInput),
    output: deltaNumber(current.output, previous.output),
  };
}

function deltaNumber(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined) {
    return undefined;
  }
  return Math.max(0, current - (previous ?? 0));
}

function tokensFromCodexCounts(counts: CodexTokenCounts): TokenBreakdown {
  const tokens: TokenBreakdown = {};
  if (counts.input !== undefined) {
    tokens.input = Math.max(0, counts.input - (counts.cachedInput ?? 0));
  }
  if (counts.cachedInput !== undefined) {
    tokens.cachedInput = counts.cachedInput;
  }
  if (counts.output !== undefined) {
    tokens.output = counts.output;
  }
  return tokens;
}

function hasNonZeroTokenUsage(tokens: TokenBreakdown): boolean {
  return Object.values(tokens).some((count) => typeof count === "number" && count > 0);
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

function sourceMeta(sourcePath: string, sourceKindValue: SourceKind, readAt: string): SourceMeta {
  return {
    sourcePath,
    sourceKind: sourceKindValue,
    schemaVersion: "local-usage-v2",
    parserVersion: jsonUsageParserVersion,
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

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeIso(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
