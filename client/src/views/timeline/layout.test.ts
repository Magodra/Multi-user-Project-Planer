import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "@planning/shared";
import { addEntry, compactLines, linesIn, moveEntry, moveRow } from "./layout";

const entry = (
  id: string,
  placement: TimelineEntry["placement"],
  line: number,
  rowId = "r1",
): TimelineEntry => ({ id, rowId, itemId: `i-${id}`, planId: "p", placement, line });

describe("timeline layout", () => {
  it("counts and compacts lines per row and area", () => {
    const entries = [entry("a", "on", 0), entry("b", "on", 3), entry("c", "above", 2)];
    expect(linesIn(entries, "r1", "on")).toBe(4);
    expect(compactLines(entries).map((e) => [e.id, e.line])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 0],
    ]);
  });

  it("moves entries between lines and in and out of callouts", () => {
    const entries = [entry("a", "on", 0), entry("b", "on", 1)];
    // b becomes a callout below; its old line disappears.
    const below = moveEntry(entries, "b", { rowId: "r1", placement: "below", line: 0 });
    expect(below.map((e) => [e.id, e.placement, e.line])).toEqual([
      ["a", "on", 0],
      ["b", "below", 0],
    ]);
    // Dropping on the empty line after the last one opens a new line.
    const newLine = moveEntry(below, "b", { rowId: "r1", placement: "on", line: 1 });
    expect(newLine.find((e) => e.id === "b")).toMatchObject({ placement: "on", line: 1 });
    // To another row.
    expect(moveEntry(entries, "a", { rowId: "r2", placement: "on", line: 0 })[0]).toMatchObject({
      rowId: "r2",
      line: 0,
    });
  });

  it("adds a task once per row and reorders rows", () => {
    const entries = [entry("a", "on", 0)];
    const target = { rowId: "r1", placement: "above" as const, line: 0 };
    const added = addEntry(entries, { id: "x", itemId: "i-x", planId: "p" }, target);
    expect(added).toHaveLength(2);
    expect(addEntry(added, { id: "y", itemId: "i-x", planId: "p" }, target)).toBe(added);
    const rows = [
      { id: "r1", name: "One" },
      { id: "r2", name: "Two" },
    ];
    expect(moveRow(rows, "r2", -1).map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(moveRow(rows, "r1", -1)).toBe(rows);
  });
});
