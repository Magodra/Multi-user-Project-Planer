/** Rules for references to external tasks in recipient plans (CLAUDE.md §4). Pure logic, no I/O. */
import type { LinkType, PlanItemReference } from "@planning/shared";
import { RuleViolationError } from "./errors.js";

/** References stored before placement existed sit at the top level, after the plan's tasks. */
const LEGACY_SORT_ORDER = 1_000_000;

export function normalizeReference(ref: PlanItemReference): PlanItemReference {
  return {
    ...ref,
    parentId: ref.parentId ?? null,
    sortOrder: ref.sortOrder ?? LEGACY_SORT_ORDER,
  };
}

/**
 * A referenced task's values come from its owner. On a MONITOR link they
 * cannot be changed in the recipient plan; on an AGREEMENT link a local
 * change is proposed to the owner for approval.
 */
export function assertLocalChangeAllowed(linkType: LinkType): void {
  if (linkType !== "AGREEMENT")
    throw new RuleViolationError(
      "This task is monitored: it follows its owner plan and cannot be changed here",
    );
}
