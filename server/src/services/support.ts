import { randomBytes, randomUUID } from "node:crypto";
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

let lastMs = 0;
let counter = 0;

/**
 * A UUIDv7: time-ordered, with a counter for ids made in the same millisecond,
 * so sorting by id keeps the order of creation within this process.
 */
export function timeOrderedId(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs;
    counter++;
    if (counter > 0xfff) {
      ms = ++lastMs;
      counter = 0;
    }
  } else {
    lastMs = ms;
    counter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter (high bits)
  bytes[7] = counter & 0xff;
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // RFC 9562 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
