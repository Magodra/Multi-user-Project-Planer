import { describe, expect, it } from "vitest";
import { timeOrderedId } from "./support.js";

describe("timeOrderedId", () => {
  it("sorts in creation order, also within one millisecond", () => {
    const ids = Array.from({ length: 5000 }, () => timeOrderedId());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
