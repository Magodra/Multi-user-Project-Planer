/** Status indicators (CLAUDE.md §7): internal/external, MONITOR/AGREEMENT, pending, rejected, variance. */
import type { AgreementState, LinkType } from "@planning/shared";

export interface StatusBadge {
  label: string;
  title: string;
  className: string;
}

export function itemBadges(input: {
  external: boolean;
  /** Plans using this external task (names, shown in the tooltip). */
  recipients: string[];
  reference: boolean;
  linkType: LinkType | null;
  pending: boolean;
  agreementState: AgreementState;
  endVarianceDays: number | null;
  /** Explanations of dependencies this task does not respect. */
  dependencyIssues?: string[];
}): StatusBadge[] {
  const badges: StatusBadge[] = [];
  if (input.reference) {
    badges.push({
      label: "REF",
      title: "External task owned by another plan",
      className: "pp-b-ref",
    });
    if (input.linkType === "AGREEMENT")
      badges.push({
        label: "AGR",
        title: "AGREEMENT link: changes need approval of all parties",
        className: "pp-b-agreement",
      });
    else
      badges.push({
        label: "MON",
        title: "MONITOR link: changes are notified",
        className: "pp-b-monitor",
      });
  } else if (input.external) {
    badges.push({
      label: `EXT${input.recipients.length ? ` ${input.recipients.length}` : ""}`,
      title:
        input.recipients.length === 0
          ? "External task, not used in other plans yet"
          : [
              `External task used in ${input.recipients.length} other plan(s):`,
              ...input.recipients.map((n) => `• ${n}`),
            ].join("\n"),
      className: "pp-b-ext",
    });
  }
  if (input.dependencyIssues?.length)
    badges.push({
      label: "⚠ DEP",
      title: input.dependencyIssues.join("\n"),
      className: "pp-b-late",
    });
  if (input.pending)
    badges.push({ label: "PEND", title: "Pending approval", className: "pp-b-pending" });
  if (input.agreementState === "REJECTED")
    badges.push({ label: "REJ", title: "Agreement rejected", className: "pp-b-rejected" });
  else if (input.agreementState === "PROPOSED")
    badges.push({
      label: "PROP",
      title: "Proposed, awaiting agreement",
      className: "pp-b-pending",
    });
  else if (input.agreementState === "AGREED")
    badges.push({ label: "✓", title: "Agreed", className: "pp-b-agreed" });
  if (input.endVarianceDays) {
    const late = input.endVarianceDays > 0;
    badges.push({
      label: `${late ? "+" : ""}${input.endVarianceDays}d`,
      title: `${Math.abs(input.endVarianceDays)} day(s) ${late ? "later" : "earlier"} than agreed`,
      className: late ? "pp-b-late" : "pp-b-early",
    });
  }
  return badges;
}
