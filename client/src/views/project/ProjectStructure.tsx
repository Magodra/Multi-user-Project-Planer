/**
 * The current project as a tree: under each project first its plans, then its
 * subprojects. Subprojects expand on demand; the expanded set is saved in the
 * user's workspace for this project. Plans of subprojects open in this
 * workspace too. Inactive subprojects are hidden with their subtrees, as on
 * the projects page.
 */
import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Plan, ProjectSummary } from "@planning/shared";
import { api } from "../../api/client";
import { Badge, ErrorText } from "../../components/ui";
import { withoutInactiveSubtrees } from "../../pages/projectTree";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { useWorkspaceActions } from "../../workspace/panels";

export function ProjectStructure() {
  const { project, plans } = useProject();
  const { openPanel, expandedProjectIds, setProjectExpanded } = useWorkspaceActions();
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
                  </div>
                </li>
              ))}
            {Array.isArray(nodePlans) && nodePlans.length === 0 && children.length === 0 && (
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
    </>
  );
}
