/** Access control — enforced in the server for every call (CLAUDE.md §10). */
import type { Role, User } from "@planning/shared";
import { ForbiddenError } from "../domain/errors.js";
import { type Action, can, effectiveRoles } from "../domain/permissions.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { ServiceContext } from "./support.js";

export class AccessService {
  constructor(private readonly storage: StorageAdapter) {}

  /** Roles of the user in a project (planId null) or on a specific plan. */
  async roles(
    user: User,
    projectId: string,
    planId: string | null,
    storage = this.storage,
  ): Promise<Role[]> {
    const assignments = await storage.query("roleAssignment", { projectId, userId: user.id });
    const roles = effectiveRoles(user, assignments, planId);
    // System admins get ADMIN everywhere, on top of (not instead of) their assignments,
    // so e.g. a system admin who owns a plan can still approve as PLAN_OWNER.
    return user.isSystemAdmin && !roles.includes("ADMIN")
      ? ([...roles, "ADMIN"] as Role[]).sort()
      : roles;
  }

  async require(
    ctx: ServiceContext,
    projectId: string,
    planId: string | null,
    action: Action,
    storage = this.storage,
  ): Promise<Role[]> {
    const roles = await this.roles(ctx.user, projectId, planId, storage);
    if (!can(roles, action)) {
      throw new ForbiddenError(`Missing permission ${action}${planId ? ` on plan ${planId}` : ""}`);
    }
    return roles;
  }

  /**
   * The link type of a reference binds both plans, so managers of either the
   * owner plan or the receiving plan may set it.
   */
  async requireLinkManager(
    ctx: ServiceContext,
    owner: { projectId: string; id: string },
    recipient: { projectId: string; id: string },
  ): Promise<void> {
    for (const plan of [owner, recipient])
      if (await this.canDo(ctx, plan.projectId, plan.id, "plan.manage")) return;
    throw new ForbiddenError(
      "Only managers of the owner plan or the receiving plan can set the link type",
    );
  }

  async canDo(
    ctx: ServiceContext,
    projectId: string,
    planId: string | null,
    action: Action,
  ): Promise<boolean> {
    return can(await this.roles(ctx.user, projectId, planId), action);
  }

  async projectIdsFor(user: User): Promise<string[] | "ALL"> {
    if (user.isSystemAdmin || user.globalRoles.length > 0) return "ALL";
    const mine = await this.storage.query("roleAssignment", { userId: user.id });
    return [...new Set(mine.map((a) => a.projectId))];
  }
}
