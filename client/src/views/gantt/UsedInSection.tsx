/**
 * "Use in another plan" for an external task: the plans using it (also in
 * other projects of the tree) with their MONITOR/AGREEMENT type, an upgrade
 * to AGREEMENT, and adding the task to another plan with a chosen type.
 */
import { useCallback, useEffect, useState } from "react";
import type { LinkType, PlanView, ReferenceTarget, Task } from "@planning/shared";
import { api } from "../../api/client";
import { Badge, ErrorText, useAction } from "../../components/ui";

const LINK_BADGE: Record<LinkType, { label: string; className: string; title: string }> = {
  MONITOR: {
    label: "MON",
    className: "pp-b-monitor",
    title: "MONITOR: the plan follows the task; changes are notified",
  },
  AGREEMENT: {
    label: "AGR",
    className: "pp-b-agreement",
    title: "AGREEMENT: changes need approval of both sides",
  },
};

export function UsedInSection({ view, task }: { view: PlanView; task: Task }) {
  const usedIn = view.recipients[task.id] ?? [];
  const [targets, setTargets] = useState<ReferenceTarget[] | null>(null);
  const [planId, setPlanId] = useState("");
  const [linkType, setLinkType] = useState<LinkType>("MONITOR");
  const { busy, error, run } = useAction();

  const loadTargets = useCallback(
    () => run(async () => setTargets(await api.items.referenceTargets(task.id))),
    [run, task.id],
  );
  // Reload when the plans using the task change (live updates of the view).
  const usedKey = usedIn.map((r) => r.planId).join(",");
  useEffect(() => void loadTargets(), [loadTargets, usedKey]);

  const target = targets?.find((t) => t.planId === planId);
  const choose = (id: string) => {
    setPlanId(id);
    setLinkType(targets?.find((t) => t.planId === id)?.defaultLinkType ?? "MONITOR");
  };
  // Only a choice that differs from the plan-level link is stored for this task.
  const add = () =>
    run(async () => {
      await api.items.addReference({
        itemId: task.id,
        planId,
        ...(linkType !== target?.defaultLinkType && { linkType }),
      });
      setPlanId("");
    });
  const upgrade = (referenceId: string) =>
    run(() => api.items.setReferenceType(referenceId, { type: "AGREEMENT" }));

  const projects = [...new Set((targets ?? []).map((t) => t.projectId))];
  const otherProject = (projectId: string) => projectId !== view.plan.projectId;

  return (
    <section className="pp-dialog-section">
      <h3>Use in another plan</h3>
      {usedIn.length > 0 && (
        <ul className="pp-used-in">
          {usedIn.map((r) => {
            const badge = LINK_BADGE[r.linkType];
            return (
              <li key={r.referenceId}>
                <span>
                  {r.planName}
                  {otherProject(r.projectId) && <span className="pp-hint"> · {r.projectName}</span>}
                </span>
                <Badge className={badge.className} title={badge.title}>
                  {badge.label}
                </Badge>
                {r.linkType === "MONITOR" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void upgrade(r.referenceId)}
                    title="Agreed values carry over; later changes need approval of both sides"
                  >
                    Upgrade to AGREEMENT
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {targets?.length === 0 && (
        <p className="pp-hint">No other plans you can edit in this project tree.</p>
      )}
      {targets && targets.length > 0 && (
        <div className="pp-row">
          <select
            value={planId}
            onChange={(e) => choose(e.target.value)}
            aria-label="Plan to use the task in"
          >
            <option value="">Choose plan…</option>
            {projects.map((pid) => {
              const inProject = targets.filter((t) => t.projectId === pid);
              return (
                <optgroup key={pid} label={inProject[0]!.projectName}>
                  {inProject.map((t) => (
                    <option key={t.planId} value={t.planId}>
                      {t.planName}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <select
            value={linkType}
            onChange={(e) => setLinkType(e.target.value as LinkType)}
            aria-label="Reference type"
          >
            <option value="MONITOR">MONITOR</option>
            <option value="AGREEMENT">AGREEMENT</option>
          </select>
          <button type="button" onClick={() => void add()} disabled={!planId || busy}>
            Add reference
          </button>
        </div>
      )}
      <ErrorText error={error} />
    </section>
  );
}
