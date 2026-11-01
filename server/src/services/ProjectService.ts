import {
  type AssignRoleInput,
  type BaselineDefinition,
  type CreateProjectInput,
  DEFAULT_CALENDAR,
  type Project,
  type ProjectSummary,
  type RoleAssignment,
  type UpdateProjectInput,
  type Versioned,
} from "@planning/shared";
import { ConflictError, NotFoundError, ValidationError } from "../domain/errors.js";
import { assertValidProjectParent, normalizeProject } from "../domain/projects.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./events.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";

/** Baseline definitions every new project starts with (CLAUDE.md §6). */
export function defaultDefinitions(): Omit<BaselineDefinition, keyof Versioned | "projectId">[] {
  return [
    {
      name: "Estimated",
      track: "ESTIMATED",
      acceptFrom: "ESTIMATED",
      requiresApproval: true,
      approvers: ["PLAN_OWNER"],
      externalItemRule: "OWNER_ONLY",
      granularityOfAcceptance: "BATCH",
      lockOnAccept: false,
      allowBranching: true,
    },
    {
      name: "Current",
      track: "CURRENT",
      acceptFrom: "ESTIMATED",
      requiresApproval: true,
      approvers: ["PLAN_OWNER"],
      externalItemRule: "OWNER_ONLY",
      granularityOfAcceptance: "BATCH",
      lockOnAccept: false,
      allowBranching: true,
    },
    {
      name: "Agreed",
      track: "AGREED",
      acceptFrom: "CURRENT",
      requiresApproval: true,
      approvers: ["PLAN_OWNER"],
      externalItemRule: "OWNER_AND_RECIPIENTS",
      granularityOfAcceptance: "ITEM",
      lockOnAccept: true,
      allowBranching: true,
    },
  ];
}

export class ProjectService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async create(ctx: ServiceContext, input: CreateProjectInput): Promise<Project> {
    if (input.parentProjectId) await this.requireParent(ctx, input.parentProjectId);
    const project: Project = {
      ...newMeta(ctx),
      name: input.name,
      projectType: input.projectType,
      description: input.description,
      parentProjectId: input.parentProjectId,
      active: true,
      calendar: input.calendar ?? DEFAULT_CALENDAR,
    };
    const saved = await this.storage.transaction(async (tx) => {
      const p = await tx.save("project", project);
      for (const def of defaultDefinitions()) {
        await tx.save("baselineDefinition", { ...newMeta(ctx), projectId: project.id, ...def });
      }
      const admin: RoleAssignment = {
        ...newMeta(ctx),
        projectId: project.id,
        userId: ctx.user.id,
        planId: null,
        role: "ADMIN",
      };
      await tx.save("roleAssignment", admin);
      await this.audit.record(tx, ctx, {
        projectId: project.id,
        entityType: "project",
        entityId: project.id,
        action: "create",
      });
      return p;
    });
    return saved;
  }

  /** Projects the user can access, including inactive ones; the client builds the tree. */
  async list(ctx: ServiceContext): Promise<ProjectSummary[]> {
    const ids = await this.access.projectIdsFor(ctx.user);
    const all = (await this.storage.query("project")).map(normalizeProject);
    const visible = (ids === "ALL" ? all : all.filter((p) => ids.includes(p.id))).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return Promise.all(
      visible.map(async (p) => ({
        ...p,
        canEdit: await this.access.canDo(ctx, p.id, null, "project.admin"),
      })),
    );
  }

  async get(ctx: ServiceContext, projectId: string): Promise<Project> {
    await this.access.require(ctx, projectId, null, "project.read");
    return normalizeProject(await mustGet(this.storage, "project", projectId));
  }

  /** Placing a project under another one requires admin rights on that parent. */
  private async requireParent(ctx: ServiceContext, parentProjectId: string): Promise<void> {
    await mustGet(this.storage, "project", parentProjectId);
    await this.access.require(ctx, parentProjectId, null, "project.admin");
  }

  async update(
    ctx: ServiceContext,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<Project> {
    await this.access.require(ctx, projectId, null, "project.admin");
    if (input.parentProjectId) await this.requireParent(ctx, input.parentProjectId);
    const saved = await this.storage.transaction(async (tx) => {
      const project = normalizeProject(await mustGet(tx, "project", projectId));
      if (project.version !== input.version)
        throw new ConflictError("Project was changed by someone else");
      const { version: _v, ...changes } = input;
      if (
        changes.parentProjectId !== undefined &&
        changes.parentProjectId !== project.parentProjectId
      ) {
        const all = (await tx.query("project")).map(normalizeProject);
        assertValidProjectParent(
          projectId,
          changes.parentProjectId,
          new Map(all.map((p) => [p.id, p])),
        );
      }
      const updated = await tx.save("project", touch(project, ctx, changes));
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "project",
        entityId: projectId,
        action: "update",
        details: changes,
      });
      return updated;
    });
    this.events.emit({
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "update",
      planIds: [],
    });
    return saved;
  }

  async listMembers(ctx: ServiceContext, projectId: string): Promise<RoleAssignment[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    return this.storage.query("roleAssignment", { projectId });
  }

  async assignRole(
    ctx: ServiceContext,
    projectId: string,
    input: AssignRoleInput,
  ): Promise<RoleAssignment> {
    await this.access.require(ctx, projectId, null, "project.admin");
    if (!(await this.storage.get("user", input.userId)))
      throw new ValidationError(`Unknown user ${input.userId}`);
    if (input.planId) {
      const plan = await mustGet(this.storage, "plan", input.planId);
      if (plan.projectId !== projectId)
        throw new ValidationError("Plan belongs to another project");
    }
    const existing = await this.storage.query("roleAssignment", {
      projectId,
      userId: input.userId,
    });
    const duplicate = existing.find((a) => a.planId === input.planId && a.role === input.role);
    if (duplicate) return duplicate;
    const assignment: RoleAssignment = { ...newMeta(ctx), projectId, ...input };
    return this.storage.transaction(async (tx) => {
      const saved = await tx.save("roleAssignment", assignment);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "roleAssignment",
        entityId: assignment.id,
        action: "create",
        details: { ...input },
      });
      return saved;
    });
  }

  async removeRole(ctx: ServiceContext, projectId: string, assignmentId: string): Promise<void> {
    await this.access.require(ctx, projectId, null, "project.admin");
    await this.storage.transaction(async (tx) => {
      const a = await tx.get("roleAssignment", assignmentId);
      if (!a || a.projectId !== projectId) throw new NotFoundError("roleAssignment", assignmentId);
      await tx.delete("roleAssignment", a.id, a.version);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "roleAssignment",
        entityId: a.id,
        action: "delete",
      });
    });
  }

  async listDefinitions(ctx: ServiceContext, projectId: string): Promise<BaselineDefinition[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    return this.storage.query("baselineDefinition", { projectId });
  }

  async updateDefinition(
    ctx: ServiceContext,
    definitionId: string,
    changes: Partial<Omit<BaselineDefinition, "id" | "projectId" | "track">> & { version: number },
  ): Promise<BaselineDefinition> {
    const def = await mustGet(this.storage, "baselineDefinition", definitionId);
    await this.access.require(ctx, def.projectId, null, "project.admin");
    return this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "baselineDefinition", definitionId);
      if (current.version !== changes.version)
        throw new ConflictError("Definition was changed by someone else");
      const { version: _v, ...rest } = changes;
      const saved = await tx.save("baselineDefinition", touch(current, ctx, rest));
      await this.audit.record(tx, ctx, {
        projectId: def.projectId,
        entityType: "baselineDefinition",
        entityId: def.id,
        action: "update",
        details: rest,
      });
      return saved;
    });
  }
}
