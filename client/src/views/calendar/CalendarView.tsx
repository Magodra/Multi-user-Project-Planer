/** Calendar view (FullCalendar MIT plugins only): tasks as events, milestones as markers. */
import { useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import multiMonthPlugin from "@fullcalendar/multimonth";
import type { EventInput } from "@fullcalendar/core";
import { type PlanView, inclusiveEnd, toDisplayDate } from "@planning/shared";
import { api } from "../../api/client";
import { ErrorText } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";

const PALETTE = ["#2f6fde", "#16a34a", "#c2410c", "#7c3aed", "#0891b2", "#be123c"];

function toEvents(view: PlanView, color: string): EventInput[] {
  const tasks = [
    ...view.items.filter((t) => view.kinds[t.id] !== "activity"),
    ...view.references.map((r) => r.item),
  ];
  return tasks.map((t) => {
    const milestone = t.duration === 0;
    const allDay = t.granularity !== "hours";
    return {
      id: `${view.plan.id}:${t.id}`,
      title: milestone ? `◆ ${t.name}` : t.name,
      start: toDisplayDate(t.start, t.granularity),
      // FullCalendar treats all-day ends as exclusive dates, matching our storage.
      end: milestone
        ? undefined
        : allDay
          ? toDisplayDate(t.end, t.granularity)
          : toDisplayDate(inclusiveEnd(t.end), t.granularity),
      allDay,
      display: milestone ? "list-item" : "block",
      color,
      classNames: milestone ? ["pp-cal-milestone"] : [],
      extendedProps: { plan: view.plan.name },
    };
  });
}

export function CalendarView({ planIds: initial }: { planIds: string[] }) {
  const { plans } = useProject();
  const [planIds, setPlanIds] = useState<string[]>(
    initial.length ? initial : plans.map((p) => p.id),
  );
  const { data: views, error } = useLive(
    () => Promise.all(planIds.map((id) => api.plans.view(id))),
    (c) => c.planIds.some((id) => planIds.includes(id)),
    [planIds.join(",")],
  );
  const events = (views ?? []).flatMap((v, i) => toEvents(v, PALETTE[i % PALETTE.length]!));

  // FullCalendar only reacts to window resizes; Dockview resizes and moves panels without one.
  const panelRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<FullCalendar>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => calendarRef.current?.getApi().updateSize());
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={panelRef} className="pp-panel pp-calendar">
      <div className="pp-toolbar">
        {plans.map((p) => (
          <label key={p.id} className="pp-check">
            <input
              type="checkbox"
              checked={planIds.includes(p.id)}
              onChange={() =>
                setPlanIds((ids) =>
                  ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id],
                )
              }
            />
            {p.name}
          </label>
        ))}
      </div>
      <ErrorText error={error} />
      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, multiMonthPlugin]}
        initialView="dayGridMonth"
        headerToolbar={{
          left: "prev,next today",
          center: "title",
          right: "timeGridDay,timeGridWeek,dayGridMonth,multiMonthYear",
        }}
        buttonText={{
          timeGridDay: "day",
          timeGridWeek: "week",
          dayGridMonth: "month",
          multiMonthYear: "year",
        }}
        firstDay={1}
        height="100%"
        events={events}
        eventDidMount={(info) => {
          info.el.title = `${String(info.event.extendedProps.plan)}: ${info.event.title}`;
        }}
      />
    </div>
  );
}
