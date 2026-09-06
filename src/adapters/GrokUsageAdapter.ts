import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AdapterImportResult, ImportIssue, SourceMeta, UsageRecord } from "../domain/types";
import { JsonUsageAdapter, normalizeIso, sourceMeta, type UsageFileListResult } from "./JsonUsageAdapter";
import { streamJsonlLines } from "./jsonlStream";

/**
 * Two Grok tools write local usage:
 *
 * - xAI's official `grok` coding agent: `~/.grok/sessions/<cwd>/<id>/updates.jsonl`,
 *   an ACP update stream whose `turn_completed` events carry per-model token
 *   usage. `inputTokens` there includes `cachedReadTokens` (API convention).
 * - the third-party grok-cli: `~/.grok-cli/session.db` (SQLite, rollback
 *   journal, table `session_events`). Read through sql.js from an in-memory
 *   copy with the same stability checks as JSON sources. Its
 *   `estimated_cost_micro_usd` is a bundled-table estimate, not a bill, and is
 *   ignored; rows with cache hits are counted but not priced because the tool
 *   does not record whether `input_tokens` already had the cache subtracted.
 */
export class GrokUsageAdapter extends JsonUsageAdapter {
  public override readonly provider = "grok" as const;

  public constructor(private readonly grokPath?: string) {
    super(grokPath);
  }

  protected override isUsageFile(name: string): boolean {
    return name === "updates.jsonl" || name === "session.db";
  }

  /**
   * The cache reuses a file while its size/mtime are unchanged, but a
   * `-journal` / `-wal` appearing or disappearing beside the database changes
   * what we can read without touching the main file. Fold their sizes into
   * the fingerprint so those transitions trigger a reparse.
   */
  public override async listUsageFiles(options?: { usagePath?: string }): Promise<UsageFileListResult> {
    // The folder picker and settings UI hand us `~/.grok-cli`; the source is
    // the single `session.db` inside it, not the JSON files the base scanner
    // would otherwise collect (auth.json is not usage data).
    const listed = await super.listUsageFiles({ usagePath: await resolveSessionDb(options?.usagePath ?? this.grokPath) });
    // Subagent runs are separate top-level sessions whose usage the parent's
    // turn_completed already includes (verified: parent modelCalls and cost
    // cover the child's call). The only link is the parent's
    // subagents/<child>/meta.json, so collect those ids and drop the children.
    const childIds = await subagentSessionIds(listed.files.map((file) => path.dirname(file.filePath)));
    listed.files = listed.files.filter((file) => !childIds.has(path.basename(path.dirname(file.filePath))));
    for (const file of listed.files) {
      for (const suffix of ["-journal", "-wal"]) {
        try {
          const sidecar = await fs.stat(file.filePath + suffix);
          file.size += sidecar.size + 1;
          file.mtimeMs = Math.max(file.mtimeMs, sidecar.mtimeMs);
        } catch {
          // no sidecar
        }
      }
    }
    return listed;
  }

  protected override async readFile(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    if (path.basename(filePath) === "updates.jsonl") {
      await this.readAcpUpdates(filePath, result, readAt);
      return;
    }
    const meta: SourceMeta = { sourcePath: filePath, sourceKind: "sqlite", parserVersion: grokParserVersion, readAt };
    result.sourceMeta.push(meta);

    // An active journal is "unstable", not "unreadable": the attempt yields
    // undefined so readStable retries once and the refresh then skips the file.
    const attempt = async (): Promise<SessionEventRow[] | undefined> => {
      try {
        return await readSessionEvents(filePath);
      } catch (error) {
        if (error instanceof JournalActiveError) {
          return undefined;
        }
        throw error;
      }
    };
    let rows: SessionEventRow[] | undefined;
    try {
      rows = await this.readStable(filePath, attempt);
    } catch (error) {
      if (error instanceof WalModeError) {
        result.warnings.push(issue("warning", "wal_unsupported", error.message, filePath));
        return;
      }
      if (error instanceof SchemaMismatchError) {
        result.warnings.push(issue("warning", "unsupported_schema", error.message, filePath));
        return;
      }
      result.errors.push(issue("error", "file_unreadable", error instanceof Error ? error.message : String(error), filePath));
      return;
    }
    if (rows === undefined) {
      result.warnings.push(issue("warning", "file_transient", "grok-cli session database changed while reading; skipped for this refresh.", filePath));
      return;
    }
    if (rows.length === 0) {
      result.warnings.push(issue("warning", "no_records", "grok-cli session database has no usage events.", filePath));
      return;
    }
    let skipped = 0;
    let ambiguous = 0;
    for (const row of rows) {
      const tokens: UsageRecord["tokens"] = {};
      if (row.input_tokens > 0) tokens.input = row.input_tokens;
      if (row.output_tokens > 0) tokens.output = row.output_tokens;
      if (row.cache_read_tokens > 0) tokens.cacheRead = row.cache_read_tokens;
      // xAI has no separate cache-write rate; those tokens are part of input.
      if (Object.keys(tokens).length === 0) {
        skipped += 1; // image/video/audio events carry no token usage
        continue;
      }
      const startedAt = normalizeIso(row.started_at);
      if (!startedAt) {
        skipped += 1;
        continue;
      }
      const endedAt = normalizeIso(row.completed_at) ?? startedAt;
      // The xAI API reports input_tokens inclusive of cached tokens, but
      // grok-cli's streaming and non-streaming paths disagree on whether the
      // stored value has the cache already subtracted, and the row carries no
      // marker. Pricing such a row either way is a guess in one direction, so
      // rows with cache hits are imported for token counts only and flagged
      // as unpriceable until grok-cli records unambiguous usage.
      if (row.cache_read_tokens > 0) {
        ambiguous += 1;
      }
      result.records.push({
        provider: "grok",
        model: row.model ?? undefined,
        sessionId: row.session_id,
        startedAt,
        endedAt,
        observedAt: endedAt,
        tokens,
        pricing: row.cache_read_tokens > 0 ? "unavailable" : undefined,
        source: meta,
        raw: row,
      });
    }
    if (ambiguous > 0) {
      result.warnings.push(issue("warning", "ambiguous_cache_tokens", `${ambiguous} grok-cli events have cache hits whose input_tokens semantics grok-cli does not record; they are counted but not priced.`, filePath));
    }
    if (skipped > 0) {
      result.warnings.push(issue("warning", "no_token_usage", `${skipped} grok-cli events carry no token usage or no timestamp (image/video/audio) and were skipped.`, filePath));
    }
  }

  /**
   * `~/.grok/sessions/<cwd>/<id>/updates.jsonl`: one record per
   * `turn_completed` event and model. `costUsdTicks` is the agent's own
   * billed amount in 1e-10 USD (verified against real turns: per-model
   * effective rates come out as clean constants across turns); it is
   * imported as the record cost because the `-build` model ids are not in
   * the public price list and bill at their own rates.
   */
  private async readAcpUpdates(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    const meta = sourceMeta(filePath, "jsonl", readAt);
    result.sourceMeta.push(meta);
    const sessionId = path.basename(path.dirname(filePath));
    const rows: UsageRecord[] = [];
    let unsplit = 0;
    const collect = (line: string, lineNumber: number): void => {
      if (!line.trim()) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        result.errors.push(issue("error", "malformed_jsonl", error instanceof Error ? error.message : String(error), filePath, lineNumber));
        return;
      }
      const event = asAcpTurn(parsed);
      if (!event) {
        return;
      }
      const observedAt = new Date(event.timestamp * 1000).toISOString();
      for (const [model, usage] of Object.entries(event.modelUsage)) {
        const tokens: UsageRecord["tokens"] = {};
        const cost = typeof usage.costUsdTicks === "number" && usage.costUsdTicks > 0
          ? { amount: usage.costUsdTicks / 1e10, currency: "USD", source: "imported" as const }
          : undefined;
        const cached = usage.cachedReadTokens ?? 0;
        // In the ACP stream inputTokens includes cached reads (totalTokens =
        // inputTokens + outputTokens); the headless JSON output uses the other
        // convention. Only split when the stream's own invariant holds so a
        // format change cannot silently under-count input.
        const inclusive = usage.totalTokens === undefined || usage.totalTokens === usage.inputTokens + usage.outputTokens;
        if (!inclusive) {
          unsplit += 1;
        }
        const input = inclusive ? usage.inputTokens - cached : usage.inputTokens;
        if (input > 0) tokens.input = input;
        if (cached > 0) tokens.cacheRead = cached;
        if (usage.outputTokens > 0) tokens.output = usage.outputTokens;
        if (Object.keys(tokens).length === 0) {
          continue;
        }
        rows.push({ provider: "grok", model, sessionId, startedAt: observedAt, observedAt, tokens, cost, source: meta, raw: parsed });
      }
    };
    const out = await this.readStable(filePath, async () => {
      rows.length = 0;
      const stream = await streamJsonlLines(filePath, collect);
      if (stream.partialTail !== undefined) {
        collect(stream.partialTail, stream.lineCount + 1);
      }
      return rows.slice();
    }).catch((error: unknown) => {
      result.errors.push(issue("error", "file_unreadable", error instanceof Error ? error.message : String(error), filePath));
      return null;
    });
    if (out === null) {
      return;
    }
    if (out === undefined) {
      result.warnings.push(issue("warning", "file_transient", "grok session log changed while reading; skipped for this refresh.", filePath));
      return;
    }
    if (unsplit > 0) {
      result.warnings.push(issue("warning", "token_convention_changed", `${unsplit} grok turns no longer report totalTokens = inputTokens + outputTokens; cached reads were left inside input.`, filePath));
    }
    result.records.push(...out);
  }
}

type AcpTurn = {
  timestamp: number;
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; totalTokens?: number; cachedReadTokens?: number; costUsdTicks?: number }>;
};

function asAcpTurn(value: unknown): AcpTurn | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  const update = (root["params"] as Record<string, unknown> | undefined)?.["update"] as Record<string, unknown> | undefined;
  if (update?.["sessionUpdate"] !== "turn_completed") {
    return undefined;
  }
  const usage = update["usage"] as Record<string, unknown> | undefined;
  const modelUsage = usage?.["modelUsage"];
  const timestamp = root["timestamp"];
  if (typeof timestamp !== "number" || typeof modelUsage !== "object" || modelUsage === null) {
    return undefined;
  }
  const perModel: AcpTurn["modelUsage"] = {};
  for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
    const entry = raw as Record<string, unknown>;
    if (typeof entry?.["inputTokens"] === "number" && typeof entry["outputTokens"] === "number") {
      perModel[model] = {
        inputTokens: entry["inputTokens"],
        outputTokens: entry["outputTokens"],
        cachedReadTokens: typeof entry["cachedReadTokens"] === "number" ? entry["cachedReadTokens"] : undefined,
        costUsdTicks: typeof entry["costUsdTicks"] === "number" ? entry["costUsdTicks"] : undefined,
        totalTokens: typeof entry["totalTokens"] === "number" ? entry["totalTokens"] : undefined,
      };
    }
  }
  return { timestamp, modelUsage: perModel };
}

export const grokParserVersion = "grok-sqlite-v1";

/** Reads `subagents/<child>/meta.json` under each session dir and returns the child session ids. */
async function subagentSessionIds(sessionDirs: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const dir of new Set(sessionDirs)) {
    let children: string[];
    try {
      children = await fs.readdir(path.join(dir, "subagents"));
    } catch {
      continue;
    }
    for (const child of children) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(dir, "subagents", child, "meta.json"), "utf8")) as { child_session_id?: unknown };
        ids.add(typeof meta.child_session_id === "string" ? meta.child_session_id : child);
      } catch {
        ids.add(child);
      }
    }
  }
  return ids;
}

/** `~/.grok-cli` (folder picker / settings) means its `session.db`; any other directory is scanned for `updates.jsonl`. */
async function resolveSessionDb(usagePath: string | undefined): Promise<string | undefined> {
  if (!usagePath) {
    return usagePath;
  }
  try {
    const db = path.join(usagePath, "session.db");
    if ((await fs.stat(usagePath)).isDirectory() && existsSync(db)) {
      return db;
    }
  } catch {
    // missing path: let the base implementation report path_unreadable
  }
  return usagePath;
}

type SessionEventRow = {
  event_id: string;
  session_id: string;
  model: string | null;
  started_at: string;
  completed_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

const sessionEventColumns: Array<keyof SessionEventRow> = [
  "event_id",
  "session_id",
  "model",
  "started_at",
  "completed_at",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
];

/**
 * A hot rollback journal beside the database means a writer is
 * mid-transaction: the main file may hold spilled, uncommitted pages that
 * look stable to a size/mtime check. sqlite readers refuse such a file; so do
 * we, by failing the attempt so readStable retries and then skips. A `-wal`
 * file is different: it persists while idle and holds committed pages the
 * main file lacks, so it is reported as unsupported; the cache keeps the last
 * good records and re-checks on every refresh until the WAL is gone.
 */
async function assertNoActiveJournal(filePath: string): Promise<void> {
  if (await exists(`${filePath}-wal`)) {
    throw new WalModeError();
  }
  if (await exists(`${filePath}-journal`)) {
    throw new JournalActiveError();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

class JournalActiveError extends Error {
  public constructor() {
    super("SQLite rollback journal present: database is being written");
  }
}

class SchemaMismatchError extends Error {
  public constructor() {
    super("Not a grok-cli session database: table session_events with the expected columns was not found");
  }
}

class WalModeError extends Error {
  public constructor() {
    super("SQLite database uses WAL mode; committed rows may be missing from the main file until grok-cli checkpoints it");
  }
}

async function readSessionEvents(filePath: string): Promise<SessionEventRow[]> {
  await assertNoActiveJournal(filePath);
  const [SQL, bytes] = await Promise.all([loadSqlJs(), fs.readFile(filePath)]);
  await assertNoActiveJournal(filePath);
  const db = new SQL.Database(bytes);
  try {
    const [schema] = db.exec("select sql from sqlite_master where type = 'table' and name = 'session_events'");
    const createSql = String(schema?.values[0]?.[0] ?? "");
    if (!createSql || sessionEventColumns.some((column) => !createSql.includes(column))) {
      throw new SchemaMismatchError();
    }
    const [table] = db.exec(`select ${sessionEventColumns.join(", ")} from session_events order by started_at`);
    if (!table) {
      return [];
    }
    return table.values.map((values) => {
      const row = {} as Record<string, unknown>;
      table.columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return {
        event_id: String(row["event_id"]),
        session_id: String(row["session_id"]),
        model: typeof row["model"] === "string" ? row["model"] : null,
        started_at: String(row["started_at"]),
        completed_at: String(row["completed_at"] ?? row["started_at"]),
        input_tokens: Number(row["input_tokens"] ?? 0),
        output_tokens: Number(row["output_tokens"] ?? 0),
        cache_read_tokens: Number(row["cache_read_tokens"] ?? 0),
        cache_write_tokens: Number(row["cache_write_tokens"] ?? 0),
      };
    });
  } finally {
    db.close();
  }
}

type SqlJs = { Database: new (data?: Uint8Array) => { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>; close(): void } };

let sqlJs: Promise<SqlJs> | undefined;

/**
 * sql.js is vendored into <extension root>/media/sqljs at build time
 * (scripts/copy-sqljs.mjs) because node_modules is not shipped in the VSIX.
 * This module lives at <root>/out/src/adapters (packaged) or <root>/src/adapters
 * (tests); only those two fixed depths are probed so the lookup can never load
 * code from outside the extension directory.
 */
function loadSqlJs(): Promise<SqlJs> {
  if (!sqlJs) {
    // out/src/adapters -> root is 3 up; src/adapters (tsx in tests) -> 2 up.
    const dir = [3, 2]
      .map((levels) => path.resolve(__dirname, ...Array<string>(levels).fill(".."), "media", "sqljs"))
      .find((candidate) => existsSync(path.join(candidate, "sql-wasm.js")));
    const entry = dir ? path.join(dir, "sql-wasm.js") : undefined;
    if (!dir || !entry) {
      return Promise.reject(new Error("The bundled SQLite runtime is missing from this extension build; reinstall the extension."));
    }
    const init = createRequire(__filename)(entry) as (config: { locateFile: (file: string) => string }) => Promise<SqlJs>;
    sqlJs = init({ locateFile: (file) => path.join(dir, file) });
    sqlJs.catch(() => {
      sqlJs = undefined; // let a later refresh retry initialisation
    });
  }
  return sqlJs;
}

function issue(severity: ImportIssue["severity"], code: string, message: string, sourcePath: string, line?: number): ImportIssue {
  return { severity, code, message, sourcePath, provider: "grok", line };
}
