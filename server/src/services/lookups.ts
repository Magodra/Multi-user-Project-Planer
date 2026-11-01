/** Storage lookups shared by several services. No business rules here. */
import type { Baseline, BaselineDefinition, Track } from "@planning/shared";
import { RuleViolationError } from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";

export async function findTrackBaseline(
  storage: StorageAdapter,
  planId: string,
  track: Exclude<Track, "ESTIMATED">,
): Promise<Baseline | null> {
  // By plan only: references and approvals can involve plans of other projects.
  const [baseline] = await storage.query("baseline", { planId, kind: "TRACK", track });
  return baseline ?? null;
}

export async function getDefinition(
  storage: StorageAdapter,
  projectId: string,
  track: Track,
): Promise<BaselineDefinition> {
  const [def] = await storage.query("baselineDefinition", { projectId, track });
  if (!def) throw new RuleViolationError(`No baseline definition for track ${track}`);
  return def;
}
