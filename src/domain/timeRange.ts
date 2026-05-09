import type { TimeRangeKind } from "./types";

export const defaultTimeRangeKind: TimeRangeKind = "thisWeek";

export const timeRangeKinds: readonly TimeRangeKind[] = [
  "today",
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
  "custom",
];

export function isTimeRangeKind(value: unknown): value is TimeRangeKind {
  return typeof value === "string" && timeRangeKinds.includes(value as TimeRangeKind);
}

export function normalizeTimeRangeKind(value: unknown, fallback: TimeRangeKind = defaultTimeRangeKind): TimeRangeKind {
  if (isTimeRangeKind(value)) {
    return value;
  }
  return fallback;
}
