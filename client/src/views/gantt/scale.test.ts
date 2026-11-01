import { describe, expect, it } from "vitest";
import { canZoom, defaultScale, fitScale, zoomScale } from "./scale";

describe("timeline scale", () => {
  it("widens columns and steps to a finer unit at the limit", () => {
    expect(zoomScale(defaultScale("days"), 1)).toEqual({ unit: "days", columnWidth: 38 });
    expect(zoomScale({ unit: "days", columnWidth: 90 }, 1).unit).toBe("hours");
    expect(zoomScale({ unit: "weeks", columnWidth: 36 }, -1).unit).toBe("months");
  });

  it("stops at the finest and coarsest scale", () => {
    expect(canZoom({ unit: "hours", columnWidth: 90 }, 1)).toBe(false);
    expect(canZoom({ unit: "years", columnWidth: 50 }, -1)).toBe(false);
  });

  it("fits a span into the available width with the finest readable unit", () => {
    expect(fitScale(30, 900)).toEqual({ unit: "days", columnWidth: 30 });
    expect(fitScale(365, 900)).toEqual({ unit: "months", columnWidth: 75 });
    expect(fitScale(1000, 900).unit).toBe("quarters");
    expect(fitScale(3650, 900).unit).toBe("years");
  });
});
