/**
 * Placement of timeline entries in a row: callouts above the timeline, bars on
 * it, callouts below. Each area has lines; moving entries keeps the lines of
 * every area numbered 0..n-1 without gaps.
 */
import type { TimelineEntry, TimelinePlacement, TimelineRow } from "@planning/shared";

export const PLACEMENTS: TimelinePlacement[] = ["above", "on", "below"];

export interface EntryTarget {
  rowId: string;
  placement: TimelinePlacement;
  line: number;
}

/** Number of lines in use in one area of a row. */
export function linesIn(
  entries: TimelineEntry[],
  rowId: string,
  placement: TimelinePlacement,
): number {
  return entries
    .filter((e) => e.rowId === rowId && e.placement === placement)
    .reduce((n, e) => Math.max(n, e.line + 1), 0);
}

/** Renumber the lines of every area so that no line is left empty. */
export function compactLines(entries: TimelineEntry[]): TimelineEntry[] {
  const used = new Map<string, number[]>();
  const key = (e: TimelineEntry) => `${e.rowId}|${e.placement}`;
  for (const e of entries) used.set(key(e), [...(used.get(key(e)) ?? []), e.line]);
  const renumber = new Map(
    [...used].map(([k, lines]) => [k, [...new Set(lines)].sort((a, b) => a - b)] as const),
  );
  return entries.map((e) => ({ ...e, line: renumber.get(key(e))!.indexOf(e.line) }));
}

/** Move an entry to a row, area and line. */
export function moveEntry(
  entries: TimelineEntry[],
  entryId: string,
  target: EntryTarget,
): TimelineEntry[] {
  return compactLines(entries.map((e) => (e.id === entryId ? { ...e, ...target } : e)));
}

/** Add a task at a row, area and line (once per row). */
export function addEntry(
  entries: TimelineEntry[],
  entry: Omit<TimelineEntry, keyof EntryTarget>,
  target: EntryTarget,
): TimelineEntry[] {
  if (entries.some((e) => e.itemId === entry.itemId && e.rowId === target.rowId)) return entries;
  return compactLines([...entries, { ...entry, ...target }]);
}

/** Move a row one place up or down. */
export function moveRow(rows: TimelineRow[], rowId: string, direction: -1 | 1): TimelineRow[] {
  const index = rows.findIndex((r) => r.id === rowId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
