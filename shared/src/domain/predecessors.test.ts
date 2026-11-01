import { describe, expect, it } from "vitest";
import { formatPredecessors, parsePredecessors } from "./predecessors.js";

describe("predecessor notation", () => {
  it("parses type, lag, lead and units", () => {
    expect(parsePredecessors("4FS+3d; 2ss-1.5w, 7; 9FF+2")).toEqual({
      ok: true,
      predecessors: [
        { taskNumber: 4, type: "FS", lag: 3, lagUnit: "days" },
        { taskNumber: 2, type: "SS", lag: -1.5, lagUnit: "weeks" },
        { taskNumber: 7, type: "FS", lag: 0, lagUnit: null },
        { taskNumber: 9, type: "FF", lag: 2, lagUnit: null },
      ],
    });
    expect(parsePredecessors("3SF-4h; 5 FS + 1mo")).toMatchObject({
      ok: true,
      predecessors: [
        { taskNumber: 3, type: "SF", lag: -4, lagUnit: "hours" },
        { taskNumber: 5, type: "FS", lag: 1, lagUnit: "months" },
      ],
    });
    expect(parsePredecessors("  ")).toEqual({ ok: true, predecessors: [] });
  });

  it("explains invalid input", () => {
    expect(parsePredecessors("4XX")).toMatchObject({ ok: false });
    expect(parsePredecessors("4FS+3q")).toEqual({
      ok: false,
      error: "Unknown lag unit 'q'; use h, d, w, mo or y",
    });
    expect(parsePredecessors("4; 4FS")).toMatchObject({ ok: false });
  });

  it("formats compactly and round-trips", () => {
    const text = "2SS-1w; 4FS+3d; 7; 9FF";
    const parsed = parsePredecessors(text);
    expect(parsed.ok && formatPredecessors(parsed.predecessors)).toBe(text);
  });
});
