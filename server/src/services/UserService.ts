import type {
  CreatePartyInput,
  CreateUserInput,
  Party,
  PublicUser,
  Role,
  SetupInput,
  User,
} from "@planning/shared";
import { ConflictError, ForbiddenError, ValidationError } from "../domain/errors.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import type { AuditService } from "./AuditService.js";
import { hashPassword } from "../auth/passwords.js";
import { type ServiceContext, newMeta, systemContext, touch } from "./support.js";

export interface ExternalIdentity {
  source: "sso" | "ldap";
  username: string;
  displayName: string;
  email: string;
  groups: string[];
}

export function toPublicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export class UserService {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly audit: AuditService,
    private readonly options: { passwordMinLength: number; roleMapping: Record<string, Role> },
  ) {}

  async findByUsername(username: string): Promise<User | null> {
    const [user] = await this.storage.query("user", { username: username.toLowerCase() });
    return user ?? null;
  }

  async get(id: string): Promise<User | null> {
    return this.storage.get("user", id);
  }

  async hasUsers(): Promise<boolean> {
    return (await this.storage.query("user")).length > 0;
  }

  /** Create the first administrator. Only possible while no users exist. */
  async setupFirstAdmin(input: SetupInput): Promise<User> {
    if (await this.hasUsers()) throw new ForbiddenError("Setup has already been completed");
    return this.createLocal(systemContext(), { ...input, isSystemAdmin: true, partyIds: [] });
  }

  async createUser(ctx: ServiceContext, input: CreateUserInput): Promise<User> {
    if (!ctx.user.isSystemAdmin)
      throw new ForbiddenError("Only system administrators can create users");
    return this.createLocal(ctx, input);
  }

  async list(ctx: ServiceContext): Promise<PublicUser[]> {
    void ctx; // every authenticated user may look up others (for role assignment and approvals)
    return (await this.storage.query("user")).map(toPublicUser);
  }

  /** Create or update a user from SSO/LDAP on login; roles follow `auth.roleMapping`. */
  async upsertExternal(identity: ExternalIdentity): Promise<User> {
    const ctx = systemContext();
    const globalRoles = [
      ...new Set(
        identity.groups.flatMap((g) =>
          this.options.roleMapping[g] ? [this.options.roleMapping[g]] : [],
        ),
      ),
    ].sort();
    const existing = await this.findByUsername(identity.username);
    return this.storage.transaction(async (tx) => {
      if (existing) {
        const updated = touch(existing, ctx, {
          displayName: identity.displayName || existing.displayName,
          email: identity.email || existing.email,
          externalGroups: identity.groups,
          globalRoles,
        });
        return tx.save("user", updated);
      }
      const user: User = {
        ...newMeta(ctx),
        username: identity.username.toLowerCase(),
        displayName: identity.displayName || identity.username,
        email: identity.email,
        authSource: identity.source,
        passwordHash: null,
        isSystemAdmin: false,
        globalRoles,
        partyIds: [],
        externalGroups: identity.groups,
      };
      const saved = await tx.save("user", user);
      await this.audit.record(tx, ctx, {
        projectId: null,
        entityType: "user",
        entityId: user.id,
        action: "create",
        details: { source: identity.source },
      });
      return saved;
    });
  }

  async createParty(ctx: ServiceContext, input: CreatePartyInput): Promise<Party> {
    if (!ctx.user.isSystemAdmin)
      throw new ForbiddenError("Only system administrators can create parties");
    const party: Party = { ...newMeta(ctx), ...input };
    return this.storage.transaction(async (tx) => {
      const saved = await tx.save("party", party);
      await this.audit.record(tx, ctx, {
        projectId: null,
        entityType: "party",
        entityId: party.id,
        action: "create",
      });
      return saved;
    });
  }

  async listParties(): Promise<Party[]> {
    return this.storage.query("party");
  }

  async setUserParties(
    ctx: ServiceContext,
    userId: string,
    partyIds: string[],
  ): Promise<PublicUser> {
    if (!ctx.user.isSystemAdmin)
      throw new ForbiddenError("Only system administrators can change parties");
    return this.storage.transaction(async (tx) => {
      const user = await tx.get("user", userId);
      if (!user) throw new ValidationError(`Unknown user ${userId}`);
      const saved = await tx.save("user", touch(user, ctx, { partyIds }));
      await this.audit.record(tx, ctx, {
        projectId: null,
        entityType: "user",
        entityId: userId,
        action: "setParties",
        details: { partyIds },
      });
      return toPublicUser(saved);
    });
  }

  private async createLocal(ctx: ServiceContext, input: CreateUserInput): Promise<User> {
    if (input.password.length < this.options.passwordMinLength) {
      throw new ValidationError(
        `Password must be at least ${this.options.passwordMinLength} characters`,
      );
    }
    const username = input.username.toLowerCase();
    if (await this.findByUsername(username))
      throw new ConflictError(`User '${username}' already exists`);
    const user: User = {
      ...newMeta(ctx),
      username,
      displayName: input.displayName,
      email: input.email,
      authSource: "local",
      passwordHash: await hashPassword(input.password),
      isSystemAdmin: input.isSystemAdmin,
      globalRoles: [],
      partyIds: input.partyIds,
      externalGroups: [],
    };
    return this.storage.transaction(async (tx) => {
      const saved = await tx.save("user", user);
      await this.audit.record(tx, ctx, {
        projectId: null,
        entityType: "user",
        entityId: user.id,
        action: "create",
        details: { username },
      });
      return saved;
    });
  }
}
