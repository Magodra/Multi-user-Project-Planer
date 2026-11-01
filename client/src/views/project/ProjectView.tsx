/** Project settings: plans and subprojects, members and roles, plan links (MONITOR/AGREEMENT). */
import { useState } from "react";
import { ROLES, type LinkType, type Role } from "@planning/shared";
import { api } from "../../api/client";
import { ErrorText, Field, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { ProjectStructure } from "./ProjectStructure";

export function ProjectView() {
  const { project, plans, users, reloadPlans } = useProject();
  const { data: members, reload: reloadMembers } = useLive(
    () => api.projects.members(project.id),
    (c) => c.entityType === "roleAssignment",
    [project.id],
  );
  const { data: links, reload: reloadLinks } = useLive(
    () => api.projects.links(project.id),
    (c) => c.entityType === "planLink",
    [project.id],
  );
  const { busy, error, run } = useAction();
  const [planName, setPlanName] = useState("");
  const [planType, setPlanType] = useState("internal");
  const [member, setMember] = useState({ userId: "", planId: "", role: "EDITOR" as Role });
  const [link, setLink] = useState({ fromPlanId: "", toPlanId: "", type: "MONITOR" as LinkType });
  const planName_ = (id: string | null) =>
    id ? (plans.find((p) => p.id === id)?.name ?? id) : "All plans";

  return (
    <div className="pp-panel pp-scroll">
      <ErrorText error={error} />
      <section>
        <h3>Plans and subprojects</h3>
        <ProjectStructure />
        <form
          className="pp-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.plans.create(project.id, {
                name: planName,
                planType,
                description: "",
                ownerPartyId: null,
              });
              setPlanName("");
              await reloadPlans();
            });
          }}
        >
          <input
            placeholder="Plan name"
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
          />
          <input
            placeholder="Type (contract, internal, …)"
            value={planType}
            onChange={(e) => setPlanType(e.target.value)}
          />
          <button type="submit" disabled={!planName || busy}>
            Add plan
          </button>
        </form>
      </section>

      <section>
        <h3>Members</h3>
        <table className="pp-table">
          <tbody>
            {members?.map((m) => (
              <tr key={m.id}>
                <td>{users.find((u) => u.id === m.userId)?.displayName ?? m.userId}</td>
                <td>{m.role}</td>
                <td>{planName_(m.planId)}</td>
                <td>
                  <button
                    type="button"
                    onClick={() =>
                      run(() => api.projects.removeRole(project.id, m.id)).then(reloadMembers)
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pp-row">
          <Field label="User">
            <select
              value={member.userId}
              onChange={(e) => setMember({ ...member, userId: e.target.value })}
            >
              <option value="">Choose…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Plan">
            <select
              value={member.planId}
              onChange={(e) => setMember({ ...member, planId: e.target.value })}
            >
              <option value="">All plans</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Role">
            <select
              value={member.role}
              onChange={(e) => setMember({ ...member, role: e.target.value as Role })}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            disabled={!member.userId || busy}
            onClick={() =>
              run(() =>
                api.projects.assignRole(project.id, {
                  userId: member.userId,
                  planId: member.planId || null,
                  role: member.role,
                }),
              ).then(reloadMembers)
            }
          >
            Assign
          </button>
        </div>
      </section>

      <section>
        <h3>Plan links</h3>
        <table className="pp-table">
          <tbody>
            {links?.map((l) => (
              <tr key={l.id}>
                <td>
                  {planName_(l.fromPlanId)} → {planName_(l.toPlanId)}
                  {l.referenceId ? " (one task)" : ""}
                </td>
                <td>
                  <span
                    className={`pp-badge ${l.type === "AGREEMENT" ? "pp-b-agreement" : "pp-b-monitor"}`}
                  >
                    {l.type}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api.links.changeType(l.id, {
                          version: l.version,
                          type: l.type === "MONITOR" ? "AGREEMENT" : "MONITOR",
                        }),
                      ).then(reloadLinks)
                    }
                  >
                    {l.type === "MONITOR" ? "Upgrade to AGREEMENT" : "Downgrade to MONITOR"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pp-row">
          <select
            value={link.fromPlanId}
            onChange={(e) => setLink({ ...link, fromPlanId: e.target.value })}
            aria-label="Owner plan"
          >
            <option value="">Owner plan…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            value={link.toPlanId}
            onChange={(e) => setLink({ ...link, toPlanId: e.target.value })}
            aria-label="Recipient plan"
          >
            <option value="">Recipient plan…</option>
            {plans
              .filter((p) => p.id !== link.fromPlanId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <select
            value={link.type}
            onChange={(e) => setLink({ ...link, type: e.target.value as LinkType })}
            aria-label="Link type"
          >
            <option>MONITOR</option>
            <option>AGREEMENT</option>
          </select>
          <button
            type="button"
            disabled={!link.fromPlanId || !link.toPlanId || busy}
            onClick={() =>
              run(() => api.links.create({ ...link, referenceId: null, partyIds: [] })).then(
                reloadLinks,
              )
            }
          >
            Link plans
          </button>
        </div>
      </section>
    </div>
  );
}
