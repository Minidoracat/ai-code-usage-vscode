import type { TimeRange, TimeRangeKind, TimeZoneState } from "../domain/types";
import {
  addDateKeyDays,
  normalizeDateKey,
  resolveTimeZone,
  startOfMonthDateKey,
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

    if (kind === "last7Days") {
      return this.fromDateKeys(kind, addDateKeyDays(today, -6), today);
    }

    if (kind === "last30Days") {
      return this.fromDateKeys(kind, addDateKeyDays(today, -29), today);
    }

    return this.fromDateKeys(kind, startOfMonthDateKey(today), today);
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
