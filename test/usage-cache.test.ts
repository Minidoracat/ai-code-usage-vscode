import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ClaudeUsageAdapter } from "../src/adapters/ClaudeUsageAdapter";
import { CodexUsageAdapter } from "../src/adapters/CodexUsageAdapter";
import type { JsonUsageAdapter } from "../src/adapters/JsonUsageAdapter";
import { CachedUsageImporter } from "../src/services/CachedUsageImporter";
import { TimeRangeService } from "../src/services/TimeRangeService";
import { resolveTimeZone } from "../src/services/TimeZoneService";

test("cached importer reuses unchanged files and does not persist raw records", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-cache-session",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 12,
      outputTokens: 4,
    });

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });
    const second = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    assert.equal(first.imports[0]?.records.length, 1);
    assert.equal(second.imports[0]?.records.length, 1);
    assert.equal(adapter.parseCount, 1);
    assert.equal(second.cache.status, "warm");

    const shard = await readShard(fixture.cacheRoot, "2026-05-01");
    assert.ok(shard[0]);
    assert.equal("raw" in shard[0].record, false);
    assert.equal(JSON.stringify(shard).includes(fixture.sourceRoot), false);
    assert.equal((shard[0].record["source"] as { sourcePath?: string }).sourcePath?.startsWith("cache:"), true);
    assert.equal((await readFile(path.join(fixture.cacheRoot, "index.json"), "utf8")).includes(fixture.sourceRoot), false);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer can force reparse for explicit refreshes", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-force-session",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 12,
      outputTokens: 4,
    });

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });
    const forced = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range, forceReparse: true });

    assert.equal(adapter.parseCount, 2);
    assert.equal(forced.cache.status, "rebuilding");
    assert.equal(forced.imports[0]?.records.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer reparses stale-span files that changed into the active range", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-stale-span-old",
      timestamp: "2026-04-01T01:00:00.000Z",
      inputTokens: 1,
      outputTokens: 1,
    });

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range: utcRange("2026-04-01", "2026-04-01") });

    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-stale-span-new",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 5,
      outputTokens: 1,
    });
    const changed = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range: utcRange("2026-05-01", "2026-05-01") });
    const forced = await importer.loadForRange({
      sources: [source(fixture.sourceRoot, adapter)],
      range: utcRange("2026-05-01", "2026-05-01"),
      forceReparse: true,
    });

    assert.deepEqual(
      changed.imports[0]?.records.map((record) => record.sessionId),
      ["fixture-stale-span-new"],
    );
    assert.deepEqual(
      forced.imports[0]?.records.map((record) => record.sessionId),
      ["fixture-stale-span-new"],
    );
    assert.equal(adapter.parseCount, 3);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer reparses changed files and keeps warm diagnostics", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeFile(
      usageFile,
      [
        claudeUsageLine({ sessionId: "fixture-cache-session", timestamp: "2026-05-01T01:00:00.000Z", inputTokens: 1, outputTokens: 1 }),
        "{not-json}",
      ].join("\n"),
      "utf8",
    );

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });
    const second = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });
    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-cache-session",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 9,
      outputTokens: 1,
    });
    const third = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    assert.ok(first.imports[0]?.errors.some((error) => error.code === "malformed_jsonl"));
    assert.ok(second.imports[0]?.errors.some((error) => error.code === "malformed_jsonl"));
    assert.equal(second.cache.status, "warm");
    assert.equal(third.imports[0]?.errors.length, 0);
    assert.equal(third.imports[0]?.records[0]?.tokens.input, 9);
    assert.equal(adapter.parseCount, 2);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer keeps records when a file becomes unreadable and retries it once readable again", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, { sessionId: "s", timestamp: "2026-05-01T01:00:00.000Z", inputTokens: 7, outputTokens: 1 });
    const adapter = new FlakyClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    const load = () => importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    const warm = await load();
    // The file is rewritten (new mtime) but the read fails this time.
    await utimes(usageFile, new Date("2026-05-02T00:00:00.000Z"), new Date("2026-05-02T00:00:00.000Z"));
    adapter.failReads = true;
    const failed = await load();
    // Retained diagnostics go through the same sanitizer as parsed ones.
    const indexAfterFailure = await readFile(path.join(fixture.cacheRoot, "index.json"), "utf8");
    adapter.failReads = false;
    const recovered = await load();

    assert.equal(warm.imports[0]?.records[0]?.tokens.input, 7);
    assert.ok(indexAfterFailure.includes("file_unreadable"));
    assert.equal(indexAfterFailure.includes(fixture.sourceRoot), false);
    // Unreadable: error surfaced, cached records retained.
    assert.ok(failed.imports[0]?.errors.some((error) => error.code === "file_unreadable"));
    assert.equal(failed.imports[0]?.records[0]?.tokens.input, 7);
    // Same size/mtime, but a cached read failure must be retried and cleared.
    assert.equal(recovered.imports[0]?.errors.length, 0);
    assert.equal(recovered.imports[0]?.records[0]?.tokens.input, 7);
    assert.equal(adapter.parseCount, 3);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer retries a file whose very first read failed", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, { sessionId: "s", timestamp: "2026-05-01T01:00:00.000Z", inputTokens: 3, outputTokens: 1 });
    const adapter = new FlakyClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    const load = () => importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    adapter.failReads = true;
    const failed = await load();
    adapter.failReads = false;
    const recovered = await load();

    assert.ok(failed.imports[0]?.errors.some((error) => error.code === "file_unreadable"));
    assert.equal(failed.imports[0]?.records.length, 0);
    assert.equal(recovered.imports[0]?.errors.length, 0);
    assert.equal(recovered.imports[0]?.records[0]?.tokens.input, 3);
  } finally {
    await fixture.dispose();
  }
});

test("source summary reports a fully parsed source with no usable records as empty, independent of the range", async () => {
  const fixture = await createFixture();
  try {
    // One file, parsed, zero usage records: the situation a stale auto-detected path leaves behind.
    await writeFile(path.join(fixture.sourceRoot, "session.jsonl"), JSON.stringify({ type: "user", message: "no usage here" }) + "\n", "utf8");
    const importer = new CachedUsageImporter(fixture.cacheRoot);

    const load = () => importer.loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range: utcRange("2026-05-01", "2026-05-01"),
    });

    const expected = { provider: "claude", sourcePath: fixture.sourceRoot, files: 1, cachedRecords: 0, complete: true };
    assert.deepEqual((await load()).sources[0], expected);
    // Second load: the empty file is skipped as already parsed, not counted as unparsed backlog.
    const warm = await load();
    assert.deepEqual(warm.sources[0], expected);
    assert.equal(warm.cache.historicalComplete, true);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer reuses unchanged files with cached diagnostics and no records", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "metadata.json");
    await writeFile(usageFile, "{not-json}", "utf8");

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });
    const second = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    assert.equal(first.imports[0]?.records.length, 0);
    assert.ok(first.imports[0]?.errors.some((error) => error.code === "malformed_json"));
    assert.ok(second.imports[0]?.errors.some((error) => error.code === "malformed_json"));
    assert.equal(adapter.parseCount, 1);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer keeps serving usage from memory when a shard file is corrupted externally", async () => {
  const fixture = await createFixture();
  try {
    await writeClaudeUsage(path.join(fixture.sourceRoot, "session.jsonl"), {
      sessionId: "fixture-corrupt-cache",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 5,
      outputTokens: 1,
    });

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range });
    await writeFile(path.join(fixture.cacheRoot, "records", "claude", "2026-05-01.json"), "{not-json}", "utf8");

    const result = await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range });

    assert.equal(result.cache.rangeComplete, true);
    assert.equal(result.imports[0]?.records.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer self-heals corrupt cache shards after a restart without forced reparse", async () => {
  const fixture = await createFixture();
  try {
    await writeClaudeUsage(path.join(fixture.sourceRoot, "session.jsonl"), {
      sessionId: "fixture-corrupt-cache",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 5,
      outputTokens: 1,
    });

    const range = utcRange("2026-05-01", "2026-05-01");
    await new CachedUsageImporter(fixture.cacheRoot).loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range,
    });
    await writeFile(path.join(fixture.cacheRoot, "records", "claude", "2026-05-01.json"), "{not-json}", "utf8");

    // A fresh importer simulates an extension-host restart with a cold shard cache.
    const restarted = new CachedUsageImporter(fixture.cacheRoot);
    const corrupted = await restarted.loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range,
    });

    assert.equal(corrupted.cache.rangeComplete, false);
    assert.ok(corrupted.imports[0]?.errors.some((error) => error.code === "cache_read_failed"));

    const healed = await restarted.loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range,
    });

    assert.equal(healed.cache.rangeComplete, true);
    assert.equal(healed.imports[0]?.records.length, 1);
    assert.equal(healed.imports[0]?.errors.some((error) => error.code === "cache_read_failed"), false);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer includes timezone boundary files before filtering precisely", async () => {
  const fixture = await createFixture();
  try {
    const datedDirectory = path.join(fixture.sourceRoot, "2026", "04", "30");
    await mkdir(datedDirectory, { recursive: true });
    await writeClaudeUsage(path.join(datedDirectory, "session.jsonl"), {
      sessionId: "fixture-tz-session",
      timestamp: "2026-04-30T18:00:00.000Z",
      inputTokens: 7,
      outputTokens: 2,
    });

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = new TimeRangeService(() => new Date("2026-05-01T06:00:00.000Z"), resolveTimeZone("custom", "Asia/Taipei")).resolve(
      "today",
    );

    const result = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range });

    assert.equal(result.imports[0]?.records.length, 1);
    assert.equal(result.imports[0]?.records[0]?.sessionId, "fixture-tz-session");
    assert.equal(result.imports[0]?.records[0]?.startedAt, "2026-04-30T18:00:00.000Z");
  } finally {
    await fixture.dispose();
  }
});

test("cached importer parses cold Codex files whose path date is outside the active range", async () => {
  const fixture = await createFixture();
  try {
    const oldSessionDirectory = path.join(fixture.sourceRoot, "2026", "04", "29");
    await mkdir(oldSessionDirectory, { recursive: true });
    await writeFile(
      path.join(oldSessionDirectory, "rollout-2026-04-29T18-38-35-fixture-codex-session.jsonl"),
      JSON.stringify({
        timestamp: "2026-06-08T01:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 5,
            },
          },
        },
      }),
      "utf8",
    );

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const result = await importer.loadForRange({
      sources: [source("codex", fixture.sourceRoot, new CodexUsageAdapter(fixture.sourceRoot))],
      range: utcRange("2026-06-08", "2026-06-08"),
    });

    assert.equal(result.imports[0]?.records.length, 1);
    assert.equal(result.imports[0]?.records[0]?.tokens.input, 80);
    assert.equal(result.imports[0]?.records[0]?.tokens.cachedInput, 20);
    assert.equal(result.cache.rangeComplete, true);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer throttles high-frequency progress updates and flushes completion", async () => {
  const fixture = await createFixture();
  try {
    for (let index = 0; index < 120; index += 1) {
      await writeClaudeUsage(path.join(fixture.sourceRoot, `session-${String(index).padStart(3, "0")}.jsonl`), {
        sessionId: `fixture-progress-${index}`,
        timestamp: "2026-05-01T01:00:00.000Z",
        inputTokens: 1,
        outputTokens: 1,
      });
    }

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const progressEvents: Array<{ filesChecked: number; filesParsed: number; recordsLoaded: number }> = [];
    await importer.loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range: utcRange("2026-05-01", "2026-05-01"),
      onProgress: (progress) => {
        progressEvents.push({
          filesChecked: progress.filesChecked,
          filesParsed: progress.filesParsed,
          recordsLoaded: progress.recordsLoaded,
        });
        return Promise.resolve();
      },
    });

    const finalEvent = progressEvents[progressEvents.length - 1];
    assert.ok(finalEvent);
    assert.equal(finalEvent.filesChecked, 120);
    assert.equal(finalEvent.filesParsed, 120);
    assert.equal(finalEvent.recordsLoaded, 120);
    assert.ok(progressEvents.length < 120);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer isolates source roots for the same provider", async () => {
  const fixture = await createFixture();
  const otherRoot = await mkdtemp(path.join(tmpdir(), "ai-code-usage-cache-source-b-"));
  try {
    await writeClaudeUsage(path.join(fixture.sourceRoot, "session.jsonl"), {
      sessionId: "fixture-root-a",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 1,
      outputTokens: 1,
    });
    await writeClaudeUsage(path.join(otherRoot, "session.jsonl"), {
      sessionId: "fixture-root-b",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 2,
      outputTokens: 1,
    });

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range });
    const second = await importer.loadForRange({ sources: [source(otherRoot, new CountingClaudeAdapter(otherRoot))], range });

    assert.deepEqual(
      second.imports[0]?.records.map((record) => record.sessionId),
      ["fixture-root-b"],
    );
  } finally {
    await fixture.dispose();
    await rm(otherRoot, { recursive: true, force: true });
  }
});

test("cached importer skips cold files dated after the range until a matching range needs them", async () => {
  const fixture = await createFixture();
  try {
    const futureDirectory = path.join(fixture.sourceRoot, "2026", "07", "10");
    await mkdir(futureDirectory, { recursive: true });
    const futureFile = path.join(futureDirectory, "rollout-2026-07-10T08-00-00-fixture-future.jsonl");
    await writeFile(
      futureFile,
      JSON.stringify({
        timestamp: "2026-07-10T08:00:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, output_tokens: 5 } } },
      }),
      "utf8",
    );
    const futureMtime = new Date("2026-07-10T09:00:00.000Z");
    await utimes(futureFile, futureMtime, futureMtime);

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const early = await importer.loadForRange({
      sources: [source("codex", fixture.sourceRoot, new CodexUsageAdapter(fixture.sourceRoot))],
      range: utcRange("2026-06-08", "2026-06-08"),
    });

    assert.equal(early.imports[0]?.records.length, 0);
    assert.equal(early.cache.historicalComplete, false);
    // A cold-skipped file is "not parsed yet", not "no data": the source summary must not read as empty.
    assert.deepEqual(early.sources[0], { provider: "codex", sourcePath: fixture.sourceRoot, files: 1, cachedRecords: 0, complete: false });

    const matching = await importer.loadForRange({
      sources: [source("codex", fixture.sourceRoot, new CodexUsageAdapter(fixture.sourceRoot))],
      range: utcRange("2026-07-10", "2026-07-10"),
    });

    assert.equal(matching.imports[0]?.records.length, 1);
    assert.deepEqual(matching.sources[0], { provider: "codex", sourcePath: fixture.sourceRoot, files: 1, cachedRecords: 1, complete: true });
  } finally {
    await fixture.dispose();
  }
});

test("cached importer skips cold files last written before the range start", async () => {
  const fixture = await createFixture();
  try {
    const usageFile = path.join(fixture.sourceRoot, "session.jsonl");
    await writeClaudeUsage(usageFile, {
      sessionId: "fixture-old-mtime",
      timestamp: "2026-03-01T01:00:00.000Z",
      inputTokens: 3,
      outputTokens: 1,
    });
    const oldMtime = new Date("2026-03-01T02:00:00.000Z");
    await utimes(usageFile, oldMtime, oldMtime);

    const adapter = new CountingClaudeAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const early = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range: utcRange("2026-05-01", "2026-05-01") });

    assert.equal(early.imports[0]?.records.length, 0);
    assert.equal(early.cache.historicalComplete, false);
    assert.equal(adapter.parseCount, 0);

    const widened = await importer.loadForRange({ sources: [source(fixture.sourceRoot, adapter)], range: utcRange("2026-03-01", "2026-05-01") });

    assert.equal(widened.imports[0]?.records.length, 1);
    assert.equal(adapter.parseCount, 1);
  } finally {
    await fixture.dispose();
  }
});

class SpyCodexAdapter extends CodexUsageAdapter {
  public appendedOutcomes: Array<boolean | undefined> = [];

  public override async importUsageFileWithState(filePath: string, prior?: unknown, readAt?: string) {
    const outcome = await super.importUsageFileWithState(filePath, prior, readAt);
    this.appendedOutcomes.push(outcome.appended);
    return outcome;
  }
}

function codexTokenCountLine(timestamp: string, total: { input: number; cached?: number; output: number }): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached ?? 0,
          output_tokens: total.output,
        },
      },
    },
  });
}

function codexTurnContextLine(timestamp: string, model: string): string {
  return JSON.stringify({ timestamp, type: "turn_context", payload: { model } });
}

test("cached importer appends grown codex rollouts incrementally with correct cumulative deltas", async () => {
  const fixture = await createFixture();
  try {
    const rolloutFile = path.join(fixture.sourceRoot, "rollout-2026-05-01T00-00-00-fixture-incremental.jsonl");
    await writeFile(
      rolloutFile,
      [codexTurnContextLine("2026-05-01T00:00:00.000Z", "gpt-test"), codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 100, output: 10 })].join("\n") + "\n",
      "utf8",
    );

    const adapter = new SpyCodexAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(first.imports[0]?.records.length, 1);
    assert.equal(first.imports[0]?.records[0]?.tokens.input, 100);

    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:02:00.000Z", { input: 250, output: 30 }) + "\n", { flag: "a" });

    const second = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(second.imports[0]?.records.length, 2);
    const tokens = second.imports[0]!.records.map((record) => record.tokens);
    assert.equal(tokens[0]?.input, 100);
    assert.equal(tokens[1]?.input, 150);
    assert.equal(tokens[1]?.output, 20);
    assert.equal(second.imports[0]?.records.every((record) => record.model === "gpt-test"), true);
    assert.equal(adapter.appendedOutcomes.at(-1), true);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer reparses the whole rollout when a new model invalidates the backfill", async () => {
  const fixture = await createFixture();
  try {
    const rolloutFile = path.join(fixture.sourceRoot, "rollout-2026-05-01T00-00-00-fixture-model-change.jsonl");
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 100, output: 10 }) + "\n", "utf8");

    const adapter = new SpyCodexAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(first.imports[0]?.records[0]?.model, undefined);

    await writeFile(
      rolloutFile,
      [codexTurnContextLine("2026-05-01T00:02:00.000Z", "gpt-late"), codexTokenCountLine("2026-05-01T00:03:00.000Z", { input: 180, output: 25 })].join("\n") + "\n",
      { flag: "a" },
    );

    const second = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(second.imports[0]?.records.length, 2);
    // Full reparse must retroactively backfill the first record with the late model.
    assert.equal(second.imports[0]?.records.every((record) => record.model === "gpt-late"), true);
    assert.equal(adapter.appendedOutcomes.at(-1), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer reparses fully when rollout history is rewritten", async () => {
  const fixture = await createFixture();
  try {
    const rolloutFile = path.join(fixture.sourceRoot, "rollout-2026-05-01T00-00-00-fixture-rewrite.jsonl");
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 100, output: 10 }) + "\n", "utf8");

    const adapter = new SpyCodexAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });

    // Rewrite history with different totals AND a larger size, so only the
    // tail-hash check can tell the difference.
    await writeFile(
      rolloutFile,
      [codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 40, output: 4 }), codexTokenCountLine("2026-05-01T00:02:00.000Z", { input: 90, output: 9 })].join("\n") + "\n",
      "utf8",
    );

    const second = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(second.imports[0]?.records.length, 2);
    assert.equal(second.imports[0]?.records[0]?.tokens.input, 40);
    assert.equal(second.imports[0]?.records[1]?.tokens.input, 50);
    assert.equal(adapter.appendedOutcomes.at(-1), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer handles rollouts without a trailing newline safely", async () => {
  const fixture = await createFixture();
  try {
    const rolloutFile = path.join(fixture.sourceRoot, "rollout-2026-05-01T00-00-00-fixture-no-newline.jsonl");
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 100, output: 10 }), "utf8");

    const adapter = new SpyCodexAdapter(fixture.sourceRoot);
    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");

    const first = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(first.imports[0]?.records.length, 1);

    await writeFile(rolloutFile, "\n" + codexTokenCountLine("2026-05-01T00:02:00.000Z", { input: 250, output: 30 }) + "\n", { flag: "a" });

    const second = await importer.loadForRange({ sources: [source("codex", fixture.sourceRoot, adapter)], range });
    assert.equal(second.imports[0]?.records.length, 2);
    assert.equal(second.imports[0]?.records[1]?.tokens.input, 150);
    // The first parse consumed an unterminated tail, so incremental resume is off.
    assert.equal(adapter.appendedOutcomes.at(-1), undefined);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer drops stale in-memory shards when another extension host writes the cache", async () => {
  const fixture = await createFixture();
  try {
    const rolloutFile = path.join(fixture.sourceRoot, "rollout-2026-05-01T00-00-00-fixture-multiwindow.jsonl");
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:01:00.000Z", { input: 100, output: 10 }) + "\n", "utf8");

    // Two importers sharing one cache directory simulate two VS Code windows.
    const windowA = new CachedUsageImporter(fixture.cacheRoot);
    const windowB = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    const sources = () => [source("codex", fixture.sourceRoot, new CodexUsageAdapter(fixture.sourceRoot))];

    await windowA.loadForRange({ sources: sources(), range });
    const bFirst = await windowB.loadForRange({ sources: sources(), range });
    assert.equal(bFirst.imports[0]?.records.length, 1);

    // Window A parses the appended tail and writes shards + index.
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:02:00.000Z", { input: 250, output: 30 }) + "\n", { flag: "a" });
    await windowA.loadForRange({ sources: sources(), range });

    // Window B must notice A's index write and reload from disk instead of
    // serving its stale in-memory shard.
    const bSecond = await windowB.loadForRange({ sources: sources(), range });
    assert.equal(bSecond.imports[0]?.records.length, 2);

    // Third append handled by B first: its incremental base must be the
    // authoritative on-disk state, preserving A's records.
    await writeFile(rolloutFile, codexTokenCountLine("2026-05-01T00:03:00.000Z", { input: 400, output: 45 }) + "\n", { flag: "a" });
    await windowB.loadForRange({ sources: sources(), range });
    const aThird = await windowA.loadForRange({ sources: sources(), range });
    assert.equal(aThird.imports[0]?.records.length, 3);
    assert.deepEqual(
      aThird.imports[0]?.records.map((record) => record.tokens.input),
      [100, 150, 150],
    );

    // A restart must see the same complete data from disk.
    const restarted = await new CachedUsageImporter(fixture.cacheRoot).loadForRange({ sources: sources(), range });
    assert.equal(restarted.imports[0]?.records.length, 3);
  } finally {
    await fixture.dispose();
  }
});

test("cached importer keeps the most recent days and reports truncation for ranges beyond the shard cap", async () => {
  const fixture = await createFixture();
  try {
    await writeClaudeUsage(path.join(fixture.sourceRoot, "session.jsonl"), {
      sessionId: "fixture-cap-recent",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 9,
      outputTokens: 3,
    });

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const huge = utcRange("2000-01-01", "2026-05-02");
    const result = await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range: huge });

    // Recent data must survive the cap; the truncation must be reported.
    assert.equal(result.imports[0]?.records.length, 1);
    assert.equal(result.cache.rangeComplete, false);
    assert.ok(result.imports[0]?.errors.some((error) => error.message.includes("most recent")));
  } finally {
    await fixture.dispose();
  }
});

test("cached importer does not rewrite index.json when nothing changed", async () => {
  const fixture = await createFixture();
  try {
    await writeClaudeUsage(path.join(fixture.sourceRoot, "session.jsonl"), {
      sessionId: "fixture-dirty-flag",
      timestamp: "2026-05-01T01:00:00.000Z",
      inputTokens: 2,
      outputTokens: 1,
    });

    const importer = new CachedUsageImporter(fixture.cacheRoot);
    const range = utcRange("2026-05-01", "2026-05-01");
    await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range });
    const before = await stat(path.join(fixture.cacheRoot, "index.json"));

    await importer.loadForRange({ sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))], range });
    const after = await stat(path.join(fixture.cacheRoot, "index.json"));

    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await fixture.dispose();
  }
});

class CountingClaudeAdapter extends ClaudeUsageAdapter {
  public parseCount = 0;

  public override async importUsageFile(filePath: string, readAt?: string) {
    this.parseCount += 1;
    return super.importUsageFile(filePath, readAt);
  }
}

/** Simulates a file that cannot be opened (EACCES/EIO) without touching its size or mtime. */
class FlakyClaudeAdapter extends CountingClaudeAdapter {
  public failReads = false;

  public override async importUsageFile(filePath: string, readAt?: string) {
    if (!this.failReads) {
      return super.importUsageFile(filePath, readAt);
    }
    this.parseCount += 1;
    return {
      provider: "claude" as const,
      records: [],
      warnings: [],
      errors: [{ severity: "error" as const, code: "file_unreadable", message: "EACCES: permission denied", sourcePath: filePath, provider: "claude" as const }],
      sourceMeta: [],
    };
  }
}

type Fixture = {
  sourceRoot: string;
  cacheRoot: string;
  dispose: () => Promise<void>;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ai-code-usage-cache-"));
  const sourceRoot = path.join(root, "source");
  const cacheRoot = path.join(root, "cache");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(cacheRoot, { recursive: true });
  return {
    sourceRoot,
    cacheRoot,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function source(sourceRoot: string, adapter: CountingClaudeAdapter): { provider: "claude"; sourcePath: string; adapter: JsonUsageAdapter };
function source(provider: "claude", sourceRoot: string, adapter: CountingClaudeAdapter): { provider: "claude"; sourcePath: string; adapter: JsonUsageAdapter };
function source(provider: "codex", sourceRoot: string, adapter: CodexUsageAdapter): { provider: "codex"; sourcePath: string; adapter: JsonUsageAdapter };
function source(
  providerOrSourceRoot: "claude" | "codex" | string,
  sourceRootOrAdapter: string | JsonUsageAdapter,
  adapter?: JsonUsageAdapter,
) {
  const provider = adapter ? (providerOrSourceRoot as "claude" | "codex") : "claude";
  const sourceRoot = adapter ? (sourceRootOrAdapter as string) : providerOrSourceRoot;
  return {
    provider,
    sourcePath: sourceRoot,
    adapter: adapter ?? (sourceRootOrAdapter as JsonUsageAdapter),
  };
}

function utcRange(start: string, end: string) {
  return new TimeRangeService(() => new Date(`${end}T12:00:00.000Z`), resolveTimeZone("utc")).resolve("custom", { start, end });
}

async function writeClaudeUsage(filePath: string, input: { sessionId: string; timestamp: string; inputTokens: number; outputTokens: number }): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, claudeUsageLine(input), "utf8");
}

function claudeUsageLine(input: { sessionId: string; timestamp: string; inputTokens: number; outputTokens: number }): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    sessionId: input.sessionId,
    message: {
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
      },
    },
  });
}

async function readShard(cacheRoot: string, shardKey: string): Promise<Array<{ record: Record<string, unknown> }>> {
  return JSON.parse(await readFile(path.join(cacheRoot, "records", "claude", `${shardKey}.json`), "utf8")) as Array<{
    record: Record<string, unknown>;
  }>;
}
