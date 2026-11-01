import type { ItemKind, Task } from "../types.js";

/**
 * Derive an item's kind from its data (CLAUDE.md §4 "Item kinds").
 * The kind is never stored, so it cannot get out of sync.
 */
export function getItemKind(task: Pick<Task, "duration">, subtaskCount: number): ItemKind {
  if (subtaskCount > 0) return "activity";
  if (task.duration === 0) return "milestone";
  return "task";
}

/** Count direct children per parent id. */
export function countSubtasks(tasks: Pick<Task, "parentId">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.parentId !== null) counts.set(t.parentId, (counts.get(t.parentId) ?? 0) + 1);
  }
  return counts;
}

/** Kinds for a whole list of tasks at once. */
export function getItemKinds(
  tasks: Pick<Task, "id" | "duration" | "parentId">[],
): Map<string, ItemKind> {
  const counts = countSubtasks(tasks);
  return new Map(tasks.map((t) => [t.id, getItemKind(t, counts.get(t.id) ?? 0)]));
}
