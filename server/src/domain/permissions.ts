/** Role → permission rules (CLAUDE.md §10). Pure logic, no I/O. */
import type { Role, RoleAssignment, User } from "@planning/shared";

export type Action =
  | "project.read"
  | "project.admin"
  | "plan.read"
  | "plan.edit"
  | "plan.manage"
  | "baseline.create"
  | "changeRequest.create";

const ROLE_ACTIONS: Record<Role, readonly Action[]> = {
  ADMIN: [
    "project.read",
    "project.admin",
    "plan.read",
    "plan.edit",
    "plan.manage",
    "baseline.create",
    "changeRequest.create",
  ],
  PLAN_OWNER: [
    "project.read",
    "plan.read",
    "plan.edit",
    "plan.manage",
    "baseline.create",
    "changeRequest.create",
  ],
  EDITOR: ["project.read", "plan.read", "plan.edit", "baseline.create", "changeRequest.create"],
  APPROVER: ["project.read", "plan.read"],
  VIEWER: ["project.read", "plan.read"],
};

/**
 * Effective roles of a user in a project, optionally narrowed to one plan:
 * global roles + project-wide assignments + assignments on the plan.
 * A plan-specific assignment also gives read access to the project.
 */
export function effectiveRoles(
  user: Pick<User, "id" | "globalRoles">,
  assignments: RoleAssignment[],
  planId: string | null,
): Role[] {
  const roles = new Set<Role>(user.globalRoles);
  for (const a of assignments) {
    if (a.userId !== user.id) continue;
    if (a.planId === null || a.planId === planId) roles.add(a.role);
    else if (planId === null) roles.add("VIEWER");
  }
  return [...roles].sort();
}

export function can(roles: readonly Role[], action: Action): boolean {
  return roles.some((r) => ROLE_ACTIONS[r].includes(action));
}
