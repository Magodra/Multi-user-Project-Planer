import { randomUUID } from "node:crypto";
import { type RequestOrigin, type User, type Versioned, nowIso } from "@planning/shared";
import { NotFoundError } from "../domain/errors.js";
import type { EntityMap, EntityType, StorageAdapter } from "../storage/StorageAdapter.js";

/** Who is calling and from where. Every service call runs as an authenticated user. */
export interface ServiceContext {
  user: User;
  origin: RequestOrigin;
}

/** Metadata for a new entity (version 0 = create). */
export function newMeta(ctx: ServiceContext): Versioned {
  const now = nowIso();
  return {
    id: randomUUID(),
    version: 0,
    createdAt: now,
    createdBy: ctx.user.id,
    updatedAt: now,
    updatedBy: ctx.user.id,
  };
}

/** Copy of an entity with updated audit fields. */
export function touch<T extends Versioned>(
  entity: T,
  ctx: ServiceContext,
  changes: Partial<T> = {},
): T {
  return { ...entity, ...changes, updatedAt: nowIso(), updatedBy: ctx.user.id };
}

export async function mustGet<K extends EntityType>(
  storage: StorageAdapter,
  type: K,
  id: string,
): Promise<EntityMap[K]> {
  const entity = await storage.get(type, id);
  if (!entity) throw new NotFoundError(type, id);
  return entity;
}

/** A fixed system identity for internal work (bootstrap, migrations). */
export const SYSTEM_USER: User = {
  id: "system",
  version: 1,
  createdAt: "1970-01-01T00:00:00.000Z",
  createdBy: "system",
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "system",
  username: "system",
  displayName: "System",
  email: "",
  authSource: "local",
  passwordHash: null,
  isSystemAdmin: true,
  globalRoles: [],
  partyIds: [],
  externalGroups: [],
};

export function systemContext(): ServiceContext {
  return { user: SYSTEM_USER, origin: "SYSTEM" };
}
