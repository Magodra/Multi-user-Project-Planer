import { describe, expect, it } from "vitest";
import {
  DEFAULT_CALENDAR,
  type BaselineDefinition,
  type BaselineItem,
  type Plan,
  type PlanItemReference,
  type PlanLink,
  type Project,
  type Task,
} from "@planning/shared";
import {
  assertAcceptanceGranularity,
  assertApprovalOrigin,
  canDecide,
  requiredApprovals,
  resolveStatus,
} from "./approvals.js";
import {
  assertBaselineMutable,
  assertBranchEditable,
  compareAgainst,
  mergeBaselineItems,
} from "./baselines.js";
import { ForbiddenError, RuleViolationError } from "./errors.js";
import {
  assertCanAddSubtask,
  assertNoCycle,
  assertScheduleEditable,
  rollUpActivities,
} from "./items.js";
import {
  assertNoDependencyCycle,
  assertNotOwnActivity,
  missingTaskNumbers,
  reorderSiblings,
} from "./dependencies.js";
import { assertValidProjectParent, normalizeProject } from "./projects.js";
import { carryOverAgreedValues, effectiveLinkType } from "./links.js";
import { can, effectiveRoles } from "./permissions.js";

const NOW = "2026-01-05T00:00:00.000Z";
const meta = (id: string) => ({
  id,
  version: 1,
  createdAt: NOW,
  createdBy: "u",
  updatedAt: NOW,
  updatedBy: "u",
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  ...meta(id),
  projectId: "pr",
  planId: "A",
  parentId: null,
  taskNumber: 1,
  name: id,
  notes: "",
  sortOrder: 0,
  ownership: "INTERNAL",
  agreementState: "NONE",
  start: NOW,
  end: "2026-01-06T00:00:00.000Z",
  duration: 1,
  granularity: "days",
  ...extra,
});

const plan = (id: string, ownerPartyId: string | null = null): Plan => ({
  ...meta(id),
  projectId: "pr",
  name: id,
  planType: "internal",
  description: "",
  ownerPartyId,
});

const ref = (id: string, itemId: string, planId: string, ownerPlanId = "A"): PlanItemReference => ({
  ...meta(id),
  projectId: "pr",
  planId,
  itemId,
  ownerPlanId,
  taskNumber: 1,
  parentId: null,
  sortOrder: 0,
  agreementState: "NONE",
});

const link = (
  type: PlanLink["type"],
  fromPlanId: string,
  toPlanId: string,
  extra: Partial<PlanLink> = {},
): PlanLink => ({
  ...meta(`${fromPlanId}-${toPlanId}`),
  projectId: "pr",
  type,
  fromPlanId,
  toPlanId,
  referenceId: null,
  partyIds: [],
  ...extra,
});

const definition = (extra: Partial<BaselineDefinition> = {}): BaselineDefinition => ({
  ...meta("def"),
  projectId: "pr",
  name: "Agreed",
  track: "AGREED",
  acceptFrom: "CURRENT",
  requiresApproval: true,
  approvers: ["PLAN_OWNER"],
  externalItemRule: "OWNER_AND_RECIPIENTS",
  granularityOfAcceptance: "BATCH",
  lockOnAccept: true,
  allowBranching: true,
  ...extra,
});

const plans = new Map(["A", "B", "C"].map((id) => [id, plan(id)]));

describe("requiredApprovals", () => {
  it("requires only the plan's approvers for internal items", () => {
    const result = requiredApprovals({
      planId: "A",
      definition: definition(),
      items: [{ itemId: "t1", ownerPlanId: "A", ownership: "INTERNAL", projectId: "pr" }],
      references: [],
      links: [],
      plans,
    });
    expect(result.map((r) => r.planId)).toEqual(["A"]);
  });

  it("requires owner and all recipients for external items", () => {
    const result = requiredApprovals({
      planId: "A",
      definition: definition(),
      items: [{ itemId: "t1", ownerPlanId: "A", ownership: "EXTERNAL", projectId: "pr" }],
      references: [ref("r1", "t1", "B"), ref("r2", "t1", "C")],
      links: [],
      plans,
    });
    expect(result.map((r) => r.planId)).toEqual(["A", "B", "C"]);
  });

  it("adds every party to an AGREEMENT link", () => {
    const result = requiredApprovals({
      planId: "A",
      definition: definition({ externalItemRule: "OWNER_ONLY" }),
      items: [{ itemId: "t1", ownerPlanId: "A", ownership: "EXTERNAL", projectId: "pr" }],
      references: [ref("r1", "t1", "B")],
      links: [link("AGREEMENT", "A", "B", { partyIds: ["supplier"] })],
      plans,
    });
    expect(result.map((r) => `${r.planId}:${r.partyId ?? "-"}`)).toEqual([
      "A:-",
      "B:-",
      "B:supplier",
    ]);
  });

  it("ignores MONITOR links and returns nothing when approval is not required", () => {
    const base = {
      planId: "A",
      items: [{ itemId: "t1", ownerPlanId: "A", ownership: "EXTERNAL" as const, projectId: "pr" }],
      references: [ref("r1", "t1", "B")],
      links: [link("MONITOR", "A", "B")],
      plans,
    };
    expect(
      requiredApprovals({ ...base, definition: definition({ externalItemRule: "OWNER_ONLY" }) }),
    ).toHaveLength(1);
    expect(
      requiredApprovals({ ...base, definition: definition({ requiresApproval: false }) }),
    ).toEqual([]);
  });

  it("tags plan approvals with the plan's owning party", () => {
    const result = requiredApprovals({
      planId: "A",
      definition: definition(),
      items: [],
      references: [],
      links: [],
      plans: new Map([["A", plan("A", "teamA")]]),
    });
    expect(result[0]?.partyId).toBe("teamA");
  });
});

describe("change request status", () => {
  it("rejects on any rejection and approves when all approve", () => {
    expect(resolveStatus([{ status: "APPROVED" }, { status: "PENDING" }])).toBe("PENDING");
    expect(resolveStatus([{ status: "APPROVED" }, { status: "REJECTED" }])).toBe("REJECTED");
    expect(resolveStatus([{ status: "APPROVED" }, { status: "APPROVED" }])).toBe("APPROVED");
  });

  it("only allows approvals from the UI", () => {
    expect(() => assertApprovalOrigin("UI")).not.toThrow();
    expect(() => assertApprovalOrigin("MCP")).toThrow(ForbiddenError);
  });

  it("lets role holders or party representatives decide", () => {
    const approval = { roles: ["PLAN_OWNER" as const], partyId: "p1", status: "PENDING" as const };
    expect(canDecide(approval, { partyIds: [] }, ["PLAN_OWNER"])).toBe(true);
    expect(canDecide(approval, { partyIds: ["p1"] }, [])).toBe(true);
    expect(canDecide(approval, { partyIds: [] }, ["EDITOR"])).toBe(false);
    expect(canDecide({ ...approval, status: "APPROVED" }, { partyIds: ["p1"] }, [])).toBe(false);
  });

  it("enforces acceptance granularity", () => {
    expect(() => assertAcceptanceGranularity("ITEM", 2, 5)).toThrow(RuleViolationError);
    expect(() => assertAcceptanceGranularity("WHOLE_PLAN", 2, 5)).toThrow(RuleViolationError);
    expect(() => assertAcceptanceGranularity("BATCH", 2, 5)).not.toThrow();
    expect(() => assertAcceptanceGranularity("BATCH", 0, 5)).toThrow(RuleViolationError);
  });
});

describe("links", () => {
  it("prefers item-level links over plan-level links", () => {
    const r = ref("r1", "t1", "B");
    expect(effectiveLinkType(r, [])).toBe("MONITOR");
    expect(effectiveLinkType(r, [link("AGREEMENT", "A", "B")])).toBe("AGREEMENT");
    expect(
      effectiveLinkType(r, [
        link("AGREEMENT", "A", "B"),
        link("MONITOR", "A", "B", { id: "x", referenceId: "r1" }),
      ]),
    ).toBe("MONITOR");
  });

  it("carries over agreed values on upgrade without overwriting", () => {
    const agreed = (itemId: string, end: string): BaselineItem => ({
      itemId,
      name: itemId,
      parentId: "p",
      start: NOW,
      end,
      duration: 1,
      granularity: "days",
      isReference: false,
    });
    const additions = carryOverAgreedValues(
      [ref("r1", "t1", "B"), ref("r2", "t2", "B"), ref("r3", "t3", "B")],
      [agreed("t1", "2026-01-06T00:00:00.000Z"), agreed("t2", "2026-01-07T00:00:00.000Z")],
      [agreed("t2", "2026-01-09T00:00:00.000Z")],
    );
    expect(additions).toEqual([
      { ...agreed("t1", "2026-01-06T00:00:00.000Z"), isReference: true, parentId: null },
    ]);
  });
});

describe("baselines", () => {
  it("never allows modifying a locked baseline", () => {
    expect(() => assertBaselineMutable({ locked: true, name: "B" })).toThrow(RuleViolationError);
    expect(() => assertBaselineMutable({ locked: false, name: "B" })).not.toThrow();
  });

  it("only allows direct edits of unlocked branches", () => {
    const b = {
      ...meta("b"),
      projectId: "pr",
      planId: "A",
      name: "B",
      track: null,
      definitionId: null,
      parentBaselineId: null,
      lockedAt: null,
      items: [],
    };
    expect(() => assertBranchEditable({ ...b, kind: "BRANCH", locked: false })).not.toThrow();
    expect(() => assertBranchEditable({ ...b, kind: "BRANCH", locked: true })).toThrow(
      RuleViolationError,
    );
    expect(() => assertBranchEditable({ ...b, kind: "TRACK", locked: false })).toThrow(
      RuleViolationError,
    );
  });

  it("merges items and computes variance", () => {
    const item = (itemId: string, end: string): BaselineItem => ({
      itemId,
      name: itemId,
      parentId: null,
      start: NOW,
      end,
      duration: 1,
      granularity: "days",
      isReference: false,
    });
    expect(
      mergeBaselineItems(
        [item("b", NOW)],
        [item("a", NOW), item("b", "2026-01-09T00:00:00.000Z")],
      ).map((i) => i.end),
    ).toEqual([NOW, "2026-01-09T00:00:00.000Z"]);
    const comparison = compareAgainst(
      "A",
      [{ item: item("a", "2026-01-08T00:00:00.000Z"), agreementState: "NONE" }],
      [{ key: "AGREED", name: "Agreed", items: [item("a", "2026-01-06T00:00:00.000Z")] }],
    );
    expect(comparison.rows[0]?.endVarianceDays.AGREED).toBe(2);
  });
});

describe("items", () => {
  it("prevents subtasks under milestones and edits of activity dates", () => {
    expect(() => assertCanAddSubtask(task("m", { duration: 0 }), [])).toThrow(RuleViolationError);
    expect(() => assertCanAddSubtask(task("t"), [])).not.toThrow();
    expect(() => assertScheduleEditable(task("a"), 1)).toThrow(RuleViolationError);
  });

  it("prevents cycles", () => {
    const byId = new Map([
      ["a", task("a")],
      ["b", task("b", { parentId: "a" })],
    ]);
    expect(() => assertNoCycle("a", "b", byId)).toThrow(RuleViolationError);
    expect(() => assertNoCycle("b", null, byId)).not.toThrow();
  });

  it("rolls up nested activities from their subtasks", () => {
    const tasks = [
      task("root"),
      task("mid", { parentId: "root" }),
      task("leaf1", {
        parentId: "mid",
        start: "2026-01-06T00:00:00.000Z",
        end: "2026-01-08T00:00:00.000Z",
        duration: 2,
      }),
      task("leaf2", {
        parentId: "root",
        start: "2026-01-12T00:00:00.000Z",
        end: "2026-01-13T00:00:00.000Z",
      }),
    ];
    const changed = new Map(rollUpActivities(tasks, DEFAULT_CALENDAR).map((t) => [t.id, t]));
    expect(changed.get("mid")?.start).toBe("2026-01-06T00:00:00.000Z");
    expect(changed.get("root")?.start).toBe("2026-01-06T00:00:00.000Z");
    expect(changed.get("root")?.end).toBe("2026-01-13T00:00:00.000Z");
    expect(changed.get("root")?.duration).toBe(5);
  });
});

describe("permissions", () => {
  it("combines global, project-wide and plan roles", () => {
    const assignments = [
      { ...meta("1"), projectId: "pr", userId: "u1", planId: null, role: "EDITOR" as const },
      { ...meta("2"), projectId: "pr", userId: "u1", planId: "A", role: "PLAN_OWNER" as const },
    ];
    const user = { id: "u1", globalRoles: ["VIEWER" as const] };
    expect(effectiveRoles(user, assignments, "A")).toEqual(["EDITOR", "PLAN_OWNER", "VIEWER"]);
    expect(effectiveRoles(user, assignments, "B")).toEqual(["EDITOR", "VIEWER"]);
    expect(can(["VIEWER"], "plan.edit")).toBe(false);
    expect(can(["EDITOR"], "plan.edit")).toBe(true);
    expect(can(["EDITOR"], "plan.manage")).toBe(false);
  });
});

describe("project hierarchy", () => {
  const project = (id: string, parentProjectId: string | null): Project =>
    ({ id, name: id, parentProjectId }) as Project;
  const byId = new Map(
    [project("root", null), project("child", "root"), project("grandchild", "child")].map((p) => [
      p.id,
      p,
    ]),
  );

  it("allows moving a project anywhere outside its own subtree", () => {
    expect(() => assertValidProjectParent("grandchild", "root", byId)).not.toThrow();
    expect(() => assertValidProjectParent("child", null, byId)).not.toThrow();
  });

  it("rejects placing a project under itself or a descendant", () => {
    expect(() => assertValidProjectParent("root", "root", byId)).toThrow(RuleViolationError);
    expect(() => assertValidProjectParent("root", "grandchild", byId)).toThrow(RuleViolationError);
  });

  it("reads projects stored before the hierarchy fields existed as top-level and active", () => {
    const legacy = { id: "old", name: "Old", description: "" } as unknown as Project;
    expect(normalizeProject(legacy)).toMatchObject({
      projectType: "",
      parentProjectId: null,
      active: true,
    });
  });
});

describe("task order, numbers and dependencies", () => {
  it("moves a task among its siblings and renumbers them", () => {
    const siblings = [
      task("a", { sortOrder: 0 }),
      task("b", { sortOrder: 5 }),
      task("c", { sortOrder: 9 }),
    ];
    expect(reorderSiblings(siblings, "c", "up")).toEqual(
      new Map([
        ["b", 2],
        ["c", 1],
      ]),
    );
    expect(reorderSiblings(siblings, "a", "up").size).toBe(0);
    expect(reorderSiblings(siblings, "c", "down").size).toBe(0);
  });

  it("numbers tasks stored without a number after the highest, in creation order", () => {
    const legacy = (id: string, createdAt: string) =>
      ({ ...task(id), taskNumber: undefined, createdAt }) as unknown as Task;
    const tasks = [
      task("x", { taskNumber: 3 }),
      legacy("late", "2026-02-01T00:00:00.000Z"),
      legacy("early", NOW),
    ];
    expect(missingTaskNumbers(tasks)).toEqual(
      new Map([
        ["early", 4],
        ["late", 5],
      ]),
    );
  });

  it("rejects loops and links between an activity and its own subtasks", () => {
    const deps = [
      { fromItemId: "a", toItemId: "b" },
      { fromItemId: "b", toItemId: "c" },
    ];
    expect(() => assertNoDependencyCycle("c", "a", deps)).toThrow(RuleViolationError);
    expect(() => assertNoDependencyCycle("a", "c", deps)).not.toThrow();
    const parent = task("p");
    const child = task("ch", { parentId: "p" });
    const byId = new Map([parent, child].map((t) => [t.id, t]));
    expect(() => assertNotOwnActivity(parent, child, byId)).toThrow(RuleViolationError);
    expect(() => assertNotOwnActivity(child, parent, byId)).toThrow(RuleViolationError);
  });
});
