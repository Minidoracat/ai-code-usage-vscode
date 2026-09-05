import { readFile } from "node:fs/promises";

const failures = [];

const catalogPaths =
  process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["src/pricing/catalog.json", "test/fixtures/pricing/catalog.json"];

for (const catalogPath of catalogPaths) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!catalog.checkedAt || !Array.isArray(catalog.sourceUrls) || catalog.sourceUrls.length === 0) {
    failures.push(`${catalogPath} must include checkedAt and sourceUrls.`);
  }
  if (!Array.isArray(catalog.rules) || catalog.rules.length === 0) {
    failures.push(`${catalogPath} must include at least one pricing rule.`);
    continue;
  }

  for (const [index, rule] of catalog.rules.entries()) {
    for (const field of ["provider", "model", "modelAliases", "currency", "priceUnit", "sourceUrl", "checkedAt", "rates"]) {
      if (rule[field] === undefined) {
        failures.push(`${catalogPath} pricing rule ${index} missing ${field}`);
      }
    }
    for (const field of ["effectiveFrom", "effectiveTo"]) {
      if (rule[field] !== undefined && (typeof rule[field] !== "string" || Number.isNaN(new Date(rule[field]).getTime()))) {
        failures.push(`${catalogPath} pricing rule ${index} has invalid ${field}`);
      }
    }
    if (
      rule.effectiveFrom !== undefined &&
      rule.effectiveTo !== undefined &&
      new Date(rule.effectiveFrom).getTime() >= new Date(rule.effectiveTo).getTime()
    ) {
      failures.push(`${catalogPath} pricing rule ${index} effectiveFrom must be before effectiveTo`);
    }
    if (rule.longContext !== undefined) {
      const label = `${catalogPath} pricing rule ${index} longContext`;
      if (!isRecord(rule.longContext)) {
        failures.push(`${label} must be an object`);
        continue;
      }
      const threshold = rule.longContext.appliesAboveInputTokens;
      const rates = rule.longContext.rates;
      if (typeof threshold !== "number" || !Number.isSafeInteger(threshold) || threshold <= 0) {
        failures.push(`${label}.appliesAboveInputTokens must be a positive safe integer`);
      }
      if (!isRecord(rates) || Object.keys(rates).length === 0) {
        failures.push(`${label}.rates must be a non-empty object`);
        continue;
      }
      if (Object.values(rates).some((rate) => typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)) {
        failures.push(`${label}.rates values must be finite nonnegative numbers`);
      }
      const baseKeys = isRecord(rule.rates) ? Object.keys(rule.rates).sort() : [];
      const longKeys = Object.keys(rates).sort();
      if (!isRecord(rule.rates) || baseKeys.length !== longKeys.length || baseKeys.some((key, keyIndex) => key !== longKeys[keyIndex])) {
        failures.push(`${label}.rates keys must match base rates`);
      }
    }
  }

  // Rules sharing provider+model must tile time without gaps or overlaps, and
  // keep identical alias sets so every alias resolves to the same dated window.
  const byModel = new Map();
  for (const rule of catalog.rules) {
    const key = `${rule.provider}:${rule.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), rule]);
  }
  for (const [key, rules] of byModel) {
    if (rules.length < 2) {
      continue;
    }
    const aliasSets = new Set(rules.map((rule) => JSON.stringify([...rule.modelAliases].sort())));
    if (aliasSets.size > 1) {
      failures.push(`${catalogPath} ${key} dated rules have inconsistent modelAliases`);
    }
    const fromTime = (rule) => (rule.effectiveFrom ? new Date(rule.effectiveFrom).getTime() : Number.NEGATIVE_INFINITY);
    const sorted = [...rules].sort((a, b) => fromTime(a) - fromTime(b));
    for (let index = 1; index < sorted.length; index += 1) {
      const previousTo = sorted[index - 1].effectiveTo;
      const currentFrom = sorted[index].effectiveFrom;
      if (!previousTo || !currentFrom || new Date(previousTo).getTime() !== new Date(currentFrom).getTime()) {
        failures.push(`${catalogPath} ${key} dated rules must be contiguous (rule ${index - 1} effectiveTo != rule ${index} effectiveFrom)`);
      }
    }
    if (sorted[sorted.length - 1].effectiveTo) {
      failures.push(`${catalogPath} ${key} latest dated rule must be open-ended (no effectiveTo)`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`pricing metadata ok: checked ${catalogPaths.length} catalogs`);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
