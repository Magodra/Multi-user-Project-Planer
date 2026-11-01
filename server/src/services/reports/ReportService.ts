/**
 * Reports (CLAUDE.md §8). A ReportDefinition is turned into a ReportModel
 * from a data snapshot, then rendered. Same definition + same data = same
 * output: nothing depends on the current time or on storage ordering.
 */
import {
  type BaselineItem,
  type ItemKind,
  type ReportDefinition,
  type ReportDefinitionInput,
  type ReportResult,
  type RunReportInput,
  compareIso,
  formatDateKey,
  getItemKinds,
  varianceInDays,
} from "@planning/shared";
import { ConflictError, ValidationError } from "../../domain/errors.js";
import type { StorageAdapter } from "../../storage/StorageAdapter.js";
import type { AccessService } from "../AccessService.js";
import type { AuditService } from "../AuditService.js";
import type { BaselineService } from "../BaselineService.js";
import { type ServiceContext, mustGet, newMeta, touch } from "../support.js";
import { PDF_COLUMNS, renderTextPdf } from "./pdf.js";

export interface ReportRow {
  itemId: string;
  name: string;
  depth: number;
  kind: ItemKind;
  isReference: boolean;
  start: string;
  end: string;
  duration: number;
  granularity: string;
  /** End date and end variance per compared baseline. */
  compared: { baseline: string; end: string | null; varianceDays: number | null }[];
}

export interface ReportSection {
  title: string;
  source: string;
  columns: string[];
  rows: ReportRow[];
}

export interface TimelineSection {
  title: string;
  rows: { row: string; items: { name: string; start: string; end: string }[] }[];
}

export interface ReportModel {
  title: string;
  range: { start: string | null; end: string | null };
  plans: ReportSection[];
  timelines: TimelineSection[];
}

export class ReportService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly baselines: BaselineService,
  ) {}

  async list(ctx: ServiceContext, projectId: string): Promise<ReportDefinition[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    return (await this.storage.query("reportDefinition", { projectId })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async get(ctx: ServiceContext, id: string): Promise<ReportDefinition> {
    const def = await mustGet(this.storage, "reportDefinition", id);
    await this.access.require(ctx, def.projectId, null, "project.read");
    return def;
  }

  async create(
    ctx: ServiceContext,
    projectId: string,
    input: ReportDefinitionInput,
  ): Promise<ReportDefinition> {
    await this.access.require(ctx, projectId, null, "project.read");
    const def: ReportDefinition = { ...newMeta(ctx), projectId, ...input };
    return this.storage.transaction(async (tx) => {
      const saved = await tx.save("reportDefinition", def);
      await this.audit.record(tx, ctx, {
        projectId,
        entityType: "reportDefinition",
        entityId: def.id,
        action: "create",
      });
      return saved;
    });
  }

  async update(
    ctx: ServiceContext,
    id: string,
    input: ReportDefinitionInput & { version: number },
  ): Promise<ReportDefinition> {
    const def = await mustGet(this.storage, "reportDefinition", id);
    await this.access.require(ctx, def.projectId, null, "project.read");
    if (def.version !== input.version)
      throw new ConflictError("Report was changed by someone else");
    const { version: _v, ...changes } = input;
    return this.storage.transaction(async (tx) => {
      const saved = await tx.save("reportDefinition", touch(def, ctx, changes));
      await this.audit.record(tx, ctx, {
        projectId: def.projectId,
        entityType: "reportDefinition",
        entityId: id,
        action: "update",
      });
      return saved;
    });
  }

  async delete(ctx: ServiceContext, id: string): Promise<void> {
    const def = await mustGet(this.storage, "reportDefinition", id);
    await this.access.require(ctx, def.projectId, null, "project.read");
    await this.storage.delete("reportDefinition", id, def.version);
  }

  async run(ctx: ServiceContext, id: string, input: RunReportInput): Promise<ReportResult> {
    const def = await this.get(ctx, id);
    const model = await this.buildModel(ctx, def, input.asOfBaselineId);
    const base = def.name.replace(/[^A-Za-z0-9_-]+/g, "_") || "report";
    switch (input.format) {
      case "html":
        return {
          contentType: "text/html; charset=utf-8",
          fileName: `${base}.html`,
          body: renderHtml(model),
          encoding: "utf8",
        };
      case "csv":
        return {
          contentType: "text/csv; charset=utf-8",
          fileName: `${base}.csv`,
          body: renderCsv(model),
          encoding: "utf8",
        };
      case "pdf":
        return {
          contentType: "application/pdf",
          fileName: `${base}.pdf`,
          body: renderTextPdf(model.title, renderTextLines(model)).toString("base64"),
          encoding: "base64",
        };
    }
  }

  async buildModel(
    ctx: ServiceContext,
    def: ReportDefinition,
    asOfBaselineId: string | null,
  ): Promise<ReportModel> {
    const plans: ReportSection[] = [];
    const asOf = asOfBaselineId ? await mustGet(this.storage, "baseline", asOfBaselineId) : null;
    if (asOf && !def.planIds.includes(asOf.planId))
      throw new ValidationError("Baseline is not from a plan in this report");
    for (const planId of def.planIds) {
      const plan = await mustGet(this.storage, "plan", planId);
      await this.access.require(ctx, plan.projectId, planId, "plan.read");
      const useBaseline = asOf?.planId === planId ? asOf : null;
      const items = useBaseline
        ? useBaseline.items
        : await this.baselines.liveItems(this.storage, plan.projectId, planId);
      const compared: { name: string; items: Map<string, BaselineItem> }[] = [];
      for (const baselineId of def.baselineIds) {
        const b = await this.storage.get("baseline", baselineId);
        if (b && b.planId === planId)
          compared.push({ name: b.name, items: new Map(b.items.map((i) => [i.itemId, i])) });
      }
      compared.sort((a, b) => a.name.localeCompare(b.name));
      const kinds = getItemKinds(
        items.map((i) => ({ id: i.itemId, duration: i.duration, parentId: i.parentId })),
      );
      const rows = orderHierarchically(items)
        .filter(({ item }) => inRange(item, def.rangeStart, def.rangeEnd))
        .filter(
          ({ item }) =>
            !def.filter.nameContains ||
            item.name.toLowerCase().includes(def.filter.nameContains.toLowerCase()),
        )
        .filter(
          ({ item }) =>
            !def.filter.kinds?.length || def.filter.kinds.includes(kinds.get(item.itemId)!),
        )
        .map(({ item, depth }) => ({
          itemId: item.itemId,
          name: item.name,
          depth,
          kind: kinds.get(item.itemId)!,
          isReference: item.isReference,
          start: item.start,
          end: item.end,
          duration: item.duration,
          granularity: item.granularity,
          compared: compared.map((c) => {
            const b = c.items.get(item.itemId);
            return {
              baseline: c.name,
              end: b?.end ?? null,
              varianceDays: b ? varianceInDays(item.end, b.end) : null,
            };
          }),
        }));
      plans.push({
        title: plan.name,
        source: useBaseline ? `Baseline: ${useBaseline.name}` : "Live data",
        columns: compared.map((c) => c.name),
        rows,
      });
    }
    const timelines: TimelineSection[] = [];
    for (const timelineId of def.timelineIds) {
      const t = await this.storage.get("timeline", timelineId);
      if (!t) continue;
      const rows = [];
      for (const row of t.rows) {
        const items = [];
        for (const e of t.entries.filter((x) => x.rowId === row.id)) {
          const item = await this.storage.get("task", e.itemId);
          if (item && (await this.access.canDo(ctx, item.projectId, item.planId, "plan.read"))) {
            items.push({ name: item.name, start: item.start, end: item.end });
          }
        }
        items.sort((a, b) => compareIso(a.start, b.start) || a.name.localeCompare(b.name));
        rows.push({ row: row.name, items });
      }
      timelines.push({ title: t.name, rows });
    }
    return {
      title: def.name,
      range: { start: def.rangeStart, end: def.rangeEnd },
      plans,
      timelines,
    };
  }
}

function inRange(item: BaselineItem, start: string | null, end: string | null): boolean {
  if (start && compareIso(item.end, start) < 0) return false;
  if (end && compareIso(item.start, end) > 0) return false;
  return true;
}

/** Depth-first order: parents before children, siblings by start then name then id. */
function orderHierarchically(items: BaselineItem[]): { item: BaselineItem; depth: number }[] {
  const ids = new Set(items.map((i) => i.itemId));
  const children = new Map<string | null, BaselineItem[]>();
  for (const i of items) {
    const parent = i.parentId && ids.has(i.parentId) ? i.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), i]);
  }
  const cmp = (a: BaselineItem, b: BaselineItem) =>
    compareIso(a.start, b.start) || a.name.localeCompare(b.name) || (a.itemId < b.itemId ? -1 : 1);
  const out: { item: BaselineItem; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const c of (children.get(parent) ?? []).sort(cmp)) {
      out.push({ item: c, depth });
      visit(c.itemId, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function variance(v: number | null): string {
  if (v === null) return "";
  return v > 0 ? `+${v}d` : `${v}d`;
}

export function renderHtml(model: ReportModel): string {
  const range =
    model.range.start || model.range.end
      ? `<p>Range: ${model.range.start ? formatDateKey(model.range.start) : "…"} – ${model.range.end ? formatDateKey(model.range.end) : "…"}</p>`
      : "";
  const plans = model.plans
    .map((p) => {
      const head = [
        "Task",
        "Kind",
        "Start",
        "End",
        "Duration",
        ...p.columns.flatMap((c) => [`${c} end`, "Variance"]),
      ];
      const rows = p.rows
        .map((r) => {
          const cells = [
            `<td style="padding-left:${0.5 + r.depth * 1.25}em">${escapeHtml(r.name)}${r.isReference ? " ↗" : ""}</td>`,
            `<td>${r.kind}</td>`,
            `<td>${formatDateKey(r.start)}</td>`,
            `<td>${formatDateKey(r.end)}</td>`,
            `<td>${r.duration} ${r.granularity}</td>`,
            ...r.compared.flatMap((c) => [
              `<td>${c.end ? formatDateKey(c.end) : ""}</td>`,
              `<td class="${c.varianceDays && c.varianceDays > 0 ? "late" : c.varianceDays && c.varianceDays < 0 ? "early" : ""}">${variance(c.varianceDays)}</td>`,
            ]),
          ];
          return `<tr>${cells.join("")}</tr>`;
        })
        .join("\n");
      return `<section><h2>${escapeHtml(p.title)}</h2><p class="src">${escapeHtml(p.source)}</p><table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>\n${rows}\n</tbody></table></section>`;
    })
    .join("\n");
  const timelines = model.timelines
    .map(
      (t) =>
        `<section><h2>Timeline: ${escapeHtml(t.title)}</h2>${t.rows
          .map(
            (r) =>
              `<h3>${escapeHtml(r.row)}</h3><ul>${r.items.map((i) => `<li>${escapeHtml(i.name)} (${formatDateKey(i.start)} – ${formatDateKey(i.end)})</li>`).join("")}</ul>`,
          )
          .join("")}</section>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(model.title)}</title>
<style>
body{font:14px system-ui,sans-serif;margin:2em;color:#1d2330}
table{border-collapse:collapse;width:100%;margin-bottom:2em}
th,td{border:1px solid #d5d9e0;padding:.3em .5em;text-align:left;font-variant-numeric:tabular-nums}
th{background:#f1f3f6}.late{color:#b42318}.early{color:#067647}.src{color:#5b6475}
</style></head><body>
<h1>${escapeHtml(model.title)}</h1>
${range}
${plans}
${timelines}
</body></html>
`;
}

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(model: ReportModel): string {
  const maxCompared = Math.max(0, ...model.plans.map((p) => p.columns.length));
  const header = [
    "Plan",
    "Source",
    "Task",
    "Depth",
    "Kind",
    "Reference",
    "Start",
    "End",
    "Duration",
    "Unit",
  ];
  for (let i = 1; i <= maxCompared; i++)
    header.push(`Baseline ${i}`, `Baseline ${i} end`, `Baseline ${i} variance (days)`);
  const lines = [header.map(csvCell).join(",")];
  for (const p of model.plans) {
    for (const r of p.rows) {
      const cells: (string | number)[] = [
        p.title,
        p.source,
        r.name,
        r.depth,
        r.kind,
        r.isReference ? "yes" : "no",
        formatDateKey(r.start),
        formatDateKey(r.end),
        r.duration,
        r.granularity,
      ];
      for (const c of r.compared)
        cells.push(c.baseline, c.end ? formatDateKey(c.end) : "", c.varianceDays ?? "");
      lines.push(cells.map(csvCell).join(","));
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function renderTextLines(model: ReportModel): string[] {
  const lines = [model.title, ""];
  for (const p of model.plans) {
    lines.push(`${p.title} — ${p.source}`, "-".repeat(Math.min(PDF_COLUMNS, 120)));
    for (const r of p.rows) {
      const name = `${"  ".repeat(r.depth)}${r.name}${r.isReference ? " (ext)" : ""}`
        .slice(0, 44)
        .padEnd(45);
      const compared = r.compared
        .map((c) => `${c.baseline.slice(0, 10)}:${variance(c.varianceDays) || "-"}`)
        .join(" ");
      lines.push(
        `${name}${r.kind.padEnd(10)}${formatDateKey(r.start)}  ${formatDateKey(r.end)}  ${`${r.duration} ${r.granularity}`.padEnd(12)}${compared}`,
      );
    }
    lines.push("");
  }
  for (const t of model.timelines) {
    lines.push(`Timeline: ${t.title}`);
    for (const r of t.rows) {
      lines.push(`  ${r.row}`);
      for (const i of r.items)
        lines.push(`    ${i.name} (${formatDateKey(i.start)} – ${formatDateKey(i.end)})`);
    }
    lines.push("");
  }
  return lines;
}
