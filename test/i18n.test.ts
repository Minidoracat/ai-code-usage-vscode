import assert from "node:assert/strict";
import { test } from "node:test";
import catalog from "../src/i18n/catalog.json";
import { messagesFor, normalizeLocale, supportedLocales, translate } from "../src/i18n/messages";

test("all supported locales have complete visible webview keys", () => {
  const keys = Object.keys(catalog.en);
  assert.deepEqual(supportedLocales.sort(), ["en", "ja", "ko", "zh-CN", "zh-TW"].sort());

  for (const locale of supportedLocales) {
    for (const key of keys) {
      assert.equal(typeof messagesFor(locale)[key as keyof typeof catalog.en], "string", `${locale}:${key}`);
    }
  }
});

test("locale normalization falls back predictably", () => {
  assert.equal(normalizeLocale("zh-tw"), "zh-TW");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("fr"), "en");
});

test("translation does not leak raw key for required strings", () => {
  assert.notEqual(translate("zh-TW", "empty.title"), "empty.title");
});
