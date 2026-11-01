/**
 * Timeline scale of the Gantt: a unit per column and a column width. Zooming
 * changes the width and steps to the next unit at the limits. Library-neutral.
 */
export const SCALE_UNITS = ["hours", "days", "weeks", "months", "quarters", "years"] as const;
export type ScaleUnit = (typeof SCALE_UNITS)[number];

export interface TimeScale {
  unit: ScaleUnit;
  /** Column width in pixels. */
  columnWidth: number;
}

const UNIT: Record<ScaleUnit, { days: number; min: number; max: number; initial: number }> = {
  hours: { days: 1 / 24, min: 20, max: 90, initial: 32 },
  days: { days: 1, min: 18, max: 90, initial: 30 },
  weeks: { days: 7, min: 36, max: 140, initial: 60 },
  months: { days: 30.44, min: 40, max: 180, initial: 70 },
  quarters: { days: 91.31, min: 50, max: 220, initial: 90 },
  years: { days: 365.25, min: 50, max: 400, initial: 90 },
};

const STEP = 1.25;

export function defaultScale(unit: ScaleUnit): TimeScale {
  return { unit, columnWidth: UNIT[unit].initial };
}

export function unitDays(unit: ScaleUnit): number {
  return UNIT[unit].days;
}

const clamp = (unit: ScaleUnit, width: number) =>
  Math.round(Math.min(UNIT[unit].max, Math.max(UNIT[unit].min, width)));

/** Zoom in (+1) or out (-1), keeping the pixels per day when the unit changes. */
export function zoomScale(scale: TimeScale, direction: 1 | -1): TimeScale {
  const width = direction > 0 ? scale.columnWidth * STEP : scale.columnWidth / STEP;
  const index = SCALE_UNITS.indexOf(scale.unit);
  const { min, max } = UNIT[scale.unit];
  const next =
    width > max ? SCALE_UNITS[index - 1] : width < min ? SCALE_UNITS[index + 1] : scale.unit;
  if (!next) return { unit: scale.unit, columnWidth: clamp(scale.unit, width) };
  const pxPerDay = width / UNIT[scale.unit].days;
  return { unit: next, columnWidth: clamp(next, pxPerDay * UNIT[next].days) };
}

/** The finest scale that shows `spanDays` in `widthPx` without scrolling. */
export function fitScale(spanDays: number, widthPx: number): TimeScale {
  const pxPerDay = widthPx / Math.max(spanDays, 1 / 24);
  for (const unit of SCALE_UNITS) {
    const width = pxPerDay * UNIT[unit].days;
    if (width >= UNIT[unit].min) return { unit, columnWidth: clamp(unit, width) };
  }
  return { unit: "years", columnWidth: UNIT.years.min };
}

export function canZoom(scale: TimeScale, direction: 1 | -1): boolean {
  const z = zoomScale(scale, direction);
  return z.unit !== scale.unit || z.columnWidth !== scale.columnWidth;
}
