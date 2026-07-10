import type { PricingCatalog, PricingRule, TokenCategory, UsageCost, UsageSummary } from "./types";

export type DisplayCurrency = {
  code: string;
  /** Units of `code` per 1 USD. */
  rate: number;
};

export type DisplayCurrencySource = "manual" | "public" | "default";

export type DisplayCurrencyState = DisplayCurrency & {
  source: DisplayCurrencySource;
  /** Data timestamp of the public rate table, when `source` is "public". */
  updatedAt?: string;
  /** Set when the configured code could not be resolved and USD is shown instead. */
  requestedCode?: string;
};

export const defaultDisplayCurrency: DisplayCurrency = { code: "USD", rate: 1 };
const defaultDisplayCurrencyState: DisplayCurrencyState = { ...defaultDisplayCurrency, source: "default" };

/**
 * Resolves the display currency from user settings. Falls back to USD when the
 * code is not a 3-letter code or when no positive finite rate is configured,
 * so a half-filled setting never produces wrong numbers.
 */
export function resolveDisplayCurrency(code: unknown, rates: unknown): DisplayCurrency {
  const state = resolveDisplayCurrencyState(code, rates);
  return { code: state.code, rate: state.rate };
}

/**
 * Full resolution with precedence: manually configured rate > fetched public
 * rate > USD fallback. `publicRates` is the table stored after the user
 * pressed the update button; it is optional and may be absent forever.
 */
export function resolveDisplayCurrencyState(
  code: unknown,
  manualRates: unknown,
  publicRates?: { updatedAt: string; rates: Record<string, number> },
): DisplayCurrencyState {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return defaultDisplayCurrencyState;
  }
  if (normalized === "USD") {
    return defaultDisplayCurrencyState;
  }
  const manualRate = manualRateFor(normalized, manualRates);
  if (manualRate !== undefined) {
    return { code: normalized, rate: manualRate, source: "manual" };
  }
  const publicRate = publicRates?.rates[normalized];
  if (typeof publicRate === "number" && Number.isFinite(publicRate) && publicRate > 0) {
    return { code: normalized, rate: publicRate, source: "public", updatedAt: publicRates?.updatedAt };
  }
  return { ...defaultDisplayCurrencyState, requestedCode: normalized };
}

function manualRateFor(normalized: string, rates: unknown): number | undefined {
  const table = typeof rates === "object" && rates !== null && !Array.isArray(rates) ? (rates as Record<string, unknown>) : {};
  // Exact key wins; otherwise fall back to a case-insensitive match.
  const raw = Object.prototype.hasOwnProperty.call(table, normalized)
    ? table[normalized]
    : Object.entries(table).find(([key]) => key.trim().toUpperCase() === normalized)?.[1];
  // The VS Code settings UI can persist object values as strings; accept both.
  const rate = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return undefined;
  }
  return rate;
}

/** Display-only conversion; only USD costs are converted, others pass through. */
export function convertCost(cost: UsageCost | undefined, currency: DisplayCurrency): UsageCost | undefined {
  if (!cost || currency.code === cost.currency || cost.currency !== "USD") {
    return cost;
  }
  return { ...cost, amount: cost.amount * currency.rate, currency: currency.code };
}

export function convertSummaryCurrency(summary: UsageSummary, currency: DisplayCurrency): UsageSummary {
  if (currency.code === "USD") {
    return summary;
  }
  return {
    ...summary,
    totals: { ...summary.totals, cost: convertCost(summary.totals.cost, currency) },
    providerSplit: summary.providerSplit.map((item) => ({ ...item, cost: convertCost(item.cost, currency) })),
    modelSplit: summary.modelSplit.map((item) => ({ ...item, cost: convertCost(item.cost, currency) })),
    trend: summary.trend.map((item) => ({ ...item, cost: convertCost(item.cost, currency) })),
    sessions: summary.sessions.map((session) => ({ ...session, cost: convertCost(session.cost, currency) })),
  };
}

export function convertPricingCatalog(catalog: PricingCatalog, currency: DisplayCurrency): PricingCatalog {
  if (currency.code === "USD") {
    return catalog;
  }
  return { ...catalog, rules: catalog.rules.map((rule) => convertPricingRule(rule, currency)) };
}

function convertPricingRule(rule: PricingRule, currency: DisplayCurrency): PricingRule {
  if (rule.currency !== "USD") {
    return rule;
  }
  return {
    ...rule,
    currency: currency.code,
    rates: convertRates(rule.rates, currency.rate),
    ...(rule.longContext
      ? { longContext: { ...rule.longContext, rates: convertRates(rule.longContext.rates, currency.rate) } }
      : {}),
  };
}

function convertRates(source: PricingRule["rates"], multiplier: number): PricingRule["rates"] {
  const rates: PricingRule["rates"] = {};
  for (const [category, value] of Object.entries(source)) {
    if (typeof value === "number") {
      rates[category as TokenCategory] = value * multiplier;
    }
  }
  return rates;
}
