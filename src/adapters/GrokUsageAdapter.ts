import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AdapterImportResult, ImportIssue, SourceMeta, UsageRecord } from "../domain/types";
import { JsonUsageAdapter } from "./JsonUsageAdapter";

/**
 * grok-cli keeps local usage accounting in `~/.grok-cli/session.db` (SQLite,
 * table `session_events`: one row per request with model, token counts and
 * an estimated cost in micro-USD). The database is read through sql.js
 * (wasm, no native module) from an in-memory copy, so the CLI can keep
 * writing while we import.
 */
export class GrokUsageAdapter extends JsonUsageAdapter {
  public override readonly provider = "grok" as const;

  protected override async readFile(filePath: string, result: AdapterImportResult, readAt: string): Promise<void> {
    const meta: SourceMeta = { sourcePath: filePath, sourceKind: "sqlite", parserVersion: grokParserVersion, readAt };
    result.sourceMeta.push(meta);

    let rows: SessionEventRow[];
    try {
      rows = await readSessionEvents(filePath);
    } catch (error) {
      result.errors.push(issue("error", "file_unreadable", error instanceof Error ? error.message : String(error), filePath));
      return;
    }
    if (rows.length === 0) {
      result.warnings.push(issue("warning", "no_records", "grok-cli session database has no usage events.", filePath));
      return;
    }
    let skipped = 0;
    for (const row of rows) {
      const tokens: UsageRecord["tokens"] = {};
      if (row.input_tokens > 0) tokens.input = row.input_tokens;
      if (row.output_tokens > 0) tokens.output = row.output_tokens;
      if (row.cache_read_tokens > 0) tokens.cacheRead = row.cache_read_tokens;
      if (row.cache_write_tokens > 0) tokens.cacheWrite5m = row.cache_write_tokens;
      const costUsd = row.estimated_cost_micro_usd / 1_000_000;
      if (Object.keys(tokens).length === 0 && costUsd === 0) {
        skipped += 1; // image/video/audio events carry no token usage and no cost
        continue;
      }
      result.records.push({
        provider: "grok",
        model: row.model ?? undefined,
        sessionId: row.session_id,
        startedAt: row.started_at,
        endedAt: row.completed_at,
        observedAt: row.completed_at,
        tokens,
        cost: costUsd > 0 ? { amount: costUsd, currency: "USD", source: "imported" } : undefined,
        source: meta,
        raw: row,
      });
    }
    if (skipped > 0) {
      result.warnings.push(issue("warning", "no_token_usage", `${skipped} grok-cli events (image/video/audio) carry no token usage or cost and were skipped.`, filePath));
    }
  }
}

export const grokParserVersion = "grok-sqlite-v1";

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
  estimated_cost_micro_usd: number;
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
  "estimated_cost_micro_usd",
];

async function readSessionEvents(filePath: string): Promise<SessionEventRow[]> {
  const [SQL, bytes] = await Promise.all([loadSqlJs(), fs.readFile(filePath)]);
  const db = new SQL.Database(bytes);
  try {
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
        estimated_cost_micro_usd: Number(row["estimated_cost_micro_usd"] ?? 0),
      };
    });
  } finally {
    db.close();
  }
}

type SqlJs = { Database: new (data?: Uint8Array) => { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>; close(): void } };

let sqlJs: Promise<SqlJs> | undefined;

/**
 * sql.js is vendored into media/sqljs at build time (scripts/copy-sqljs.mjs)
 * because node_modules is not shipped in the VSIX. The vendored copy sits at
 * <extension root>/media/sqljs; walk up from this module to find it so the
 * same code works from out/src/adapters (packaged) and src/adapters (tests).
 */
function loadSqlJs(): Promise<SqlJs> {
  if (!sqlJs) {
    const require = createRequire(__filename);
    let dir = __dirname;
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = path.join(dir, "media", "sqljs");
      if (existsSync(path.join(candidate, "sql-wasm.js"))) {
        const init = require(path.join(candidate, "sql-wasm.js")) as (config: { locateFile: (file: string) => string }) => Promise<SqlJs>;
        sqlJs = init({ locateFile: (file) => path.join(candidate, file) });
        return sqlJs;
      }
      dir = path.dirname(dir);
    }
    sqlJs = Promise.reject(new Error("sql.js runtime not found; run `npm run build:sqljs`."));
  }
  return sqlJs;
}

function issue(severity: ImportIssue["severity"], code: string, message: string, sourcePath: string): ImportIssue {
  return { severity, code, message, sourcePath, provider: "grok" };
}
