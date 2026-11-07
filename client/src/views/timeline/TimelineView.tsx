/**
 * User-configurable timeline: name, span, scale and rows. It can show tasks
 * of any project the user can read. Each row has an
 * area above the timeline (callouts), the timeline itself (bars in lines) and
 * an area below (callouts). Tasks are dragged in from plans and stored as
 * references (dates are read live); added entries can be dragged between
 * lines, areas and rows.
 */
import { useEffect, useState } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import {
  GRANULARITIES,
  type Granularity,
  type Task,
  type Timeline,
  type TimelineEntry,
  type TimelinePlacement,
  type TimelineRow,
  formatForDisplay,
  fromDateInputValue,
  positionInRange,
  scaleTicks,
  toDateInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { ErrorText, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import type {
  PlanItemDragData,
  TimelineEntryDragData,
  TimelineRowDropData,
} from "../../workspace/panels";
import { type EntryTarget, addEntry, linesIn, moveEntry, moveRow } from "./layout";

const target = (drop: TimelineRowDropData): EntryTarget => ({
  rowId: drop.rowId,
  placement: drop.placement,
  line: drop.line,
});

/** Add a dragged plan task at a timeline line (called by the workspace's DndContext). */
export async function addItemToTimeline(
  drop: TimelineRowDropData,
  item: PlanItemDragData,
): Promise<void> {
  const timeline = await api.timelines.get(drop.timelineId);
  const entries = addEntry(
    timeline.entries,
    { id: crypto.randomUUID(), itemId: item.itemId, planId: item.planId },
    target(drop),
  );
  if (entries === timeline.entries) return;
  await api.timelines.update(timeline.id, { version: timeline.version, entries });
}

/** Move an added entry to another line, area or row of the same timeline. */
export async function moveTimelineEntry(
  drop: TimelineRowDropData,
  entry: TimelineEntryDragData,
): Promise<void> {
  if (drop.timelineId !== entry.timelineId) return;
  const timeline = await api.timelines.get(drop.timelineId);
  await api.timelines.update(timeline.id, {
    version: timeline.version,
    entries: moveEntry(timeline.entries, entry.entryId, target(drop)),
  });
}

interface Loaded {
  timeline: Timeline;
  items: Map<string, Task>;
}

async function load(timelineId: string): Promise<Loaded> {
  const timeline = await api.timelines.get(timelineId);
  const items = new Map<string, Task>();
  for (const id of new Set(timeline.entries.map((e) => e.itemId))) {
    const item = await api.items.get(id).catch(() => null);
    if (item) items.set(id, item);
  }
  return { timeline, items };
}

const PLACEMENT_LABEL: Record<TimelinePlacement, string> = {
  above: "callouts above",
  on: "timeline",
  below: "callouts below",
};

/** One entry: a bar on the timeline, or a callout above or below it. Draggable. */
function EntryView({
  timeline,
  entry,
  item,
  onRemove,
}: {
  timeline: Timeline;
  entry: TimelineEntry;
  item: Task;
  onRemove(): void;
}) {
  const data: TimelineEntryDragData = {
    type: "timeline-entry",
    timelineId: timeline.id,
    entryId: entry.id,
    name: item.name,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `timeline-entry:${entry.id}`,
    data,
  });
  const left = Math.max(0, positionInRange(item.start, timeline.start, timeline.end));
  const right = Math.min(1, positionInRange(item.end, timeline.start, timeline.end));
  if (right < 0 || left > 1) return null;
  const milestone = item.duration === 0;
  const dates = milestone
    ? formatForDisplay(item.start, item.granularity)
    : `${formatForDisplay(item.start, item.granularity)} – ${formatForDisplay(item.end, item.granularity)}`;
  const callout = entry.placement !== "on";
  return (
    <div
      ref={setNodeRef}
      className={[
        "pp-tl-entry",
        callout ? `pp-tl-callout pp-tl-callout-${entry.placement}` : "",
        milestone ? "pp-tl-milestone" : "",
        isDragging ? "pp-dragging" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: `${left * 100}%`,
        width: callout || milestone ? undefined : `${Math.max(0.5, (right - left) * 100)}%`,
      }}
      title={`${item.name}: ${dates}`}
      data-testid="timeline-entry"
      data-placement={entry.placement}
      data-line={entry.line}
      {...attributes}
      {...listeners}
    >
      {/* A milestone is a diamond at its date, followed by its name. */}
      {milestone && (
        <span className="pp-tl-diamond" aria-hidden>
          ◆
        </span>
      )}
      <span>
        {item.name}
        {callout && <small> · {formatForDisplay(item.start, item.granularity)}</small>}
      </span>
      <button
        type="button"
        className="pp-tl-remove"
        aria-label={`Remove ${item.name}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

/** One line of an area: a drop target for plan tasks and entries. */
function Line({
  timeline,
  row,
  placement,
  line,
  isNew,
  entries,
  items,
  onRemove,
}: {
  timeline: Timeline;
  row: TimelineRow;
  placement: TimelinePlacement;
  line: number;
  /** The empty line after the last one: dropping here opens a new line. */
  isNew: boolean;
  entries: TimelineEntry[];
  items: Map<string, Task>;
  onRemove(entryId: string): void;
}) {
  const data: TimelineRowDropData = {
    type: "timeline-row",
    timelineId: timeline.id,
    rowId: row.id,
    placement,
    line,
  };
  const { setNodeRef, isOver } = useDroppable({
    id: `timeline-line:${timeline.id}:${row.id}:${placement}:${line}`,
    data,
  });
  return (
    <div
      ref={setNodeRef}
      className={[
        "pp-tl-lane",
        `pp-tl-lane-${placement}`,
        isNew ? "pp-tl-lane-new" : "",
        isOver ? "pp-drop-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={`timeline-line-${row.id}-${placement}-${line}`}
      title={isNew ? `Drop here for a new line (${PLACEMENT_LABEL[placement]})` : undefined}
    >
      {entries.map((e) => {
        const item = items.get(e.itemId);
        return item ? (
          <EntryView
            key={e.id}
            timeline={timeline}
            entry={e}
            item={item}
            onRemove={() => onRemove(e.id)}
          />
        ) : null;
      })}
    </div>
  );
}

function Row({
  timeline,
  row,
  index,
  items,
  onRename,
  onMove,
  onRemove,
}: {
  timeline: Timeline;
  row: TimelineRow;
  index: number;
  items: Map<string, Task>;
  onRename(name: string): void;
  onMove(direction: -1 | 1): void;
  onRemove(entryId: string): void;
}) {
  const rowEntries = timeline.entries.filter((e) => e.rowId === row.id);
  // Lines in use plus one empty line at the outer edge of each area.
  const lines = (placement: TimelinePlacement) => {
    const count = linesIn(rowEntries, row.id, placement);
    const all = Array.from({ length: count + 1 }, (_, line) => line);
    // Above: the farthest line is at the top; line 0 sits next to the timeline.
    return placement === "above" ? all.reverse() : all;
  };
  const area = (placement: TimelinePlacement) => {
    const count = linesIn(rowEntries, row.id, placement);
    return (
      <div className={`pp-tl-area pp-tl-area-${placement}`}>
        {lines(placement).map((line) => (
          <Line
            key={line}
            timeline={timeline}
            row={row}
            placement={placement}
            line={line}
            // An empty timeline band keeps its full height; other new lines are thin.
            isNew={line === count && !(placement === "on" && count === 0)}
            entries={rowEntries.filter((e) => e.placement === placement && e.line === line)}
            items={items}
            onRemove={onRemove}
          />
        ))}
      </div>
    );
  };
  return (
    <div className="pp-tl-row" data-testid={`timeline-row-${row.id}`}>
      <div className="pp-tl-label">
        <input
          className="pp-tl-row-name"
          defaultValue={row.name}
          key={row.name}
          aria-label="Row name"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name && name !== row.name) onRename(name);
            else e.target.value = row.name;
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
        <span className="pp-button-group">
          <button
            type="button"
            aria-label={`Move row ${row.name} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move row ${row.name} down`}
            disabled={index === timeline.rows.length - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </span>
      </div>
      <div className="pp-tl-body">
        {area("above")}
        {area("on")}
        {area("below")}
        {rowEntries.length === 0 && <span className="pp-tl-placeholder">Drop tasks here</span>}
      </div>
    </div>
  );
}

export function TimelineView({ timelineId }: { timelineId: string }) {
  const { data, error, reload } = useLive(
    () => load(timelineId),
    (c) => (c.entityType === "timeline" && c.entityId === timelineId) || c.entityType === "task",
    [timelineId],
  );
  const { error: actionError, run } = useAction();
  const [newRow, setNewRow] = useState("");
  // Tasks can come from other projects: keep them live too.
  const { watchProject } = useProject();
  const itemProjects = [...new Set([...(data?.items.values() ?? [])].map((t) => t.projectId))];
  const itemProjectsKey = itemProjects.join(",");
  useEffect(() => {
    for (const id of itemProjectsKey ? itemProjectsKey.split(",") : []) watchProject(id);
  }, [itemProjectsKey, watchProject]);
  if (!data) return <ErrorText error={error} />;
  const { timeline, items } = data;
  const ticks = scaleTicks(timeline.start, timeline.end, timeline.scale, 400);

  const update = (
    changes: Partial<Pick<Timeline, "name" | "start" | "end" | "scale" | "rows" | "entries">>,
  ) =>
    run(async () => {
      await api.timelines.update(timeline.id, { version: timeline.version, ...changes });
      await reload();
    });

  return (
    <div className="pp-panel pp-timeline">
      <div className="pp-toolbar">
        <input
          className="pp-title-input"
          defaultValue={timeline.name}
          onBlur={(e) => e.target.value !== timeline.name && update({ name: e.target.value })}
          aria-label="Timeline name"
        />
        <input
          type="date"
          value={toDateInputValue(timeline.start)}
          onChange={(e) => e.target.value && update({ start: fromDateInputValue(e.target.value) })}
          aria-label="Start"
        />
        <input
          type="date"
          value={toDateInputValue(timeline.end)}
          onChange={(e) => e.target.value && update({ end: fromDateInputValue(e.target.value) })}
          aria-label="End"
        />
        <select
          value={timeline.scale}
          onChange={(e) => update({ scale: e.target.value as Granularity })}
          aria-label="Scale"
        >
          {GRANULARITIES.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <span className="pp-spacer" />
        <input placeholder="New row" value={newRow} onChange={(e) => setNewRow(e.target.value)} />
        <button
          type="button"
          disabled={!newRow}
          onClick={() =>
            update({ rows: [...timeline.rows, { id: crypto.randomUUID(), name: newRow }] }).then(
              () => setNewRow(""),
            )
          }
        >
          Add row
        </button>
      </div>
      <ErrorText error={actionError} />
      <div className="pp-tl-scale">
        <div className="pp-tl-label" />
        <div className="pp-tl-ticks">
          {ticks.map((t) => (
            <span
              key={t}
              style={{ left: `${positionInRange(t, timeline.start, timeline.end) * 100}%` }}
            >
              {formatForDisplay(t, timeline.scale)}
            </span>
          ))}
        </div>
      </div>
      {timeline.rows.map((r, index) => (
        <Row
          key={r.id}
          timeline={timeline}
          row={r}
          index={index}
          items={items}
          onRename={(name) =>
            update({ rows: timeline.rows.map((x) => (x.id === r.id ? { ...x, name } : x)) })
          }
          onMove={(direction) => update({ rows: moveRow(timeline.rows, r.id, direction) })}
          onRemove={(id) => update({ entries: timeline.entries.filter((e) => e.id !== id) })}
        />
      ))}
    </div>
  );
}
