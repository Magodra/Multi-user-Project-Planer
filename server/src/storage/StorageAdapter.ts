/**
 * Storage contract implemented by FileAdapter and SqlAdapter (CLAUDE.md §9).
 * Adapters only store and retrieve; they contain no business rules.
 */
import type {
  Approval,
  AuditLogEntry,
  Baseline,
  BaselineDefinition,
  ChangeRequest,
  Dependency,
  OAuthClient,
  Party,
  Plan,
  PlanItemReference,
  PlanLink,
  Project,
  ReportDefinition,
  RoleAssignment,
  Task,
  Timeline,
  User,
  Versioned,
  Workspace,
} from "@planning/shared";
import { ValidationError } from "../domain/errors.js";

export interface EntityMap {
  project: Project;
  plan: Plan;
  task: Task;
  planItemReference: PlanItemReference;
  planLink: PlanLink;
  dependency: Dependency;
  baseline: Baseline;
  baselineDefinition: BaselineDefinition;
  changeRequest: ChangeRequest;
  approval: Approval;
  timeline: Timeline;
  workspace: Workspace;
  reportDefinition: ReportDefinition;
  user: User;
  party: Party;
  oauthClient: OAuthClient;
  roleAssignment: RoleAssignment;
  auditLog: AuditLogEntry;
}

export type EntityType = keyof EntityMap;

export type FilterValue = string | number | null;
/** Equality filter on the queryable fields of an entity type. */
export type Filter = Record<string, FilterValue>;

/**
 * Fields each entity type can be filtered on. Both adapters accept exactly
 * these, so a query that works on one backend works on the other.
 */
export const QUERYABLE_FIELDS: { [K in EntityType]: readonly (keyof EntityMap[K] & string)[] } = {
  project: [],
  plan: ["projectId"],
  task: ["projectId", "planId", "parentId"],
  planItemReference: ["projectId", "planId", "itemId"],
  planLink: ["projectId", "fromPlanId", "toPlanId", "referenceId"],
  dependency: ["projectId", "fromItemId", "toItemId"],
  baseline: ["projectId", "planId", "kind", "track"],
  baselineDefinition: ["projectId", "track"],
  changeRequest: ["projectId", "planId", "status"],
  approval: ["projectId", "changeRequestId", "planId", "status"],
  timeline: ["projectId"],
  workspace: ["projectId", "userId"],
  reportDefinition: ["projectId"],
  user: ["username"],
  party: [],
  oauthClient: [],
  roleAssignment: ["projectId", "userId", "planId"],
  auditLog: ["projectId", "entityId"],
};

export const ENTITY_TYPES = Object.keys(QUERYABLE_FIELDS) as EntityType[];

export interface StorageAdapter {
  get<K extends EntityType>(type: K, id: string): Promise<EntityMap[K] | null>;
  query<K extends EntityType>(type: K, filter?: Filter): Promise<EntityMap[K][]>;
  /**
   * Create (`version === 0`) or update (`version` = stored version) an entity.
   * Returns the stored entity with `version` incremented.
   * Throws ConflictError when the version does not match.
   */
  save<K extends EntityType>(type: K, entity: EntityMap[K]): Promise<EntityMap[K]>;
  /** Throws ConflictError when the version does not match. */
  delete(type: EntityType, id: string, version: number): Promise<void>;
  /**
   * Run `fn` atomically: either all writes are stored, or none.
   * Inside `fn`, use only `tx` — never the outer adapter. SQLite has a single
   * connection, so an outer call inside a transaction waits forever.
   */
  transaction<R>(fn: (tx: StorageAdapter) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export function validateFilter(type: EntityType, filter: Filter): void {
  const allowed = QUERYABLE_FIELDS[type] as readonly string[];
  for (const key of Object.keys(filter)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`Field '${key}' is not queryable on ${type}`);
    }
  }
}

export function matchesFilter(entity: object, filter: Filter): boolean {
  const record = entity as Record<string, unknown>;
  return Object.entries(filter).every(([k, v]) => (record[k] ?? null) === v);
}

/** Deterministic ordering for query results across backends. */
export function sortById<T extends Versioned>(items: T[]): T[] {
  return items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The next version an adapter stores for a save. */
export function nextVersion(entity: Versioned): number {
  return entity.version + 1;
}
