import { describe, expect, it } from "vitest";
import { itemBadges } from "./status";

const base = {
  external: false,
  recipients: [],
  reference: false,
  linkType: null,
  pending: false,
  agreementState: "NONE" as const,
  endVarianceDays: null,
};

describe("itemBadges", () => {
  it("shows nothing for a plain internal task", () => {
    expect(itemBadges(base)).toEqual([]);
  });

  it("marks references with their link type and external tasks with recipients", () => {
    expect(
      itemBadges({ ...base, reference: true, linkType: "AGREEMENT" }).map((b) => b.label),
    ).toEqual(["REF", "AGR"]);
    expect(
      itemBadges({ ...base, reference: true, linkType: "MONITOR" }).map((b) => b.label),
    ).toEqual(["REF", "MON"]);
    const ext = itemBadges({ ...base, external: true, recipients: ["Customer", "Site (Sub)"] });
    expect(ext[0]?.title).toBe("External task used in 2 other plan(s):\n• Customer\n• Site (Sub)");
    expect(ext.map((b) => b.label)).toEqual(["EXT 2"]);
  });

  it("shows pending, rejected and variance against agreed", () => {
    const labels = itemBadges({
      ...base,
      pending: true,
      agreementState: "REJECTED",
      endVarianceDays: 3,
    }).map((b) => b.label);
    expect(labels).toEqual(["PEND", "REJ", "+3d"]);
    expect(itemBadges({ ...base, endVarianceDays: -2 })[0]?.className).toBe("pp-b-early");
  });
});
