import { normalizeReference } from "../domain/references.js";
import {
  type Baseline,
  type BaselineComparison,
  type BaselineItem,
  type BaselineTreeNode,
  type CompareBaselinesInput,
  type CreateBaselineInput,
  type Track,
  type UpdateBaselineItemInput,
  makeSchedule,
  nowIso,
} from "@planning/shared";
import { ConflictError, RuleViolationError, ValidationError } from "../domain/errors.js";
import {
  type ComparisonSource,
  assertBaselineMutable,
  assertBranchEditable,
  compareAgainst,
  mergeBaselineItems,
  toBaselineItem,
} from "../domain/baselines.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import type { EventBus } from "./events.js";
import { findTrackBaseline, getDefinition } from "./lookups.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";

export class BaselineService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async list(ctx: ServiceContext, planId: string): Promise<Baseline[]> {
    const plan = await mustGet(this.storage, "plan", planId);
    await this.access.require(ctx, plan.projectId, planId, "plan.read");
    const baselines = await this.storage.query("baseline", { projectId: plan.projectId, planId });
    return baselines.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
    );
  }

  async tree(ctx: ServiceContext, planId: string): Promise<BaselineTreeNode[]> {
    const baselines = await this.list(ctx, planId);
    const nodes = new Map<string, BaselineTreeNode>(
      baselines.map(({ items: _items, ...b }) => [b.id, { baseline: b, children: [] }]),
    );
    const roots: BaselineTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.baseline.parentBaselineId
        ? nodes.get(node.baseline.parentBaselineId)
        : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  async get(ctx: ServiceContext, baselineId: string): Promise<Baseline> {
    const baseline = await mustGet(this.storage, "baseline", baselineId);
    await this.access.require(ctx, baseline.projectId, baseline.planId, "plan.read");
    return baseline;
  }

  /** Snapshot (usually locked) or what-if branch, from the live plan or another baseline. */
  async create(ctx: ServiceContext, input: CreateBaselineInput): Promise<Baseline> {
    const plan = await mustGet(this.storage, "plan", input.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "baseline.create");
    const saved = await this.storage.transaction(async (tx) => {
      let items: BaselineItem[];
      let sourceTrack: Track = "ESTIMATED";
      if (input.fromBaselineId) {
        const source = await mustGet(tx, "baseline", input.fromBaselineId);
        if (source.planId !== plan.id)
          throw new ValidationError("Source baseline belongs to another plan");
        items = source.items;
        sourceTrack = source.track ?? "ESTIMATED";
      } else {
        items = await this.liveItems(tx, plan.projectId, plan.id);
      }
      if (input.kind === "BRANCH") {
        const def = await getDefinition(tx, plan.projectId, sourceTrack);
        if (!def.allowBranching)
          throw new RuleViolationError(`Branching is not allowed from ${def.name}`);
      }
      const lock = input.kind === "SNAPSHOT" && input.lock;
      const baseline: Baseline = {
        ...newMeta(ctx),
        projectId: plan.projectId,
        planId: plan.id,
        name: input.name,
        kind: input.kind,
        track: null,
        definitionId: null,
        parentBaselineId: input.fromBaselineId,
        locked: lock,
        lockedAt: lock ? nowIso() : null,
        items,
      };
      const b = await tx.save("baseline", baseline);
      await this.audit.record(tx, ctx, {
        projectId: plan.projectId,
        entityType: "baseline",
        entityId: baseline.id,
        action: "create",
        details: { kind: input.kind, name: input.name, locked: lock },
      });
      return b;
    });
    this.events.emit({
      projectId: plan.projectId,
      entityType: "baseline",
      entityId: saved.id,
      action: "create",
      planIds: [plan.id],
    });
    return saved;
  }

  /** Locking is one-way: a locked baseline is immutable forever. */
  async lock(ctx: ServiceContext, baselineId: string, version: number): Promise<Baseline> {
    const baseline = await mustGet(this.storage, "baseline", baselineId);
    await this.access.require(ctx, baseline.projectId, baseline.planId, "plan.manage");
    if (baseline.kind === "TRACK")
      throw new RuleViolationError("Tracks cannot be locked; create a snapshot instead");
    return this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "baseline", baselineId);
      assertBaselineMutable(current);
      if (current.version !== version)
        throw new ConflictError("Baseline was changed by someone else");
      const saved = await tx.save(
        "baseline",
        touch(current, ctx, { locked: true, lockedAt: nowIso() }),
      );
      await this.audit.record(tx, ctx, {
        projectId: baseline.projectId,
        entityType: "baseline",
        entityId: baselineId,
        action: "lock",
      });
      return saved;
    });
  }

  /** Edit one item of a what-if branch. */
  async updateBranchItem(
    ctx: ServiceContext,
    baselineId: string,
    itemId: string,
    input: UpdateBaselineItemInput,
  ): Promise<Baseline> {
    const baseline = await mustGet(this.storage, "baseline", baselineId);
    await this.access.require(ctx, baseline.projectId, baseline.planId, "plan.edit");
    const saved = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "baseline", baselineId);
      assertBranchEditable(current);
      if (current.version !== input.version)
        throw new ConflictError("Branch was changed by someone else");
      const item = current.items.find((i) => i.itemId === itemId);
      if (!item) throw new ValidationError(`Item ${itemId} is not in this branch`);
      const project = await mustGet(tx, "project", current.projectId);
      const schedule = makeSchedule(
        input.start,
        input.duration,
        input.granularity,
        project.calendar,
      );
      const updated = touch(current, ctx, {
        items: mergeBaselineItems(current.items, [{ ...item, ...schedule }]),
      });
      const b = await tx.save("baseline", updated);
      await this.audit.record(tx, ctx, {
        projectId: current.projectId,
        entityType: "baseline",
        entityId: baselineId,
        action: "updateItem",
        details: { itemId, ...input },
      });
      return b;
    });
    this.events.emit({
      projectId: baseline.projectId,
      entityType: "baseline",
      entityId: baselineId,
      action: "update",
      planIds: [baseline.planId],
    });
    return saved;
  }

  /** Only unlocked, non-track baselines can be deleted. */
  async delete(ctx: ServiceContext, baselineId: string): Promise<void> {
    const baseline = await mustGet(this.storage, "baseline", baselineId);
    await this.access.require(ctx, baseline.projectId, baseline.planId, "plan.manage");
    assertBaselineMutable(baseline);
    if (baseline.kind === "TRACK") throw new RuleViolationError("Tracks cannot be deleted");
    await this.storage.transaction(async (tx) => {
      const children = (
        await tx.query("baseline", { projectId: baseline.projectId, planId: baseline.planId })
      ).filter((b) => b.parentBaselineId === baselineId);
      if (children.length > 0)
        throw new RuleViolationError("Baseline has branches; delete them first");
      await tx.delete("baseline", baselineId, baseline.version);
      await this.audit.record(tx, ctx, {
        projectId: baseline.projectId,
        entityType: "baseline",
        entityId: baselineId,
        action: "delete",
      });
    });
  }

  /** Compare the live plan against tracks ("CURRENT", "AGREED") and/or baseline ids. */
  async compare(ctx: ServiceContext, input: CompareBaselinesInput): Promise<BaselineComparison> {
    const plan = await mustGet(this.storage, "plan", input.planId);
    await this.access.require(ctx, plan.projectId, plan.id, "plan.read");
    const live = await this.liveItems(this.storage, plan.projectId, plan.id);
    const sources: ComparisonSource[] = [];
    for (const key of input.against) {
      if (key === "ESTIMATED") {
        sources.push({ key, name: "Estimated", items: live });
        continue;
      }
      const baseline =
        key === "CURRENT" || key === "AGREED"
          ? await findTrackBaseline(this.storage, plan.id, key)
          : await this.storage.get("baseline", key);
      if (!baseline || baseline.planId !== plan.id)
        throw new ValidationError(`Unknown baseline ${key}`);
      sources.push({ key, name: baseline.name, items: baseline.items });
    }
    const states = await this.agreementStates(plan.projectId, plan.id);
    return compareAgainst(
      plan.id,
      live.map((item) => ({ item, agreementState: states.get(item.itemId) ?? "NONE" })),
      sources,
    );
  }

  /** The live (Estimated) values of a plan: own items plus resolved references. */
  async liveItems(
    storage: StorageAdapter,
    projectId: string,
    planId: string,
  ): Promise<BaselineItem[]> {
    const items = await storage.query("task", { projectId, planId });
    const refs = await storage.query("planItemReference", { projectId, planId });
    const out = items.map((t) => toBaselineItem(t, false));
    for (const r of refs) {
      const item = await storage.get("task", r.itemId);
      if (item)
        out.push({ ...toBaselineItem(item, true), parentId: normalizeReference(r).parentId });
    }
    return mergeBaselineItems([], out);
  }

  private async agreementStates(projectId: string, planId: string) {
    const items = await this.storage.query("task", { projectId, planId });
    const refs = await this.storage.query("planItemReference", { projectId, planId });
    return new Map([
      ...items.map((i) => [i.id, i.agreementState] as const),
      ...refs.map((r) => [r.itemId, r.agreementState] as const),
    ]);
  }
}
