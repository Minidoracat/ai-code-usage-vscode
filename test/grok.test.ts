import assert from "node:assert/strict";
import { promises as fs, type Stats } from "node:fs";
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
    assert.deepEqual(first?.tokens, { input: 1000, output: 200, cacheRead: 500 });
    assert.equal(first?.pricing, "unavailable");
    assert.equal(second?.pricing, undefined);
    assert.ok(result.warnings.some((warning) => warning.code === "ambiguous_cache_tokens"));
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

test("grok rows with cache hits are counted but not priced, because grok-cli does not record which input_tokens convention it stored", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const dbPath = path.join(dir, "session.db");
    await writeSessionDb(dbPath, [
      textEvent("e1", "sess_a", "2026-09-01T10:00:00.000Z", { input: 150_000, output: 0, cached: 100_000 }),
      textEvent("e2", "sess_b", "2026-09-01T11:00:00.000Z", { input: 150_000, output: 0 }),
    ]);
    const imported = await new GrokUsageAdapter(dbPath).importUsage();
    const catalog = JSON.parse(await readFile(path.join(process.cwd(), "src/pricing/catalog.json"), "utf8")) as PricingCatalog;
    const pricing = new PricingService(catalog);

    const [withCache, withoutCache] = imported.records.map((record) => pricing.estimate(record));
    assert.deepEqual(withCache, { available: false, reason: "ambiguous_tokens" });
    assert.equal(withoutCache?.available && withoutCache.cost.amount, 0.3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const acpTurn = (timestamp: number, model: string, usage: { input: number; output: number; cached?: number; ticks?: number }) =>
  JSON.stringify({
    timestamp,
    method: "_x.ai/session/update",
    params: {
      sessionId: "s",
      update: {
        sessionUpdate: "turn_completed",
        usage: {
          inputTokens: usage.input, outputTokens: usage.output, cachedReadTokens: usage.cached ?? 0, costUsdTicks: usage.ticks ?? 0,
          modelUsage: { [model]: { inputTokens: usage.input, outputTokens: usage.output, cachedReadTokens: usage.cached ?? 0, costUsdTicks: usage.ticks ?? 0 } },
        },
      },
    },
  });

test("grok adapter reads the official grok agent's ACP session updates: billed cost, cached tokens split out of inputTokens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const session = path.join(root, "%2Froot%2Fproj", "01a0-session");
    await mkdir(session, { recursive: true });
    await writeFile(path.join(session, "updates.jsonl"), [
      JSON.stringify({ timestamp: 1_788_677_370, method: "_x.ai/session/update", params: { update: { sessionUpdate: "agent_message_chunk" } } }),
      acpTurn(1_788_677_379, "grok-4.6-build", { input: 36_343, output: 63, ticks: 124_208_800 }),
      acpTurn(1_788_677_381, "grok-4.6-build", { input: 36_426, output: 66, cached: 36_224, ticks: 32_150_400 }),
    ].join("\n") + "\n");
    // sibling files the base scanner would otherwise pick up
    await writeFile(path.join(session, "chat_history.jsonl"), JSON.stringify({ role: "user", content: "hi", usage: { inputTokens: 999 } }) + "\n");
    await writeFile(path.join(session, "summary.json"), JSON.stringify({ info: { id: "x" } }));

    const result = await new GrokUsageAdapter(root).importUsage();
    const catalog = JSON.parse(await readFile(path.join(process.cwd(), "src/pricing/catalog.json"), "utf8")) as PricingCatalog;
    const pricing = new PricingService(catalog);

    assert.deepEqual(result.errors, []);
    assert.equal(result.records.length, 2);
    assert.equal(result.records[0]?.sessionId, "01a0-session");
    assert.equal(result.records[0]?.startedAt, "2026-09-06T06:49:39.000Z");
    assert.deepEqual(result.records[0]?.tokens, { input: 36_343, output: 63 });
    assert.deepEqual(result.records[1]?.tokens, { input: 202, cacheRead: 36_224, output: 66 });
    // costUsdTicks is the agent's billed amount in 1e-10 USD and wins over the catalog
    // (grok-4.6-build is not a public list price; at list rates this turn would be $0.018912).
    assert.deepEqual(result.records[1]?.cost, { amount: 0.00321504, currency: "USD", source: "imported" });
    const billed = pricing.estimate(result.records[1]!);
    assert.equal(billed.available && billed.cost.amount, 0.00321504);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cached importer keeps grok agent turns while updates.jsonl is being written and rereads once stable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-code-usage-grok-"));
  try {
    const session = path.join(root, "sessions", "cwd", "01a0-session");
    await mkdir(session, { recursive: true });
    const log = path.join(session, "updates.jsonl");
    await writeFile(log, acpTurn(1_788_677_379, "grok-4.6-build", { input: 100, output: 10, ticks: 1_000_000 }) + "\n");
    const importer = new CachedUsageImporter(path.join(root, "cache"));
    const range = new TimeRangeService(() => new Date("2026-09-06T23:00:00.000Z"), resolveTimeZone("utc")).resolve("today");
    const sourceRoot = path.join(root, "sessions");
    const load = (adapter: GrokUsageAdapter) => importer.loadForRange({ sources: [{ provider: "grok", sourcePath: sourceRoot, adapter }], range });

    const warm = await load(new GrokUsageAdapter(sourceRoot));
    // A writer keeps changing the file for the whole refresh: every stat differs.
    const flaky = new GrokUsageAdapter(sourceRoot);
    const realStat = fs.stat.bind(fs);
    let bump = 0;
    (fs as { stat: typeof fs.stat }).stat = (async (target: string, ...rest: unknown[]) => {
      const stat = await (realStat as (...args: unknown[]) => Promise<Stats>)(target, ...rest);
      if (target === log) {
        bump += 1;
        return { ...stat, size: stat.size + bump, mtimeMs: stat.mtimeMs + bump, isFile: () => true, isDirectory: () => false } as Stats;
      }
      return stat;
    }) as typeof fs.stat;
    let unstable;
    try {
      unstable = await load(flaky);
    } finally {
      (fs as { stat: typeof fs.stat }).stat = realStat;
    }
    const recovered = await load(new GrokUsageAdapter(sourceRoot));

    assert.equal(warm.imports[0]?.records.length, 1);
    assert.equal(unstable.imports[0]?.records.length, 1, "cached turn survives a torn read");
    assert.ok(unstable.imports[0]?.warnings.some((warning) => warning.code === "file_transient"));
    assert.equal(recovered.imports[0]?.records.length, 1);
    assert.deepEqual(recovered.imports[0]?.warnings, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
