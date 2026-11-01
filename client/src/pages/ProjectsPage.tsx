import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Project, ProjectSummary } from "@planning/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Badge, Empty, ErrorText, Field, useAction } from "../components/ui";
import { ProjectProvider } from "../workspace/ProjectContext";
import { ProjectWorkspace } from "../workspace/ProjectWorkspace";
import { ProjectDialog } from "./ProjectDialog";
import {
  type ProjectNode,
  buildProjectTree,
  parentOptions,
  withoutInactiveSubtrees,
} from "./projectTree";

function ProjectTree({
  nodes,
  onEdit,
}: {
  nodes: ProjectNode[];
  onEdit(project: ProjectSummary): void;
}) {
  return (
    <ul className="pp-cards pp-project-tree">
      {nodes.map(({ project: p, children }) => (
        <li key={p.id}>
          <div className={`pp-card${p.active ? "" : " pp-inactive"}`} data-testid="project-card">
            <header>
              <Link to={`/projects/${p.id}`}>{p.name}</Link>
              {p.projectType && (
                <Badge className="pp-b-type" title="Project type">
                  {p.projectType}
                </Badge>
              )}
              {!p.active && (
                <Badge className="pp-b-inactive" title="This project is deactivated">
                  Inactive
                </Badge>
              )}
              <span className="pp-spacer" />
              {p.canEdit && (
                <button type="button" className="pp-link" onClick={() => onEdit(p)}>
                  Edit
                </button>
              )}
            </header>
            {p.description && <p className="pp-hint pp-description">{p.description}</p>}
          </div>
          {children.length > 0 && <ProjectTree nodes={children} onEdit={onEdit} />}
        </li>
      ))}
    </ul>
  );
}

export function ProjectsPage() {
  const { user, signOut } = useAuth();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState("");
  const [projectType, setProjectType] = useState("");
  const [parentProjectId, setParentProjectId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<ProjectSummary | null>(null);
  const { busy, error, run } = useAction();

  const reload = useCallback(() => run(async () => setProjects(await api.projects.list())), [run]);
  useEffect(() => void reload(), [reload]);

  const all = projects ?? [];
  const shown = showInactive ? all : withoutInactiveSubtrees(all);
  const inactiveCount = all.length - all.filter((p) => p.active).length;

  return (
    <main className="pp-page">
      <header className="pp-page-header">
        <h1>Projects</h1>
        <span className="pp-spacer" />
        <span>{user?.displayName}</span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <ErrorText error={error} />
      {inactiveCount > 0 && (
        <label className="pp-check">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive projects ({inactiveCount})
        </label>
      )}
      {projects?.length === 0 && <Empty>No projects yet.</Empty>}
      <ProjectTree nodes={buildProjectTree(shown)} onEdit={setEditing} />
      <form
        className="pp-row"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api.projects.create({ name, projectType, parentProjectId, description: "" });
            setName("");
            setProjectType("");
            setProjects(await api.projects.list());
          });
        }}
      >
        <Field label="Name">
          <input
            placeholder="New project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Project type">
          <input value={projectType} onChange={(e) => setProjectType(e.target.value)} />
        </Field>
        <Field label="Parent project">
          <select
            aria-label="Parent project"
            value={parentProjectId ?? ""}
            onChange={(e) => setParentProjectId(e.target.value || null)}
          >
            <option value="">(none — top level)</option>
            {parentOptions(all).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="pp-primary" disabled={!name || busy}>
          Create project
        </button>
      </form>
      {editing && (
        <ProjectDialog
          project={editing}
          projects={all}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void reload();
          }}
        />
      )}
    </main>
  );
}

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.projects
      .get(projectId)
      .then(setProject, (err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [projectId]);
  if (!project)
    return (
      <main className="pp-center">{error ? <ErrorText error={error} /> : <p>Loading…</p>}</main>
    );
  return (
    <ProjectProvider key={project.id} project={project}>
      <ProjectWorkspace />
    </ProjectProvider>
  );
}
