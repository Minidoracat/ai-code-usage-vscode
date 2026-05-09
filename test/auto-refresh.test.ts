import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultAutoRefreshIntervalSeconds,
  normalizeAutoRefreshIntervalSeconds,
} from "../src/services/AutoRefreshService";

test("auto refresh interval normalization keeps stop explicit", () => {
  assert.equal(normalizeAutoRefreshIntervalSeconds(0), 0);
  assert.equal(normalizeAutoRefreshIntervalSeconds(-10), 0);
});

test("auto refresh interval normalization clamps unsafe short values", () => {
  assert.equal(normalizeAutoRefreshIntervalSeconds(1), 30);
  assert.equal(normalizeAutoRefreshIntervalSeconds(29), 30);
});

test("auto refresh interval normalization preserves normal values", () => {
  assert.equal(normalizeAutoRefreshIntervalSeconds(300), 300);
  assert.equal(normalizeAutoRefreshIntervalSeconds(301.4), 301);
});

test("auto refresh interval normalization caps very long values", () => {
  assert.equal(normalizeAutoRefreshIntervalSeconds(90_000), 86_400);
});

test("auto refresh interval normalization falls back for invalid values", () => {
  assert.equal(normalizeAutoRefreshIntervalSeconds(undefined), defaultAutoRefreshIntervalSeconds);
  assert.equal(normalizeAutoRefreshIntervalSeconds(Number.NaN), defaultAutoRefreshIntervalSeconds);
});
