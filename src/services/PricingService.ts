import { addCost, roundCurrency, tokenTotal } from "../domain/math";
import type { CostEstimate, PricingCatalog, PricingRule, UsageCost, UsageRecord } from "../domain/types";

export class PricingService {
  public constructor(private readonly catalog: PricingCatalog) {}

  public estimate(record: UsageRecord): CostEstimate {
    if (record.cost) {
      return { available: true, cost: record.cost };
    }

    const metadata = validatePricingMetadata(this.catalog);
    if (!metadata.ok) {
      return { available: false, reason: metadata.reason };
    }

    if (!record.model) {
      return { available: false, reason: "unknown_model" };
    }

    if (tokenTotal(record.tokens) === 0) {
      return { available: false, reason: "missing_tokens" };
    }

    const rule = findPricingRule(this.catalog.rules, record.provider, record.model, pricingInstant(record));
    if (!rule) {
      return { available: false, reason: "unknown_model" };
    }

    const amount = Object.entries(record.tokens).reduce((total, [category, count]) => {
      if (typeof count !== "number") {
        return total;
      }
      const rate = rule.rates[category as keyof typeof rule.rates];
      if (typeof rate !== "number") {
        return total;
      }
      return total + (count / 1_000_000) * rate;
    }, 0);

    if (amount === 0) {
      return { available: false, reason: "missing_tokens" };
    }

    return {
      available: true,
      cost: {
        amount: roundCurrency(amount),
        currency: rule.currency,
        source: "calculated",
        sourceUrl: rule.sourceUrl,
        checkedAt: rule.checkedAt,
      },
    };
  }
}

export function estimateRecordCost(record: UsageRecord, pricing?: PricingService): UsageCost | undefined {
  if (!pricing) {
    return record.cost;
  }
  const estimate = pricing.estimate(record);
  return estimate.available ? estimate.cost : estimate.importedCost;
}

export function sumEstimatedCosts(records: UsageRecord[], pricing?: PricingService): UsageCost | undefined {
  return records.reduce<UsageCost | undefined>((total, record) => addCost(total, estimateRecordCost(record, pricing)), undefined);
}

export function findPricingRule(
  rules: PricingRule[],
  provider: UsageRecord["provider"],
  model: string,
  at?: Date,
): PricingRule | undefined {
  const normalizedModel = model.toLowerCase();
  const candidates = rules.filter(
    (rule) =>
      rule.provider === provider &&
      (rule.model.toLowerCase() === normalizedModel ||
        rule.modelAliases.some((alias) => alias.toLowerCase() === normalizedModel)),
  );
  const applicable = candidates
    .filter((rule) => !at || pricingRuleAppliesAt(rule, at))
    .sort((a, b) => effectiveFromTime(b) - effectiveFromTime(a));

  return applicable[0] ?? candidates.find((rule) => !rule.effectiveFrom && !rule.effectiveTo);
}

export function validatePricingMetadata(catalog: PricingCatalog): { ok: true } | { ok: false; reason: "missing_pricing_metadata" } {
  if (
    !validRequiredIso(catalog.checkedAt) ||
    !Array.isArray(catalog.sourceUrls) ||
    catalog.sourceUrls.length === 0 ||
    !Array.isArray(catalog.rules) ||
    catalog.rules.length === 0
  ) {
    return { ok: false, reason: "missing_pricing_metadata" };
  }
  for (const rule of catalog.rules) {
    if (!rule.sourceUrl || !validRequiredIso(rule.checkedAt)) {
      return { ok: false, reason: "missing_pricing_metadata" };
    }
    if (!validOptionalIso(rule.effectiveFrom) || !validOptionalIso(rule.effectiveTo)) {
      return { ok: false, reason: "missing_pricing_metadata" };
    }
    if (rule.effectiveFrom && rule.effectiveTo && new Date(rule.effectiveFrom).getTime() >= new Date(rule.effectiveTo).getTime()) {
      return { ok: false, reason: "missing_pricing_metadata" };
    }
  }

  return { ok: true };
}

function pricingInstant(record: UsageRecord): Date | undefined {
  for (const timestamp of [record.startedAt, record.observedAt, record.endedAt]) {
    if (!timestamp) {
      continue;
    }
    const time = new Date(timestamp).getTime();
    if (!Number.isNaN(time)) {
      return new Date(time);
    }
  }
  return undefined;
}

function pricingRuleAppliesAt(rule: PricingRule, at: Date): boolean {
  const atTime = at.getTime();
  const from = rule.effectiveFrom ? new Date(rule.effectiveFrom).getTime() : Number.NEGATIVE_INFINITY;
  const to = rule.effectiveTo ? new Date(rule.effectiveTo).getTime() : Number.POSITIVE_INFINITY;
  return atTime >= from && atTime < to;
}

function effectiveFromTime(rule: PricingRule): number {
  return rule.effectiveFrom ? new Date(rule.effectiveFrom).getTime() : Number.NEGATIVE_INFINITY;
}

function validRequiredIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function validOptionalIso(value: unknown): value is string | undefined {
  return value === undefined || validRequiredIso(value);
}
