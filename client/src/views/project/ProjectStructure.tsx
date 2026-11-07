/**
 * The current project as a tree: under each project first its plans, then its
 * subprojects. Subprojects expand on demand; the expanded set is saved in the
 * user's workspace for this project. Timelines are listed after the plans. Plans of subprojects open in this
 * workspace too. Inactive subprojects are hidden with their subtrees, as on
 * the projects page.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DependencyIssueSummary, Plan, ProjectSummary } from "@planning/shared";
import { api } from "../../api/client";
import { Badge, ErrorText } from "../../components/ui";
import { withoutInactiveSubtrees } from "../../pages/projectTree";
import { describeDependencyIssue } from "../gantt/dependencyText";
import { PlanDialog } from "./PlanDialog";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { useWorkspaceActions } from "../../workspace/panels";

export function ProjectStructure() {
  const { project, plans } = useProject();
  const { openPanel, expandedProjectIds, setProjectExpanded, planChanged } = useWorkspaceActions();
  const { reloadPlans } = useProject();
  const [editing, setEditing] = useState<{ plan: Plan; projectId: string } | null>(null);
  const { data: projects, error } = useLive(
    () => api.projects.list(),
    (c) => c.entityType === "project",
    [],
  );
  const [subPlans, setSubPlans] = useState<Record<string, Plan[] | "error">>({});

  // The current project is always the root, even when it is itself inactive.
  const visible = withoutInactiveSubtrees(
    (projects ?? []).map((p) => (p.id === project.id ? { ...p, active: true } : p)),
  );
  const childrenOf = (id: string) => visible.filter((p) => p.parentProjectId === id);
  const expanded = new Set(expandedProjectIds);

  // Timelines of the open projects, kept live.
  const openIds = treeIdsOpen(project.id, expandedProjectIds, visible);
  const { data: timelineLists } = useLive(
    () => Promise.all(openIds.map((pid) => api.timelines.list(pid).catch(() => []))),
    (c) => c.entityType === "timeline",
    [openIds.join(",")],
  );
  const timelinesOf = new Map(openIds.map((pid, i) => [pid, timelineLists?.[i] ?? []] as const));

  // Dependency problems of every plan in the tree (also collapsed subprojects), kept live.
  const treeIds = [project.id, ...descendantsOf(project.id, visible)];
  const { data: issueLists } = useLive(
    () => Promise.all(treeIds.map((pid) => api.plans.dependencyIssues(pid).catch(() => []))),
    (c) => ISSUE_SOURCES.has(c.entityType),
    [treeIds.join(",")],
  );
  const issuesByPlan = new Map((issueLists ?? []).flat().map((p) => [p.planId, p.issues] as const));
  const ownIssueCount = new Map(
    treeIds.map((pid, i) => [
      pid,
      (issueLists?.[i] ?? []).reduce((n, p) => n + p.issues.length, 0),
    ]),
  );
  const subtreeIssueCount = (id: string): number =>
    (ownIssueCount.get(id) ?? 0) + childrenOf(id).reduce((n, c) => n + subtreeIssueCount(c.id), 0);

  // Load the plans of expanded subprojects that are not loaded yet.
  const missing = expandedProjectIds.filter(
    (id) => id !== project.id && !(id in subPlans) && visible.some((p) => p.id === id),
  );
  const missingKey = missing.join(",");
  useEffect(() => {
    for (const id of missingKey ? missingKey.split(",") : []) {
      api.plans.list(id).then(
        (list) => setSubPlans((s) => ({ ...s, [id]: list })),
        () => setSubPlans((s) => ({ ...s, [id]: "error" })),
      );
    }
  }, [missingKey]);

  const renderNode = (p: ProjectSummary | null, depth: number): ReactNode => {
    const id = p?.id ?? project.id;
    const name = p?.name ?? project.name;
    const isRoot = id === project.id;
    const open = expanded.has(id);
    const nodePlans = isRoot ? plans : subPlans[id];
    const children = childrenOf(id);
    return (
      <li key={id} role="treeitem" aria-expanded={open} aria-selected={false}>
        <div className="pp-tree-row" style={{ paddingLeft: `${depth * 1.2}rem` }}>
          <button
            type="button"
            className="pp-tree-toggle"
            aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
            onClick={() => setProjectExpanded(id, !open)}
          >
            {open ? "▾" : "▸"}
          </button>
          {isRoot ? (
            <strong>{name}</strong>
          ) : (
            <Link to={`/projects/${id}`} title="Open this project">
              {name}
            </Link>
          )}
          {(p?.projectType ?? project.projectType) && (
            <Badge className="pp-b-type" title="Project type">
              {p?.projectType ?? project.projectType}
            </Badge>
          )}
          {subtreeIssueCount(id) > 0 && (
            <Badge
              className="pp-b-late"
              title={`${subtreeIssueCount(id)} dependency problem(s) in this project and its subprojects`}
            >
              ⚠ {subtreeIssueCount(id)}
            </Badge>
          )}
        </div>
        {open && (
          <ul role="group" className="pp-tree-group">
            {nodePlans === undefined && <li className="pp-hint">Loading…</li>}
            {nodePlans === "error" && <li className="pp-error">Plans could not be loaded.</li>}
            {Array.isArray(nodePlans) &&
              nodePlans.map((plan) => (
                <li key={plan.id} role="treeitem" aria-selected={false}>
                  <div
                    className="pp-tree-row pp-tree-plan"
                    style={{ paddingLeft: `${(depth + 1) * 1.2}rem` }}
                  >
                    <span className="pp-tree-toggle" aria-hidden />
                    <button
                      type="button"
                      className="pp-link"
                      onClick={() =>
                        openPanel(
                          "gantt",
                          { planId: plan.id },
                          isRoot ? plan.name : `${plan.name} (${name})`,
                        )
                      }
                    >
                      {plan.name}
                    </button>
                    <span className="pp-hint">{plan.planType}</span>
                    <PlanIssuesBadge issues={issuesByPlan.get(plan.id) ?? []} />
                    <button
                      type="button"
                      className="pp-link pp-tree-edit"
                      aria-label={`Edit plan ${plan.name}`}
                      onClick={() => setEditing({ plan, projectId: id })}
                    >
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            {(timelinesOf.get(id) ?? []).map((timeline) => (
              <li key={timeline.id} role="treeitem" aria-selected={false}>
                <div
                  className="pp-tree-row pp-tree-timeline"
                  style={{ paddingLeft: `${(depth + 1) * 1.2}rem` }}
                >
                  <span className="pp-tree-toggle" aria-hidden />
                  <button
                    type="button"
                    className="pp-link"
                    onClick={() =>
                      openPanel(
                        "timeline",
                        { timelineId: timeline.id },
                        isRoot ? timeline.name : `${timeline.name} (${name})`,
                      )
                    }
                  >
                    {timeline.name}
                  </button>
                  <span className="pp-hint">timeline</span>
                </div>
              </li>
            ))}
            {Array.isArray(nodePlans) &&
              nodePlans.length === 0 &&
              (timelinesOf.get(id) ?? []).length === 0 &&
              children.length === 0 && (
                <li className="pp-hint" style={{ paddingLeft: `${(depth + 1) * 1.2 + 1.8}rem` }}>
                  No plans or subprojects.
                </li>
              )}
            {children.map((c) => renderNode(c, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <>
      <ErrorText error={error} />
      <ul role="tree" aria-label="Project structure" className="pp-tree">
        {renderNode(visible.find((p) => p.id === project.id) ?? null, 0)}
      </ul>
      {editing && (
        <PlanDialog
          plan={editing.plan}
          onClose={() => setEditing(null)}
          onChanged={(deleted, name) => {
            planChanged(editing.plan.id, editing.plan.name, deleted ? null : name);
            setEditing(null);
            // Reload the plan list of the project that changed.
            if (editing.projectId === project.id) void reloadPlans();
            else
              setSubPlans((s) => {
                const { [editing.projectId]: _dropped, ...rest } = s;
                return rest;
              });
          }}
        />
      )}
    </>
  );
}

/** Live changes that can create or resolve dependency problems. */
const ISSUE_SOURCES = new Set(["task", "dependency", "planItemReference", "plan", "changeRequest"]);

function descendantsOf(rootId: string, projects: ProjectSummary[]): string[] {
  const out: string[] = [];
  for (let i = -1, parent = rootId; i < out.length; parent = out[++i]!)
    for (const p of projects) if (p.parentProjectId === parent) out.push(p.id);
  return out;
}

/** "⚠ 2" with the problems listed in the tooltip. */
function PlanIssuesBadge({ issues }: { issues: DependencyIssueSummary[] }) {
  if (issues.length === 0) return null;
  const lines = issues.slice(0, 15).map((i) => `${i.toName}: ${describeDependencyIssue(i)}`);
  if (issues.length > 15) lines.push(`…and ${issues.length - 15} more`);
  return (
    <span data-testid="plan-dependency-issues">
      <Badge className="pp-b-late" title={[`Dependency problems:`, ...lines].join("\n")}>
        ⚠ {issues.length}
      </Badge>
    </span>
  );
}

/** The root and the expanded projects that are visible in the tree. */
function treeIdsOpen(rootId: string, expanded: string[], projects: ProjectSummary[]): string[] {
  const visible = new Set(projects.map((p) => p.id));
  return [rootId, ...expanded.filter((id) => id !== rootId && visible.has(id))];
}
