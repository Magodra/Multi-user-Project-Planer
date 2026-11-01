import { normalizeReference } from "../domain/references.js";
import {
  checkDependency,
  compareTaskOrder,
  missingTaskNumbers,
  normalizeDependency,
} from "../domain/dependencies.js";
import {
  type Baseline,
  type CreatePlanInput,
  type Dependency,
  type Plan,
  type PlanDependencyIssues,
  type PlanView,
  type RecipientInfo,
  type ResolvedReference,
  type RoleAssignment,
  getItemKind,
  getItemKinds,
} from "@planning/shared";
import { ConflictError } from "../domain/errors.js";
import { assertPlanDeletable } from "../domain/plans.js";
import { effectiveLinkType } from "../domain/links.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./events.js";
import { findTrackBaseline, getDefinition } from "./lookups.js";
import { childCount } from "./workflow.js";
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

  /** Dependency problems per plan of a project, from the same check as each plan's view. */
  async dependencyIssues(ctx: ServiceContext, projectId: string): Promise<PlanDependencyIssues[]> {
    const out: PlanDependencyIssues[] = [];
    for (const plan of await this.list(ctx, projectId)) {
      const view = await this.getView(ctx, plan.id);
      const names = new Map([
        ...view.items.map((t) => [t.id, t.name] as const),
        ...view.references.map(
          (r) => [r.item.id, `${r.item.name} (from ${r.ownerPlanName})`] as const,
        ),
      ]);
      const byId = new Map(view.dependencies.map((d) => [d.id, d]));
      out.push({
        planId: plan.id,
        issues: view.dependencyIssues.map((issue) => {
          const d = byId.get(issue.dependencyId)!;
          return {
            ...issue,
            type: d.type,
            lag: d.lag,
            lagUnit: d.lagUnit,
            fromName: names.get(d.fromItemId) ?? "",
            toName: names.get(d.toItemId) ?? "",
          };
        }),
      });
    }
    return out;
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

  /**
   * Delete a plan for good, after the user confirmed it. Refused while its
   * tasks are used in other plans, while change requests involving it are
   * open, and when it has locked baselines (accepted history is never
   * removed). Deletes everything that belongs only to the plan and drops it
   * from timelines and report definitions.
   */
  async delete(ctx: ServiceContext, planId: string, version: number): Promise<void> {
    const plan = await mustGet(this.storage, "plan", planId);
    await this.access.require(ctx, plan.projectId, planId, "plan.manage");
    const { projectId } = plan;
    await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "plan", planId);
      if (current.version !== version) throw new ConflictError("Plan was changed by someone else");
      const tasks = await tx.query("task", { projectId, planId });
      const taskIds = new Set(tasks.map((t) => t.id));
      const usedBy = (
        await Promise.all(tasks.map((t) => tx.query("planItemReference", { itemId: t.id })))
      ).flat();
      const usedInPlans = [
        ...new Set(
          await Promise.all(
            usedBy.map(async (r) => (await tx.get("plan", r.planId))?.name ?? r.planId),
          ),
        ),
      ];
      const requests = await tx.query("changeRequest", { projectId, planId });
      const pendingApprovals = await tx.query("approval", { planId, status: "PENDING" });
      const baselines = await tx.query("baseline", { projectId, planId });
      assertPlanDeletable({
        usedInPlans,
        openRequests:
          requests.filter((cr) => cr.status === "PENDING").length + pendingApprovals.length,
        lockedBaselines: baselines.filter((b) => b.locked).length,
      });

      // Dependencies on its tasks (any plan) and the plan's own ones.
      const deps = new Map<string, Dependency>();
      for (const id of taskIds) {
        for (const d of await tx.query("dependency", { fromItemId: id })) deps.set(d.id, d);
        for (const d of await tx.query("dependency", { toItemId: id })) deps.set(d.id, d);
      }
      for (const d of await tx.query("dependency", { projectId }))
        if (d.planId === planId) deps.set(d.id, d);
      for (const d of deps.values()) await tx.delete("dependency", d.id, d.version);

      // Its uses of other plans' tasks, with their links.
      for (const ref of await tx.query("planItemReference", { planId })) {
        for (const link of await tx.query("planLink", { referenceId: ref.id }))
          await tx.delete("planLink", link.id, link.version);
        await tx.delete("planItemReference", ref.id, ref.version);
      }
      for (const cr of requests) {
        for (const a of await tx.query("approval", { changeRequestId: cr.id }))
          await tx.delete("approval", a.id, a.version);
        await tx.delete("changeRequest", cr.id, cr.version);
      }
      for (const b of baselines) await tx.delete("baseline", b.id, b.version);
      for (const t of tasks) await tx.delete("task", t.id, t.version);
      for (const a of await tx.query("roleAssignment", { projectId, planId }))
        await tx.delete("roleAssignment", a.id, a.version);
      for (const t of await tx.query("timeline", { projectId })) {
        const entries = t.entries.filter((e) => e.planId !== planId);
        if (entries.length !== t.entries.length)
          await tx.save("timeline", touch(t, ctx, { entries }));
      }
      for (const r of await tx.query("reportDefinition", { projectId })) {
        if (r.planIds.includes(planId))
          await tx.save(
            "reportDefinition",
            touch(r, ctx, { planIds: r.planIds.filter((id) => id !== planId) }),
          );
      }
      await tx.delete("plan", planId, version);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "plan",
        entityId: planId,
        action: "delete",
        details: { name: plan.name, tasks: tasks.length },
      });
    });
    this.events.emit({
      projectId,
      entityType: "plan",
      entityId: planId,
      action: "delete",
      planIds: [planId],
    });
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
    const ownerNames = new Map<string, string>();
    for (const r of refs) {
      const item = await this.storage.get("task", r.itemId);
      if (!item) continue;
      if (!ownerNames.has(r.ownerPlanId))
        ownerNames.set(r.ownerPlanId, (await this.storage.get("plan", r.ownerPlanId))?.name ?? "");
      references.push({
        ...normalizeReference(r),
        item,
        linkType: effectiveLinkType(r, allLinks),
        ownerPlanName: ownerNames.get(r.ownerPlanId)!,
        itemKind: getItemKind(item, await childCount(this.storage, item)),
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
    // Lags are working time on this plan's project calendar.
    const { calendar } = await mustGet(this.storage, "project", projectId);
    const dependencies = allDeps
      .filter((d) => visibleIds.has(d.fromItemId) && visibleIds.has(d.toItemId))
      .map((d) => normalizeDependency(d, shown.get(d.toItemId)!));
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
      dependencies,
      dependencyIssues: dependencies.flatMap((d) => {
        const check = checkDependency(
          d,
          shown.get(d.fromItemId)!,
          shown.get(d.toItemId)!,
          calendar,
        );
        return check.violated
          ? [{ dependencyId: d.id, required: check.required, actual: check.actual }]
          : [];
      }),
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
