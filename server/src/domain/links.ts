/** Link type rules (CLAUDE.md §4 "Link types"). Pure logic, no I/O. */
import type {
  BaselineItem,
  LinkType,
  PlanItemReference,
  PlanLink,
  Versioned,
} from "@planning/shared";

/** The link type of a reference: from its link, MONITOR without one. */
export function effectiveLinkType(reference: PlanItemReference, links: PlanLink[]): LinkType {
  return governingLink(reference, links)?.type ?? "MONITOR";
}

/** The link of a reference, if any. */
export function governingLink(reference: PlanItemReference, links: PlanLink[]): PlanLink | null {
  return links.find((l) => l.referenceId === reference.id) ?? null;
}

/**
 * MONITOR → AGREEMENT takes effect immediately without an approval round.
 * The owner's agreed values become the starting point of the agreement for
 * references that have no agreed value yet in the recipient plan.
 * Returns the entries to add to the recipient's Agreed track.
 */
export function carryOverAgreedValues(
  references: PlanItemReference[],
  ownerAgreed: BaselineItem[],
  recipientAgreed: BaselineItem[],
): BaselineItem[] {
  const existing = new Set(recipientAgreed.map((i) => i.itemId));
  const ownerByItem = new Map(ownerAgreed.map((i) => [i.itemId, i]));
  const additions: BaselineItem[] = [];
  for (const ref of references) {
    const agreed = ownerByItem.get(ref.itemId);
    if (agreed && !existing.has(ref.itemId))
      additions.push({ ...agreed, isReference: true, parentId: null });
  }
  return additions;
}

/** The reference a link applies to. */
export function referencesUnderLink(
  link: PlanLink,
  references: PlanItemReference[],
): PlanItemReference[] {
  return references.filter((r) => r.id === link.referenceId);
}

/**
 * Plan-level links (one link for every reference between two plans) were
 * replaced by links per reference. Returns the per-reference links to create
 * for a plan-level link: one for each reference between its plans that has no
 * link of its own.
 */
export function splitPlanLevelLink(
  link: Omit<PlanLink, "referenceId"> & { referenceId: string | null },
  references: PlanItemReference[],
  existing: PlanLink[],
): Omit<PlanLink, keyof Versioned>[] {
  const linked = new Set(existing.map((l) => l.referenceId));
  return references
    .filter(
      (r) => r.ownerPlanId === link.fromPlanId && r.planId === link.toPlanId && !linked.has(r.id),
    )
    .map((r) => ({
      projectId: r.projectId,
      type: link.type,
      fromPlanId: link.fromPlanId,
      toPlanId: link.toPlanId,
      referenceId: r.id,
      partyIds: link.partyIds,
    }));
}
