/** Builds the project hierarchy for display. The server enforces the rules. */
import type { ProjectSummary } from "@planning/shared";

export interface ProjectNode {
  project: ProjectSummary;
  children: ProjectNode[];
}

/**
 * Tree of the given projects. A project whose parent is not in the list
 * (hidden or not accessible to the user) is shown at the top level.
 */
export function buildProjectTree(projects: ProjectSummary[]): ProjectNode[] {
  const ids = new Set(projects.map((p) => p.id));
  const children = new Map<string | null, ProjectSummary[]>();
  for (const p of projects) {
    const parent = p.parentProjectId && ids.has(p.parentProjectId) ? p.parentProjectId : null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  const build = (parent: string | null): ProjectNode[] =>
    (children.get(parent) ?? []).map((project) => ({ project, children: build(project.id) }));
  return build(null);
}

/** Ids of a project and everything below it. */
export function subtreeIds(projects: ProjectSummary[], rootId: string): Set<string> {
  const result = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of projects) {
      if (p.parentProjectId && result.has(p.parentProjectId) && !result.has(p.id)) {
        result.add(p.id);
        grew = true;
      }
    }
  }
  return result;
}

/** Projects to list when inactive ones are hidden: inactive projects and everything below them are left out. */
export function withoutInactiveSubtrees(projects: ProjectSummary[]): ProjectSummary[] {
  const hidden = new Set<string>();
  for (const p of projects)
    if (!p.active) for (const id of subtreeIds(projects, p.id)) hidden.add(id);
  return projects.filter((p) => !hidden.has(p.id));
}

/** Ids of the projects above a project, nearest first. */
export function ancestorIds(projects: ProjectSummary[], id: string): string[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const result: string[] = [];
  let cursor = byId.get(id)?.parentProjectId ?? null;
  while (cursor && !result.includes(cursor) && cursor !== id) {
    result.push(cursor);
    cursor = byId.get(cursor)?.parentProjectId ?? null;
  }
  return result;
}

/** "Parent / Child" path, for parent pickers. */
export function projectPath(projects: ProjectSummary[], id: string): string {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const p = byId.get(cursor);
    if (!p) break;
    names.unshift(p.name);
    cursor = p.parentProjectId;
  }
  return names.join(" / ");
}

/** Projects the user may place a project under (excluding `exclude`), sorted by path. */
export function parentOptions(
  projects: ProjectSummary[],
  exclude: Set<string> = new Set(),
): { id: string; label: string }[] {
  return projects
    .filter((p) => p.canEdit && !exclude.has(p.id))
    .map((p) => ({ id: p.id, label: projectPath(projects, p.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
