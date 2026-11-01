import type {
  ChangeLinkTypeInput,
  CreateLinkInput,
  PlanLink,
  SetReferenceTypeInput,
} from "@planning/shared";
import { ConflictError, ValidationError } from "../domain/errors.js";
import { assertValidLink } from "../domain/links.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import { type EventBus, perProject } from "./events.js";
import { type ServiceContext, mustGet, newMeta, touch } from "./support.js";
import { carryOverAgreed, setReferenceLinkType } from "./workflow.js";

export class LinkService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async list(ctx: ServiceContext, projectId: string): Promise<PlanLink[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    return this.storage.query("planLink", { projectId });
  }

  async create(ctx: ServiceContext, input: CreateLinkInput): Promise<PlanLink> {
    assertValidLink(input.fromPlanId, input.toPlanId);
    const from = await mustGet(this.storage, "plan", input.fromPlanId);
    const to = await mustGet(this.storage, "plan", input.toPlanId);
    await this.access.require(ctx, from.projectId, from.id, "plan.manage");
    // A link for one task lives with its reference (recipient's project, maybe another
    // project of the tree); a plan-level link connects plans of one project.
    let projectId = from.projectId;
    if (input.referenceId) {
      const ref = await mustGet(this.storage, "planItemReference", input.referenceId);
      if (ref.ownerPlanId !== from.id || ref.planId !== to.id) {
        throw new ValidationError("Reference does not connect these plans");
      }
      projectId = ref.projectId;
    } else if (from.projectId !== to.projectId) {
      throw new ValidationError("Plan-level links connect plans of the same project");
    }
    const existing = await this.storage.query("planLink", {
      projectId,
      fromPlanId: from.id,
      toPlanId: to.id,
    });
    if (existing.some((l) => l.referenceId === input.referenceId)) {
      throw new ConflictError("A link already exists; change its type instead");
    }
    const link: PlanLink = { ...newMeta(ctx), projectId, ...input };
    const saved = await this.storage.transaction(async (tx) => {
      const l = await tx.save("planLink", link);
      if (link.type === "AGREEMENT") await carryOverAgreed(tx, l);
      await this.audit.record(tx, ctx, {
        projectId: link.projectId,
        entityType: "planLink",
        entityId: link.id,
        action: "create",
        details: { ...input },
      });
      return l;
    });
    this.emitLink(saved, from.projectId, "create");
    return saved;
  }

  /**
   * Change MONITOR ↔ AGREEMENT. An upgrade to AGREEMENT takes effect at once
   * without an approval round; agreed values carry over (CLAUDE.md §4).
   */
  async changeType(
    ctx: ServiceContext,
    linkId: string,
    input: ChangeLinkTypeInput,
  ): Promise<PlanLink> {
    const link = await mustGet(this.storage, "planLink", linkId);
    const owner = await mustGet(this.storage, "plan", link.fromPlanId);
    await this.access.require(ctx, owner.projectId, owner.id, "plan.manage");
    const saved = await this.storage.transaction(async (tx) => {
      const current = await mustGet(tx, "planLink", linkId);
      if (current.version !== input.version)
        throw new ConflictError("Link was changed by someone else");
      if (current.type === input.type) return current;
      const updated = await tx.save("planLink", touch(current, ctx, { type: input.type }));
      let carried = 0;
      if (input.type === "AGREEMENT") carried = await carryOverAgreed(tx, updated);
      await this.audit.record(tx, ctx, {
        projectId: link.projectId,
        entityType: "planLink",
        entityId: link.id,
        action: input.type === "AGREEMENT" ? "upgrade" : "downgrade",
        details: { from: current.type, to: input.type, carriedOverItems: carried },
      });
      return updated;
    });
    this.emitLink(saved, owner.projectId, "update");
    return saved;
  }

  /**
   * Set the link type of one reference (MONITOR or AGREEMENT). Needs the
   * owner plan's manage right; an upgrade carries over agreed values.
   */
  async setReferenceType(
    ctx: ServiceContext,
    referenceId: string,
    input: SetReferenceTypeInput,
  ): Promise<PlanLink> {
    const ref = await mustGet(this.storage, "planItemReference", referenceId);
    const owner = await mustGet(this.storage, "plan", ref.ownerPlanId);
    await this.access.require(ctx, owner.projectId, owner.id, "plan.manage");
    const link = await this.storage.transaction(async (tx) =>
      setReferenceLinkType(
        tx,
        ctx,
        this.audit,
        await mustGet(tx, "planItemReference", referenceId),
        input.type,
      ),
    );
    this.emitLink(link, owner.projectId, "update");
    return link;
  }

  private emitLink(link: PlanLink, ownerProjectId: string, action: string): void {
    this.events.emit(
      perProject([link.projectId, ownerProjectId], {
        entityType: "planLink",
        entityId: link.id,
        action,
        planIds: [link.fromPlanId, link.toPlanId],
      }),
    );
  }

  async delete(ctx: ServiceContext, linkId: string): Promise<void> {
    const link = await mustGet(this.storage, "planLink", linkId);
    const owner = await mustGet(this.storage, "plan", link.fromPlanId);
    await this.access.require(ctx, owner.projectId, owner.id, "plan.manage");
    await this.storage.transaction(async (tx) => {
      await tx.delete("planLink", link.id, link.version);
      await this.audit.record(tx, ctx, {
        projectId: link.projectId,
        entityType: "planLink",
        entityId: link.id,
        action: "delete",
      });
    });
    this.emitLink(link, owner.projectId, "delete");
  }
}
