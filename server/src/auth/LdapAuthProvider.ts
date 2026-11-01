import { Client } from "ldapts";
import type { User } from "@planning/shared";
import { UnauthorizedError } from "../domain/errors.js";
import type { AppConfig } from "../config/config.js";
import type { UserService } from "../services/UserService.js";
import type { AuthProvider } from "./AuthProvider.js";

type LdapConfig = NonNullable<AppConfig["auth"]["ldap"]>;

/** Escape a value for use inside an LDAP filter (RFC 4515). */
export function escapeLdapFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function first(value: unknown): string {
  if (Array.isArray(value)) return first(value[0]);
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

/** Bind with a service account, find the user, verify by binding as the user, then read groups. */
export class LdapAuthProvider implements AuthProvider {
  readonly mode = "ldap" as const;

  constructor(
    private readonly config: LdapConfig,
    private readonly users: UserService,
  ) {}

  async login(username: string, password: string): Promise<User> {
    if (!password) throw new UnauthorizedError("Invalid username or password");
    const service = new Client({ url: this.config.url });
    let dn: string;
    let displayName: string;
    let email: string;
    let groups: string[];
    try {
      await service.bind(this.config.bindDn, this.config.bindPassword);
      const filter = this.config.userFilter.replace(
        /\{username\}/g,
        escapeLdapFilterValue(username),
      );
      const { searchEntries } = await service.search(this.config.userSearchBase, {
        scope: "sub",
        filter,
        attributes: ["dn", "cn", "displayName", "mail"],
      });
      const entry = searchEntries[0];
      if (!entry || searchEntries.length > 1)
        throw new UnauthorizedError("Invalid username or password");
      dn = entry.dn;
      displayName = first(entry.displayName) || first(entry.cn) || username;
      email = first(entry.mail);
      const groupFilter = this.config.groupFilter.replace(/\{dn\}/g, escapeLdapFilterValue(dn));
      const groupResult = await service.search(this.config.groupSearchBase, {
        scope: "sub",
        filter: groupFilter,
        attributes: ["cn"],
      });
      groups = groupResult.searchEntries.map((g) => first(g.cn)).filter(Boolean);
    } finally {
      await service.unbind().catch(() => undefined);
    }

    const userClient = new Client({ url: this.config.url });
    try {
      await userClient.bind(dn, password);
    } catch {
      throw new UnauthorizedError("Invalid username or password");
    } finally {
      await userClient.unbind().catch(() => undefined);
    }
    return this.users.upsertExternal({ source: "ldap", username, displayName, email, groups });
  }
}
