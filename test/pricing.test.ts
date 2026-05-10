import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { PricingCatalog, UsageRecord } from "../src/domain/types";
import { PricingService, validatePricingMetadata } from "../src/services/PricingService";

test("pricing calculates known Codex model with cached input", async () => {
  const pricing = new PricingService(await catalog());
  const estimate = pricing.estimate(record("codex", "gpt-5.5", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 35.5);
    assert.equal(estimate.cost.source, "calculated");
  }
});

test("pricing calculates known Claude model cache categories", async () => {
  const pricing = new PricingService(await catalog());
  const estimate = pricing.estimate(record("claude", "Claude Sonnet 4.6", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }));

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 18.3);
  }
});

test("current catalog prices Claude Code snapshot model ids", async () => {
  const pricing = new PricingService(await srcCatalog());
  const haiku = pricing.estimate(record("claude", "claude-haiku-4-5-20251001", { input: 1_000_000, output: 1_000_000 }));
  const opus = pricing.estimate(record("claude", "claude-opus-4-5-20251101", { input: 1_000_000, output: 1_000_000 }));
  const sonnet = pricing.estimate(record("claude", "claude-sonnet-4-5-20250929", { input: 1_000_000, output: 1_000_000 }));

  assert.equal(haiku.available, true);
  assert.equal(opus.available, true);
  assert.equal(sonnet.available, true);
  if (haiku.available && opus.available && sonnet.available) {
    assert.equal(haiku.cost.amount, 6);
    assert.equal(opus.cost.amount, 30);
    assert.equal(sonnet.cost.amount, 18);
  }
});

test("current catalog prices Codex as API equivalent USD", async () => {
  const pricing = new PricingService(await srcCatalog());
  const gpt55 = pricing.estimate(record("codex", "gpt-5.5", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));
  const autoReview = pricing.estimate(record("codex", "codex-auto-review", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));

  assert.equal(gpt55.available, true);
  assert.equal(autoReview.available, true);
  if (gpt55.available && autoReview.available) {
    assert.equal(gpt55.cost.amount, 35.5);
    assert.equal(gpt55.cost.currency, "USD");
    assert.equal(autoReview.cost.amount, 15.925);
    assert.equal(autoReview.cost.currency, "USD");
  }
});

test("unknown model without imported cost is unavailable", async () => {
  const pricing = new PricingService(await catalog());
  const estimate = pricing.estimate(record("codex", "future-model", { input: 100 }));

  assert.equal(estimate.available, false);
  if (!estimate.available) {
    assert.equal(estimate.reason, "unknown_model");
  }
});

test("imported source cost is preserved", async () => {
  const pricing = new PricingService(await catalog());
  const estimate = pricing.estimate({
    ...record("codex", "future-model", { input: 100 }),
    cost: { amount: 0.25, currency: "USD", source: "imported" },
  });

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 0.25);
    assert.equal(estimate.cost.source, "imported");
  }
});

test("old pricing checkedAt still calculates because packaged catalogs do not expire", async () => {
  const oldCatalog = { ...(await catalog()), checkedAt: "2026-01-01T00:00:00.000Z" };
  const pricing = new PricingService(oldCatalog);
  const estimate = pricing.estimate(record("codex", "gpt-5.5", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 35.5);
  }
});

test("pricing snapshots are selected by usage timestamp when effective dates are present", async () => {
  const baseCatalog = await catalog();
  const baseRule = baseCatalog.rules[0];
  assert.ok(baseRule);
  const snapshotCatalog: PricingCatalog = {
    ...baseCatalog,
    rules: [
      {
        ...baseRule,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-05-01T00:00:00.000Z",
        rates: { input: 1, output: 2 },
      },
      {
        ...baseRule,
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        rates: { input: 10, output: 20 },
      },
    ],
  };
  const pricing = new PricingService(snapshotCatalog);
  const oldEstimate = pricing.estimate(
    record("codex", "gpt-5.5", { input: 1_000_000, output: 1_000_000 }, "2026-04-30T00:00:00.000Z"),
  );
  const newEstimate = pricing.estimate(
    record("codex", "gpt-5.5", { input: 1_000_000, output: 1_000_000 }, "2026-05-02T00:00:00.000Z"),
  );

  assert.equal(oldEstimate.available, true);
  assert.equal(newEstimate.available, true);
  if (oldEstimate.available && newEstimate.available) {
    assert.equal(oldEstimate.cost.amount, 3);
    assert.equal(newEstimate.cost.amount, 30);
  }
});

test("pricing timestamp selection skips malformed startedAt and falls back to observedAt", async () => {
  const baseCatalog = await catalog();
  const baseRule = baseCatalog.rules[0];
  assert.ok(baseRule);
  const pricing = new PricingService({
    ...baseCatalog,
    rules: [
      {
        ...baseRule,
        effectiveFrom: "2026-05-01T00:00:00.000Z",
        rates: { input: 10, output: 20 },
      },
    ],
  });
  const malformedStartedAt = {
    ...record("codex", "gpt-5.5", { input: 1_000_000, output: 1_000_000 }, "2026-05-02T00:00:00.000Z"),
    startedAt: "not-a-date",
  };
  const estimate = pricing.estimate(malformedStartedAt);

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 30);
  }
});

test("pricing metadata rejects malformed rule periods", async () => {
  const baseCatalog = await catalog();
  const baseRule = baseCatalog.rules[0];
  assert.ok(baseRule);
  const result = validatePricingMetadata({
    ...baseCatalog,
    rules: [
      {
        ...baseRule,
        effectiveFrom: null as unknown as string,
      },
    ],
  });

  assert.deepEqual(result, { ok: false, reason: "missing_pricing_metadata" });
});

async function catalog(): Promise<PricingCatalog> {
  return JSON.parse(await readFile("test/fixtures/pricing/catalog.json", "utf8")) as PricingCatalog;
}

async function srcCatalog(): Promise<PricingCatalog> {
  return JSON.parse(await readFile("src/pricing/catalog.json", "utf8")) as PricingCatalog;
}

function record(
  provider: "claude" | "codex",
  model: string,
  tokens: UsageRecord["tokens"],
  timestamp = "2026-04-30T00:00:00.000Z",
): UsageRecord {
  return {
    provider,
    model,
    sessionId: "pricing-test",
    startedAt: timestamp,
    observedAt: timestamp,
    tokens,
    source: {
      sourcePath: "pricing-test",
      sourceKind: "json",
      parserVersion: "test",
      readAt: timestamp,
    },
  };
}
