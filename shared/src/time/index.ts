/**
 * The single home of all date/time logic (CLAUDE.md §5).
 *
 * - Storage is UTC; every function takes and returns ISO strings in UTC.
 * - `hours` and `days` durations are counted in working time according to the
 *   project's WorkingCalendar. Weeks, months and years are calendar units.
 * - The working calendar is evaluated in UTC.
 */
import type { Granularity, IsoDateTime, Schedule, WorkingCalendar } from "../types.js";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Guard against runaway loops on calendars without working days. */
const MAX_DAYS_SCANNED = 366 * 200;

export const DEFAULT_CALENDAR: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  workdayStartHour: 8,
  workdayEndHour: 16,
  holidays: [],
};

export function nowIso(): IsoDateTime {
  return new Date().toISOString();
}

export function parseIso(iso: IsoDateTime): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid timestamp: ${iso}`);
  return d;
}

export function toIso(date: Date | number): IsoDateTime {
  return new Date(date).toISOString();
}

export function isValidIso(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value);
}

export function compareIso(a: IsoDateTime, b: IsoDateTime): number {
  return parseIso(a).getTime() - parseIso(b).getTime();
}

export function minIso(values: IsoDateTime[]): IsoDateTime | null {
  return values.reduce<IsoDateTime | null>(
    (acc, v) => (acc === null || compareIso(v, acc) < 0 ? v : acc),
    null,
  );
}

export function maxIso(values: IsoDateTime[]): IsoDateTime | null {
  return values.reduce<IsoDateTime | null>(
    (acc, v) => (acc === null || compareIso(v, acc) > 0 ? v : acc),
    null,
  );
}

/** "YYYY-MM-DD" of a UTC date. */
export function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function addUtcMonths(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(date.getUTCDate(), lastDay);
  return new Date(
    Date.UTC(
      y,
      m,
      day,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export function isWorkingDay(date: Date, calendar: WorkingCalendar): boolean {
  return (
    calendar.workingDays.includes(date.getUTCDay()) && !calendar.holidays.includes(utcDateKey(date))
  );
}

function workdayBounds(day: Date, calendar: WorkingCalendar): [number, number] {
  const base = startOfUtcDay(day).getTime();
  return [
    base + calendar.workdayStartHour * MS_PER_HOUR,
    base + calendar.workdayEndHour * MS_PER_HOUR,
  ];
}

function assertCalendarUsable(calendar: WorkingCalendar): void {
  if (calendar.workingDays.length === 0) {
    throw new RangeError("Working calendar has no working days");
  }
  if (calendar.workdayEndHour <= calendar.workdayStartHour) {
    throw new RangeError("Working calendar has an empty working day");
  }
}

/** Snap a timestamp down to the start of its unit (week starts Monday). */
export function startOfUnit(iso: IsoDateTime, granularity: Granularity): IsoDateTime {
  const d = parseIso(iso);
  switch (granularity) {
    case "hours":
      return toIso(Math.floor(d.getTime() / MS_PER_HOUR) * MS_PER_HOUR);
    case "days":
      return toIso(startOfUtcDay(d));
    case "weeks": {
      const day = startOfUtcDay(d);
      const offset = (day.getUTCDay() + 6) % 7;
      return toIso(addUtcDays(day, -offset));
    }
    case "months":
      return toIso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    case "years":
      return toIso(Date.UTC(d.getUTCFullYear(), 0, 1));
  }
}

/** Snap to the nearest unit boundary (used for display and drag handling). */
export function snapToGranularity(iso: IsoDateTime, granularity: Granularity): IsoDateTime {
  const down = startOfUnit(iso, granularity);
  const up = addCalendarUnits(down, 1, granularity);
  const t = parseIso(iso).getTime();
  return t - parseIso(down).getTime() < parseIso(up).getTime() - t ? down : up;
}

/** Plain calendar arithmetic, ignoring working time (for scales and timelines). */
export function addCalendarUnits(
  iso: IsoDateTime,
  amount: number,
  granularity: Granularity,
): IsoDateTime {
  const d = parseIso(iso);
  switch (granularity) {
    case "hours":
      return toIso(d.getTime() + amount * MS_PER_HOUR);
    case "days":
      return toIso(addUtcDays(d, amount));
    case "weeks":
      return toIso(addUtcDays(d, amount * 7));
    case "months":
      return toIso(addUtcMonths(d, Math.round(amount)));
    case "years":
      return toIso(addUtcMonths(d, Math.round(amount) * 12));
  }
}

/** Move a timestamp forward to the next moment that is inside working hours. */
function nextWorkingMoment(t: number, calendar: WorkingCalendar): number {
  let day = startOfUtcDay(new Date(t));
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isWorkingDay(day, calendar)) {
      const [ws, we] = workdayBounds(day, calendar);
      if (t < ws) return ws;
      if (t < we) return t;
    }
    day = addUtcDays(day, 1);
    t = Math.max(t, day.getTime());
  }
  throw new RangeError("No working time found within scan limit");
}

/** Move a date forward to the start of the next working day (inclusive). */
function nextWorkingDay(day: Date, calendar: WorkingCalendar): Date {
  let d = startOfUtcDay(day);
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isWorkingDay(d, calendar)) return d;
    d = addUtcDays(d, 1);
  }
  throw new RangeError("No working day found within scan limit");
}

/**
 * End timestamp of a task that starts at `start` and lasts `duration` units.
 * Hours/days count working time; end is exclusive. Duration 0 → end = start.
 */
export function addDuration(
  start: IsoDateTime,
  duration: number,
  granularity: Granularity,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): IsoDateTime {
  if (duration < 0) throw new RangeError("Duration must not be negative");
  if (duration === 0) return parseIso(start).toISOString();
  switch (granularity) {
    case "hours": {
      assertCalendarUsable(calendar);
      let cursor = nextWorkingMoment(parseIso(start).getTime(), calendar);
      let remaining = Math.round(duration * 60) * MS_PER_MINUTE;
      for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
        const [, we] = workdayBounds(new Date(cursor), calendar);
        const available = we - cursor;
        if (remaining <= available) return toIso(cursor + remaining);
        remaining -= available;
        cursor = nextWorkingMoment(
          startOfUtcDay(new Date(cursor)).getTime() + MS_PER_DAY,
          calendar,
        );
      }
      throw new RangeError("Duration exceeds scan limit");
    }
    case "days": {
      assertCalendarUsable(calendar);
      let day = nextWorkingDay(parseIso(start), calendar);
      let remaining = Math.round(duration);
      for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
        if (isWorkingDay(day, calendar)) {
          remaining--;
          if (remaining === 0) return toIso(addUtcDays(day, 1));
        }
        day = addUtcDays(day, 1);
      }
      throw new RangeError("Duration exceeds scan limit");
    }
    case "weeks":
    case "months":
    case "years":
      return addCalendarUnits(start, duration, granularity);
  }
}

/** Inverse of `addDuration`: the duration between two timestamps in the given unit. */
export function durationBetween(
  start: IsoDateTime,
  end: IsoDateTime,
  granularity: Granularity,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): number {
  const s = parseIso(start);
  const e = parseIso(end);
  if (e.getTime() <= s.getTime()) return 0;
  switch (granularity) {
    case "hours": {
      let total = 0;
      let day = startOfUtcDay(s);
      for (let i = 0; i < MAX_DAYS_SCANNED && day.getTime() < e.getTime(); i++) {
        if (isWorkingDay(day, calendar)) {
          const [ws, we] = workdayBounds(day, calendar);
          const overlap = Math.min(we, e.getTime()) - Math.max(ws, s.getTime());
          if (overlap > 0) total += overlap;
        }
        day = addUtcDays(day, 1);
      }
      return Math.round((total / MS_PER_HOUR) * 100) / 100;
    }
    case "days": {
      let count = 0;
      let day = startOfUtcDay(s);
      for (let i = 0; i < MAX_DAYS_SCANNED && day.getTime() < e.getTime(); i++) {
        if (isWorkingDay(day, calendar)) count++;
        day = addUtcDays(day, 1);
      }
      return count;
    }
    case "weeks":
      return Math.round((e.getTime() - s.getTime()) / (7 * MS_PER_DAY));
    case "months":
    case "years": {
      let months =
        (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
      if (parseIso(addCalendarUnits(start, months, "months")).getTime() > e.getTime()) months--;
      const anchor = parseIso(addCalendarUnits(start, months, "months")).getTime();
      const next = parseIso(addCalendarUnits(start, months + 1, "months")).getTime();
      const fraction = (e.getTime() - anchor) / (next - anchor);
      const exact = months + fraction;
      return granularity === "months" ? Math.round(exact) : Math.round(exact / 12);
    }
  }
}

/** Build a schedule from a start and a duration. */
export function makeSchedule(
  start: IsoDateTime,
  duration: number,
  granularity: Granularity,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Schedule {
  const snapped = startOfUnit(start, granularity);
  return {
    start: snapped,
    end: addDuration(snapped, duration, granularity, calendar),
    duration,
    granularity,
  };
}

/** Recompute duration from start/end (e.g. after a resize in the Gantt). */
export function scheduleFromRange(
  start: IsoDateTime,
  end: IsoDateTime,
  granularity: Granularity,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Schedule {
  const duration = durationBetween(start, end, granularity, calendar);
  return makeSchedule(start, duration, granularity, calendar);
}

/** The span covering all given schedules (used to roll up activities). */
export function spanOf(
  schedules: Schedule[],
  granularity: Granularity,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Schedule | null {
  const start = minIso(schedules.map((s) => s.start));
  const end = maxIso(schedules.map((s) => s.end));
  if (start === null || end === null) return null;
  return { start, end, duration: durationBetween(start, end, granularity, calendar), granularity };
}

/** Signed difference end-to-end in calendar days (positive = later). Used for variance. */
export function varianceInDays(actual: IsoDateTime, reference: IsoDateTime): number {
  return Math.round((parseIso(actual).getTime() - parseIso(reference).getTime()) / MS_PER_DAY);
}

/** Calendar-day difference, not working-time aware. */
export function calendarDaysBetween(start: IsoDateTime, end: IsoDateTime): number {
  return (parseIso(end).getTime() - parseIso(start).getTime()) / MS_PER_DAY;
}

/** Generate the tick boundaries of a scale between two timestamps. */
export function scaleTicks(
  start: IsoDateTime,
  end: IsoDateTime,
  granularity: Granularity,
  maxTicks = 2000,
): IsoDateTime[] {
  const ticks: IsoDateTime[] = [];
  let cursor = startOfUnit(start, granularity);
  while (compareIso(cursor, end) <= 0 && ticks.length < maxTicks) {
    ticks.push(cursor);
    cursor = addCalendarUnits(cursor, 1, granularity);
  }
  return ticks;
}

/** Fraction (0..1) of `iso` within [start, end]. Used to position bars. */
export function positionInRange(iso: IsoDateTime, start: IsoDateTime, end: IsoDateTime): number {
  const s = parseIso(start).getTime();
  const span = parseIso(end).getTime() - s;
  if (span <= 0) return 0;
  return (parseIso(iso).getTime() - s) / span;
}

/** Convert a JS Date coming from a UI library to an ISO string in UTC. */
export function fromDate(date: Date): IsoDateTime {
  return date.toISOString();
}

/** Convert an ISO string to a JS Date for a UI library. */
export function toDate(iso: IsoDateTime): Date {
  return parseIso(iso);
}

/** Format for display in the user's time zone, at the precision of the granularity. */
export function formatForDisplay(
  iso: IsoDateTime,
  granularity: Granularity,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const base: Intl.DateTimeFormatOptions = {
    timeZone: options.timeZone ?? (granularity === "hours" ? undefined : "UTC"),
  };
  const byUnit: Record<Granularity, Intl.DateTimeFormatOptions> = {
    hours: { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" },
    days: { year: "numeric", month: "short", day: "2-digit" },
    weeks: { year: "numeric", month: "short", day: "2-digit" },
    months: { year: "numeric", month: "long" },
    years: { year: "numeric" },
  };
  return new Intl.DateTimeFormat(options.locale, { ...base, ...byUnit[granularity] }).format(
    parseIso(iso),
  );
}

/** "YYYY-MM-DD" for display in tables and reports (UTC, deterministic). */
export function formatDateKey(iso: IsoDateTime): string {
  return utcDateKey(parseIso(iso));
}

/** Last instant (inclusive) shown for an exclusive end; used by calendar UIs. */
export function inclusiveEnd(end: IsoDateTime): IsoDateTime {
  return toIso(parseIso(end).getTime() - 1);
}

/**
 * UI libraries (Gantt, calendar) render in the browser's local time. Items
 * planned in days or coarser are shown as "floating" dates so they land on
 * the same calendar day for every user; hour items keep their real instant.
 */
export function toDisplayDate(iso: IsoDateTime, granularity: Granularity): Date {
  const d = parseIso(iso);
  if (granularity === "hours") return d;
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
  );
}

/** Inverse of `toDisplayDate`, for values coming back from a UI library. */
export function fromDisplayDate(date: Date, granularity: Granularity): IsoDateTime {
  if (granularity === "hours") return date.toISOString();
  return toIso(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    ),
  );
}

/** "YYYY-MM-DD" for an <input type="date"> value from an ISO timestamp (UTC date). */
export function toDateInputValue(iso: IsoDateTime): string {
  return utcDateKey(parseIso(iso));
}

/** ISO timestamp (UTC midnight) from an <input type="date"> value. */
export function fromDateInputValue(value: string): IsoDateTime {
  return `${value}T00:00:00.000Z`;
}

/** "YYYY-MM-DDTHH:mm" (UTC) for an <input type="datetime-local"> value. */
export function toDateTimeInputValue(iso: IsoDateTime): string {
  return parseIso(iso).toISOString().slice(0, 16);
}

/** ISO timestamp from an <input type="datetime-local"> value interpreted as UTC. */
export function fromDateTimeInputValue(value: string): IsoDateTime {
  return parseIso(`${value}:00.000Z`).toISOString();
}
