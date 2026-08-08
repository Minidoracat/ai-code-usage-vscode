import type { TimeZoneMode, TimeZoneState } from "../domain/types";

export const defaultTimeZoneMode: TimeZoneMode = "system";

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isTimeZoneMode(value: unknown): value is TimeZoneMode {
  return value === "system" || value === "utc" || value === "custom";
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(mode: TimeZoneMode = defaultTimeZoneMode, customTimeZone?: string): TimeZoneState {
  const system = systemTimeZone();
  const custom = customTimeZone?.trim() || undefined;
  const effectiveMode = mode === "custom" && !isValidTimeZone(custom) ? "system" : mode;
  const resolvedTimeZone = effectiveMode === "utc" ? "UTC" : effectiveMode === "custom" && custom ? custom : system;
  const offsetLabel = timeZoneOffsetLabel(resolvedTimeZone);

  return {
    mode: effectiveMode,
    systemTimeZone: system,
    customTimeZone: custom,
    resolvedTimeZone,
    label: `${resolvedTimeZone} ${offsetLabel}`,
    offsetLabel,
  };
}

export function zonedDateKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return dateKey(parts.year, parts.month, parts.day);
}

/**
 * Local-hour key for a timestamp, e.g. "2026-08-08T14" in the target zone.
 * zonedParts resolves the actual local wall-clock fields, so hour keys stay
 * contiguous across DST shifts (each local hour still gets its own bucket).
 */
/** Local-hour key for a timestamp, e.g. "2026-08-08T14" in the target zone. */
export function zonedHourKey(epochMs: number, timeZone: string): string {
  const parts = zonedParts(new Date(epochMs), timeZone);
  return `${dateKey(parts.year, parts.month, parts.day)}T${String(parts.hour).padStart(2, "0")}`;
}

/**
 * Precomputes local-hour boundaries for an ISO range so per-record bucketing
 * is a binary search, mirroring makeZonedDayBucketer. Keys are "YYYY-MM-DDTHH"
 * in the target time zone (zero-padded hour). Timestamps outside the
 * precomputed window fall back to zonedHourKey.
 */
/** Precomputes local-hour boundaries for an ISO range so per-record bucketing is a binary search. */
export function makeZonedHourBucketer(startIso: string, endIso: string, timeZone: string): (epochMs: number) => string {
  const keys: string[] = [];
  const boundaries: number[] = [];
  let lastBoundaryEnd = Number.NEGATIVE_INFINITY;
  try {
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      throw new Error("invalid range");
    }
    const firstMs = Math.min(startMs, endMs);
    const lastMs = Math.max(startMs, endMs);
    // Round the window start down to the local hour boundary, then walk one
    // local hour at a time. The hour count is bounded by the caller's
    // granularity choice (<= 48h ranges), plus a hard cap as a safety net.
    const maxPrecomputedHours = 192;
    const startParts = zonedParts(new Date(firstMs), timeZone);
    const cursor = zonedLocalTimeToUtc(startParts.year, startParts.month, startParts.day, startParts.hour, 0, 0, 0, timeZone).getTime();
    for (let index = 0; index < maxPrecomputedHours && cursor + index * 3_600_000 <= lastMs; index += 1) {
      const boundaryMs = cursor + index * 3_600_000;
      keys.push(zonedHourKey(boundaryMs, timeZone));
      boundaries.push(boundaryMs);
    }
    if (keys.length > 0) {
      const lastBoundary = boundaries[boundaries.length - 1];
      if (lastBoundary !== undefined) {
        lastBoundaryEnd = lastBoundary + 3_600_000;
      }
    }
  } catch {
    keys.length = 0;
    boundaries.length = 0;
    lastBoundaryEnd = Number.NEGATIVE_INFINITY;
  }
  return (epochMs: number): string => {
    const firstBoundary = boundaries[0];
    if (keys.length === 0 || firstBoundary === undefined || epochMs < firstBoundary || epochMs > lastBoundaryEnd) {
      return zonedHourKey(epochMs, timeZone);
    }
    let low = 0;
    let high = boundaries.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const boundary = boundaries[mid];
      if (boundary !== undefined && boundary <= epochMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const key = keys[found];
    return key ?? zonedHourKey(epochMs, timeZone);
  };
}

const maxPrecomputedBucketDays = 4_000;

/**
 * Precomputes local-day boundaries for a date-key range so per-record bucketing
 * is a binary search instead of an Intl.DateTimeFormat round-trip (~150µs each).
 * Timestamps outside the precomputed window fall back to zonedDateKey.
 */
export function makeZonedDayBucketer(startDate: string, endDate: string, timeZone: string): (epochMs: number) => string {
  const keys: string[] = [];
  const boundaries: number[] = [];
  let lastBoundaryEnd = Number.NEGATIVE_INFINITY;
  try {
    // Anchor the precompute window at the range end: when the range exceeds
    // the cap, the ancient days (which rarely hold data) fall back to the
    // per-record path instead of the recent ones.
    let firstKey = startDate;
    const spanDays = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
    if (Number.isFinite(spanDays) && spanDays > maxPrecomputedBucketDays) {
      firstKey = addDateKeyDays(endDate, -(maxPrecomputedBucketDays - 1));
    }
    for (let key = firstKey; key <= endDate && keys.length < maxPrecomputedBucketDays; key = addDateKeyDays(key, 1)) {
      keys.push(key);
      boundaries.push(new Date(zonedDateTimeToUtcIso(key, "start", timeZone)).getTime());
    }
    // Exotic calendars can break the bucketing assumptions: a skipped calendar
    // day (date-line change) makes boundaries non-monotonic, and a DST jump
    // across midnight makes a boundary resolve into the neighbouring day.
    // Either way the binary search would misbucket, so verify and fall back.
    for (let index = 0; index < boundaries.length; index += 1) {
      if (index > 0 && boundaries[index]! <= boundaries[index - 1]!) {
        throw new Error("non-monotonic day boundaries");
      }
      if (zonedDateKey(new Date(boundaries[index]!), timeZone) !== keys[index]) {
        throw new Error("day boundary resolves outside its own day");
      }
    }
    if (keys.length > 0) {
      lastBoundaryEnd = new Date(zonedDateTimeToUtcIso(keys[keys.length - 1]!, "end", timeZone)).getTime();
    }
  } catch {
    // Invalid date keys or broken boundary assumptions: leave the precomputed
    // window empty so every timestamp takes the per-record fallback below.
    keys.length = 0;
    boundaries.length = 0;
    lastBoundaryEnd = Number.NEGATIVE_INFINITY;
  }

  return (epochMs: number): string => {
    if (keys.length === 0 || epochMs < boundaries[0]! || epochMs > lastBoundaryEnd) {
      return zonedDateKey(new Date(epochMs), timeZone);
    }
    let low = 0;
    let high = boundaries.length - 1;
    let found = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (boundaries[mid]! <= epochMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return keys[found]!;
  };
}

export function zonedDateTimeToUtcIso(date: string, side: "start" | "end", timeZone: string): string {
  const parts = parseDateKey(date);
  const hour = side === "start" ? 0 : 23;
  const minute = side === "start" ? 0 : 59;
  const second = side === "start" ? 0 : 59;
  const millisecond = side === "start" ? 0 : 999;
  return zonedLocalTimeToUtc(parts.year, parts.month, parts.day, hour, minute, second, millisecond, timeZone).toISOString();
}

/**
 * Resolves a local "YYYY-MM-DDTHH" hour key to an ISO instant in the target
 * time zone: side "start" = HH:00:00.000, side "end" = HH:59:59.999.
 * Returns undefined for malformed keys or out-of-range hours.
 */
/** Resolves a local "YYYY-MM-DDTHH" hour key to an ISO instant (HH:00:00.000 start / HH:59:59.999 end). */
export function zonedDateTimeHourToUtcIso(dateHourKey: string, side: "start" | "end", timeZone: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(dateHourKey);
  if (!match) {
    return undefined;
  }
  const hour = Number(match[4]);
  if (hour > 23) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (side === "start") {
    return zonedLocalTimeToUtc(year, month, day, hour, 0, 0, 0, timeZone).toISOString();
  }
  return zonedLocalTimeToUtc(year, month, day, hour, 59, 59, 999, timeZone).toISOString();
}

export function addDateKeyDays(value: string, days: number): string {
  const parts = parseDateKey(value);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function startOfMonthDateKey(value: string): string {
  const parts = parseDateKey(value);
  return dateKey(parts.year, parts.month, 1);
}

export function startOfWeekDateKey(value: string): string {
  const parts = parseDateKey(value);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addDateKeyDays(value, -daysSinceMonday);
}

export function normalizeDateKey(value: string | undefined, timeZone: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (match) {
    const candidate = `${match[1]}-${match[2]}-${match[3]}`;
    return isValidDateKey(candidate) ? candidate : undefined;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return zonedDateKey(date, timeZone);
}

export function timeZoneOffsetLabel(timeZone: string, date = new Date()): string {
  const offset = offsetMs(date, timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const totalMinutes = Math.abs(Math.round(offset / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function zonedLocalTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const firstPass = utcGuess - offsetMs(new Date(utcGuess), timeZone);
  const secondPass = utcGuess - offsetMs(new Date(firstPass), timeZone);
  return new Date(secondPass);
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime() + date.getUTCMilliseconds();
}

function zonedParts(date: Date, timeZone: string): DateParts {
  const values: Partial<DateParts> = {};
  for (const part of dateFormatter(timeZone).formatToParts(date)) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute" || part.type === "second") {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = dateFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  dateFormatterCache.set(timeZone, formatter);
  return formatter;
}

function parseDateKey(value: string): { year: number; month: number; day: number } {
  if (!isValidDateKey(value)) {
    throw new Error(`Invalid date key: ${value}`);
  }
  return {
    year: Number(value.slice(0, 4)),
    month: Number(value.slice(5, 7)),
    day: Number(value.slice(8, 10)),
  };
}

function isValidDateKey(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
