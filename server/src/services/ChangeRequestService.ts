/**
 * Acceptance workflow (CLAUDE.md §6): ChangeRequest → Approval[] → atomic
 * acceptance into a track. Approvals can only be decided from the UI.
 */
import {
  type Approval,
  type Baseline,
  type BaselineItem,
  type ChangeRequest,
  type ChangeRequestWithApprovals,
  type CreateChangeRequestInput,
  type DecideApprovalInput,
  type PendingApproval,
  type ProposeTaskChangeInput,
  type TaskApprovalRequest,
  type Track,
  nowIso,
} from "@planning/shared";
import {
  type CoveredItem,
  assertAcceptanceGranularity,
  assertApprovalOrigin,
  assertPending,
  canDecide,
  decisionStatus,
  requiredApprovals,
  resolveStatus,
  taskChangeApproval,
} from "../domain/approvals.js";
import { mergeBaselineItems } from "../domain/baselines.js";
import { applyScheduleChange, assertScheduleEditable } from "../domain/items.js";
import { effectiveLinkType } from "../domain/links.js";
import { projectWithDescendants } from "../domain/projects.js";
import { assertLocalChangeAllowed, normalizeReference } from "../domain/references.js";
import { ForbiddenError, RuleViolationError, ValidationError } from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { BaselineService } from "./BaselineService.js";
import { type EventBus, perProject } from "./events.js";
import { findTrackBaseline, getDefinition } from "./lookups.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";
import {
  childCount,
  restingState,
  revertProposed,
  rollUpPlan,
  saveTaskChange,
  supersedeOpenRequests,
  updateAgreementStates,
} from "./workflow.js";

export class ChangeRequestService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly baselines: BaselineService,
  ) {}

  /** Propose accepting items (or promoting a branch) into a track. Allowed from UI and MCP. */
  async create(
    ctx: ServiceContext,
    input: CreateChangeRequestInput,
  ): Promise<ChangeRequestWithApprovals> {
    const plan = await mustGet(this.storage, "plan", input.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "changeRequest.create");
    const { projectId } = plan;
    const result = await this.storage.transaction(async (tx) => {
      const definition = await getDefinition(tx, projectId, input.targetTrack);
      const source = await this.sourceItems(tx, projectId, plan.id, definition.acceptFrom, input);
      const available = new Map(source.items.map((i) => [i.itemId, i]));
      const itemIds =
        input.itemIds.length > 0
          ? [...new Set(input.itemIds)].sort()
          : [...available.keys()].sort();
      for (const id of itemIds) {
        if (!available.has(id))
          throw new RuleViolationError(`Task ${id} is not in ${source.label}`);
      }
      assertAcceptanceGranularity(
        definition.granularityOfAcceptance,
        itemIds.length,
        available.size,
      );

      const covered: CoveredItem[] = [];
      for (const id of itemIds) {
        const task = await mustGet(tx, "task", id);
        if (input.targetTrack === "ESTIMATED" && task.planId !== plan.id) {
          throw new RuleViolationError("Changes to external tasks are made in the owner plan");
        }
        covered.push({
          itemId: id,
          ownerPlanId: task.planId,
          ownership: task.ownership,
          projectId: task.projectId,
        });
      }

      // A newer request for the same items and track replaces the older one.
      await supersedeOpenRequests(
        tx,
        ctx,
        this.audit,
        projectId,
        itemIds,
        (cr) => cr.planId === plan.id && cr.targetTrack === input.targetTrack,
      );

      const cr: ChangeRequest = {
        ...newMeta(ctx),
        projectId,
        planId: plan.id,
        kind: input.sourceBaselineId ? "PROMOTE_BRANCH" : "ACCEPT_TO_TRACK",
        title: input.title,
        description: input.description,
        targetTrack: input.targetTrack,
        itemIds,
        sourceBaselineId: input.sourceBaselineId,
        proposed: itemIds.map((id) => available.get(id)!),
        status: "PENDING",
        requestedBy: ctx.user.id,
        origin: ctx.origin,
        resolvedAt: null,
      };
      let saved = await tx.save("changeRequest", cr);

      // Recipients of external tasks can be plans of other projects in the tree.
      const references = (
        await Promise.all(covered.map((c) => tx.query("planItemReference", { itemId: c.itemId })))
      ).flat();
      const projectIds = [
        ...new Set([
          projectId,
          ...covered.map((c) => c.projectId),
          ...references.map((r) => r.projectId),
        ]),
      ];
      const plans = new Map(
        (await Promise.all(projectIds.map((pid) => tx.query("plan", { projectId: pid }))))
          .flat()
          .map((p) => [p.id, p]),
      );
      const links = (
        await Promise.all(projectIds.map((pid) => tx.query("planLink", { projectId: pid })))
      ).flat();
      const required = requiredApprovals({
        planId: plan.id,
        definition,
        items: covered,
        references,
        links,
        plans,
      });
      const approvals: Approval[] = [];
      for (const r of required) {
        approvals.push(
          await tx.save("approval", {
            ...newMeta(ctx),
            // Stored with the deciding plan's project: its members see and decide it.
            projectId: plans.get(r.planId)?.projectId ?? projectId,
            changeRequestId: cr.id,
            planId: r.planId,
            partyId: r.partyId,
            roles: r.roles,
            reason: r.reason,
            status: "PENDING",
            decidedBy: null,
            decidedAt: null,
            comment: "",
          }),
        );
      }
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "changeRequest",
        entityId: cr.id,
        action: "create",
        details: { targetTrack: cr.targetTrack, itemIds, approvals: required.length },
      });

      if (approvals.length === 0) {
        saved = await this.accept(tx, ctx, saved);
      } else if (cr.targetTrack === "AGREED") {
        for (const id of itemIds) {
          await updateAgreementStates(tx, ctx, id, async () => "PROPOSED");
        }
      }
      return { changeRequest: saved, approvals };
    });
    this.emit(result.changeRequest, "create", result.approvals);
    return result;
  }

  /**
   * A local change to an external task on an AGREEMENT reference: proposed to
   * the task's owner plan, applied to the task when approved. MONITOR
   * references cannot be changed. Allowed from UI and MCP (deciding is UI only).
   */
  async proposeTaskChange(
    ctx: ServiceContext,
    referenceId: string,
    input: ProposeTaskChangeInput,
  ): Promise<ChangeRequestWithApprovals> {
    const existing = await mustGet(this.storage, "planItemReference", referenceId);
    await this.access.require(ctx, existing.projectId, existing.planId, "plan.edit");
    const { projectId } = existing;
    const result = await this.storage.transaction(async (tx) => {
      const ref = normalizeReference(await mustGet(tx, "planItemReference", referenceId));
      assertLocalChangeAllowed(effectiveLinkType(ref, await tx.query("planLink", { projectId })));
      const task = await mustGet(tx, "task", ref.itemId);
      const project = await mustGet(tx, "project", projectId);
      const children = await childCount(tx, task);
      const scheduleTouched = [input.start, input.end, input.duration, input.granularity].some(
        (v) => v !== undefined,
      );
      if (scheduleTouched) assertScheduleEditable(task, children);
      if (input.duration === 0 && children > 0)
        throw new RuleViolationError("An activity cannot become a milestone");
      const schedule = scheduleTouched
        ? applyScheduleChange(task, input, project.calendar)
        : {
            start: task.start,
            end: task.end,
            duration: task.duration,
            granularity: task.granularity,
          };
      const name = input.name ?? task.name;
      const unchanged =
        name === task.name &&
        schedule.start === task.start &&
        schedule.end === task.end &&
        schedule.duration === task.duration &&
        schedule.granularity === task.granularity;
      if (unchanged) throw new ValidationError("Nothing to change");

      // A newer proposal from the same plan replaces the older one.
      await supersedeOpenRequests(
        tx,
        ctx,
        this.audit,
        projectId,
        [task.id],
        (cr) => cr.kind === "PROPOSE_TASK_CHANGE" && cr.planId === ref.planId,
      );
      const cr: ChangeRequest = {
        ...newMeta(ctx),
        projectId,
        planId: ref.planId,
        kind: "PROPOSE_TASK_CHANGE",
        title: `Change: ${task.name}`,
        description: input.description,
        targetTrack: "ESTIMATED",
        itemIds: [task.id],
        sourceBaselineId: null,
        proposed: [
          { itemId: task.id, name, parentId: task.parentId, isReference: true, ...schedule },
        ],
        status: "PENDING",
        requestedBy: ctx.user.id,
        origin: ctx.origin,
        resolvedAt: null,
      };
      const saved = await tx.save("changeRequest", cr);
      // Decided by the owner plan, which may belong to another project of the tree.
      const required = taskChangeApproval(
        await mustGet(tx, "plan", task.planId),
        await getDefinition(tx, task.projectId, "ESTIMATED"),
      );
      const approval = await tx.save("approval", {
        ...newMeta(ctx),
        projectId: task.projectId,
        changeRequestId: cr.id,
        planId: required.planId,
        partyId: required.partyId,
        roles: required.roles,
        reason: required.reason,
        status: "PENDING",
        decidedBy: null,
        decidedAt: null,
        comment: "",
      });
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "changeRequest",
        entityId: cr.id,
        action: "create",
        details: { kind: cr.kind, itemIds: cr.itemIds, referenceId },
      });
      return { changeRequest: saved, approvals: [approval] };
    });
    this.emit(result.changeRequest, "create", result.approvals);
    return result;
  }

  /** Approve or reject. UI only: calls from MCP are rejected here, not just in the MCP layer. */
  async decide(
    ctx: ServiceContext,
    approvalId: string,
    input: DecideApprovalInput,
  ): Promise<ChangeRequestWithApprovals> {
    assertApprovalOrigin(ctx.origin);
    const approval = await mustGet(this.storage, "approval", approvalId);
    const roles = await this.access.roles(ctx.user, approval.projectId, approval.planId);
    const result = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "approval", approvalId);
      let cr = await mustGet(tx, "changeRequest", current.changeRequestId);
      assertPending(cr.status);
      if (!canDecide(current, ctx.user, roles))
        throw new ForbiddenError("You cannot decide this approval");
      await tx.save(
        "approval",
        touch(current, ctx, {
          status: decisionStatus(input.decision),
          decidedBy: ctx.user.id,
          decidedAt: nowIso(),
          comment: input.comment,
        }),
      );
      await this.audit.record(tx, ctx, {
        projectId: cr.projectId,
        entityType: "approval",
        entityId: approvalId,
        action: input.decision === "APPROVE" ? "approve" : "reject",
        details: { changeRequestId: cr.id, comment: input.comment },
      });
      const approvals = await tx.query("approval", { changeRequestId: cr.id });
      const status = resolveStatus(approvals);
      if (status === "APPROVED") cr = await this.accept(tx, ctx, cr);
      else if (status === "REJECTED") cr = await this.reject(tx, ctx, cr);
      return { changeRequest: cr, approvals };
    });
    this.emit(result.changeRequest, "decide", result.approvals);
    const cr = result.changeRequest;
    if (cr.kind === "PROPOSE_TASK_CHANGE" && cr.status === "APPROVED")
      await this.emitTaskChange(cr.projectId, cr.itemIds[0]!);
    return result;
  }

  async withdraw(ctx: ServiceContext, changeRequestId: string): Promise<ChangeRequest> {
    const cr = await mustGet(this.storage, "changeRequest", changeRequestId);
    if (cr.requestedBy !== ctx.user.id)
      await this.access.require(ctx, cr.projectId, cr.planId, "plan.manage");
    const saved = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "changeRequest", changeRequestId);
      assertPending(current.status);
      const s = await tx.save(
        "changeRequest",
        touch(current, ctx, { status: "WITHDRAWN", resolvedAt: nowIso() }),
      );
      await revertProposed(tx, ctx, s);
      await this.audit.record(tx, ctx, {
        projectId: cr.projectId,
        entityType: "changeRequest",
        entityId: cr.id,
        action: "withdraw",
      });
      return s;
    });
    this.emit(saved, "withdraw");
    return saved;
  }

  async list(ctx: ServiceContext, planId: string): Promise<ChangeRequestWithApprovals[]> {
    const plan = await mustGet(this.storage, "plan", planId);
    await this.access.require(ctx, plan.projectId, planId, "plan.read");
    const crs = await this.storage.query("changeRequest", { projectId: plan.projectId, planId });
    const out: ChangeRequestWithApprovals[] = [];
    for (const cr of crs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))) {
      out.push({
        changeRequest: cr,
        approvals: await this.storage.query("approval", { changeRequestId: cr.id }),
      });
    }
    return out;
  }

  async get(ctx: ServiceContext, changeRequestId: string): Promise<ChangeRequestWithApprovals> {
    const cr = await mustGet(this.storage, "changeRequest", changeRequestId);
    await this.access.require(ctx, cr.projectId, cr.planId, "plan.read");
    return {
      changeRequest: cr,
      approvals: await this.storage.query("approval", { changeRequestId: cr.id }),
    };
  }

  /** The approval inbox: pending approvals the user can decide. */
  async listPending(
    ctx: ServiceContext,
    projectId?: string,
    includeSubprojects = false,
  ): Promise<PendingApproval[]> {
    const ids = await this.access.projectIdsFor(ctx.user);
    const all = await this.storage.query("project");
    const accessible = ids === "ALL" ? all.map((p) => p.id) : ids;
    // A workspace shows subproject plans too, so its inbox can include their approvals.
    const projectIds = projectId
      ? includeSubprojects
        ? projectWithDescendants(projectId, all).filter(
            (id) => id === projectId || accessible.includes(id),
          )
        : [projectId]
      : accessible;
    const out: PendingApproval[] = [];
    for (const pid of projectIds) {
      const pending = await this.storage.query("approval", { projectId: pid, status: "PENDING" });
      for (const approval of pending) {
        const roles = await this.access.roles(ctx.user, pid, approval.planId);
        if (!canDecide(approval, ctx.user, roles)) continue;
        const cr = await this.storage.get("changeRequest", approval.changeRequestId);
        if (cr?.status !== "PENDING") continue;
        const plan = await this.storage.get("plan", approval.planId);
        out.push({ approval, changeRequest: cr, planName: plan?.name ?? "" });
      }
    }
    return out.sort((a, b) => (a.changeRequest.createdAt < b.changeRequest.createdAt ? -1 : 1));
  }

  /**
   * Open requests covering a task (raised in its own plan or in plans using
   * it), with the approvals the user may decide. Shown in the task dialogs.
   */
  async pendingForItem(ctx: ServiceContext, itemId: string): Promise<TaskApprovalRequest[]> {
    const task = await mustGet(this.storage, "task", itemId);
    await this.access.require(ctx, task.projectId, null, "project.read");
    const refs = await this.storage.query("planItemReference", { itemId });
    const projectIds = [...new Set([task.projectId, ...refs.map((r) => r.projectId)])];
    const requests = (
      await Promise.all(
        projectIds.map((pid) =>
          this.storage.query("changeRequest", { projectId: pid, status: "PENDING" }),
        ),
      )
    )
      .flat()
      .filter((cr) => cr.itemIds.includes(itemId))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const planName = async (planId: string) => (await this.storage.get("plan", planId))?.name ?? "";
    const out: TaskApprovalRequest[] = [];
    for (const cr of requests) {
      const approvals = await this.storage.query("approval", { changeRequestId: cr.id });
      const decidableApprovalIds: string[] = [];
      const planNames: Record<string, string> = {};
      for (const a of approvals) {
        planNames[a.planId] = await planName(a.planId);
        if (a.status !== "PENDING") continue;
        const roles = await this.access.roles(ctx.user, a.projectId, a.planId);
        if (canDecide(a, ctx.user, roles)) decidableApprovalIds.push(a.id);
      }
      out.push({
        changeRequest: cr,
        approvals,
        decidableApprovalIds,
        planName: await planName(cr.planId),
        planNames,
      });
    }
    return out;
  }

  // --- acceptance ----------------------------------------------------------

  /** Accept atomically: runs inside the caller's transaction, so either everything is written or nothing. */
  private async accept(
    tx: StorageAdapter,
    ctx: ServiceContext,
    cr: ChangeRequest,
  ): Promise<ChangeRequest> {
    const { projectId } = cr;
    const definition = await getDefinition(tx, projectId, cr.targetTrack);
    if (cr.kind === "PROPOSE_TASK_CHANGE") {
      // Apply the recipient's proposal to the owner's task (activities keep their roll-up).
      const p = cr.proposed[0]!;
      const task = await mustGet(tx, "task", p.itemId);
      const project = await mustGet(tx, "project", projectId);
      const schedule =
        (await childCount(tx, task)) > 0
          ? {}
          : { start: p.start, end: p.end, duration: p.duration, granularity: p.granularity };
      await saveTaskChange(
        tx,
        ctx,
        this.audit,
        task,
        touch(task, ctx, { name: p.name, ...schedule }),
        project.calendar,
        "update",
        { changeRequestId: cr.id, name: p.name, ...schedule },
        cr.id,
      );
    } else if (cr.targetTrack === "ESTIMATED") {
      const project = await mustGet(tx, "project", projectId);
      for (const p of cr.proposed) {
        const task = await mustGet(tx, "task", p.itemId);
        const hasSubtasks = (await tx.query("task", { projectId, parentId: task.id })).length > 0;
        if (task.planId !== cr.planId || hasSubtasks) continue; // activities follow by roll-up
        await tx.save(
          "task",
          touch(task, ctx, {
            start: p.start,
            end: p.end,
            duration: p.duration,
            granularity: p.granularity,
          }),
        );
      }
      await rollUpPlan(tx, projectId, cr.planId, project.calendar);
    } else {
      const writes = new Map<string, BaselineItem[]>();
      const push = (planId: string, item: BaselineItem) =>
        writes.set(planId, [...(writes.get(planId) ?? []), item]);
      for (const p of cr.proposed) {
        const task = await mustGet(tx, "task", p.itemId);
        if (cr.targetTrack === "AGREED" && task.ownership === "EXTERNAL") {
          // Agreed values of an external item are written to the owner and every recipient.
          push(task.planId, { ...p, isReference: false, parentId: task.parentId });
          for (const ref of await tx.query("planItemReference", { itemId: task.id })) {
            push(ref.planId, {
              ...p,
              isReference: true,
              parentId: normalizeReference(ref).parentId,
            });
          }
        } else {
          push(cr.planId, { ...p, isReference: task.planId !== cr.planId });
        }
      }
      for (const [planId, items] of writes) {
        await this.writeTrack(
          tx,
          ctx,
          planId,
          cr.targetTrack,
          items,
          definition.lockOnAccept ? `${definition.name}: ${cr.title}` : null,
        );
      }
      if (cr.targetTrack === "AGREED") {
        for (const itemId of cr.itemIds) {
          await updateAgreementStates(tx, ctx, itemId, async (planId) =>
            writes.get(planId)?.some((i) => i.itemId === itemId) ? "AGREED" : null,
          );
        }
      }
    }
    const saved = await tx.save(
      "changeRequest",
      touch(cr, ctx, { status: "APPROVED", resolvedAt: nowIso() }),
    );
    await this.audit.record(tx, ctx, {
      projectId,
      entityType: "changeRequest",
      entityId: cr.id,
      action: "accept",
      details: { targetTrack: cr.targetTrack, itemIds: cr.itemIds },
    });
    return saved;
  }

  /**
   * Rejection. For AGREED: the owner item becomes REJECTED; in recipient
   * plans where the item is already in Current it stays there with state
   * REJECTED (not rolled back, CLAUDE.md §6.6); elsewhere it reverts.
   */
  private async reject(
    tx: StorageAdapter,
    ctx: ServiceContext,
    cr: ChangeRequest,
  ): Promise<ChangeRequest> {
    const saved = await tx.save(
      "changeRequest",
      touch(cr, ctx, { status: "REJECTED", resolvedAt: nowIso() }),
    );
    if (cr.targetTrack === "AGREED") {
      for (const itemId of cr.itemIds) {
        await updateAgreementStates(tx, ctx, itemId, async (planId, current, isOwner) => {
          if (isOwner) return "REJECTED";
          const currentTrack = await findTrackBaseline(tx, planId, "CURRENT");
          if (currentTrack?.items.some((i) => i.itemId === itemId)) return "REJECTED";
          return current === "PROPOSED" ? restingState(tx, planId, itemId) : null;
        });
      }
    }
    await this.audit.record(tx, ctx, {
      projectId: cr.projectId,
      entityType: "changeRequest",
      entityId: cr.id,
      action: "reject",
    });
    return saved;
  }

  private async writeTrack(
    tx: StorageAdapter,
    ctx: ServiceContext,
    planId: string,
    track: Exclude<Track, "ESTIMATED">,
    items: BaselineItem[],
    snapshotName: string | null,
  ): Promise<void> {
    const baseline = await findTrackBaseline(tx, planId, track);
    if (!baseline) throw new ValidationError(`Plan ${planId} has no ${track} track`);
    const updated = await tx.save(
      "baseline",
      touch(baseline, ctx, { items: mergeBaselineItems(baseline.items, items) }),
    );
    if (snapshotName) {
      // lockOnAccept: keep an immutable record of the track as accepted.
      const snapshot: Baseline = {
        ...newMeta(ctx),
        projectId: baseline.projectId,
        planId,
        name: snapshotName,
        kind: "SNAPSHOT",
        track: null,
        definitionId: baseline.definitionId,
        parentBaselineId: baseline.id,
        locked: true,
        lockedAt: nowIso(),
        items: updated.items,
      };
      await tx.save("baseline", snapshot);
    }
  }

  private async sourceItems(
    tx: StorageAdapter,
    projectId: string,
    planId: string,
    acceptFrom: Track,
    input: CreateChangeRequestInput,
  ): Promise<{ items: BaselineItem[]; label: string }> {
    if (input.sourceBaselineId) {
      const branch = await mustGet(tx, "baseline", input.sourceBaselineId);
      if (branch.planId !== planId || branch.kind !== "BRANCH") {
        throw new RuleViolationError("Only a what-if branch of this plan can be promoted");
      }
      return { items: branch.items, label: `branch '${branch.name}'` };
    }
    if (acceptFrom === "ESTIMATED") {
      return { items: await this.baselines.liveItems(tx, projectId, planId), label: "the plan" };
    }
    const track = await findTrackBaseline(tx, planId, acceptFrom);
    return { items: track?.items ?? [], label: `the ${acceptFrom} track` };
  }

  /** An approved proposal changed the owner's task: notify the owner and every recipient plan. */
  private async emitTaskChange(projectId: string, itemId: string): Promise<void> {
    const task = await this.storage.get("task", itemId);
    if (!task) return;
    const refs = await this.storage.query("planItemReference", { itemId });
    this.events.emit(
      perProject([projectId, task.projectId, ...refs.map((r) => r.projectId)], {
        entityType: "task",
        entityId: itemId,
        action: "update",
        planIds: [...new Set([task.planId, ...refs.map((r) => r.planId)])],
      }),
    );
  }

  /** Notify the requesting plan and every plan that takes part in the approval. */
  private emit(cr: ChangeRequest, action: string, approvals: Approval[] = []): void {
    const planIds = [...new Set([cr.planId, ...approvals.map((a) => a.planId)])];
    this.events.emit(
      perProject([cr.projectId, ...approvals.map((a) => a.projectId)], {
        entityType: "changeRequest",
        entityId: cr.id,
        action,
        planIds,
      }),
    );
  }
}
