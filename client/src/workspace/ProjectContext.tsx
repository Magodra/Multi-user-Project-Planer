import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Plan, PlanView, Project, PublicUser, RealtimeMessage } from "@planning/shared";
import { api } from "../api/client";
import { RealtimeConnection } from "../api/realtime";

type Change = Extract<RealtimeMessage, { type: "changed" }>;

interface ProjectData {
  project: Project;
  plans: Plan[];
  users: PublicUser[];
  reloadPlans(): Promise<void>;
  /** Subscribe to live changes from other users (and this one). */
  onChange(listener: (change: Change) => void): () => void;
}

const Ctx = createContext<ProjectData | null>(null);

export function ProjectProvider({ project, children }: { project: Project; children: ReactNode }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const listeners = useRef(new Set<(c: Change) => void>());

  const reloadPlans = useCallback(
    async () => setPlans(await api.plans.list(project.id)),
    [project.id],
  );

  useEffect(() => {
    void reloadPlans();
    void api.users.list().then(setUsers);
    const connection = new RealtimeConnection(project.id);
    // Subproject plans can be opened in this workspace: keep them live too.
    void api.projects.list().then(
      (all) => {
        for (const id of descendantIds(all, project.id)) connection.watch(id);
      },
      () => undefined,
    );
    const off = connection.subscribe((change) => {
      if (change.entityType === "plan") void reloadPlans();
      for (const l of listeners.current) l(change);
    });
    return () => {
      off();
      connection.close();
    };
  }, [project.id, reloadPlans]);

  const onChange = useCallback((listener: (c: Change) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const value = useMemo(
    () => ({ project, plans, users, reloadPlans, onChange }),
    [project, plans, users, reloadPlans, onChange],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function descendantIds(all: Project[], rootId: string): string[] {
  const result: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const p of all)
      if (p.parentProjectId === id) {
        result.push(p.id);
        queue.push(p.id);
      }
  }
  return result;
}

export function useProject(): ProjectData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useProject outside ProjectProvider");
  return ctx;
}

/** Load a value and reload it when a matching live change arrives. */
export function useLive<T>(
  load: () => Promise<T>,
  matches: (change: Change) => boolean,
  deps: unknown[],
) {
  const { onChange } = useProject();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const matchRef = useRef(matches);
  loadRef.current = load;
  matchRef.current = matches;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    return onChange((change) => {
      if (matchRef.current(change)) void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, onChange, ...deps]);

  return { data, error, reload };
}

/** Plans of a project: the workspace's own from context, others (subprojects) loaded live. */
export function useProjectPlans(projectId: string): Plan[] {
  const { project, plans } = useProject();
  const own = projectId === project.id;
  const { data } = useLive(
    () => (own ? Promise.resolve(null) : api.plans.list(projectId)),
    (c) => !own && c.projectId === projectId && c.entityType === "plan",
    [projectId, own],
  );
  return own ? plans : (data ?? []);
}

export function usePlanView(planId: string) {
  return useLive<PlanView>(
    () => api.plans.view(planId),
    (c) => c.planIds.includes(planId) || c.entityType === "planLink",
    [planId],
  );
}
