/** Rules for the project hierarchy (CLAUDE.md §4). Pure logic, no I/O. */
import type { Project } from "@planning/shared";
import { RuleViolationError } from "./errors.js";

/**
 * Fill in fields added after a project was first stored, so projects saved by
 * an earlier version read as top-level, untyped and active.
 */
export function normalizeProject(p: Project): Project {
  return {
    ...p,
    projectType: p.projectType ?? "",
    parentProjectId: p.parentProjectId ?? null,
    active: p.active ?? true,
  };
}

/** A project cannot become its own parent or an ancestor of itself. */
export function assertValidProjectParent(
  projectId: string,
  newParentId: string | null,
  byId: Map<string, Project>,
): void {
  let cursor = newParentId;
  while (cursor !== null) {
    if (cursor === projectId)
      throw new RuleViolationError("A project cannot be placed under itself or a subproject");
    cursor = byId.get(cursor)?.parentProjectId ?? null;
  }
}

/** The top-level project of a project's tree. */
export function rootProjectId(projectId: string, byId: Map<string, Project>): string {
  let cursor = projectId;
  const seen = new Set<string>();
  for (;;) {
    const parent = byId.get(cursor)?.parentProjectId ?? null;
    if (parent === null || seen.has(parent)) return cursor;
    seen.add(cursor);
    cursor = parent;
  }
}

/** External tasks can be used in plans of the same project tree (parents and subprojects). */
export function assertSameProjectTree(a: string, b: string, byId: Map<string, Project>): void {
  if (rootProjectId(a, byId) !== rootProjectId(b, byId))
    throw new RuleViolationError("Tasks can only be used in plans of the same project tree");
}

/** Ids of a project and all its subprojects. */
export function projectWithDescendants(projectId: string, all: Project[]): string[] {
  const result = [projectId];
  for (let i = 0; i < result.length; i++)
    for (const p of all) if (p.parentProjectId === result[i]) result.push(p.id);
  return result;
}
