/** Rules for task order, task numbers and dependencies (CLAUDE.md §4). Pure logic, no I/O. */
import {
  type Dependency,
  type Granularity,
  type Schedule,
  type WorkingCalendar,
  addWorkingLag,
  compareIso,
} from "@planning/shared";
import { RuleViolationError } from "./errors.js";

/** Anything placed among siblings in a plan: tasks and references share one order. */
export interface Orderable {
  id: string;
  sortOrder: number;
  name: string;
}

/** Order of tasks (and references) among their siblings, as shown in the plan. */
export function compareTaskOrder(a: Orderable, b: Orderable): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * New sortOrder values after moving one task up or down among its siblings.
 * Siblings are renumbered 0..n-1; only tasks whose value changes are returned.
 * Empty when the task is already first (up) or last (down).
 */
export function reorderSiblings(
  siblings: Orderable[],
  taskId: string,
  direction: "up" | "down",
): Map<string, number> {
  const ordered = [...siblings].sort(compareTaskOrder);
  const index = ordered.findIndex((t) => t.id === taskId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= ordered.length) return new Map();
  [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
  const changes = new Map<string, number>();
  ordered.forEach((t, i) => {
    if (t.sortOrder !== i) changes.set(t.id, i);
  });
  return changes;
}

/**
 * Task numbers for tasks stored before numbers existed, continuing after the
 * highest existing number in creation order. Deterministic, so a view and a
 * later write that persists them agree.
 */
export function missingTaskNumbers(
  planTasks: { id: string; taskNumber?: number; createdAt: string }[],
): Map<string, number> {
  let next = planTasks.reduce((max, t) => Math.max(max, t.taskNumber ?? 0), 0);
  const result = new Map<string, number>();
  const unnumbered = planTasks
    .filter((t) => t.taskNumber === undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  for (const t of unnumbered) result.set(t.id, ++next);
  return result;
}

/**
 * Dependencies stored before lag units (or plans) existed: the lag is in the
 * successor's granularity and the dependency belongs to the successor's plan.
 */
export function normalizeDependency(
  dep: Dependency,
  successor: { granularity: Granularity; planId: string },
): Dependency {
  return {
    ...dep,
    lagUnit: dep.lagUnit ?? successor.granularity,
    planId: dep.planId ?? successor.planId,
  };
}

/** A task or external task as placed in one plan's hierarchy. */
export interface PlacedNode {
  id: string;
  parentId: string | null;
  name: string;
}

/** A task cannot be linked to its own activity (or the activity to one of its subtasks). */
export function assertNotOwnActivity(
  from: PlacedNode,
  to: PlacedNode,
  byId: Map<string, PlacedNode>,
): void {
  const isAncestor = (ancestor: PlacedNode, of: PlacedNode) => {
    let cursor = of.parentId;
    while (cursor !== null) {
      if (cursor === ancestor.id) return true;
      cursor = byId.get(cursor)?.parentId ?? null;
    }
    return false;
  };
  if (isAncestor(from, to) || isAncestor(to, from))
    throw new RuleViolationError(
      `'${from.name}' and '${to.name}' are an activity and its subtask and cannot be linked`,
    );
}

/** Adding from → to must not close a loop through the existing dependencies. */
export function assertNoDependencyCycle(
  fromItemId: string,
  toItemId: string,
  existing: Pick<Dependency, "fromItemId" | "toItemId">[],
): void {
  const successors = new Map<string, string[]>();
  for (const d of existing)
    successors.set(d.fromItemId, [...(successors.get(d.fromItemId) ?? []), d.toItemId]);
  // A loop exists if `from` can already be reached from `to`.
  const seen = new Set<string>();
  const stack = [toItemId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === fromItemId) throw new RuleViolationError("This dependency would create a loop");
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(successors.get(id) ?? []));
  }
}

export interface DependencyCheck {
  /** Earliest allowed start (FS, SS) or finish (FF, SF) of the successor. */
  required: string;
  /** The successor's actual start or finish. */
  actual: string;
  /** True when the successor starts or finishes too early; later (slack) is fine. */
  violated: boolean;
}

/**
 * Whether a successor respects a dependency. FS: start ≥ predecessor's end +
 * lag; SS: start ≥ predecessor's start + lag; FF: end ≥ predecessor's end +
 * lag; SF: end ≥ predecessor's start + lag. Lag is working time on the
 * project's calendar (`addWorkingLag`; negative = lead). Slack is allowed.
 */
export function checkDependency(
  dep: Pick<Dependency, "type" | "lag" | "lagUnit">,
  predecessor: Schedule,
  successor: Schedule,
  calendar: WorkingCalendar,
): DependencyCheck {
  const fromEnd = dep.type === "FS" || dep.type === "FF";
  const toStart = dep.type === "FS" || dep.type === "SS";
  const anchor = fromEnd ? predecessor.end : predecessor.start;
  const required = addWorkingLag(anchor, dep.lag, dep.lagUnit, calendar);
  const actual = toStart ? successor.start : successor.end;
  return { required, actual, violated: compareIso(actual, required) < 0 };
}
