/** Predecessors in task-ID notation, with live validation; used by both task dialogs. */
import { parsePredecessors } from "@planning/shared";
import { Field } from "../../components/ui";

export function PredecessorsField({
  value,
  onChange,
  disabled,
  otherPlanLinks,
}: {
  value: string;
  onChange(value: string): void;
  disabled: boolean;
  /** Predecessors linked in another plan (shown, not editable here). */
  otherPlanLinks: string[];
}) {
  const parsed = parsePredecessors(value);
  return (
    <>
      <Field label="Predecessors">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          placeholder="e.g. 4FS+3d; 2SS-1d"
          aria-invalid={!parsed.ok}
        />
      </Field>
      <p className={parsed.ok ? "pp-hint" : "pp-error"}>
        {parsed.ok
          ? "Task IDs of this plan (also external tasks) with type FS, SS, FF or SF (default FS) and lag in h, d, w, mo or y; a negative lag is a lead."
          : parsed.error}
      </p>
      {otherPlanLinks.length > 0 && (
        <p className="pp-hint">Also linked in its owner plan: {otherPlanLinks.join(", ")}.</p>
      )}
    </>
  );
}
