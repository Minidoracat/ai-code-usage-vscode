import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AdapterImportResult, ImportIssue, SourceMeta, UsageRecord } from "../domain/types";
import { JsonUsageAdapter, normalizeIso, type UsageFileListResult } from "./JsonUsageAdapter";

/**
 * grok-cli keeps local usage accounting in `~/.grok-cli/session.db` (SQLite,
 * rollback-journal mode, table `session_events`: one row per request with
 * model and token counts). The file is copied into memory and opened with
 * sql.js (wasm, no native module). A copy taken mid-transaction could mix old
 * and new pages, so the read goes through the same before/after fingerprint
 * check as JSON sources and is skipped for this refresh if the file moved.
 * grok-cli's `estimated_cost_micro_usd` is its own bundled-table estimate,
 * not a bill, so it is ignored in favour of the catalog's xAI rules.
 */
export class GrokUsageAdapter extends JsonUsageAdapter {
  public override readonly provider = "grok" as const;

  public constructor(private readonly grokPath?: string) {
    super(grokPath);
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
    for (const row of rows) {
      const tokens: UsageRecord["tokens"] = {};
      // The xAI API reports `input_tokens` inclusive of cached tokens
      // (docs.x.ai prompt-caching usage-and-pricing); grok-cli's streaming path
      // stores that value verbatim while its non-streaming path stores the
      // uncached remainder. The row does not say which, so split whenever the
      // cache count fits inside the prompt: correct for verbatim rows, and for
      // already-split rows it can only under-count, never charge cached tokens
      // twice at the full rate.
      const cacheRead = Math.max(0, row.cache_read_tokens);
      const input = cacheRead > 0 && cacheRead <= row.input_tokens ? row.input_tokens - cacheRead : row.input_tokens;
      if (input > 0) tokens.input = input;
      if (row.output_tokens > 0) tokens.output = row.output_tokens;
      if (cacheRead > 0) tokens.cacheRead = cacheRead;
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
      result.records.push({
        provider: "grok",
        model: row.model ?? undefined,
        sessionId: row.session_id,
        startedAt,
        endedAt,
        observedAt: endedAt,
        tokens,
        source: meta,
        raw: row,
      });
    }
    if (skipped > 0) {
      result.warnings.push(issue("warning", "no_token_usage", `${skipped} grok-cli events carry no token usage or no timestamp (image/video/audio) and were skipped.`, filePath));
    }
  }
}

export const grokParserVersion = "grok-sqlite-v1";

async function resolveSessionDb(usagePath: string | undefined): Promise<string | undefined> {
  if (!usagePath) {
    return usagePath;
  }
  try {
    if ((await fs.stat(usagePath)).isDirectory()) {
      return path.join(usagePath, "session.db");
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

function issue(severity: ImportIssue["severity"], code: string, message: string, sourcePath: string): ImportIssue {
  return { severity, code, message, sourcePath, provider: "grok" };
}
