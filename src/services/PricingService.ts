import { addCost, roundCurrency, tokenTotal } from "../domain/math";
import type { CostEstimate, PricingCatalog, PricingRule, UsageCost, UsageRecord } from "../domain/types";

export class PricingService {
  private readonly metadata: ReturnType<typeof validatePricingMetadata>;
  // Rules with effectiveFrom/effectiveTo depend on the record instant, so those
  // model keys cannot use the memoized single-rule cache. They get a precomputed
  // candidate list instead, keeping the per-record cost at a couple of date
  // comparisons rather than a full catalog scan (the aggregate hot path prices
  // ~83k records per pass).
  private readonly datedCandidates = new Map<string, PricingRule[]>();
  private readonly ruleCache = new Map<string, PricingRule | undefined>();

  public constructor(private readonly catalog: PricingCatalog) {
    this.metadata = validatePricingMetadata(catalog);
    if (this.metadata.ok) {
      const datedKeys = new Set<string>();
      for (const rule of catalog.rules) {
        if (!rule.effectiveFrom && !rule.effectiveTo) {
          continue;
        }
        for (const name of [rule.model, ...rule.modelAliases]) {
          datedKeys.add(`${rule.provider}:${name.toLowerCase()}`);
        }
      }
      for (const key of datedKeys) {
        const separator = key.indexOf(":");
        const provider = key.slice(0, separator) as UsageRecord["provider"];
        const model = key.slice(separator + 1);
        this.datedCandidates.set(
          key,
          this.catalog.rules.filter(
            (rule) =>
              rule.provider === provider &&
              (rule.model.toLowerCase() === model || rule.modelAliases.some((alias) => alias.toLowerCase() === model)),
          ),
        );
      }
    }
  }

  public estimate(record: UsageRecord): CostEstimate {
    if (record.cost) {
      return { available: true, cost: record.cost };
    }

    if (!this.metadata.ok) {
      return { available: false, reason: this.metadata.reason };
    }

    if (!record.model) {
      return { available: false, reason: "unknown_model" };
    }

    if (tokenTotal(record.tokens) === 0) {
      return { available: false, reason: "missing_tokens" };
    }

    const rule = this.lookupRule(record);
    if (!rule) {
      return { available: false, reason: "unknown_model" };
    }

    const rates =
      rule.longContext && (record.tokens.input ?? 0) + (record.tokens.cachedInput ?? 0) > rule.longContext.appliesAboveInputTokens
        ? rule.longContext.rates
        : rule.rates;
    const amount = Object.entries(record.tokens).reduce((total, [category, count]) => {
      if (typeof count !== "number") {
        return total;
      }
      const rate = rates[category as keyof typeof rates];
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

  private lookupRule(record: UsageRecord): PricingRule | undefined {
    if (!this.metadata.ok || !record.model) {
      return findPricingRule(this.catalog.rules, record.provider, record.model ?? "", pricingInstant(record));
    }
    const key = `${record.provider}:${record.model.toLowerCase()}`;
    const datedCandidates = this.datedCandidates.get(key);
    if (datedCandidates) {
      return selectPricingRule(datedCandidates, pricingInstant(record));
    }
    if (this.ruleCache.has(key)) {
      return this.ruleCache.get(key);
    }
    const rule = findPricingRule(this.catalog.rules, record.provider, record.model);
    this.ruleCache.set(key, rule);
    return rule;
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
  const matching = (target: UsageRecord["provider"]) =>
    rules.filter(
      (rule) =>
        rule.provider === target &&
        (rule.model.toLowerCase() === normalizedModel ||
          rule.modelAliases.some((alias) => alias.toLowerCase() === normalizedModel)),
    );
  const rule = selectPricingRule(matching(provider), at);
  if (rule || provider !== "pi") {
    return rule;
  }
  // pi transcripts carry the upstream model id; price it with that vendor's
  // catalog when no pi-specific rule exists (imported cost still wins).
  const native = nativeProviderForModel(normalizedModel);
  return native ? selectPricingRule(matching(native), at) : undefined;
}

function nativeProviderForModel(model: string): UsageRecord["provider"] | undefined {
  if (model.startsWith("claude")) {
    return "claude";
  }
  if (/^(gpt|o\d)/.test(model)) {
    return "codex";
  }
  return undefined;
}

function selectPricingRule(candidates: PricingRule[], at?: Date): PricingRule | undefined {
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
    if (!validLongContext(rule)) {
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

function validLongContext(rule: PricingRule): boolean {
  const longContext: unknown = rule.longContext;
  if (longContext === undefined) {
    return true;
  }
  if (!isRecord(longContext)) {
    return false;
  }
  const threshold = longContext["appliesAboveInputTokens"];
  const rates = longContext["rates"];
  if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0 || !isRecord(rates)) {
    return false;
  }
  const entries = Object.entries(rates);
  if (entries.length === 0 || entries.some(([, rate]) => typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)) {
    return false;
  }
  if (!isRecord(rule.rates)) {
    return false;
  }
  const baseKeys = Object.keys(rule.rates).sort();
  const longKeys = Object.keys(rates).sort();
  return baseKeys.length === longKeys.length && baseKeys.every((key, index) => key === longKeys[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
