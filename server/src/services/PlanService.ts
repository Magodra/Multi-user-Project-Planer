import { normalizeReference } from "../domain/references.js";
import {
  compareTaskOrder,
  missingTaskNumbers,
  normalizeDependency,
} from "../domain/dependencies.js";
import {
  type Baseline,
  type CreatePlanInput,
  type Plan,
  type PlanView,
  type RecipientInfo,
  type ResolvedReference,
  type RoleAssignment,
  getItemKinds,
} from "@planning/shared";
import { ConflictError } from "../domain/errors.js";
import { effectiveLinkType } from "../domain/links.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./events.js";
import { findTrackBaseline, getDefinition } from "./lookups.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";

export class PlanService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /** Create a plan with its Current and Agreed tracks. The creator becomes PLAN_OWNER. */
  async create(ctx: ServiceContext, projectId: string, input: CreatePlanInput): Promise<Plan> {
    await this.access.require(ctx, projectId, null, "plan.manage");
    const plan: Plan = { ...newMeta(ctx), projectId, ...input };
    const saved = await this.storage.transaction(async (tx) => {
      await mustGet(tx, "project", projectId);
      const p = await tx.save("plan", plan);
      for (const track of ["CURRENT", "AGREED"] as const) {
        const def = await getDefinition(tx, projectId, track);
        const baseline: Baseline = {
          ...newMeta(ctx),
          projectId,
          planId: plan.id,
          name: def.name,
          kind: "TRACK",
          track,
          definitionId: def.id,
          parentBaselineId: null,
          locked: false,
          lockedAt: null,
          items: [],
        };
        await tx.save("baseline", baseline);
      }
      const owner: RoleAssignment = {
        ...newMeta(ctx),
        projectId,
        userId: ctx.user.id,
        planId: plan.id,
        role: "PLAN_OWNER",
      };
      await tx.save("roleAssignment", owner);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "plan",
        entityId: plan.id,
        action: "create",
        details: { name: plan.name },
      });
      return p;
    });
    this.events.emit({
      projectId,
      entityType: "plan",
      entityId: plan.id,
      action: "create",
      planIds: [plan.id],
    });
    return saved;
  }

  async list(ctx: ServiceContext, projectId: string): Promise<Plan[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    const plans = await this.storage.query("plan", { projectId });
    const visible: Plan[] = [];
    for (const p of plans)
      if (await this.access.canDo(ctx, projectId, p.id, "plan.read")) visible.push(p);
    return visible.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(ctx: ServiceContext, planId: string): Promise<Plan> {
    const plan = await mustGet(this.storage, "plan", planId);
    await this.access.require(ctx, plan.projectId, planId, "plan.read");
    return plan;
  }

  async update(
    ctx: ServiceContext,
    planId: string,
    changes: Partial<CreatePlanInput> & { version: number },
  ): Promise<Plan> {
    const plan = await mustGet(this.storage, "plan", planId);
    await this.access.require(ctx, plan.projectId, planId, "plan.manage");
    const saved = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "plan", planId);
      if (current.version !== changes.version)
        throw new ConflictError("Plan was changed by someone else");
      const { version: _v, ...rest } = changes;
      const updated = await tx.save("plan", touch(current, ctx, rest));
      await this.audit.record(tx, ctx, {
        projectId: plan.projectId,
        entityType: "plan",
        entityId: planId,
        action: "update",
        details: rest,
      });
      return updated;
    });
    this.events.emit({
      projectId: plan.projectId,
      entityType: "plan",
      entityId: planId,
      action: "update",
      planIds: [planId],
    });
    return saved;
  }

  /** Everything the client needs to render a plan, with external items resolved live. */
  async getView(ctx: ServiceContext, planId: string): Promise<PlanView> {
    const plan = await mustGet(this.storage, "plan", planId);
    const myRoles = await this.access.require(ctx, plan.projectId, planId, "plan.read");
    const { projectId } = plan;
    const [items, refs, allLinks] = await Promise.all([
      this.storage.query("task", { projectId, planId }),
      this.storage.query("planItemReference", { planId }),
      this.storage.query("planLink", { projectId }),
    ]);
    const references: ResolvedReference[] = [];
    for (const r of refs) {
      const item = await this.storage.get("task", r.itemId);
      if (item)
        references.push({
          ...normalizeReference(r),
          item,
          linkType: effectiveLinkType(r, allLinks),
        });
    }
    // Plans using this plan's external tasks, in any project of the tree.
    const recipientRefs = (
      await Promise.all(
        items
          .filter((t) => t.ownership === "EXTERNAL")
          .map((t) => this.storage.query("planItemReference", { itemId: t.id })),
      )
    ).flat();
    // Requests and links of every project involved (owners of used tasks, recipients).
    const involved = [
      ...new Set([
        projectId,
        ...references.map((r) => r.item.projectId),
        ...recipientRefs.map((r) => r.projectId),
      ]),
    ];
    const linksOf = new Map(
      await Promise.all(
        involved.map(
          async (pid) => [pid, await this.storage.query("planLink", { projectId: pid })] as const,
        ),
      ),
    );
    const pending = (
      await Promise.all(
        involved.map((pid) =>
          this.storage.query("changeRequest", { projectId: pid, status: "PENDING" }),
        ),
      )
    ).flat();
    const visibleIds = new Set([...items.map((i) => i.id), ...references.map((r) => r.itemId)]);
    // References placed under a local task make it an activity, like subtasks.
    const kinds = getItemKinds([
      ...items,
      ...references
        .filter((r) => r.parentId !== null)
        .map((r) => ({ id: `ref:${r.id}`, duration: r.item.duration, parentId: r.parentId })),
    ]);
    // Tasks and external tasks share one sequence of local IDs (older ones are numbered here).
    const backfill = missingTaskNumbers([...items, ...references]);
    const numbered = items.map((t) => {
      const taskNumber = backfill.get(t.id);
      return taskNumber === undefined ? t : { ...t, taskNumber };
    });
    for (const r of references) r.taskNumber = backfill.get(r.id) ?? r.taskNumber;
    const shown = new Map([...items, ...references.map((r) => r.item)].map((t) => [t.id, t]));
    // Dependencies between shown tasks, from every project involved (also the owners' own).
    const allDeps = (
      await Promise.all(involved.map((pid) => this.storage.query("dependency", { projectId: pid })))
    ).flat();
    const recipients: Record<string, RecipientInfo[]> = {};
    for (const r of recipientRefs) {
      const [recipientPlan, recipientProject] = await Promise.all([
        this.storage.get("plan", r.planId),
        this.storage.get("project", r.projectId),
      ]);
      (recipients[r.itemId] ??= []).push({
        referenceId: r.id,
        planId: r.planId,
        planName: recipientPlan?.name ?? "",
        projectId: r.projectId,
        projectName: recipientProject?.name ?? "",
        linkType: effectiveLinkType(r, linksOf.get(r.projectId) ?? []),
      });
    }
    const [current, agreed] = await Promise.all([
      findTrackBaseline(this.storage, planId, "CURRENT"),
      findTrackBaseline(this.storage, planId, "AGREED"),
    ]);
    return {
      plan,
      items: numbered.sort(compareTaskOrder),
      kinds: Object.fromEntries(items.map((t) => [t.id, kinds.get(t.id)!])),
      references: references.sort((a, b) =>
        compareTaskOrder(
          { id: a.id, sortOrder: a.sortOrder, name: a.item.name },
          { id: b.id, sortOrder: b.sortOrder, name: b.item.name },
        ),
      ),
      dependencies: allDeps
        .filter((d) => visibleIds.has(d.fromItemId) && visibleIds.has(d.toItemId))
        .map((d) => normalizeDependency(d, shown.get(d.toItemId)!)),
      links: allLinks.filter((l) => l.fromPlanId === planId || l.toPlanId === planId),
      myRoles,
      pendingItemIds: [
        ...new Set(pending.flatMap((cr) => cr.itemIds).filter((id) => visibleIds.has(id))),
      ].sort(),
      proposedChanges: pending
        .filter((cr) => cr.kind === "PROPOSE_TASK_CHANGE" && visibleIds.has(cr.itemIds[0]!))
        .map((cr) => ({
          changeRequestId: cr.id,
          planId: cr.planId,
          proposed: cr.proposed[0]!,
          description: cr.description,
        })),
      recipients,
      trackBaselineIds: { CURRENT: current?.id ?? null, AGREED: agreed?.id ?? null },
    };
  }
}
