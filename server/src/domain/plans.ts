/** Rules for deleting a plan (CLAUDE.md §4, §6). Pure logic, no I/O. */
import { RuleViolationError } from "./errors.js";

export interface PlanDeletionCheck {
  /** Names of other plans using this plan's tasks. */
  usedInPlans: string[];
  /** Open change requests raised in the plan, or waiting for its approval. */
  openRequests: number;
  /** Locked baselines (accepted history), which must never change. */
  lockedBaselines: number;
}

/** Why a plan cannot be deleted; empty when it can. */
export function planDeletionBlockers(check: PlanDeletionCheck): string[] {
  const reasons: string[] = [];
  if (check.usedInPlans.length > 0)
    reasons.push(
      `its tasks are used in other plans (${check.usedInPlans.join(", ")}); remove them there first`,
    );
  if (check.openRequests > 0)
    reasons.push(`${check.openRequests} change request(s) involving it are still open`);
  if (check.lockedBaselines > 0)
    reasons.push(
      `it has ${check.lockedBaselines} locked baseline(s) with accepted history, which is kept`,
    );
  return reasons;
}

export function assertPlanDeletable(check: PlanDeletionCheck): void {
  const reasons = planDeletionBlockers(check);
  if (reasons.length > 0)
    throw new RuleViolationError(`The plan cannot be deleted: ${reasons.join("; ")}.`);
}
