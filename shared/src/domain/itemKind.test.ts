import { describe, expect, it } from "vitest";
import { getItemKind, getItemKinds } from "./itemKind.js";

describe("getItemKind", () => {
  it("derives milestone, task and activity", () => {
    expect(getItemKind({ duration: 0 }, 0)).toBe("milestone");
    expect(getItemKind({ duration: 3 }, 0)).toBe("task");
    expect(getItemKind({ duration: 3 }, 2)).toBe("activity");
  });

  it("derives kinds for a list", () => {
    const kinds = getItemKinds([
      { id: "a", duration: 5, parentId: null },
      { id: "b", duration: 2, parentId: "a" },
      { id: "c", duration: 0, parentId: "a" },
    ]);
    expect(Object.fromEntries(kinds)).toEqual({ a: "activity", b: "task", c: "milestone" });
  });
});
