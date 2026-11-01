/**
 * Common interface for authentication modes (CLAUDE.md §2 "Configuration").
 * The rest of the server only sees AuthProvider and SessionStore.
 */
import type { User } from "@planning/shared";

export interface AuthProvider {
  readonly mode: "local" | "sso" | "ldap";
  /** Username/password login (local and LDAP). */
  login?(username: string, password: string): Promise<User>;
  /**
   * Start a browser redirect login (SSO). Returns the IdP URL. `context` comes
   * back from `completeRedirect`, e.g. to finish an MCP OAuth authorization.
   */
  startRedirect?(context?: string): Promise<URL>;
  /** Finish a redirect login from the callback URL. */
  completeRedirect?(callbackUrl: URL): Promise<{ user: User; context: string | null }>;
}
