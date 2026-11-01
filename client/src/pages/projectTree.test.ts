import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@planning/shared";
import {
  buildProjectTree,
  parentOptions,
  projectPath,
  subtreeIds,
  withoutInactiveSubtrees,
} from "./projectTree";

const p = (id: string, parentProjectId: string | null, canEdit = true): ProjectSummary =>
  ({ id, name: id.toUpperCase(), parentProjectId, canEdit, active: true }) as ProjectSummary;

const projects = [p("a", null), p("b", "a"), p("c", "b"), p("d", "hidden", false)];

describe("project tree", () => {
  it("nests subprojects and lifts projects with an unknown parent to the top", () => {
    const tree = buildProjectTree(projects);
    expect(tree.map((n) => n.project.id)).toEqual(["a", "d"]);
    expect(tree[0]!.children[0]!.children[0]!.project.id).toBe("c");
  });

  it("offers only editable parents outside the project's own subtree", () => {
    expect(subtreeIds(projects, "b")).toEqual(new Set(["b", "c"]));
    expect(parentOptions(projects, subtreeIds(projects, "b"))).toEqual([{ id: "a", label: "A" }]);
    expect(projectPath(projects, "c")).toBe("A / B / C");
  });
});

describe("hiding inactive projects", () => {
  it("leaves out an inactive project together with all its subprojects", () => {
    const list = [
      p("a", null),
      { ...p("b", "a"), active: false },
      p("c", "b"),
      p("e", "c"),
      p("f", "a"),
    ];
    expect(withoutInactiveSubtrees(list).map((x) => x.id)).toEqual(["a", "f"]);
  });
});
