/**
 * Link types of references (CLAUDE.md §4 "Link types"): each external task
 * used in another plan is MONITOR or AGREEMENT on its own. Plan-level links
 * no longer exist; `convertPlanLevelLinks` turns stored ones into links per
 * reference once, at startup.
 */
import type { PlanLink, SetReferenceTypeInput } from "@planning/shared";
import { splitPlanLevelLink } from "../domain/links.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import type { AuditService } from "./AuditService.js";
import { type EventBus, perProject } from "./events.js";
import { type ServiceContext, mustGet, newMeta, systemContext } from "./support.js";
import { setReferenceLinkType } from "./workflow.js";

export class LinkService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  /**
   * Set the link type of one reference (MONITOR or AGREEMENT), optionally with
   * extra approving parties. Managers of the owner or the receiving plan may
   * do it; an upgrade carries over agreed values without an approval round.
   */
  async setReferenceType(
    ctx: ServiceContext,
    referenceId: string,
    input: SetReferenceTypeInput,
  ): Promise<PlanLink> {
    const ref = await mustGet(this.storage, "planItemReference", referenceId);
    const owner = await mustGet(this.storage, "plan", ref.ownerPlanId);
    const recipient = await mustGet(this.storage, "plan", ref.planId);
    await this.access.requireLinkManager(ctx, owner, recipient);
    const link = await this.storage.transaction(async (tx) =>
      setReferenceLinkType(
        tx,
        ctx,
        this.audit,
        await mustGet(tx, "planItemReference", referenceId),
        input.type,
        input.partyIds,
      ),
    );
    this.events.emit(
      perProject([link.projectId, owner.projectId], {
        entityType: "planLink",
        entityId: link.id,
        action: "update",
        planIds: [link.fromPlanId, link.toPlanId],
      }),
    );
    return link;
  }

  /**
   * One-off data conversion: replace each stored plan-level link (no
   * `referenceId`) by links for the references between its plans that have
   * none, so no reference changes type. Idempotent. Returns how many
   * plan-level links were converted.
   */
  async convertPlanLevelLinks(): Promise<number> {
    const stored = await this.storage.query("planLink");
    const planLevel = stored.filter((l) => !l.referenceId);
    if (planLevel.length === 0) return 0;
    const ctx = systemContext();
    await this.storage.transaction(async (tx) => {
      for (const link of planLevel) {
        const references = await tx.query("planItemReference", { planId: link.toPlanId });
        const existing = await tx.query("planLink", { toPlanId: link.toPlanId });
        const created = splitPlanLevelLink(
          link,
          references,
          existing.filter((l) => l.referenceId),
        );
        for (const l of created) await tx.save("planLink", { ...newMeta(ctx), ...l });
        await tx.delete("planLink", link.id, link.version);
        await this.audit.record(tx, ctx, {
          projectId: link.projectId,
          entityType: "planLink",
          entityId: link.id,
          action: "convert",
          details: { type: link.type, referencesLinked: created.length },
        });
      }
    });
    return planLevel.length;
  }
}
