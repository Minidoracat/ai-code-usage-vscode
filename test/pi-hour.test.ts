import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PiUsageAdapter } from "../src/adapters/PiUsageAdapter";
import { makeZonedHourBucketer, zonedDateTimeHourToUtcIso, zonedHourKey } from "../src/services/TimeZoneService";
import { TimeRangeService } from "../src/services/TimeRangeService";
import { UsageAggregator } from "../src/services/UsageAggregator";
import type { TimeRange, TimeZoneState } from "../src/domain/types";

const zone: TimeZoneState = { mode: "custom", systemTimeZone: "UTC", customTimeZone: "Asia/Shanghai", resolvedTimeZone: "Asia/Shanghai", label: "Asia/Shanghai", offsetLabel: "UTC+08:00" };

test("pi adapter imports pi session records with real billed cost", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ai-code-usage-pi-"));
  const file = path.join(dir, "session.jsonl");
  const lines = [
    { type: "message", id: "m1", parentId: "p1", timestamp: "2026-08-08T02:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: "2026-08-08T02:01:00.000Z",
      message: {
        role: "assistant",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
        usage: { input: 1000, output: 200, cacheRead: 5000, cacheWrite: 300, reasoning: 100, totalTokens: 6600, cost: { input: 0.00014, output: 0.000056, cacheRead: 0.000014, cacheWrite: 0.000042, total: 0.000252 } },
        timestamp: 1786137660000,
      },
    },
    { type: "session_info", id: "s1", parentId: "p1", timestamp: "2026-08-08T02:02:00.000Z", name: "测试会话" },
  ];
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  try {
    const result = await new PiUsageAdapter(file).importUsage();
    assert.equal(result.provider, "pi");
    assert.equal(result.errors.length, 0);
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record?.model, "deepseek-v4-flash");
    assert.equal(record?.tokens.input, 1000);
    assert.equal(record?.tokens.output, 200);
    assert.equal(record?.tokens.cacheRead, 5000);
    // pi "cacheWrite" bucket maps to cacheWrite5m so cache-write tokens survive.
    assert.equal(record?.tokens.cacheWrite5m, 300);
    // Real provider-billed cost is imported as-is.
    assert.deepEqual(record?.cost, { amount: 0.000252, currency: "USD", source: "imported" });
    assert.equal(record?.startedAt, "2026-08-08T02:01:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hour bucketer covers a local day with 24 hourly buckets", () => {
  const start = "2026-08-07T16:00:00.000Z"; // 2026-08-08 00:00 +08:00
  const end = "2026-08-08T15:59:59.999Z"; // 2026-08-08 23:59:59 +08:00
  const bucketOf = makeZonedHourBucketer(start, end, "Asia/Shanghai");
  const keys = new Set<string>();
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 30 * 60_000) {
    keys.add(bucketOf(ms));
  }
  assert.equal(keys.size, 24);
  assert.equal([...keys].sort()[0], "2026-08-08T00+08:00");
  assert.equal([...keys].sort().at(-1), "2026-08-08T23+08:00");
  assert.equal(bucketOf(Date.parse("2026-08-08T02:30:00+08:00")), "2026-08-08T02+08:00");
  // Outside the precomputed window falls back to the direct hour key.
  assert.equal(bucketOf(Date.parse("2026-08-07T15:00:00Z")), "2026-08-07T23+08:00");
});

test("hour key to ISO conversion honors the local time zone", () => {
  assert.equal(zonedDateTimeHourToUtcIso("2026-08-07T18", "start", "Asia/Shanghai"), "2026-08-07T10:00:00.000Z");
  assert.equal(zonedDateTimeHourToUtcIso("2026-08-08T18", "end", "Asia/Shanghai"), "2026-08-08T10:59:59.999Z");
  assert.equal(zonedDateTimeHourToUtcIso("2026-08-08T25", "start", "Asia/Shanghai"), undefined);
  assert.equal(zonedDateTimeHourToUtcIso("2026-08-08", "start", "Asia/Shanghai"), undefined);
  assert.equal(zonedHourKey(Date.parse("2026-08-08T02:30:00+08:00"), "Asia/Shanghai"), "2026-08-08T02+08:00");
  // A real calendar date is required, not just the "YYYY-MM-DDTHH" shape.
  assert.equal(zonedDateTimeHourToUtcIso("2020-02-30T12", "start", "Asia/Shanghai"), undefined);
  assert.equal(zonedDateTimeHourToUtcIso("2021-02-29T12", "start", "Asia/Shanghai"), undefined);
  assert.equal(zonedDateTimeHourToUtcIso("2020-13-01T10", "start", "Asia/Shanghai"), undefined);
  assert.equal(zonedDateTimeHourToUtcIso("2020-01-01T24", "start", "Asia/Shanghai"), undefined);
});

test("custom range accepts hour boundaries (yesterday 18:00 -> today 18:00)", () => {
  const service = new TimeRangeService(() => new Date("2026-08-08T15:00:00+08:00"), zone);
  const range = service.resolve("custom", { start: "2026-08-07T18", end: "2026-08-08T18" });
  assert.equal(range.start, "2026-08-07T10:00:00.000Z");
  assert.equal(range.end, "2026-08-08T10:59:59.999Z");
  assert.equal(range.startDate, "2026-08-07");
  assert.equal(range.endDate, "2026-08-08");
  assert.equal(range.startHour, "18");
  assert.equal(range.endHour, "18");
  // Whole-day custom ranges keep day semantics and no hour echo.
  const dayRange = service.resolve("custom", { start: "2026-08-06", end: "2026-08-08" });
  assert.equal(dayRange.start, "2026-08-05T16:00:00.000Z");
  assert.equal(dayRange.end, "2026-08-08T15:59:59.999Z");
  assert.equal(dayRange.startHour, undefined);
  assert.equal(dayRange.endHour, undefined);
});

test("aggregator picks hourly granularity for <=48h ranges and reports it", () => {
  const aggregator = new UsageAggregator();
  const range: TimeRange = { kind: "custom", startDate: "2026-08-07", endDate: "2026-08-08", start: "2026-08-07T10:00:00.000Z", end: "2026-08-08T10:59:59.999Z", timeZone: zone, startHour: "18", endHour: "18" };
  const imports = [{
    provider: "pi" as const,
    records: [
      {
        provider: "pi" as const,
        model: "deepseek-v4-flash",
        startedAt: "2026-08-08T02:30:00.000Z",
        observedAt: "2026-08-08T02:30:00.000Z",
        tokens: { input: 100, output: 10 },
        source: { sourcePath: "cache:x", sourceKind: "jsonl" as const, parserVersion: "v", readAt: "2026-08-08T02:30:00.000Z" },
      },
    ],
    warnings: [],
    errors: [],
    sourceMeta: [],
  }];
  const summary = aggregator.aggregate(imports, range, "all");
  assert.equal(summary.trendGranularity, "hour");
  assert.equal(summary.trend.length, 1);
  assert.equal(summary.trend[0]?.bucket, "2026-08-08T10+08:00"); // 02:30Z = 10:30 +08:00
  assert.ok(summary.providerSplit.some((item) => item.provider === "pi"));

  const weekRange: TimeRange = { kind: "thisWeek", startDate: "2026-08-04", endDate: "2026-08-08", start: "2026-08-03T16:00:00.000Z", end: "2026-08-08T15:59:59.999Z", timeZone: zone };
  const weekSummary = aggregator.aggregate(imports, weekRange, "all");
  assert.equal(weekSummary.trendGranularity, "day");
});

test("DST fall-back keeps the two repeated local hours in separate buckets", () => {
  const newYork: TimeZoneState = { mode: "custom", systemTimeZone: "UTC", customTimeZone: "America/New_York", resolvedTimeZone: "America/New_York", label: "America/New_York", offsetLabel: "UTC-04:00" };
  const range: TimeRange = { kind: "custom", startDate: "2026-11-01", endDate: "2026-11-01", start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:59:59.999Z", timeZone: newYork };
  const record = (startedAt: string) => ({
    provider: "pi" as const,
    model: "deepseek-v4-flash",
    startedAt,
    observedAt: startedAt,
    tokens: { input: 100, output: 10 },
    source: { sourcePath: "cache:x", sourceKind: "jsonl" as const, parserVersion: "v", readAt: startedAt },
  });
  const imports = [{
    provider: "pi" as const,
    // 01:30 EDT (-04:00) and 01:30 EST (-05:00): same wall clock, different instants.
    records: [record("2026-11-01T05:30:00.000Z"), record("2026-11-01T06:30:00.000Z")],
    warnings: [],
    errors: [],
    sourceMeta: [],
  }];

  const summary = new UsageAggregator().aggregate(imports, range, "all");
  assert.equal(summary.trendGranularity, "hour");
  assert.deepEqual(summary.trend.map((item) => item.bucket), ["2026-11-01T01-04:00", "2026-11-01T01-05:00"]);
  assert.deepEqual(summary.trend.map((item) => item.records), [1, 1]);
});

test("custom range rejects hour keys with an impossible calendar date", () => {
  const service = new TimeRangeService(() => new Date("2026-08-08T15:00:00+08:00"), zone);
  const range = service.resolve("custom", { start: "2020-02-30T12", end: "2026-08-08T18" });
  // Falls back to today's local start instead of resolving the bogus key.
  assert.equal(range.startDate, "2026-08-08");
  assert.equal(range.start, "2026-08-07T16:00:00.000Z");
  assert.equal(range.startHour, undefined);
});
