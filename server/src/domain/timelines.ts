/** Timeline rules (CLAUDE.md §7 "Timelines"). Pure logic, no I/O. */
import type { TimelineEntry } from "@planning/shared";

/**
 * Entries stored before placement and lines existed are bars on the timeline,
 * spread over three lines per row in their order (as they used to be drawn).
 */
export function normalizeTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  const perRow = new Map<string, number>();
  return entries.map((e) => {
    const index = perRow.get(e.rowId) ?? 0;
    perRow.set(e.rowId, index + 1);
    return {
      ...e,
      placement: e.placement ?? "on",
      line: typeof e.line === "number" ? e.line : index % 3,
    };
  });
}
