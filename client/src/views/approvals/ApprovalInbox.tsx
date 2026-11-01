/**
 * ChangeRequests the user needs to act on, in this project and its
 * subprojects (whose plans can be opened in the workspace). Approving is UI
 * only (never via MCP); task dialogs offer the same decision.
 */
import { api } from "../../api/client";
import { Empty, ErrorText, useAction } from "../../components/ui";
import { useLive, useProject } from "../../workspace/ProjectContext";
import { DecisionControls, ProposedTable, requestKindLabel } from "./ApprovalParts";

export function ApprovalInbox() {
  const { project, users } = useProject();
  const { data, error, reload } = useLive(
    () => api.changeRequests.pending(project.id, true),
    (c) => c.entityType === "changeRequest",
    [project.id],
  );
  const { busy, error: actionError, run } = useAction();
  const nameOf = (id: string) => users.find((u) => u.id === id)?.displayName ?? id;

  return (
    <div className="pp-panel">
      <ErrorText error={error ?? actionError} />
      {data?.length === 0 && <Empty>Nothing to approve.</Empty>}
      <ul className="pp-cards">
        {data?.map(({ approval, changeRequest: cr, planName }) => (
          <li key={approval.id} className="pp-card" data-testid="approval-card">
            <header>
              <strong>{cr.title}</strong>
              <span className="pp-badge pp-b-pending">{requestKindLabel(cr)}</span>
              {cr.origin === "MCP" && (
                <span className="pp-badge pp-b-ref" title="Proposed by an AI assistant via MCP">
                  MCP
                </span>
              )}
            </header>
            {cr.kind === "PROPOSE_TASK_CHANGE" && (
              <p className="pp-hint">
                Proposed from a plan that uses this task under an AGREEMENT link. Approving applies
                these values to the task.
                {cr.description && ` Reason: ${cr.description}`}
              </p>
            )}
            <p className="pp-hint">
              On behalf of <b>{planName}</b> ({approval.reason}) · requested by{" "}
              {nameOf(cr.requestedBy)}
            </p>
            <ProposedTable cr={cr} />
            <DecisionControls
              approvalId={approval.id}
              busy={busy}
              run={run}
              onDecided={() => void reload()}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
