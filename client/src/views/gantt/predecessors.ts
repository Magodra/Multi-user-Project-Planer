/**
 * Predecessor text for a task shown in a plan, with the shared notation and
 * the plan's local task IDs (own tasks and external tasks used in it).
 */
import { type PlanView, formatPredecessors } from "@planning/shared";

/** Local task ID of every task shown in the plan, keyed by task id. */
export function localNumbers(view: PlanView): Map<string, number> {
  return new Map([
    ...view.items.map((t) => [t.id, t.taskNumber] as const),
    ...view.references.map((r) => [r.item.id, r.taskNumber] as const),
  ]);
}

/** The plan's own predecessors of a task, e.g. "2SS-1w; 4FS+3d". */
export function predecessorText(view: PlanView, itemId: string): string {
  const numbers = localNumbers(view);
  return formatPredecessors(
    view.dependencies
      .filter(
        (d) => d.toItemId === itemId && d.planId === view.plan.id && numbers.has(d.fromItemId),
      )
      .map((d) => ({
        taskNumber: numbers.get(d.fromItemId)!,
        type: d.type,
        lag: d.lag,
        lagUnit: d.lagUnit,
      })),
  );
}

/** Names of predecessors linked in another plan (e.g. the owner's own dependencies); read-only here. */
export function otherPlanPredecessors(view: PlanView, itemId: string): string[] {
  const names = new Map([
    ...view.items.map((t) => [t.id, t.name] as const),
    ...view.references.map((r) => [r.item.id, r.item.name] as const),
  ]);
  return view.dependencies
    .filter((d) => d.toItemId === itemId && d.planId !== view.plan.id)
    .map((d) => names.get(d.fromItemId) ?? "")
    .filter(Boolean);
}
