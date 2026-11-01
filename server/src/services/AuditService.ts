import type { AuditLogEntry } from "@planning/shared";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AccessService } from "./AccessService.js";
import { type ServiceContext, newMeta, timeOrderedId } from "./support.js";

export interface AuditRecord {
  projectId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  details?: Record<string, unknown>;
}

/** Writes the immutable AuditLog. Always called inside the transaction of the change. */
export class AuditService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly access: AccessService,
  ) {}

  async record(tx: StorageAdapter, ctx: ServiceContext, record: AuditRecord): Promise<void> {
    const entry: AuditLogEntry = {
      ...newMeta(ctx),
      // Time-ordered: entries written in the same millisecond keep their order.
      id: timeOrderedId(),
      projectId: record.projectId,
      entityType: record.entityType,
      entityId: record.entityId,
      action: record.action,
      origin: ctx.origin,
      details: record.details ?? {},
    };
    await tx.save("auditLog", entry);
  }

  async list(ctx: ServiceContext, projectId: string, entityId?: string): Promise<AuditLogEntry[]> {
    await this.access.require(ctx, projectId, null, "project.read");
    const entries = await this.storage.query(
      "auditLog",
      entityId ? { projectId, entityId } : { projectId },
    );
    const key = (e: AuditLogEntry) => `${e.createdAt}|${e.id}`;
    return entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
}
