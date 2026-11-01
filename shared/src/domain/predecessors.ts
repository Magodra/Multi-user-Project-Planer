/**
 * Predecessor notation, e.g. "4FS+3d; 2SS-1d; 7": task number, optional
 * dependency type (default FS) and optional lag. A negative lag is a lead.
 * Lag units: h, d, w, mo, y; without a unit the lag is in the successor's
 * granularity. Used by the client for editing and by the server for parsing.
 */
import type { DependencyType, Granularity } from "../types.js";

export interface PredecessorSpec {
  taskNumber: number;
  type: DependencyType;
  lag: number;
  /** Null when no unit was written: the successor's granularity applies. */
  lagUnit: Granularity | null;
}

export type PredecessorParseResult =
  { ok: true; predecessors: PredecessorSpec[] } | { ok: false; error: string };

const UNIT_BY_SUFFIX: Record<string, Granularity> = {
  h: "hours",
  d: "days",
  w: "weeks",
  mo: "months",
  y: "years",
};
const SUFFIX_BY_UNIT = Object.fromEntries(
  Object.entries(UNIT_BY_SUFFIX).map(([k, v]) => [v, k]),
) as Record<Granularity, string>;

const ENTRY = /^(\d+)\s*(FS|SS|FF|SF)?\s*(?:([+-])\s*(\d+(?:\.\d+)?)\s*([a-z]*))?$/i;

export function parsePredecessors(text: string): PredecessorParseResult {
  const predecessors: PredecessorSpec[] = [];
  for (const raw of text.split(/[;,]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = ENTRY.exec(entry);
    if (!m) {
      return {
        ok: false,
        error: `'${entry}' is not a predecessor; use e.g. 4FS+3d (types FS, SS, FF, SF)`,
      };
    }
    const [, num, type, sign, amount, suffix] = m;
    let lagUnit: Granularity | null = null;
    if (suffix) {
      const unit = UNIT_BY_SUFFIX[suffix.toLowerCase()];
      if (!unit) return { ok: false, error: `Unknown lag unit '${suffix}'; use h, d, w, mo or y` };
      lagUnit = unit;
    }
    const lag = amount ? Number(amount) * (sign === "-" ? -1 : 1) : 0;
    const spec: PredecessorSpec = {
      taskNumber: Number(num),
      type: (type?.toUpperCase() as DependencyType | undefined) ?? "FS",
      lag: Object.is(lag, -0) ? 0 : lag,
      lagUnit,
    };
    if (predecessors.some((p) => p.taskNumber === spec.taskNumber && p.type === spec.type))
      return { ok: false, error: `Task ${spec.taskNumber} is listed twice as ${spec.type}` };
    predecessors.push(spec);
  }
  return { ok: true, predecessors };
}

/** "4" for a plain FS link, otherwise e.g. "4SS" or "4FS+3d". */
export function formatPredecessor(p: PredecessorSpec): string {
  if (p.lag === 0) return p.type === "FS" ? String(p.taskNumber) : `${p.taskNumber}${p.type}`;
  const sign = p.lag > 0 ? "+" : "-";
  const unit = p.lagUnit ? SUFFIX_BY_UNIT[p.lagUnit] : "";
  return `${p.taskNumber}${p.type}${sign}${Math.abs(p.lag)}${unit}`;
}

/** Entries sorted by task number, separated by "; ". */
export function formatPredecessors(list: PredecessorSpec[]): string {
  return [...list]
    .sort((a, b) => a.taskNumber - b.taskNumber || a.type.localeCompare(b.type))
    .map(formatPredecessor)
    .join("; ");
}
