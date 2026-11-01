/**
 * User-configurable timeline: name, span, scale and swimlanes. Items are
 * dragged in from plans and stored as references (dates are read live).
 */
import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  GRANULARITIES,
  type Granularity,
  type Task,
  type Timeline,
  formatForDisplay,
  fromDateInputValue,
  positionInRange,
  scaleTicks,
  toDateInputValue,
} from "@planning/shared";
import { api } from "../../api/client";
import { ErrorText, useAction } from "../../components/ui";
import { useLive } from "../../workspace/ProjectContext";
import type { PlanItemDragData, TimelineRowDropData } from "../../workspace/panels";

/** Add a dragged plan item to a timeline row (called by the workspace's DndContext). */
export async function addItemToTimeline(
  drop: TimelineRowDropData,
  item: PlanItemDragData,
): Promise<void> {
  const timeline = await api.timelines.get(drop.timelineId);
  if (timeline.entries.some((e) => e.itemId === item.itemId && e.rowId === drop.rowId)) return;
  const entry = {
    id: crypto.randomUUID(),
    rowId: drop.rowId,
    itemId: item.itemId,
    planId: item.planId,
  };
  await api.timelines.update(timeline.id, {
    version: timeline.version,
    entries: [...timeline.entries, entry],
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

function Row({
  timeline,
  rowId,
  name,
  items,
  onRemove,
}: {
  timeline: Timeline;
  rowId: string;
  name: string;
  items: Map<string, Task>;
  onRemove(entryId: string): void;
}) {
  const data: TimelineRowDropData = { type: "timeline-row", timelineId: timeline.id, rowId };
  const { setNodeRef, isOver } = useDroppable({ id: `timeline-row:${timeline.id}:${rowId}`, data });
  const entries = timeline.entries.filter((e) => e.rowId === rowId);
  return (
    <div className="pp-tl-row">
      <div className="pp-tl-label">{name}</div>
      <div
        ref={setNodeRef}
        className={`pp-tl-lane${isOver ? " pp-drop-over" : ""}`}
        data-testid={`timeline-row-${rowId}`}
      >
        {entries.map((e, index) => {
          const item = items.get(e.itemId);
          if (!item) return null;
          const left = Math.max(0, positionInRange(item.start, timeline.start, timeline.end));
          const right = Math.min(1, positionInRange(item.end, timeline.start, timeline.end));
          if (right < 0 || left > 1) return null;
          const milestone = item.duration === 0;
          return (
            <div
              key={e.id}
              className={`pp-tl-entry${milestone ? " pp-tl-milestone" : ""}`}
              style={{
                left: `${left * 100}%`,
                width: milestone ? undefined : `${Math.max(0.5, (right - left) * 100)}%`,
                top: `${(index % 3) * 26 + 4}px`,
              }}
              title={`${item.name}: ${formatForDisplay(item.start, item.granularity)} – ${formatForDisplay(item.end, item.granularity)}`}
            >
              <span>{item.name}</span>
              <button
                type="button"
                className="pp-tl-remove"
                aria-label={`Remove ${item.name}`}
                onClick={() => onRemove(e.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        {entries.length === 0 && <span className="pp-tl-placeholder">Drop tasks here</span>}
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
      {timeline.rows.map((r) => (
        <Row
          key={r.id}
          timeline={timeline}
          rowId={r.id}
          name={r.name}
          items={items}
          onRemove={(id) => update({ entries: timeline.entries.filter((e) => e.id !== id) })}
        />
      ))}
    </div>
  );
}
