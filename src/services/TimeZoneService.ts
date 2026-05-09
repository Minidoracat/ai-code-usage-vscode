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

export function zonedDateTimeToUtcIso(date: string, side: "start" | "end", timeZone: string): string {
  const parts = parseDateKey(date);
  const hour = side === "start" ? 0 : 23;
  const minute = side === "start" ? 0 : 59;
  const second = side === "start" ? 0 : 59;
  const millisecond = side === "start" ? 0 : 999;
  return zonedLocalTimeToUtc(parts.year, parts.month, parts.day, hour, minute, second, millisecond, timeZone).toISOString();
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

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
