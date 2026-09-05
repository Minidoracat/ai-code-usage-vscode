import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PricingCatalog, PricingRule, UsageRecord } from "../src/domain/types";
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

test("current catalog prices Claude Opus 4.8 by id and display name", async () => {
  const pricing = new PricingService(await srcCatalog());
  const byId = pricing.estimate(record("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000 }));
  const byName = pricing.estimate(record("claude", "Claude Opus 4.8", { input: 1_000_000, output: 1_000_000 }));

  assert.equal(byId.available, true);
  assert.equal(byName.available, true);
  if (byId.available && byName.available) {
    assert.equal(byId.cost.amount, 30);
    assert.equal(byName.cost.amount, 30);
  }
});

test("current catalog prices Claude Opus 5 aliases and cache categories", async () => {
  const pricing = new PricingService(await srcCatalog());
  const tokens = {
    input: 1_000_000,
    output: 1_000_000,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
    cacheRead: 1_000_000,
  };
  const estimates = ["claude-opus-5", "Claude Opus 5", "claude-opus-5[1m]"].map((model) =>
    pricing.estimate(record("claude", model, tokens)),
  );

  for (const estimate of estimates) {
    assert.equal(estimate.available, true);
    if (estimate.available) {
      assert.equal(estimate.cost.amount, 46.75);
    }
  }
});

test("current catalog prices Claude Fable 5 by id and display name", async () => {
  const pricing = new PricingService(await srcCatalog());
  const byId = pricing.estimate(record("claude", "claude-fable-5", { input: 1_000_000, output: 1_000_000 }));
  const byName = pricing.estimate(record("claude", "Claude Fable 5", { input: 1_000_000, output: 1_000_000 }));

  assert.equal(byId.available, true);
  assert.equal(byName.available, true);
  if (byId.available && byName.available) {
    assert.equal(byId.cost.amount, 60);
    assert.equal(byName.cost.amount, 60);
  }
});

test("current catalog prices Claude Fable 5 cache categories", async () => {
  const pricing = new PricingService(await srcCatalog());
  const estimate = pricing.estimate(record("claude", "claude-fable-5", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }));

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 61);
  }
});

test("pricing preserves Claude cache write categories", async () => {
  const pricing = new PricingService(await catalog());
  const estimate = pricing.estimate(
    record("claude", "Claude Sonnet 4.6", { cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 }),
  );

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 9.75);
  }
});

test("current catalog prices Claude Sonnet 5 with introductory rates through 2026-08-31", async () => {
  const pricing = new PricingService(await srcCatalog());
  const intro = pricing.estimate(record("claude", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 }, "2026-07-15T00:00:00.000Z"));
  const introCache = pricing.estimate(
    record("claude", "Claude Sonnet 5", { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 }, "2026-07-15T00:00:00.000Z"),
  );

  assert.equal(intro.available, true);
  assert.equal(introCache.available, true);
  if (intro.available && introCache.available) {
    assert.equal(intro.cost.amount, 12);
    assert.equal(introCache.cost.amount, 12.2);
  }
});

test("current catalog prices Claude Sonnet 5 at standard rates from 2026-09-01", async () => {
  const pricing = new PricingService(await srcCatalog());
  const standard = pricing.estimate(record("claude", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 }, "2026-09-02T00:00:00.000Z"));
  const longContext = pricing.estimate(record("claude", "claude-sonnet-5[1m]", { input: 1_000_000, output: 1_000_000 }, "2026-09-02T00:00:00.000Z"));

  assert.equal(standard.available, true);
  assert.equal(longContext.available, true);
  if (standard.available && longContext.available) {
    assert.equal(standard.cost.amount, 18);
    assert.equal(longContext.cost.amount, 18);
  }
});

test("Claude Sonnet 5 rate switch happens exactly at 2026-09-01T00:00:00Z", async () => {
  const pricing = new PricingService(await srcCatalog());
  const lastIntroInstant = pricing.estimate(
    record("claude", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 }, "2026-08-31T23:59:59.999Z"),
  );
  const boundaryInstant = pricing.estimate(
    record("claude", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 }, "2026-09-01T00:00:00.000Z"),
  );

  assert.equal(lastIntroInstant.available, true);
  assert.equal(boundaryInstant.available, true);
  if (lastIntroInstant.available && boundaryInstant.available) {
    assert.equal(lastIntroInstant.cost.amount, 12);
    assert.equal(boundaryInstant.cost.amount, 18);
  }
});

test("undated models keep pricing through the rule cache when dated rules exist elsewhere", async () => {
  const pricing = new PricingService(await srcCatalog());
  const first = pricing.estimate(record("claude", "claude-opus-4-8", { input: 1_000_000, output: 1_000_000 }));
  const second = pricing.estimate(record("claude", "claude-opus-4-8", { input: 2_000_000, output: 2_000_000 }));
  const sonnet = pricing.estimate(record("claude", "claude-sonnet-5", { input: 1_000_000, output: 1_000_000 }, "2026-07-15T00:00:00.000Z"));

  assert.equal(first.available, true);
  assert.equal(second.available, true);
  assert.equal(sonnet.available, true);
  if (first.available && second.available && sonnet.available) {
    assert.equal(first.cost.amount, 30);
    assert.equal(second.cost.amount, 60);
    assert.equal(sonnet.cost.amount, 12);
  }

  // White-box: the memoized cache must hold the undated key and never the dated one,
  // otherwise a stale cached rule could serve the wrong dated rate.
  const ruleCache = (pricing as unknown as { ruleCache: Map<string, unknown> }).ruleCache;
  assert.equal(ruleCache.has("claude:claude-opus-4-8"), true);
  assert.equal(ruleCache.has("claude:claude-sonnet-5"), false);
});

test("current catalog prices Claude Mythos 5 by id", async () => {
  const pricing = new PricingService(await srcCatalog());
  const estimate = pricing.estimate(record("claude", "claude-mythos-5", { input: 1_000_000, output: 1_000_000 }));

  assert.equal(estimate.available, true);
  if (estimate.available) {
    assert.equal(estimate.cost.amount, 60);
  }
});

test("current catalog prices Codex as API equivalent USD", async () => {
  const pricing = new PricingService(await srcCatalog());
  const gpt55 = pricing.estimate(record("codex", "gpt-5.5", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));
  const autoReview = pricing.estimate(record("codex", "codex-auto-review", { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }));

  assert.equal(gpt55.available, true);
  assert.equal(autoReview.available, true);
  if (gpt55.available && autoReview.available) {
    assert.equal(gpt55.cost.amount, 56);
    assert.equal(gpt55.cost.currency, "USD");
    assert.equal(autoReview.cost.amount, 15.925);
    assert.equal(autoReview.cost.currency, "USD");
  }
});

test("current catalog prices GPT-5.6 canonical ids and alias", async () => {
  const pricing = new PricingService(await srcCatalog());
  for (const [model, baseAmount, longAmount] of [
    ["gpt-5.6-sol", 0.4, 38.8],
    ["gpt-5.6-terra", 0.2, 22.4],
    ["gpt-5.6-luna", 0.02, 2.24],
    ["gpt-5.6", 0.4, 38.8],
  ] as const) {
    const base = pricing.estimate(record("codex", model, { input: 100_000 }));
    const long = pricing.estimate(
      record("codex", model, { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }),
    );
    assert.equal(base.available, true, model);
    assert.equal(long.available, true, model);
    if (base.available && long.available) {
      assert.equal(base.cost.amount, baseAmount, model);
      assert.equal(long.cost.amount, longAmount, model);
    }
  }
});

test("GPT-5.6 long-context pricing starts strictly above 272000 prompt tokens", async () => {
  const pricing = new PricingService(await srcCatalog());
  const below = pricing.estimate(record("codex", "gpt-5.6-sol", { input: 271_999 }));
  const boundary = pricing.estimate(record("codex", "gpt-5.6-sol", { input: 272_000 }));
  const above = pricing.estimate(record("codex", "gpt-5.6-sol", { input: 272_001 }));

  assert.equal(below.available, true);
  assert.equal(boundary.available, true);
  assert.equal(above.available, true);
  if (below.available && boundary.available && above.available) {
    assert.equal(below.cost.amount, 1.087996);
    assert.equal(boundary.cost.amount, 1.088);
    assert.equal(above.cost.amount, 2.176008);
  }
});

test("GPT-5.6 tier includes cached input and applies long output rates to the whole record", async () => {
  const pricing = new PricingService(await srcCatalog());
  const cachedCrossing = pricing.estimate(
    record("codex", "gpt-5.6-sol", { input: 100_000, cachedInput: 172_001 }),
  );
  const longOutput = pricing.estimate(record("codex", "gpt-5.6-sol", { input: 272_001, output: 1_000_000 }));

  assert.equal(cachedCrossing.available, true);
  assert.equal(longOutput.available, true);
  if (cachedCrossing.available && longOutput.available) {
    assert.equal(cachedCrossing.cost.amount, 0.937601);
    assert.equal(longOutput.cost.amount, 32.176008);
  }
});

test("GPT-5.5 and GPT-5.4 use long-context rates", async () => {
  const pricing = new PricingService(await srcCatalog());
  for (const [model, amount] of [
    ["gpt-5.5", 55],
    ["gpt-5.4", 27.5],
  ] as const) {
    const estimate = pricing.estimate(record("codex", model, { input: 1_000_000, output: 1_000_000 }));
    assert.equal(estimate.available, true, model);
    if (estimate.available) {
      assert.equal(estimate.cost.amount, amount, model);
    }
  }
});

test("legacy Codex pricing rules remain unchanged", async () => {
  const pricing = new PricingService(await srcCatalog());
  for (const [model, amount] of [
    ["gpt-5.4-mini", 5.325],
    ["gpt-5.3-codex", 15.925],
  ] as const) {
    const estimate = pricing.estimate(
      record("codex", model, { input: 1_000_000, cachedInput: 1_000_000, output: 1_000_000 }),
    );
    assert.equal(estimate.available, true, model);
    if (estimate.available) {
      assert.equal(estimate.cost.amount, amount, model);
    }
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

test("runtime pricing metadata validates the long-context contract", () => {
  assert.deepEqual(validatePricingMetadata(pricingCatalogWithLongContext(validLongContext())), { ok: true });

  for (const { name, longContext } of invalidLongContextCases) {
    assert.deepEqual(
      validatePricingMetadata(pricingCatalogWithLongContext(longContext)),
      { ok: false, reason: "missing_pricing_metadata" },
      name,
    );
  }
});

test("pricing CLI accepts optional catalogs and rejects the same invalid long-context matrix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ai-code-usage-pricing-"));
  try {
    const validPath = join(directory, "valid.json");
    await writeFile(validPath, JSON.stringify(pricingCatalogWithLongContext(validLongContext())), "utf8");
    const valid = runPricingCheck(validPath);
    assert.equal(valid.status, 0, valid.stderr);

    for (const [index, { name, longContext, diagnostic, rawNonfinite }] of invalidLongContextCases.entries()) {
      const catalogPath = join(directory, `invalid-${index}.json`);
      let contents = JSON.stringify(pricingCatalogWithLongContext(longContext));
      if (rawNonfinite) {
        contents = contents.replace('"output":null', '"output":1e400');
      }
      await writeFile(catalogPath, contents, "utf8");

      const invalid = runPricingCheck(catalogPath);
      assert.notEqual(invalid.status, 0, name);
      assert.ok(invalid.stderr.includes(diagnostic), `${name}: ${invalid.stderr}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function catalog(): Promise<PricingCatalog> {
  return JSON.parse(await readFile("test/fixtures/pricing/catalog.json", "utf8")) as PricingCatalog;
}

async function srcCatalog(): Promise<PricingCatalog> {
  return JSON.parse(await readFile("src/pricing/catalog.json", "utf8")) as PricingCatalog;
}

function record(
  provider: UsageRecord["provider"],
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

function validLongContext(): PricingRule["longContext"] {
  return {
    appliesAboveInputTokens: 272_000,
    rates: { input: 10, cachedInput: 1, output: 45 },
  };
}

const invalidLongContextCases: Array<{
  name: string;
  longContext: unknown;
  diagnostic: string;
  rawNonfinite?: boolean;
}> = [
  { name: "zero threshold", longContext: { ...validLongContext(), appliesAboveInputTokens: 0 }, diagnostic: "longContext.appliesAboveInputTokens" },
  { name: "negative threshold", longContext: { ...validLongContext(), appliesAboveInputTokens: -1 }, diagnostic: "longContext.appliesAboveInputTokens" },
  { name: "fractional threshold", longContext: { ...validLongContext(), appliesAboveInputTokens: 1.5 }, diagnostic: "longContext.appliesAboveInputTokens" },
  {
    name: "unsafe threshold",
    longContext: { ...validLongContext(), appliesAboveInputTokens: Number.MAX_SAFE_INTEGER + 1 },
    diagnostic: "longContext.appliesAboveInputTokens",
  },
  { name: "empty rates", longContext: { appliesAboveInputTokens: 272_000, rates: {} }, diagnostic: "longContext.rates must be a non-empty object" },
  {
    name: "missing rate key",
    longContext: { appliesAboveInputTokens: 272_000, rates: { input: 10, cachedInput: 1 } },
    diagnostic: "longContext.rates keys must match base rates",
  },
  {
    name: "extra rate key",
    longContext: { appliesAboveInputTokens: 272_000, rates: { input: 10, cachedInput: 1, output: 45, cacheRead: 0 } },
    diagnostic: "longContext.rates keys must match base rates",
  },
  {
    name: "negative rate",
    longContext: { appliesAboveInputTokens: 272_000, rates: { input: 10, cachedInput: 1, output: -1 } },
    diagnostic: "longContext.rates values must be finite nonnegative numbers",
  },
  {
    name: "non-number rate",
    longContext: { appliesAboveInputTokens: 272_000, rates: { input: 10, cachedInput: 1, output: "45" } },
    diagnostic: "longContext.rates values must be finite nonnegative numbers",
  },
  {
    name: "nonfinite rate",
    longContext: { appliesAboveInputTokens: 272_000, rates: { input: 10, cachedInput: 1, output: Number.POSITIVE_INFINITY } },
    diagnostic: "longContext.rates values must be finite nonnegative numbers",
    rawNonfinite: true,
  },
];

function pricingCatalogWithLongContext(longContext: unknown): PricingCatalog {
  return {
    checkedAt: "2026-07-10T00:00:00.000Z",
    sourceUrls: ["https://developers.openai.com/api/docs/pricing"],
    rules: [
      {
        provider: "codex",
        model: "gpt-test",
        modelAliases: [],
        currency: "USD",
        priceUnit: "per_1m_tokens",
        sourceUrl: "https://developers.openai.com/api/docs/pricing",
        checkedAt: "2026-07-10T00:00:00.000Z",
        rates: { input: 5, cachedInput: 0.5, output: 30 },
        longContext: longContext as PricingRule["longContext"],
      },
    ],
  };
}

function runPricingCheck(catalogPath: string) {
  return spawnSync(process.execPath, ["scripts/check-pricing.mjs", catalogPath], { encoding: "utf8" });
}

test("pi records without a pi-specific rule price with the model's native vendor rule", async () => {
  const pricing = new PricingService(await srcCatalog());
  const claude = pricing.estimate(record("pi", "claude-opus-5", { input: 1_000_000 }));
  const codex = pricing.estimate(record("pi", "gpt-6-astra", { input: 100_000 }));
  const unknown = pricing.estimate(record("pi", "grok-4.6", { input: 1_000_000 }));

  assert.equal(claude.available && claude.cost.amount, 5);
  assert.equal(codex.available && codex.cost.amount, 1);
  assert.equal(unknown.available, false);
});

test("current catalog prices GPT-6 Astra and Claude Fable/Mythos 5.1", async () => {
  const pricing = new PricingService(await srcCatalog());
  const astra = pricing.estimate(record("codex", "gpt-6-astra", { input: 100_000, output: 100_000 }));
  const fable = pricing.estimate(record("claude", "claude-fable-5-1", { cacheRead: 1_000_000 }));
  const mythos = pricing.estimate(record("claude", "Claude Mythos 5.1", { input: 1_000_000 }));

  assert.equal(astra.available && astra.cost.amount, 6);
  assert.equal(fable.available && fable.cost.amount, 0.25);
  assert.equal(mythos.available && mythos.cost.amount, 10);
});
