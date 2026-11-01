/** Link type rules (CLAUDE.md §4 "Link types"). Pure logic, no I/O. */
import type { BaselineItem, LinkType, PlanItemReference, PlanLink } from "@planning/shared";
import { RuleViolationError } from "./errors.js";

/**
 * The link type governing a reference: an item-level link wins over a
 * plan-level link between the owner and recipient plan. Default: MONITOR.
 */
export function effectiveLinkType(reference: PlanItemReference, links: PlanLink[]): LinkType {
  return governingLink(reference, links)?.type ?? "MONITOR";
}

export function governingLink(reference: PlanItemReference, links: PlanLink[]): PlanLink | null {
  const itemLink = links.find((l) => l.referenceId === reference.id);
  if (itemLink) return itemLink;
  return (
    links.find(
      (l) =>
        l.referenceId === null &&
        l.fromPlanId === reference.ownerPlanId &&
        l.toPlanId === reference.planId,
    ) ?? null
  );
}

export function assertValidLink(fromPlanId: string, toPlanId: string): void {
  if (fromPlanId === toPlanId) throw new RuleViolationError("A plan cannot be linked to itself");
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

/** References covered by a link (one reference, or all between the two plans). */
export function referencesUnderLink(
  link: PlanLink,
  references: PlanItemReference[],
): PlanItemReference[] {
  if (link.referenceId !== null) return references.filter((r) => r.id === link.referenceId);
  return references.filter((r) => r.ownerPlanId === link.fromPlanId && r.planId === link.toPlanId);
}
