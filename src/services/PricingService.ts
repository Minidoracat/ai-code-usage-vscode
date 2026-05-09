import { addCost, roundCurrency, tokenTotal } from "../domain/math";
import type { CostEstimate, PricingCatalog, PricingRule, UsageCost, UsageRecord } from "../domain/types";

const defaultMaxAgeDays = 14;

export class PricingService {
  public constructor(
    private readonly catalog: PricingCatalog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public estimate(record: UsageRecord): CostEstimate {
    if (record.cost) {
      return { available: true, cost: record.cost };
    }

    const freshness = validatePricingFreshness(this.catalog, this.now(), defaultMaxAgeDays);
    if (!freshness.ok) {
      return { available: false, reason: freshness.reason };
    }

    if (!record.model) {
      return { available: false, reason: "unknown_model" };
    }

    if (tokenTotal(record.tokens) === 0) {
      return { available: false, reason: "missing_tokens" };
    }

    const rule = findPricingRule(this.catalog.rules, record.provider, record.model);
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

export function findPricingRule(rules: PricingRule[], provider: UsageRecord["provider"], model: string): PricingRule | undefined {
  const normalizedModel = model.toLowerCase();
  return rules.find(
    (rule) =>
      rule.provider === provider &&
      (rule.model.toLowerCase() === normalizedModel ||
        rule.modelAliases.some((alias) => alias.toLowerCase() === normalizedModel)),
  );
}

export function validatePricingFreshness(
  catalog: PricingCatalog,
  now: Date,
  maxAgeDays = defaultMaxAgeDays,
): { ok: true } | { ok: false; reason: "stale_pricing" | "missing_pricing_metadata" } {
  if (!catalog.checkedAt || catalog.sourceUrls.length === 0) {
    return { ok: false, reason: "missing_pricing_metadata" };
  }
  for (const rule of catalog.rules) {
    if (!rule.sourceUrl || !rule.checkedAt) {
      return { ok: false, reason: "missing_pricing_metadata" };
    }
  }

  const checkedAt = new Date(catalog.checkedAt).getTime();
  if (Number.isNaN(checkedAt)) {
    return { ok: false, reason: "missing_pricing_metadata" };
  }

  const ageMs = now.getTime() - checkedAt;
  if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    return { ok: false, reason: "stale_pricing" };
  }

  return { ok: true };
}
