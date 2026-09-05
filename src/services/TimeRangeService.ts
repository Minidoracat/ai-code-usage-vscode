import type { TimeRange, TimeRangeKind, TimeZoneState } from "../domain/types";
import {
  addDateKeyDays,
  isValidDateHourKey,
  normalizeDateKey,
  resolveTimeZone,
  startOfMonthDateKey,
  startOfWeekDateKey,
  zonedDateKey,
  zonedDateTimeHourToUtcIso,
  zonedDateTimeToUtcIso,
} from "./TimeZoneService";

export type Clock = () => Date;

export class TimeRangeService {
  public constructor(
    private readonly clock: Clock = () => new Date(),
    private readonly timeZone: TimeZoneState = resolveTimeZone(),
  ) {}

  public resolve(kind: TimeRangeKind, custom?: { start?: string; end?: string }): TimeRange {
    const now = this.clock();
    const zone = this.timeZone.resolvedTimeZone;
    const today = zonedDateKey(now, zone);
    if (kind === "custom") {
      return this.fromCustomKeys(custom);
    }

    if (kind === "today") {
      return this.fromDateKeys(kind, today, today);
    }

    if (kind === "yesterday") {
      const yesterday = addDateKeyDays(today, -1);
      return this.fromDateKeys(kind, yesterday, yesterday);
    }

    if (kind === "thisWeek") {
      return this.fromDateKeys(kind, startOfWeekDateKey(today), today);
    }

    if (kind === "lastWeek") {
      const endDate = addDateKeyDays(startOfWeekDateKey(today), -1);
      return this.fromDateKeys(kind, startOfWeekDateKey(endDate), endDate);
    }

    if (kind === "thisMonth") {
      return this.fromDateKeys(kind, startOfMonthDateKey(today), today);
    }

    if (kind === "lastMonth") {
      const endDate = addDateKeyDays(startOfMonthDateKey(today), -1);
      return this.fromDateKeys(kind, startOfMonthDateKey(endDate), endDate);
    }

    const exhaustiveKind: never = kind;
    throw new Error(`Unsupported time range kind: ${exhaustiveKind}`);
  }

  /**
   * Custom ranges accept "YYYY-MM-DD" (whole local day) or "YYYY-MM-DDTHH"
   * (local hour boundary, e.g. yesterday 18:00 -> today 18:00). Hour keys are
   * echoed back as startHour/endHour for UI display.
   */
/** Resolves custom ranges, accepting "YYYY-MM-DD" or "YYYY-MM-DDTHH" hour boundaries. */
  private fromCustomKeys(custom?: { start?: string; end?: string }): TimeRange {
    const zone = this.timeZone.resolvedTimeZone;
    const today = zonedDateKey(this.clock(), zone);
    const startHourKey = isValidDateHourKey(custom?.start);
    const endHourKey = isValidDateHourKey(custom?.end);
    const startDateKey = normalizeDateKey(custom?.start, zone) ?? today;
    const endDateKey = normalizeDateKey(custom?.end, zone) ?? today;
    const start = startHourKey
      ? zonedDateTimeHourToUtcIso(custom?.start as string, "start", zone)
      : zonedDateTimeToUtcIso(startDateKey, "start", zone);
    const end = endHourKey
      ? zonedDateTimeHourToUtcIso(custom?.end as string, "end", zone)
      : zonedDateTimeToUtcIso(endDateKey, "end", zone);
    return {
      kind: "custom",
      startDate: startDateKey,
      endDate: endDateKey,
      start: start ?? zonedDateTimeToUtcIso(startDateKey, "start", zone),
      end: end ?? zonedDateTimeToUtcIso(endDateKey, "end", zone),
      timeZone: this.timeZone,
      startHour: startHourKey ? custom?.start?.slice(-2) : undefined,
      endHour: endHourKey ? custom?.end?.slice(-2) : undefined,
    };
  }

  private fromDateKeys(kind: TimeRangeKind, startDate: string, endDate: string): TimeRange {
    const zone = this.timeZone.resolvedTimeZone;
    return {
      kind,
      startDate,
      endDate,
      start: zonedDateTimeToUtcIso(startDate, "start", zone),
      end: zonedDateTimeToUtcIso(endDate, "end", zone),
      timeZone: this.timeZone,
    };
  }
}

export function isWithinRange(iso: string | undefined, range: TimeRange): boolean {
  if (!iso) {
    return false;
  }
  const value = new Date(iso).getTime();
  return value >= new Date(range.start).getTime() && value <= new Date(range.end).getTime();
}

