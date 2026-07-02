import assert from "node:assert/strict";
import { test } from "node:test";
import type { PricingCatalog, UsageSummary } from "../src/domain/types";
import {
  convertCost,
  convertPricingCatalog,
  convertSummaryCurrency,
  resolveDisplayCurrency,
  resolveDisplayCurrencyState,
} from "../src/domain/currency";
import { parsePublicExchangeRates } from "../src/services/ExchangeRateService";

test("resolveDisplayCurrency falls back to USD without a usable rate", () => {
  assert.deepEqual(resolveDisplayCurrency("USD", {}), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency("TWD", {}), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency("TWD", { TWD: 0 }), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency("TWD", { TWD: -1 }), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency("NTD$", { NTD$: 32 }), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency(undefined, undefined), { code: "USD", rate: 1 });
});

test("resolveDisplayCurrency matches codes case-insensitively", () => {
  assert.deepEqual(resolveDisplayCurrency("twd", { twd: 32.5 }), { code: "TWD", rate: 32.5 });
  assert.deepEqual(resolveDisplayCurrency(" jpy ", { JPY: 155 }), { code: "JPY", rate: 155 });
});

test("resolveDisplayCurrency accepts numeric strings from the settings UI", () => {
  assert.deepEqual(resolveDisplayCurrency("TWD", { TWD: "32.5" }), { code: "TWD", rate: 32.5 });
  assert.deepEqual(resolveDisplayCurrency("TWD", { TWD: "not-a-number" }), { code: "USD", rate: 1 });
  assert.deepEqual(resolveDisplayCurrency("TWD", { TWD: "" }), { code: "USD", rate: 1 });
});

test("resolveDisplayCurrencyState prefers manual rates over public rates", () => {
  const publicRates = { updatedAt: "2026-07-01T00:00:00.000Z", rates: { TWD: 31, JPY: 155 } };

  assert.deepEqual(resolveDisplayCurrencyState("TWD", { TWD: 32.5 }, publicRates), {
    code: "TWD",
    rate: 32.5,
    source: "manual",
  });
  assert.deepEqual(resolveDisplayCurrencyState("TWD", {}, publicRates), {
    code: "TWD",
    rate: 31,
    source: "public",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  assert.deepEqual(resolveDisplayCurrencyState("KRW", {}, publicRates), {
    code: "USD",
    rate: 1,
    source: "default",
    requestedCode: "KRW",
  });
  assert.deepEqual(resolveDisplayCurrencyState("USD", {}, publicRates), { code: "USD", rate: 1, source: "default" });
});

test("parsePublicExchangeRates validates and normalizes the provider payload", () => {
  const parsed = parsePublicExchangeRates({
    result: "success",
    base_code: "USD",
    time_last_update_utc: "Tue, 01 Jul 2026 00:02:31 +0000",
    rates: { USD: 1, TWD: 31.2, jpy: 155.5, bad: "x", ZERO: 0, NEG: -3 },
  });

  assert.equal(parsed.rates["TWD"], 31.2);
  assert.equal(parsed.rates["JPY"], 155.5);
  assert.equal(parsed.rates["USD"], 1);
  assert.equal("ZERO" in parsed.rates, false);
  assert.equal("NEG" in parsed.rates, false);
  assert.equal(parsed.updatedAt, "2026-07-01T00:02:31.000Z");
});

test("parsePublicExchangeRates fails closed on provider drift", () => {
  const valid = {
    result: "success",
    base_code: "USD",
    time_last_update_utc: "Tue, 01 Jul 2026 00:02:31 +0000",
    rates: { USD: 1, TWD: 31.2 },
  };

  assert.throws(() => parsePublicExchangeRates({ ...valid, result: "error" }));
  assert.throws(() => parsePublicExchangeRates({ ...valid, base_code: "EUR" }), /not USD-based/);
  assert.throws(() => parsePublicExchangeRates({ ...valid, rates: { USD: 1.2, TWD: 31.2 } }), /unexpected USD rate/);
  assert.throws(() => parsePublicExchangeRates({ ...valid, rates: { TWD: 31.2 } }), /unexpected USD rate/);
  assert.throws(() => parsePublicExchangeRates({ ...valid, time_last_update_utc: "bad-date" }), /invalid data timestamp/);
  assert.throws(() => parsePublicExchangeRates({ ...valid, time_last_update_utc: undefined }), /invalid data timestamp/);
  assert.throws(() => parsePublicExchangeRates("not-an-object"));
});

test("convertCost converts USD only and preserves metadata", () => {
  const currency = { code: "TWD", rate: 32 };
  const converted = convertCost({ amount: 1.5, currency: "USD", source: "calculated", note: "partial" }, currency);
  assert.deepEqual(converted, { amount: 48, currency: "TWD", source: "calculated", note: "partial" });

  const imported = { amount: 100, currency: "EUR", source: "imported" as const };
  assert.equal(convertCost(imported, currency), imported);
  assert.equal(convertCost(undefined, currency), undefined);
});

test("convertSummaryCurrency converts every cost surface and is identity for USD", () => {
  const summary = {
    totals: { records: 1, sessions: 1, tokens: {}, cost: { amount: 2, currency: "USD", source: "calculated" }, activeModels: 1 },
    providerSplit: [{ provider: "claude", records: 1, sessions: 1, tokens: {}, cost: { amount: 1, currency: "USD", source: "calculated" } }],
    modelSplit: [{ provider: "claude", model: "m", records: 1, tokens: {}, cost: { amount: 1, currency: "USD", source: "calculated" } }],
    trend: [{ bucket: "2026-07-01", records: 1, sessions: 1, tokens: {}, cost: { amount: 1, currency: "USD", source: "calculated" } }],
    sessions: [{ provider: "claude", sessionId: "s", records: 1, tokens: {}, cost: { amount: 1, currency: "USD", source: "calculated" } }],
  } as unknown as UsageSummary;

  assert.equal(convertSummaryCurrency(summary, { code: "USD", rate: 1 }), summary);

  const converted = convertSummaryCurrency(summary, { code: "TWD", rate: 30 });
  assert.equal(converted.totals.cost?.amount, 60);
  assert.equal(converted.totals.cost?.currency, "TWD");
  assert.equal(converted.providerSplit[0]?.cost?.amount, 30);
  assert.equal(converted.modelSplit[0]?.cost?.amount, 30);
  assert.equal(converted.trend[0]?.cost?.amount, 30);
  assert.equal(converted.sessions[0]?.cost?.amount, 30);
});

test("convertPricingCatalog converts rates and currency labels", () => {
  const catalog = {
    checkedAt: "2026-07-01T00:00:00.000Z",
    sourceUrls: ["https://example.com"],
    rules: [
      {
        provider: "claude",
        model: "m",
        modelAliases: [],
        currency: "USD",
        priceUnit: "per_1m_tokens",
        sourceUrl: "https://example.com",
        checkedAt: "2026-07-01T00:00:00.000Z",
        rates: { input: 3, output: 15 },
      },
    ],
  } as unknown as PricingCatalog;

  assert.equal(convertPricingCatalog(catalog, { code: "USD", rate: 1 }), catalog);

  const converted = convertPricingCatalog(catalog, { code: "JPY", rate: 150 });
  assert.equal(converted.rules[0]?.currency, "JPY");
  assert.equal(converted.rules[0]?.rates.input, 450);
  assert.equal(converted.rules[0]?.rates.output, 2250);
});
