import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { AdapterImportResult, PricingCatalog, UsageRecord } from "../src/domain/types";
import { PricingService } from "../src/services/PricingService";
import { UsageAggregator } from "../src/services/UsageAggregator";
import { TimeRangeService } from "../src/services/TimeRangeService";
import { resolveTimeZone } from "../src/services/TimeZoneService";

test("aggregator builds totals, splits, trend, and session rollups", () => {
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("thisWeek");
  const summary = new UsageAggregator().aggregate([importResult(records())], range);

  assert.equal(summary.totals.records, 3);
  assert.equal(summary.totals.sessions, 2);
  assert.equal(summary.totals.tokens.input, 300);
  assert.equal(summary.providerSplit.find((item) => item.provider === "claude")?.records, 2);
  assert.equal(summary.providerSplit.find((item) => item.provider === "codex")?.records, 1);
  assert.equal(summary.modelSplit[0]?.model, "claude-sonnet-4-6");
  assert.equal(summary.modelSplit[0]?.tokens.output, 50);
  assert.equal(summary.modelSplit[0]?.tokens.cacheRead, 10);
  assert.equal(summary.modelSplit[0]?.tokens.cacheWrite5m, 40);
  assert.equal(summary.modelSplit[0]?.tokens.cacheWrite1h, 60);
  assert.equal(summary.trend.length, 2);
  assert.equal(summary.sessions.length, 2);
  assert.equal(summary.sessions.find((session) => session.sessionId === "a")?.tokens.cacheWrite1h, 60);
  assert.equal(summary.sessions.find((session) => session.sessionId === "b")?.tokens.cachedInput, 50);
});

test("custom range filters records inclusively", () => {
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("custom", {
    start: "2026-04-30",
    end: "2026-04-30",
  });
  const summary = new UsageAggregator().aggregate([importResult(records())], range);

  assert.equal(summary.totals.records, 2);
  assert.equal(summary.providerSplit.find((item) => item.provider === "claude")?.records, 1);
});

test("quick ranges resolve by selected time zone", () => {
  const timeZone = resolveTimeZone("custom", "Asia/Taipei");
  const range = new TimeRangeService(() => new Date("2026-04-30T17:00:00.000Z"), timeZone).resolve("today");

  assert.equal(range.startDate, "2026-05-01");
  assert.equal(range.endDate, "2026-05-01");
  assert.equal(range.start, "2026-04-30T16:00:00.000Z");
  assert.equal(range.end, "2026-05-01T15:59:59.999Z");
  assert.equal(range.timeZone.resolvedTimeZone, "Asia/Taipei");
});

test("calendar quick ranges resolve from selected time zone date boundaries", () => {
  const timeZone = resolveTimeZone("custom", "Asia/Taipei");
  const service = new TimeRangeService(() => new Date("2026-05-10T02:00:00.000Z"), timeZone);

  const yesterday = service.resolve("yesterday");
  assert.equal(yesterday.startDate, "2026-05-09");
  assert.equal(yesterday.endDate, "2026-05-09");
  assert.equal(yesterday.start, "2026-05-08T16:00:00.000Z");
  assert.equal(yesterday.end, "2026-05-09T15:59:59.999Z");

  const thisWeek = service.resolve("thisWeek");
  assert.equal(thisWeek.startDate, "2026-05-04");
  assert.equal(thisWeek.endDate, "2026-05-10");
  assert.equal(thisWeek.start, "2026-05-03T16:00:00.000Z");
  assert.equal(thisWeek.end, "2026-05-10T15:59:59.999Z");

  const lastWeek = service.resolve("lastWeek");
  assert.equal(lastWeek.startDate, "2026-04-27");
  assert.equal(lastWeek.endDate, "2026-05-03");
  assert.equal(lastWeek.start, "2026-04-26T16:00:00.000Z");
  assert.equal(lastWeek.end, "2026-05-03T15:59:59.999Z");

  const lastMonth = service.resolve("lastMonth");
  assert.equal(lastMonth.startDate, "2026-04-01");
  assert.equal(lastMonth.endDate, "2026-04-30");
  assert.equal(lastMonth.start, "2026-03-31T16:00:00.000Z");
  assert.equal(lastMonth.end, "2026-04-30T15:59:59.999Z");
});

test("utc ranges stay on utc calendar days", () => {
  const service = new TimeRangeService(() => new Date("2026-05-10T02:00:00.000Z"), resolveTimeZone("utc"));
  const range = service.resolve("today");

  assert.equal(range.startDate, "2026-05-10");
  assert.equal(range.start, "2026-05-10T00:00:00.000Z");
  assert.equal(range.end, "2026-05-10T23:59:59.999Z");

  const thisWeek = service.resolve("thisWeek");
  assert.equal(thisWeek.startDate, "2026-05-04");
  assert.equal(thisWeek.endDate, "2026-05-10");
  assert.equal(thisWeek.start, "2026-05-04T00:00:00.000Z");
  assert.equal(thisWeek.end, "2026-05-10T23:59:59.999Z");
});

test("trend buckets use selected time zone date keys", () => {
  const source = {
    sourcePath: "fixture",
    sourceKind: "json" as const,
    parserVersion: "test",
    readAt: "2026-04-30T17:00:00.000Z",
  };
  const range = new TimeRangeService(() => new Date("2026-04-30T17:00:00.000Z"), resolveTimeZone("custom", "Asia/Taipei")).resolve("today");
  const summary = new UsageAggregator().aggregate([
    importResult([
      {
        provider: "codex",
        model: "gpt-5.5",
        sessionId: "tz",
        startedAt: "2026-04-30T17:00:00.000Z",
        observedAt: "2026-04-30T17:00:00.000Z",
        tokens: { input: 1 },
        source,
      },
    ]),
  ], range);

  assert.equal(summary.totals.records, 1);
  assert.equal(summary.trend[0]?.bucket, "2026-05-01T01+08:00"); // today is hourly now
});

test("empty input returns zero totals", () => {
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("today");
  const summary = new UsageAggregator().aggregate([], range);

  assert.equal(summary.totals.records, 0);
  assert.equal(summary.totals.sessions, 0);
  assert.equal(summary.providerSplit.length, 3);
});

test("provider filter limits totals to selected provider", () => {
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("thisWeek");
  const summary = new UsageAggregator().aggregate([importResult(records())], range, "claude");

  assert.equal(summary.providerFilter, "claude");
  assert.equal(summary.totals.records, 2);
  assert.equal(summary.providerSplit.find((item) => item.provider === "claude")?.records, 2);
  assert.equal(summary.providerSplit.find((item) => item.provider === "codex")?.records, 0);
  assert.equal(summary.sessions.every((session) => session.provider === "claude"), true);
});

test("mixed cost currencies do not produce misleading total cost", () => {
  const source = {
    sourcePath: "fixture",
    sourceKind: "json" as const,
    parserVersion: "test",
    readAt: "2026-04-30T12:00:00.000Z",
  };
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("thisWeek");
  const summary = new UsageAggregator().aggregate([
    importResult([
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        sessionId: "claude",
        startedAt: "2026-04-30T12:00:00.000Z",
        observedAt: "2026-04-30T12:00:00.000Z",
        tokens: { input: 1 },
        cost: { amount: 1, currency: "USD", source: "imported" },
        source,
      },
      {
        provider: "codex",
        model: "gpt-5.5",
        sessionId: "codex",
        startedAt: "2026-04-30T12:00:00.000Z",
        observedAt: "2026-04-30T12:00:00.000Z",
        tokens: { input: 1 },
        cost: { amount: 1, currency: "credits", source: "imported" },
        source,
      },
    ]),
  ], range);

  assert.equal(summary.totals.cost, undefined);
  assert.equal(summary.providerSplit.find((item) => item.provider === "claude")?.cost?.currency, "USD");
  assert.equal(summary.providerSplit.find((item) => item.provider === "codex")?.cost?.currency, "credits");
});

test("partial cost coverage is marked on cost totals", () => {
  const source = {
    sourcePath: "fixture",
    sourceKind: "json" as const,
    parserVersion: "test",
    readAt: "2026-04-30T12:00:00.000Z",
  };
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("thisWeek");
  const summary = new UsageAggregator().aggregate([
    importResult([
      {
        provider: "codex",
        model: "gpt-5.5",
        sessionId: "priced",
        startedAt: "2026-04-30T12:00:00.000Z",
        observedAt: "2026-04-30T12:00:00.000Z",
        tokens: { input: 1 },
        cost: { amount: 1, currency: "USD", source: "imported" },
        source,
      },
      {
        provider: "codex",
        model: "future-model",
        sessionId: "unpriced",
        startedAt: "2026-04-30T12:00:00.000Z",
        observedAt: "2026-04-30T12:00:00.000Z",
        tokens: { input: 1 },
        source,
      },
    ]),
  ], range);

  assert.equal(summary.totals.cost?.amount, 1);
  assert.equal(summary.totals.cost?.currency, "USD");
  assert.equal(summary.totals.cost?.note, "partial");
});

test("aggregator keeps long-context pricing per record instead of repricing the session total", async () => {
  const catalog = JSON.parse(await readFile("src/pricing/catalog.json", "utf8")) as PricingCatalog;
  const range = new TimeRangeService(() => new Date("2026-04-30T12:00:00.000Z")).resolve("thisWeek");
  const source = {
    sourcePath: "fixture",
    sourceKind: "json" as const,
    parserVersion: "test",
    readAt: "2026-04-30T12:00:00.000Z",
  };
  const records = ["2026-04-30T12:00:00.000Z", "2026-04-30T12:01:00.000Z"].map(
    (timestamp): UsageRecord => ({
      provider: "codex",
      model: "gpt-5.6-sol",
      sessionId: "same-session",
      startedAt: timestamp,
      observedAt: timestamp,
      tokens: { input: 200_000 },
      source,
    }),
  );
  const summary = new UsageAggregator(new PricingService(catalog)).aggregate(
    [{ provider: "codex", records, warnings: [], errors: [], sourceMeta: [] }],
    range,
  );

  assert.equal(summary.totals.tokens.input, 400_000);
  assert.equal(summary.totals.cost?.amount, 2);
  assert.equal(summary.sessions[0]?.cost?.amount, 2);
});

function records(): UsageRecord[] {
  const source = {
    sourcePath: "fixture",
    sourceKind: "json" as const,
    parserVersion: "test",
    readAt: "2026-04-30T12:00:00.000Z",
  };
  return [
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      sessionId: "a",
      startedAt: "2026-04-29T12:00:00.000Z",
      observedAt: "2026-04-29T12:00:00.000Z",
      tokens: { input: 100, output: 20, cacheRead: 10 },
      source,
    },
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      sessionId: "a",
      startedAt: "2026-04-30T12:00:00.000Z",
      observedAt: "2026-04-30T12:00:00.000Z",
      tokens: { input: 100, output: 30, cacheWrite5m: 40, cacheWrite1h: 60 },
      source,
    },
    {
      provider: "codex",
      model: "gpt-5.5",
      sessionId: "b",
      startedAt: "2026-04-30T15:00:00.000Z",
      observedAt: "2026-04-30T15:00:00.000Z",
      tokens: { input: 100, cachedInput: 50, output: 25 },
      source,
    },
  ];
}

function importResult(input: UsageRecord[]): AdapterImportResult {
  return {
    provider: "claude",
    records: input,
    warnings: [],
    errors: [],
    sourceMeta: [],
  };
}
