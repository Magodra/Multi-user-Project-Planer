import type {
  CreateTimelineInput,
  Timeline,
  UpdateTimelineInput,
  Workspace,
  SaveWorkspaceInput,
} from "@planning/shared";
import { compareIso } from "@planning/shared";
import { ConflictError, ForbiddenError, ValidationError } from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./events.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";

/** User-defined timelines. Entries reference plan items; dates are never copied. */
export class TimelineService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async list(ctx: ServiceContext, projectId: string): Promise<Timeline[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    return (await this.storage.query("timeline", { projectId })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async get(ctx: ServiceContext, timelineId: string): Promise<Timeline> {
    const t = await mustGet(this.storage, "timeline", timelineId);
    await this.access.require(ctx, t.projectId, null, "project.read");
    return t;
  }

  async create(
    ctx: ServiceContext,
    projectId: string,
    input: CreateTimelineInput,
  ): Promise<Timeline> {
    await this.access.require(ctx, projectId, null, "project.read");
    if (compareIso(input.end, input.start) <= 0)
      throw new ValidationError("Timeline end must be after start");
    const timeline: Timeline = { ...newMeta(ctx), projectId, ...input, entries: [] };
    const saved = await this.storage.transaction(async (tx) => {
      const t = await tx.save("timeline", timeline);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "timeline",
        entityId: t.id,
        action: "create",
      });
      return t;
    });
    this.emit(saved, "create");
    return saved;
  }

  async update(
    ctx: ServiceContext,
    timelineId: string,
    input: UpdateTimelineInput,
  ): Promise<Timeline> {
    const existing = await mustGet(this.storage, "timeline", timelineId);
    await this.access.require(ctx, existing.projectId, null, "project.read");
    for (const planId of new Set((input.entries ?? []).map((e) => e.planId))) {
      if (!(await this.access.canDo(ctx, existing.projectId, planId, "plan.read"))) {
        throw new ForbiddenError(`No access to plan ${planId}`);
      }
    }
    const saved = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "timeline", timelineId);
      if (current.version !== input.version)
        throw new ConflictError("Timeline was changed by someone else");
      const { version: _v, ...changes } = input;
      const next = { ...current, ...changes };
      if (compareIso(next.end, next.start) <= 0)
        throw new ValidationError("Timeline end must be after start");
      const rowIds = new Set(next.rows.map((r) => r.id));
      for (const entry of next.entries) {
        if (!rowIds.has(entry.rowId)) throw new ValidationError(`Unknown row ${entry.rowId}`);
        const item = await tx.get("task", entry.itemId);
        if (item && item.projectId !== current.projectId)
          throw new ValidationError(
            `'${item.name}' belongs to another project; timelines show tasks of their own project only`,
          );
        if (!item || item.planId !== entry.planId) {
          throw new ValidationError(`Item ${entry.itemId} is not in plan ${entry.planId}`);
        }
      }
      const t = await tx.save("timeline", touch(current, ctx, changes));
      await this.audit.record(tx, ctx, {
        projectId: current.projectId,
        entityType: "timeline",
        entityId: t.id,
        action: "update",
      });
      return t;
    });
    this.emit(saved, "update");
    return saved;
  }

  async delete(ctx: ServiceContext, timelineId: string): Promise<void> {
    const t = await mustGet(this.storage, "timeline", timelineId);
    await this.access.require(ctx, t.projectId, null, "project.admin");
    await this.storage.transaction(async (tx) => {
      await tx.delete("timeline", t.id, t.version);
      await this.audit.record(tx, ctx, {
        projectId: t.projectId,
        entityType: "timeline",
        entityId: t.id,
        action: "delete",
      });
    });
    this.emit(t, "delete");
  }

  private emit(t: Timeline, action: string): void {
    this.events.emit({
      projectId: t.projectId,
      entityType: "timeline",
      entityId: t.id,
      action,
      planIds: [],
    });
  }
}

/** Saved panel layouts, private to each user. */
export class WorkspaceService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
  ) {}

  async list(ctx: ServiceContext, projectId: string): Promise<Workspace[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    const saved = await this.storage.query("workspace", { projectId, userId: ctx.user.id });
    // Workspaces saved before view state existed have none.
    return saved.map((w) => ({ ...w, viewState: w.viewState ?? null }));
  }

  async save(
    ctx: ServiceContext,
    projectId: string,
    workspaceId: string | null,
    input: SaveWorkspaceInput,
  ): Promise<Workspace> {
    await this.access.require(ctx, projectId, null, "project.read");
    if (!workspaceId) {
      return this.storage.save("workspace", {
        ...newMeta(ctx),
        projectId,
        userId: ctx.user.id,
        name: input.name,
        layout: input.layout ?? null,
        viewState: input.viewState ?? null,
      });
    }
    const current = await mustGet(this.storage, "workspace", workspaceId);
    if (current.userId !== ctx.user.id) throw new ForbiddenError("Workspaces are private");
    if (input.version !== undefined && input.version !== current.version)
      throw new ConflictError("Workspace was changed elsewhere");
    return this.storage.save(
      "workspace",
      touch(current, ctx, {
        name: input.name,
        layout: input.layout ?? null,
        viewState: input.viewState === undefined ? (current.viewState ?? null) : input.viewState,
      }),
    );
  }

  async delete(ctx: ServiceContext, workspaceId: string): Promise<void> {
    const current = await mustGet(this.storage, "workspace", workspaceId);
    if (current.userId !== ctx.user.id) throw new ForbiddenError("Workspaces are private");
    await this.storage.delete("workspace", current.id, current.version);
  }
}
