import { readFile } from "node:fs/promises";

const failures = [];

const catalogPaths = ["src/pricing/catalog.json", "test/fixtures/pricing/catalog.json"];

for (const catalogPath of catalogPaths) {
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (!catalog.checkedAt || !Array.isArray(catalog.sourceUrls) || catalog.sourceUrls.length === 0) {
    failures.push(`${catalogPath} must include checkedAt and sourceUrls.`);
  }

  for (const [index, rule] of (catalog.rules ?? []).entries()) {
    for (const field of ["provider", "model", "modelAliases", "currency", "priceUnit", "sourceUrl", "checkedAt", "rates"]) {
      if (rule[field] === undefined) {
        failures.push(`${catalogPath} pricing rule ${index} missing ${field}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`pricing metadata ok: checked ${catalogPaths.length} catalogs`);
