import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeTimeRangeKind } from "../src/domain/timeRange";

test("invalid default range values fall back safely", () => {
  assert.equal(normalizeTimeRangeKind("futureRange"), "thisWeek");
  assert.equal(normalizeTimeRangeKind("last7Days"), "thisWeek");
  assert.equal(normalizeTimeRangeKind("last30Days"), "thisWeek");
});
