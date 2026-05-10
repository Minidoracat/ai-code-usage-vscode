import { readFile } from "node:fs/promises";

const failures = [];

const catalogPaths = ["src/pricing/catalog.json", "test/fixtures/pricing/catalog.json"];

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
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`pricing metadata ok: checked ${catalogPaths.length} catalogs`);
