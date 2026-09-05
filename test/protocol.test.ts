import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWebviewRequest, webviewProtocolVersion } from "../src/webview/protocol";

test("valid refresh message passes", () => {
  const result = validateWebviewRequest({ requestId: "1", type: "refresh", version: webviewProtocolVersion });
  assert.equal("error" in result, false);
});

test("valid rebuild cache message passes", () => {
  const result = validateWebviewRequest({ requestId: "rebuild", type: "rebuildCache", version: webviewProtocolVersion });
  assert.equal("error" in result, false);
});

test("valid range update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "2",
    type: "setRange",
    version: webviewProtocolVersion,
    payload: { kind: "custom", start: "2026-04-01", end: "2026-04-30" },
  });
  assert.equal("error" in result, false);
});

test("valid calendar quick range update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "range",
    type: "setRange",
    version: webviewProtocolVersion,
    payload: { kind: "lastWeek" },
  });
  assert.equal("error" in result, false);
});

test("legacy rolling range update message fails", () => {
  const result = validateWebviewRequest({
    requestId: "range",
    type: "setRange",
    version: webviewProtocolVersion,
    payload: { kind: "last7Days" },
  });
  assert.equal("error" in result, true);
});

test("valid currency update message normalizes the code", () => {
  const result = validateWebviewRequest({
    requestId: "currency",
    type: "setCurrency",
    version: webviewProtocolVersion,
    payload: { code: "twd" },
  });
  assert.equal("error" in result, false);
  if (!("error" in result) && result.type === "setCurrency") {
    assert.equal(result.payload.code, "TWD");
  }
});

test("invalid currency update fails", () => {
  const badCode = validateWebviewRequest({
    requestId: "currency",
    type: "setCurrency",
    version: webviewProtocolVersion,
    payload: { code: "NT$" },
  });
  assert.equal("error" in badCode, true);
});

test("valid exchange rate refresh message passes", () => {
  const result = validateWebviewRequest({
    requestId: "rates",
    type: "refreshExchangeRates",
    version: webviewProtocolVersion,
  });
  assert.equal("error" in result, false);
});

test("valid provider filter message passes", () => {
  const result = validateWebviewRequest({
    requestId: "provider",
    type: "setProvider",
    version: webviewProtocolVersion,
    payload: { provider: "claude" },
  });
  assert.equal("error" in result, false);
});

test("valid locale update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "locale",
    type: "setLocale",
    version: webviewProtocolVersion,
    payload: { locale: "zh-TW" },
  });
  assert.equal("error" in result, false);
});

test("invalid locale update fails", () => {
  const result = validateWebviewRequest({
    requestId: "locale",
    type: "setLocale",
    version: webviewProtocolVersion,
    payload: { locale: "fr" },
  });
  assert.equal("error" in result, true);
});

test("valid auto refresh update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "auto-refresh",
    type: "setAutoRefresh",
    version: webviewProtocolVersion,
    payload: { intervalSeconds: 300 },
  });
  assert.equal("error" in result, false);
});

test("valid time zone update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "time-zone",
    type: "setTimeZone",
    version: webviewProtocolVersion,
    payload: { mode: "custom", customTimeZone: "Asia/Taipei" },
  });
  assert.equal("error" in result, false);
});

test("valid utc time zone update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "time-zone",
    type: "setTimeZone",
    version: webviewProtocolVersion,
    payload: { mode: "utc" },
  });
  assert.equal("error" in result, false);
});

test("invalid custom time zone update fails", () => {
  const result = validateWebviewRequest({
    requestId: "time-zone",
    type: "setTimeZone",
    version: webviewProtocolVersion,
    payload: { mode: "custom", customTimeZone: "Taipei Standard Time" },
  });
  assert.equal("error" in result, true);
});

test("disabled auto refresh update message passes", () => {
  const result = validateWebviewRequest({
    requestId: "auto-refresh",
    type: "setAutoRefresh",
    version: webviewProtocolVersion,
    payload: { intervalSeconds: 0 },
  });
  assert.equal("error" in result, false);
});

test("invalid auto refresh update fails", () => {
  const result = validateWebviewRequest({
    requestId: "auto-refresh",
    type: "setAutoRefresh",
    version: webviewProtocolVersion,
    payload: { intervalSeconds: -1 },
  });
  assert.equal("error" in result, true);
});

test("too frequent auto refresh update fails", () => {
  const result = validateWebviewRequest({
    requestId: "auto-refresh",
    type: "setAutoRefresh",
    version: webviewProtocolVersion,
    payload: { intervalSeconds: 1 },
  });
  assert.equal("error" in result, true);
});

test("screenshot save message is not supported", () => {
  const result = validateWebviewRequest({
    requestId: "screenshot",
    type: "saveScreenshot",
    version: webviewProtocolVersion,
    payload: { dataUrl: "data:image/png;base64,abcd", fileName: "ai-coding-usage.png" },
  });
  assert.equal("error" in result, true);
});

test("invalid provider filter fails", () => {
  const result = validateWebviewRequest({
    requestId: "provider",
    type: "setProvider",
    version: webviewProtocolVersion,
    payload: { provider: "future" },
  });
  assert.equal("error" in result, true);
});

test("unknown type fails", () => {
  const result = validateWebviewRequest({ requestId: "3", type: "unknown", version: webviewProtocolVersion });
  assert.equal("error" in result, true);
});

test("version mismatch fails", () => {
  const result = validateWebviewRequest({ requestId: "4", type: "refresh", version: 99 });
  assert.deepEqual(result, { error: "Unsupported webview message version." });
});

test("missing requestId fails", () => {
  const result = validateWebviewRequest({ type: "refresh", version: webviewProtocolVersion });
  assert.deepEqual(result, { error: "Message requestId is required." });
});
