/**
 * Open requests covering one task, shown in the task dialogs: who still has
 * to decide, and Approve / Reject where the current user may decide.
 */
import { api } from "../../api/client";
import { Badge, ErrorText, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { DecisionControls, ProposedTable, requestKindLabel } from "./ApprovalParts";

const STATUS_CLASS = {
  PENDING: "pp-b-pending",
  APPROVED: "pp-b-agreed",
  REJECTED: "pp-b-rejected",
} as const;

export function TaskApprovals({ itemId }: { itemId: string }) {
  const { users } = useProject();
  const { data, error, reload } = useLive(
    () => api.changeRequests.forItem(itemId),
    (c) => c.entityType === "changeRequest" || c.entityType === "task",
    [itemId],
  );
  const { busy, error: actionError, run } = useAction();
  if (!data || data.length === 0) return <ErrorText error={error} />;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  return (
    <section className="pp-dialog-section" data-testid="task-approvals">
      <h3>Pending approvals</h3>
      {data.map(({ changeRequest: cr, approvals, decidableApprovalIds, planName, planNames }) => (
        <div key={cr.id} className="pp-task-request">
          <p>
            <strong>{cr.title}</strong>{" "}
            <Badge className="pp-b-pending" title="Kind of request">
              {requestKindLabel(cr)}
            </Badge>
          </p>
          <p className="pp-hint">
            From <b>{planName}</b> · requested by {nameOf(cr.requestedBy)}
            {cr.description && ` · ${cr.description}`}
          </p>
          <ProposedTable cr={cr} />
          <ul className="pp-approval-list">
            {approvals.map((a) => (
              <li key={a.id}>
                <span>
                  {planNames[a.planId]} <span className="pp-hint">({a.reason})</span>
                </span>
                <Badge className={STATUS_CLASS[a.status]} title={`Approval ${a.status}`}>
                  {a.status.toLowerCase()}
                </Badge>
                {decidableApprovalIds.includes(a.id) && (
                  <DecisionControls
                    approvalId={a.id}
                    busy={busy}
                    run={run}
                    onDecided={() => void reload()}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <ErrorText error={error ?? actionError} />
    </section>
  );
}
