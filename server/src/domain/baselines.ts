/** Baseline rules (CLAUDE.md §6). Pure logic, no I/O. */
import {
  type AgreementState,
  type Baseline,
  type BaselineComparison,
  type BaselineItem,
  type Schedule,
  type Task,
  varianceInDays,
} from "@planning/shared";
import { RuleViolationError } from "./errors.js";

/** Locked baselines are immutable — always check before writing one. */
export function assertBaselineMutable(baseline: Pick<Baseline, "locked" | "name">): void {
  if (baseline.locked)
    throw new RuleViolationError(`Baseline '${baseline.name}' is locked and cannot be modified`);
}

/** Branches can only be edited directly; tracks change only through acceptance. */
export function assertBranchEditable(baseline: Baseline): void {
  assertBaselineMutable(baseline);
  if (baseline.kind !== "BRANCH") {
    throw new RuleViolationError(`Baseline '${baseline.name}' is not a what-if branch`);
  }
}

export function toBaselineItem(
  item: Pick<Task, "id" | "name" | "parentId"> & Schedule,
  isReference: boolean,
): BaselineItem {
  return {
    itemId: item.id,
    name: item.name,
    parentId: isReference ? null : item.parentId,
    start: item.start,
    end: item.end,
    duration: item.duration,
    granularity: item.granularity,
    isReference,
  };
}

/** Insert or replace entries by item id, keeping a deterministic order. */
export function mergeBaselineItems(
  existing: BaselineItem[],
  updates: BaselineItem[],
): BaselineItem[] {
  const byId = new Map(existing.map((i) => [i.itemId, i]));
  for (const u of updates) byId.set(u.itemId, u);
  return [...byId.values()].sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
  );
}

export interface ComparisonSource {
  key: string;
  name: string;
  items: BaselineItem[];
}

/** Compare the live plan against one or more baselines (variance on end date). */
export function compareAgainst(
  planId: string,
  live: { item: BaselineItem; agreementState: AgreementState }[],
  sources: ComparisonSource[],
): BaselineComparison {
  const maps = sources.map((s) => ({
    key: s.key,
    byId: new Map(s.items.map((i) => [i.itemId, i])),
  }));
  const ids = new Set<string>(live.map((l) => l.item.itemId));
  for (const s of sources) for (const i of s.items) ids.add(i.itemId);
  const liveById = new Map(live.map((l) => [l.item.itemId, l]));
  const rows = [...ids].sort().map((itemId) => {
    const l = liveById.get(itemId) ?? null;
    const against: Record<string, BaselineItem | null> = {};
    const endVarianceDays: Record<string, number | null> = {};
    let name = l?.item.name ?? "";
    for (const { key, byId } of maps) {
      const b = byId.get(itemId) ?? null;
      against[key] = b;
      if (!name && b) name = b.name;
      endVarianceDays[key] = l && b ? varianceInDays(l.item.end, b.end) : null;
    }
    return {
      itemId,
      name,
      live: l?.item ?? null,
      against,
      endVarianceDays,
      agreementState: l?.agreementState ?? "NONE",
    };
  });
  return { planId, columns: sources.map(({ key, name }) => ({ key, name })), rows };
}
