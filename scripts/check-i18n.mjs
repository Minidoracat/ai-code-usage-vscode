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

const webviewLocales = Object.fromEntries(locales.map((locale) => [locale, `src/i18n/locales/${locale}.json`]));
const baseWebview = JSON.parse(await readFile(webviewLocales.en, "utf8"));
const baseKeys = Object.keys(baseWebview);
const failures = [];

function checkKeyCoverage(kind, locale, messages, keys) {
  for (const key of keys) {
    if (typeof messages[key] !== "string" || messages[key].length === 0) {
      failures.push(`Missing ${kind} key ${locale}:${key}`);
    }
  }

  for (const key of Object.keys(messages)) {
    if (!keys.includes(key)) {
      failures.push(`Unexpected ${kind} key ${locale}:${key}`);
    }
  }
}

for (const [locale, file] of Object.entries(webviewLocales)) {
  const messages = JSON.parse(await readFile(file, "utf8"));
  checkKeyCoverage("webview", locale, messages, baseKeys);
}

const basePackage = JSON.parse(await readFile(packageLocales.en, "utf8"));
const packageKeys = Object.keys(basePackage);
for (const [locale, file] of Object.entries(packageLocales)) {
  const messages = JSON.parse(await readFile(file, "utf8"));
  checkKeyCoverage("package", locale, messages, packageKeys);
}

const baseL10n = JSON.parse(await readFile(l10nLocales.en, "utf8"));
const l10nKeys = Object.keys(baseL10n);
for (const [locale, file] of Object.entries(l10nLocales)) {
  const messages = JSON.parse(await readFile(file, "utf8"));
  checkKeyCoverage("l10n", locale, messages, l10nKeys);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`i18n coverage ok: ${locales.length} locales, ${baseKeys.length} webview keys, ${packageKeys.length} package keys, ${l10nKeys.length} l10n keys`);
