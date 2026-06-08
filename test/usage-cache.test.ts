import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("cached importer surfaces corrupt cache shards instead of silently dropping usage", async () => {
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

    assert.equal(result.cache.rangeComplete, false);
    assert.ok(result.imports[0]?.errors.some((error) => error.code === "cache_read_failed"));

    const repaired = await importer.loadForRange({
      sources: [source(fixture.sourceRoot, new CountingClaudeAdapter(fixture.sourceRoot))],
      range,
      forceReparse: true,
    });

    assert.equal(repaired.cache.rangeComplete, true);
    assert.equal(repaired.imports[0]?.records.length, 1);
    assert.equal(repaired.imports[0]?.errors.some((error) => error.code === "cache_read_failed"), false);
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

class CountingClaudeAdapter extends ClaudeUsageAdapter {
  public parseCount = 0;

  public override async importUsageFile(filePath: string, readAt?: string) {
    this.parseCount += 1;
    return super.importUsageFile(filePath, readAt);
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
