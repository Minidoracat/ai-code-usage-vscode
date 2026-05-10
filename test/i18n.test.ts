import assert from "node:assert/strict";
import { test } from "node:test";
import en from "../src/i18n/locales/en.json";
import { type Locale, messagesFor, normalizeLocale, supportedLocales, translate } from "../src/i18n/messages";

test("all supported locales have complete visible webview keys", () => {
  const keys = Object.keys(en);
  assert.deepEqual([...supportedLocales].sort(), ["en", "ja", "ko", "zh-CN", "zh-TW"].sort());

  for (const locale of supportedLocales) {
    for (const key of keys) {
      assert.equal(typeof messagesFor(locale)[key as keyof typeof en], "string", `${locale}:${key}`);
    }
  }
});

test("locale normalization falls back predictably", () => {
  assert.equal(normalizeLocale(undefined), "en");
  assert.equal(normalizeLocale("auto"), "en");
  assert.equal(normalizeLocale("EN"), "en");
  assert.equal(normalizeLocale("zh-tw"), "zh-TW");
  assert.equal(normalizeLocale("zh-Hant"), "zh-TW");
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale("fr"), "en");
});

test("supported locale registry is immutable", () => {
  assert.equal(Object.isFrozen(supportedLocales), true);
  assert.throws(() => (supportedLocales as Locale[]).push("en"), TypeError);
});

test("translation does not leak raw key for required strings", () => {
  assert.notEqual(translate("zh-TW", "empty.title"), "empty.title");
});
