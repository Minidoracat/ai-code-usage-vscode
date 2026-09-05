import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GrokUsageAdapter } from "../src/adapters/GrokUsageAdapter";
import { CachedUsageImporter } from "../src/services/CachedUsageImporter";
import { PricingService } from "../src/services/PricingService";
import { SourceDetectionService } from "../src/services/SourceDetectionService";
import { UsageAggregator } from "../src/services/UsageAggregator";
import { TimeRangeService } from "../src/services/TimeRangeService";
import { resolveTimeZone } from "../src/services/TimeZoneService";
import type { PricingCatalog } from "../src/domain/types";
import initSqlJs from "sql.js";

/** Builds a grok-cli style session.db with the given events. */
async function writeSessionDb(filePath: string, events: Array<Record<string, string | number>>): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE session_events (
    event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, command TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NULL,
    started_at TEXT NOT NULL, completed_at TEXT NOT NULL, duration_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_micro_usd INTEGER NOT NULL DEFAULT 0,
    context_window_tokens INTEGER NULL, request_id TEXT NULL, metadata_json TEXT NULL)`);
  for (const event of events) {
    const columns = Object.keys(event);
    db.run(`INSERT INTO session_events (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, columns.map((column) => event[column] ?? null));
  }
  await writeFile(filePath, db.export());
}

const textEvent = (id: string, session: string, at: string, tokens: { input: number; output: number; cached?: number }) => ({
  event_id: id, session_id: session, command: "chat", provider: "xai-oauth", model: "grok-4.6",
  started_at: at, completed_at: at, duration_ms: 1000,
  input_tokens: tokens.input, output_tokens: tokens.output, cache_read_tokens: tokens.cached ?? 0,
});

test("grok adapter imports grok-cli session events and skips media-only events", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [
      textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 1000, output: 200, cached: 500 }),
      textEvent("e2", "sess_b", "2026-09-01T11:00:00.000Z", { input: 100, output: 10 }),
      { event_id: "e3", session_id: "sess_a", command: "image", provider: "xai-oauth", model: "grok-imagine-image", started_at: "2026-09-01T12:00:00.000Z", completed_at: "2026-09-01T12:00:01.000Z", duration_ms: 1000 },
    ]);

    const result = await new GrokUsageAdapter(dbPath).importUsage();

    assert.equal(result.provider, "grok");
    assert.deepEqual(result.errors, []);
    assert.equal(result.sourceMeta[0]?.sourceKind, "sqlite");
    assert.equal(result.records.length, 2);
    const [first, second] = result.records;
    assert.equal(first?.model, "grok-4.6");
    assert.equal(first?.sessionId, "sess_a");
    // API-style row: input_tokens (1000) includes the 500 cached tokens.
    assert.deepEqual(first?.tokens, { input: 500, output: 200, cacheRead: 500 });
    assert.equal(first?.cost, undefined); // grok-cli only stores its own estimate; the catalog prices these
    assert.equal(second?.sessionId, "sess_b");
    assert.ok(result.warnings.some((warning) => warning.code === "no_token_usage"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok records aggregate as their own provider and price with the xAI catalog", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 100_000, output: 0 })]);
    const imported = await new GrokUsageAdapter(dbPath).importUsage();
    const catalog = JSON.parse(await readFile(path.join(process.cwd(), "src/pricing/catalog.json"), "utf8")) as PricingCatalog;
    const range = new TimeRangeService(() => new Date("2026-09-01T23:00:00.000Z"), resolveTimeZone("utc")).resolve("today");

    const summary = new UsageAggregator(new PricingService(catalog)).aggregate([imported], range);

    assert.equal(summary.providerSplit.find((item) => item.provider === "grok")?.records, 1);
    assert.equal(summary.modelSplit[0]?.cost?.amount, 0.2); // grok-4.6 $2 / MTok input, below the 200K tier
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("source detection finds the grok-cli session database", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "ai-code-usage-home-"));
  try {
    await mkdir(path.join(home, ".grok-cli"), { recursive: true });
    await writeFile(path.join(home, ".grok-cli", "session.db"), "");

    const detected = await new SourceDetectionService(home, {}).detect();

    assert.deepEqual(detected.map((source) => [source.provider, source.sourcePath]), [["grok", path.join(home, ".grok-cli", "session.db")]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("grok adapter skips the refresh while a writer holds an open transaction and reads after commit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 10, output: 1 })]);
    // A hot rollback journal is what a real sqlite writer leaves beside the
    // database for the whole transaction; its presence is the signal we key on.
    await writeFile(`${dbPath}-journal`, Buffer.alloc(512));

    const duringWrite = await new GrokUsageAdapter(dbPath).importUsage();
    await rm(`${dbPath}-journal`);
    const afterCommit = await new GrokUsageAdapter(dbPath).importUsage();

    assert.equal(duringWrite.records.length, 0);
    assert.deepEqual(duringWrite.errors, []);
    assert.ok(duringWrite.warnings.some((warning) => warning.code === "file_transient"));
    assert.equal(afterCommit.records.length, 1);
    assert.deepEqual(afterCommit.warnings, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok adapter reports a WAL-mode database instead of retrying it forever", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 10, output: 1 })]);
    await writeFile(`${dbPath}-wal`, Buffer.alloc(32));

    const result = await new GrokUsageAdapter(dbPath).importUsage();

    assert.equal(result.records.length, 0);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ["wal_unsupported"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cached importer keeps grok records while the database is in WAL mode and rereads after checkpoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 10, output: 1 })]);
    const importer = new CachedUsageImporter(path.join(dir, "cache"));
    const range = new TimeRangeService(() => new Date("2026-09-01T23:00:00.000Z"), resolveTimeZone("utc")).resolve("today");
    const load = () => importer.loadForRange({ sources: [{ provider: "grok", sourcePath: dbPath, adapter: new GrokUsageAdapter(dbPath) }], range });

    const warm = await load();
    await writeFile(`${dbPath}-wal`, Buffer.alloc(32));
    const duringWal = await load();
    await rm(`${dbPath}-wal`);
    const afterCheckpoint = await load(); // same size/mtime as before

    assert.equal(warm.imports[0]?.records.length, 1);
    assert.equal(duringWal.imports[0]?.records.length, 1, "cached records survive a WAL refresh");
    assert.ok(duringWal.imports[0]?.warnings.some((warning) => warning.code === "wal_unsupported"));
    assert.equal(afterCheckpoint.imports[0]?.records.length, 1);
    assert.equal(afterCheckpoint.imports[0]?.warnings.some((warning) => warning.code === "wal_unsupported"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok adapter accepts the grok-cli folder and reads session.db inside it, ignoring auth.json", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    await writeSessionDb(path.join(dir, "session.db"), [textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 10, output: 1 })]);
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ access_token: "secret" }));

    const result = await new GrokUsageAdapter(dir).importUsage();

    assert.deepEqual(result.errors, []);
    assert.equal(result.records.length, 1);
    assert.equal(result.sourceMeta.every((meta) => !meta.sourcePath.endsWith("auth.json")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok adapter reports a database without the grok-cli schema as unsupported, not as an error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeFile(dbPath, ""); // what detection accepts: any existing *.db

    const result = await new GrokUsageAdapter(dbPath).importUsage();

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings.map((warning) => warning.code), ["unsupported_schema"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("grok pricing does not double count cached tokens toward the 200K long-context tier", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [
      // streaming row: API input_tokens (150K) already includes the 100K cache hit
      textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 150_000, output: 0, cached: 100_000 }),
      // non-streaming row: grok-cli stored the uncached remainder; cache exceeds input so it is left alone
      textEvent("e2", "sess_b", "2026-09-01T11:00:00.000Z", { input: 50_000, output: 0, cached: 100_000 }),
    ]);
    const imported = await new GrokUsageAdapter(dbPath).importUsage();
    const catalog = JSON.parse(await readFile(path.join(process.cwd(), "src/pricing/catalog.json"), "utf8")) as PricingCatalog;
    const pricing = new PricingService(catalog);

    const [streaming, nonStreaming] = imported.records.map((record) => pricing.estimate(record));
    // 150K prompt is below the tier: 50K uncached * $2 + 100K cached * $0.50 = $0.15 (not $0.70 at the long-context rate)
    assert.equal(streaming?.available && streaming.cost.amount, 0.15);
    assert.equal(nonStreaming?.available && nonStreaming.cost.amount, 0.15);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
