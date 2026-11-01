import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR,
  addDuration,
  addWorkingLag,
  durationBetween,
  fromDisplayDate,
  toDisplayDate,
  makeSchedule,
  snapToGranularity,
  spanOf,
  startOfUnit,
} from "./index.js";
import type { WorkingCalendar } from "../types.js";

// 2026-01-05 is a Monday.
const MONDAY = "2026-01-05T00:00:00.000Z";

describe("addDuration", () => {
  it("returns start for zero duration (milestone)", () => {
    expect(addDuration(MONDAY, 0, "days")).toBe(MONDAY);
  });

  it("counts working days and skips weekends", () => {
    // Mon + 5 working days = end of Friday → Saturday 00:00.
    expect(addDuration(MONDAY, 5, "days")).toBe("2026-01-10T00:00:00.000Z");
    // Mon + 6 working days ends on the next Monday.
    expect(addDuration(MONDAY, 6, "days")).toBe("2026-01-13T00:00:00.000Z");
  });

  it("skips holidays", () => {
    const cal: WorkingCalendar = { ...DEFAULT_CALENDAR, holidays: ["2026-01-06"] };
    expect(addDuration(MONDAY, 2, "days", cal)).toBe("2026-01-08T00:00:00.000Z");
  });

  it("counts working hours across days", () => {
    // 08:00–16:00 working day: 10 h from Mon 08:00 ends Tue 10:00.
    expect(addDuration("2026-01-05T08:00:00.000Z", 10, "hours")).toBe("2026-01-06T10:00:00.000Z");
    // Starting outside working hours moves to the next working moment.
    expect(addDuration("2026-01-05T17:00:00.000Z", 1, "hours")).toBe("2026-01-06T09:00:00.000Z");
  });

  it("uses calendar units for weeks, months and years", () => {
    expect(addDuration(MONDAY, 2, "weeks")).toBe("2026-01-19T00:00:00.000Z");
    expect(addDuration("2026-01-31T00:00:00.000Z", 1, "months")).toBe("2026-02-28T00:00:00.000Z");
    expect(addDuration("2026-01-01T00:00:00.000Z", 2, "years")).toBe("2028-01-01T00:00:00.000Z");
  });

  it("rejects negative durations and unusable calendars", () => {
    expect(() => addDuration(MONDAY, -1, "days")).toThrow(RangeError);
    expect(() => addDuration(MONDAY, 1, "days", { ...DEFAULT_CALENDAR, workingDays: [] })).toThrow(
      RangeError,
    );
  });
});

describe("durationBetween", () => {
  it("is the inverse of addDuration", () => {
    for (const [d, g] of [
      [7, "days"],
      [13, "hours"],
      [3, "weeks"],
      [5, "months"],
      [2, "years"],
    ] as const) {
      const start = g === "hours" ? "2026-01-05T08:00:00.000Z" : MONDAY;
      expect(durationBetween(start, addDuration(start, d, g), g)).toBe(d);
    }
  });

  it("returns zero for empty or inverted ranges", () => {
    expect(durationBetween(MONDAY, MONDAY, "days")).toBe(0);
    expect(durationBetween("2026-02-01T00:00:00.000Z", MONDAY, "days")).toBe(0);
  });
});

describe("snapping", () => {
  it("snaps down to unit starts (weeks start Monday)", () => {
    expect(startOfUnit("2026-01-08T13:45:00.000Z", "weeks")).toBe(MONDAY);
    expect(startOfUnit("2026-03-17T13:45:00.000Z", "months")).toBe("2026-03-01T00:00:00.000Z");
    expect(startOfUnit("2026-03-17T13:45:00.000Z", "hours")).toBe("2026-03-17T13:00:00.000Z");
  });

  it("snaps to the nearest boundary", () => {
    expect(snapToGranularity("2026-01-05T13:00:00.000Z", "days")).toBe("2026-01-06T00:00:00.000Z");
    expect(snapToGranularity("2026-01-05T11:00:00.000Z", "days")).toBe(MONDAY);
  });
});

describe("schedules", () => {
  it("builds a schedule snapped to the granularity", () => {
    expect(makeSchedule("2026-01-05T10:00:00.000Z", 1, "days")).toEqual({
      start: MONDAY,
      end: "2026-01-06T00:00:00.000Z",
      duration: 1,
      granularity: "days",
    });
  });

  it("spans child schedules", () => {
    const a = makeSchedule(MONDAY, 2, "days");
    const b = makeSchedule("2026-01-08T00:00:00.000Z", 2, "days");
    expect(spanOf([a, b], "days")).toEqual({
      start: MONDAY,
      end: "2026-01-10T00:00:00.000Z",
      duration: 5,
      granularity: "days",
    });
    expect(spanOf([], "days")).toBeNull();
  });
});

describe("display dates", () => {
  it("round-trips floating dates for day granularity", () => {
    const d = toDisplayDate(MONDAY, "days");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 0, 5]);
    expect(fromDisplayDate(d, "days")).toBe(MONDAY);
    expect(fromDisplayDate(toDisplayDate("2026-01-05T09:30:00.000Z", "hours"), "hours")).toBe(
      "2026-01-05T09:30:00.000Z",
    );
  });
});

describe("addWorkingLag", () => {
  const at = (d: string, h = "00") => `2026-01-${d}T${h}:00:00.000Z`; // 2026-01-05 is a Monday
  const friday = at("10"); // end of a task finishing on Friday the 9th

  it("counts working days, skipping weekends, both ways", () => {
    expect(addWorkingLag(friday, 2, "days")).toBe(at("14")); // Mon, Tue → Wednesday
    expect(addWorkingLag(friday, -2, "days")).toBe(at("08")); // Fri, Thu → Thursday
    expect(addWorkingLag(friday, 1, "weeks")).toBe(at("17")); // 5 working days
    expect(addWorkingLag(friday, 0, "days")).toBe(friday);
  });

  it("respects holidays", () => {
    const calendar = { ...DEFAULT_CALENDAR, holidays: ["2026-01-12"] };
    expect(addWorkingLag(friday, 1, "days", calendar)).toBe(at("14"));
  });

  it("counts working hours, both ways", () => {
    expect(addWorkingLag(at("09", "16"), 2, "hours")).toBe(at("12", "10")); // Fri 16:00 → Mon 10:00
    expect(addWorkingLag(at("09", "10"), -3, "hours")).toBe(at("08", "15")); // Fri 10:00 → Thu 15:00
  });

  it("keeps months as calendar units", () => {
    expect(addWorkingLag(at("10"), 1, "months")).toBe("2026-02-10T00:00:00.000Z");
  });
});
