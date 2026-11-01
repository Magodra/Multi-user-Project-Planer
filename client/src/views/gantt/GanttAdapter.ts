/**
 * The only module that touches DHTMLX Gantt (CLAUDE.md §7). Everything else
 * uses the library-neutral types below, so the Gantt can be replaced or
 * upgraded to PRO without changing the rest of the client.
 *
 * Community Edition only: no PRO APIs. The baseline overlay and the today
 * line are our own layer inside the timeline area, positioned with
 * getTaskPosition() / posFromDate().
 */
import {
  Gantt,
  allowRawHTML,
  escapeHTML,
  type GanttStatic,
  type Link,
  type Task,
} from "dhtmlx-gantt";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import type { DependencyType, ItemKind } from "@planning/shared";
import { type ScaleUnit, type TimeScale, unitDays } from "./scale";

export interface GanttRow {
  id: string;
  text: string;
  parent: string | null;
  start: Date;
  end: Date;
  kind: ItemKind | "group";
  /** Local task ID shown in the grid (own and external tasks); empty for groups. */
  number: string;
  /** Predecessors in task-ID notation, e.g. "2SS-1w; 4FS+3d". */
  predecessors: string;
  durationLabel: string;
  /** Prevent drag/resize (references, activities, no edit rights). */
  locked: boolean;
  classes: string[];
  /** Small status badges shown in the grid. */
  badges: { label: string; title: string; className: string }[];
}

export interface GanttLinkRow {
  id: string;
  source: string;
  target: string;
  type: DependencyType;
}

export interface OverlayBar {
  rowId: string;
  start: Date;
  end: Date;
  /** Index of the overlaid baseline (0..n), sets vertical position and colour. */
  slot: number;
  label: string;
  variance: "early" | "late" | "same";
}

/** A pending proposal for a row, drawn as a dashed outline at the proposed dates. */
export interface ProposalBar {
  rowId: string;
  start: Date;
  end: Date;
  label: string;
}

export interface GanttCallbacks {
  onMove(id: string, start: Date): void;
  onResize(id: string, start: Date, end: Date): void;
  onOpen(id: string): void;
  onLinkCreate(source: string, target: string, type: DependencyType): void;
  onLinkDelete(id: string): void;
  onSelect(id: string | null): void;
  /** Ctrl + mouse wheel over the chart: +1 zooms in, -1 out. */
  onZoom(direction: 1 | -1): void;
}

export interface GanttAdapter {
  mount(container: HTMLElement): void;
  setData(rows: GanttRow[], links: GanttLinkRow[]): void;
  setOverlay(bars: OverlayBar[]): void;
  setProposals(bars: ProposalBar[]): void;
  setScale(scale: TimeScale): void;
  /** Days covered by the rows (including today) and the visible chart width in pixels. */
  measure(): { spanDays: number; widthPx: number };
  scrollToToday(): void;
  setReadonly(readonly: boolean): void;
  destroy(): void;
}

const LINK_TYPES: Record<DependencyType, string> = { FS: "0", SS: "1", FF: "2", SF: "3" };
const LINK_TYPES_REVERSE = Object.fromEntries(
  Object.entries(LINK_TYPES).map(([k, v]) => [v, k]),
) as Record<string, DependencyType>;

type Scales = GanttStatic["config"]["scales"];

const quarter = (d: Date) => `Q${Math.floor(d.getMonth() / 3) + 1}`;

const SCALES: Record<ScaleUnit, Scales> = {
  hours: [
    { unit: "day", step: 1, format: "%d %M" },
    { unit: "hour", step: 1, format: "%H" },
  ],
  days: [
    { unit: "month", step: 1, format: "%F %Y" },
    { unit: "day", step: 1, format: "%d" },
  ],
  weeks: [
    { unit: "month", step: 1, format: "%F %Y" },
    { unit: "week", step: 1, format: "W%W" },
  ],
  months: [
    { unit: "year", step: 1, format: "%Y" },
    { unit: "month", step: 1, format: "%M" },
  ],
  quarters: [
    { unit: "year", step: 1, format: "%Y" },
    { unit: "quarter", step: 1, format: quarter },
  ],
  years: [{ unit: "year", step: 1, format: "%Y" }],
};

const DAY_MS = 86_400_000;

interface RowData extends Task {
  pp: GanttRow;
}

export function createGanttAdapter(callbacks: GanttCallbacks): GanttAdapter {
  const gantt: GanttStatic = Gantt.getGanttInstance();
  let overlay: OverlayBar[] = [];
  let proposals: ProposalBar[] = [];
  let layer: HTMLDivElement | null = null;
  let suppressLinkEvents = false;
  let rows: GanttRow[] = [];
  let scale: TimeScale = { unit: "days", columnWidth: 30 };
  let selectedId: string | null = null;
  let host: HTMLElement | null = null;

  gantt.config.row_height = 40;
  gantt.config.bar_height = 22;
  gantt.config.open_tree_initially = true;
  gantt.config.drag_progress = false;
  gantt.config.drag_links = true;
  gantt.config.show_progress = false;
  gantt.config.details_on_dblclick = false;
  gantt.config.round_dnd_dates = true;
  gantt.config.columns = [
    {
      name: "number",
      label: "ID",
      align: "right",
      width: 40,
      template: (t: Task) => escapeHTML((t as RowData).pp?.number ?? ""),
    },
    { name: "text", label: "Task", tree: true, width: 200, resize: true },
    { name: "start_date", label: "Start", align: "center", width: 90 },
    {
      name: "dur",
      label: "Duration",
      align: "center",
      width: 80,
      template: (t: Task) => escapeHTML((t as RowData).pp?.durationLabel ?? ""),
    },
    {
      name: "predecessors",
      label: "Predecessors",
      width: 100,
      template: (t: Task) => escapeHTML((t as RowData).pp?.predecessors ?? ""),
    },
    {
      name: "status",
      label: "",
      width: 130,
      template: allowRawHTML((t: Task) =>
        ((t as RowData).pp?.badges ?? [])
          .map(
            (b) =>
              `<span class="pp-badge ${escapeHTML(b.className)}" title="${escapeHTML(b.title)}">${escapeHTML(b.label)}</span>`,
          )
          .join(""),
      ),
    },
  ];
  gantt.templates.task_class = (_s: Date, _e: Date, t: Task) =>
    ((t as RowData).pp?.classes ?? []).join(" ");
  gantt.templates.grid_row_class = (_s: Date, _e: Date, t: Task) =>
    (t as RowData).pp?.kind === "group" ? "pp-group-row" : "";

  gantt.attachEvent("onBeforeLightbox", () => false);
  gantt.attachEvent("onTaskDblClick", (id: string | number) => {
    const row = gantt.isTaskExists(id) ? (gantt.getTask(id) as RowData).pp : null;
    if (row && row.kind !== "group") callbacks.onOpen(String(id));
    return false;
  });
  gantt.attachEvent("onBeforeTaskDrag", (id: string | number) => {
    const row = (gantt.getTask(id) as RowData).pp;
    return !row.locked;
  });
  gantt.attachEvent("onAfterTaskDrag", (id: string | number, mode: string) => {
    const t = gantt.getTask(id);
    if (!t.start_date || !t.end_date) return;
    if (mode === gantt.config.drag_mode.move) callbacks.onMove(String(id), t.start_date);
    else if (mode === gantt.config.drag_mode.resize)
      callbacks.onResize(String(id), t.start_date, t.end_date);
  });
  gantt.attachEvent("onBeforeLinkAdd", (_id: string | number, link: Link) => {
    if (suppressLinkEvents) return true;
    callbacks.onLinkCreate(
      String(link.source),
      String(link.target),
      LINK_TYPES_REVERSE[String(link.type)] ?? "FS",
    );
    return false; // the server is the source of truth; the link appears after reload
  });
  gantt.attachEvent("onLinkDblClick", (id: string | number) => {
    callbacks.onLinkDelete(String(id));
    return false;
  });
  gantt.attachEvent("onTaskSelected", (id: string | number) => {
    const row = gantt.isTaskExists(id) ? (gantt.getTask(id) as RowData).pp : null;
    selectedId = row && row.kind !== "group" ? String(id) : null;
    callbacks.onSelect(selectedId);
  });
  gantt.attachEvent("onTaskUnselected", () => {
    if (suppressLinkEvents) return; // clearAll() during a reload; the selection is restored
    selectedId = null;
    callbacks.onSelect(null);
  });

  /** Rows' (and proposals') time range, always including today, plus room to drag into. */
  const range = () => {
    const now = Date.now();
    let start = now;
    let end = now;
    for (const r of [...rows, ...proposals]) {
      start = Math.min(start, r.start.getTime());
      end = Math.max(end, r.end.getTime());
    }
    const pad = Math.max(3 * unitDays(scale.unit) * DAY_MS, (end - start) * 0.05);
    return { start: new Date(start - pad), end: new Date(end + pad), spanMs: end - start };
  };
  const applyScale = () => {
    const r = range();
    gantt.config.start_date = r.start;
    gantt.config.end_date = r.end;
    gantt.config.scales = SCALES[scale.unit];
    gantt.config.min_column_width = scale.columnWidth;
    gantt.config.duration_unit = scale.unit === "hours" ? "hour" : "day";
  };

  const drawOverlay = () => {
    const taskData = gantt.$task_data;
    if (!taskData) return;
    if (!layer || layer.parentElement !== taskData) {
      layer = document.createElement("div");
      layer.className = "pp-baseline-layer";
      taskData.appendChild(layer);
    }
    const fragment = document.createDocumentFragment();
    const now = new Date();
    const state = gantt.getState();
    if (now >= state.min_date && now <= state.max_date) {
      const today = document.createElement("div");
      today.className = "pp-today-line";
      today.style.left = `${gantt.posFromDate(now)}px`;
      today.style.height = `${Math.max(taskData.scrollHeight, taskData.clientHeight)}px`;
      today.title = `Today, ${now.toLocaleString()}`;
      fragment.appendChild(today);
    }
    const barBottom = (gantt.config.row_height + Number(gantt.config.bar_height)) / 2;
    for (const bar of overlay) {
      if (!gantt.isTaskExists(bar.rowId) || !gantt.isTaskVisible(bar.rowId)) continue;
      const pos = gantt.getTaskPosition(gantt.getTask(bar.rowId), bar.start, bar.end) as {
        left: number;
        top: number;
        width: number;
      };
      const el = document.createElement("div");
      el.className = `pp-baseline-bar pp-slot-${bar.slot} pp-${bar.variance}`;
      el.style.left = `${pos.left}px`;
      el.style.width = `${Math.max(pos.width, 3)}px`;
      el.style.top = `${pos.top + barBottom + 1 + bar.slot * 4}px`;
      el.title = bar.label;
      fragment.appendChild(el);
    }
    const barHeight = Number(gantt.config.bar_height);
    const barTop = (gantt.config.row_height - barHeight) / 2;
    for (const bar of proposals) {
      if (!gantt.isTaskExists(bar.rowId) || !gantt.isTaskVisible(bar.rowId)) continue;
      const pos = gantt.getTaskPosition(gantt.getTask(bar.rowId), bar.start, bar.end) as {
        left: number;
        top: number;
        width: number;
      };
      const el = document.createElement("div");
      el.className = "pp-proposal-bar";
      el.style.left = `${pos.left - 3}px`;
      el.style.width = `${Math.max(pos.width, 8) + 6}px`;
      el.style.top = `${pos.top + barTop - 3}px`;
      el.style.height = `${barHeight + 6}px`;
      el.title = bar.label;
      el.dataset.rowId = bar.rowId;
      fragment.appendChild(el);
    }
    layer.replaceChildren(fragment);
  };
  for (const event of ["onGanttRender", "onDataRender", "onTaskOpened", "onTaskClosed"] as const) {
    gantt.attachEvent(event, drawOverlay);
  }
  // Keep the today line current while the panel stays open.
  const timer = window.setInterval(drawOverlay, 60_000);
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey || e.deltaY === 0) return;
    e.preventDefault();
    callbacks.onZoom(e.deltaY < 0 ? 1 : -1);
  };
  // DHTMLX watches its size through a hidden iframe, which the browser reloads
  // (losing the listener) when Dockview moves the panel to another group. A
  // ResizeObserver on our own container keeps working wherever it is moved.
  let frame = 0;
  let lastSize = "";
  const resizeObserver = new ResizeObserver(([entry]) => {
    const { width, height } = entry?.contentRect ?? { width: 0, height: 0 };
    const size = `${Math.round(width)}x${Math.round(height)}`;
    if (width === 0 || height === 0) {
      // Hidden tab: data updated meanwhile is drawn when the tab is shown again.
      lastSize = "";
      return;
    }
    if (size === lastSize) return;
    lastSize = size;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => gantt.render());
  });

  return {
    mount(container) {
      host = container;
      applyScale();
      gantt.init(container);
      container.addEventListener("wheel", onWheel, { passive: false });
      resizeObserver.observe(container);
    },
    setData(next, links) {
      rows = next;
      const scroll = gantt.getScrollState();
      suppressLinkEvents = true;
      gantt.clearAll();
      applyScale();
      gantt.parse({
        data: rows.map((r) => ({
          id: r.id,
          text: r.text,
          parent: r.parent ?? 0,
          start_date: r.start,
          end_date: r.kind === "milestone" ? r.start : r.end,
          type:
            r.kind === "milestone"
              ? "milestone"
              : r.kind === "activity" || r.kind === "group"
                ? "project"
                : "task",
          open: true,
          readonly: r.locked,
          pp: r,
        })),
        links: links.map((l) => ({
          id: l.id,
          source: l.source,
          target: l.target,
          type: LINK_TYPES[l.type],
        })),
      });
      if (selectedId && gantt.isTaskExists(selectedId)) gantt.selectTask(selectedId);
      else if (selectedId) {
        selectedId = null;
        callbacks.onSelect(null);
      }
      suppressLinkEvents = false;
      gantt.scrollTo(scroll.x, scroll.y);
    },
    setOverlay(bars) {
      overlay = bars;
      drawOverlay();
    },
    setProposals(bars) {
      proposals = bars;
      // Proposed dates can lie outside the bars' range: widen the chart if needed.
      applyScale();
      gantt.render();
    },
    setScale(next) {
      // Keep the date in the middle of the chart in view while zooming.
      const width = gantt.$task?.offsetWidth ?? 0;
      const centre = width > 0 ? gantt.dateFromPos(gantt.getScrollState().x + width / 2) : null;
      scale = next;
      applyScale();
      gantt.render();
      if (centre) gantt.scrollTo(Math.max(0, gantt.posFromDate(centre) - width / 2), null);
    },
    measure() {
      return {
        spanDays: Math.max(range().spanMs / DAY_MS, 1 / 24) * 1.1,
        widthPx: gantt.$task?.offsetWidth ?? host?.clientWidth ?? 800,
      };
    },
    scrollToToday() {
      const width = gantt.$task?.offsetWidth ?? 0;
      gantt.scrollTo(Math.max(0, gantt.posFromDate(new Date()) - width / 3), null);
    },
    setReadonly(readonly) {
      gantt.config.readonly = readonly;
      gantt.config.drag_links = !readonly;
      gantt.render();
    },
    destroy() {
      window.clearInterval(timer);
      resizeObserver.disconnect();
      cancelAnimationFrame(frame);
      host?.removeEventListener("wheel", onWheel);
      gantt.destructor();
    },
  };
}
