import { readFile } from "node:fs/promises";

const locales = ["en", "zh-TW", "zh-CN", "ja", "ko"];
const packageLocales = {
  en: "package.nls.json",
  "zh-TW": "package.nls.zh-tw.json",
  "zh-CN": "package.nls.zh-cn.json",
  ja: "package.nls.ja.json",
  ko: "package.nls.ko.json",
};
const l10nLocales = {
  en: "l10n/bundle.l10n.json",
  "zh-TW": "l10n/bundle.l10n.zh-tw.json",
  "zh-CN": "l10n/bundle.l10n.zh-cn.json",
  ja: "l10n/bundle.l10n.ja.json",
  ko: "l10n/bundle.l10n.ko.json",
};

const catalog = JSON.parse(await readFile("src/i18n/catalog.json", "utf8"));
const baseKeys = Object.keys(catalog.en ?? {});
const failures = [];

for (const locale of locales) {
  const messages = catalog[locale];
  if (!messages) {
    failures.push(`Missing webview locale ${locale}`);
    continue;
  }
  for (const key of baseKeys) {
    if (typeof messages[key] !== "string" || messages[key].length === 0) {
      failures.push(`Missing webview key ${locale}:${key}`);
    }
  }
}

const basePackage = JSON.parse(await readFile(packageLocales.en, "utf8"));
const packageKeys = Object.keys(basePackage);
for (const [locale, file] of Object.entries(packageLocales)) {
  const messages = JSON.parse(await readFile(file, "utf8"));
  for (const key of packageKeys) {
    if (typeof messages[key] !== "string" || messages[key].length === 0) {
      failures.push(`Missing package key ${locale}:${key}`);
    }
  }
}

const baseL10n = JSON.parse(await readFile(l10nLocales.en, "utf8"));
const l10nKeys = Object.keys(baseL10n);
for (const [locale, file] of Object.entries(l10nLocales)) {
  const messages = JSON.parse(await readFile(file, "utf8"));
  for (const key of l10nKeys) {
    if (typeof messages[key] !== "string" || messages[key].length === 0) {
      failures.push(`Missing l10n key ${locale}:${key}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`i18n coverage ok: ${locales.length} locales, ${baseKeys.length} webview keys, ${packageKeys.length} package keys, ${l10nKeys.length} l10n keys`);
