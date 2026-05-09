import type { TokenBreakdown, UsageCost } from "./types";

export function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  const result: TokenBreakdown = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value !== "number") {
      continue;
    }
    const tokenKey = key as keyof TokenBreakdown;
    result[tokenKey] = (result[tokenKey] ?? 0) + value;
  }
  return result;
}

export function addCost(a: UsageCost | undefined, b: UsageCost | undefined): UsageCost | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  if (a.currency !== b.currency) {
    return undefined;
  }

  return {
    amount: roundCurrency(a.amount + b.amount),
    currency: a.currency,
    source: a.source === b.source ? a.source : "calculated",
    sourceUrl: a.sourceUrl === b.sourceUrl ? a.sourceUrl : undefined,
    checkedAt: newerIso(a.checkedAt, b.checkedAt),
    note: a.note ?? b.note,
  };
}

export function tokenTotal(tokens: TokenBreakdown): number {
  return Object.values(tokens).reduce((total, value) => total + (typeof value === "number" ? value : 0), 0);
}

export function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function newerIso(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}
