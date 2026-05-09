import type { TimeRange, TimeRangeKind, TimeZoneState } from "../domain/types";
import {
  addDateKeyDays,
  normalizeDateKey,
  resolveTimeZone,
  startOfMonthDateKey,
  startOfWeekDateKey,
  zonedDateKey,
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
      return this.fromDateKeys(
        kind,
        normalizeDateKey(custom?.start, zone) ?? today,
        normalizeDateKey(custom?.end, zone) ?? today,
      );
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
