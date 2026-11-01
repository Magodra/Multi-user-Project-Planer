/** Wording for dependencies and their problems, used by the Gantt and the Project tab. */
import { type DependencyType, type Granularity, varianceInDays } from "@planning/shared";

/** Lag in hours, days and weeks is working time; e.g. "+2 working days". */
export function lagText(d: { lag: number; lagUnit: Granularity }): string {
  if (d.lag === 0) return "";
  const working = d.lagUnit === "hours" || d.lagUnit === "days" || d.lagUnit === "weeks";
  return `${d.lag > 0 ? "+" : ""}${d.lag} ${working ? `working ${d.lagUnit}` : d.lagUnit}`;
}

/** E.g. "Starts 2 day(s) too early for Design (FS +1 working days): earliest 2026-11-05". */
export function describeDependencyIssue(issue: {
  type: DependencyType;
  lag: number;
  lagUnit: Granularity;
  fromName: string;
  required: string;
  actual: string;
}): string {
  const what = issue.type === "FS" || issue.type === "SS" ? "Starts" : "Finishes";
  const days = varianceInDays(issue.required, issue.actual);
  const amount = days > 0 ? `${days} day(s) too early` : "too early";
  return `${what} ${amount} for ${issue.fromName || "its predecessor"} (${issue.type}${lagText(issue)}): earliest ${issue.required.slice(0, 16).replace("T", " ")}`;
}
