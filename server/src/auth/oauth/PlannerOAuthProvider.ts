/**
 * OAuth 2.1 authorization server for MCP clients (e.g. the ChatGPT app),
 * plugged into the MCP SDK's router, which handles discovery metadata,
 * dynamic client registration, PKCE checks and the token endpoint.
 *
 * - Users sign in on our own page with the configured auth mode (local/LDAP
 *   password, or SSO through the identity provider) and approve the client.
 * - Access tokens are bound to the MCP endpoint (RFC 8707 `resource`), are
 *   short-lived and come with rotating refresh tokens.
 * - Codes and tokens live in memory, like UI sessions (a restart means the
 *   client signs in again); registered clients are stored, so a restart does
 *   not break a connected client's registration.
 * - Ordinary session tokens from /api/auth/login are accepted at the MCP
 *   endpoint too, for API clients that send a fixed bearer token.
 */
import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { User } from "@planning/shared";
import { nowIso } from "@planning/shared";
import type { StorageAdapter } from "../../storage/StorageAdapter.js";
import type { UserService } from "../../services/UserService.js";
import type { SessionStore } from "../sessions.js";
import { renderAuthorizePage } from "./authorizePage.js";

/** The one scope: act as the signed-in user through MCP. */
export const MCP_SCOPE = "planning";

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

interface Grant {
  clientId: string;
  userId: string;
  scopes: string[];
  expiresAt: number;
}

export interface OAuthProviderOptions {
  storage: StorageAdapter;
  users: UserService;
  sessions: SessionStore;
  /** The MCP endpoint's URL: the audience of every access token. */
  resource: URL;
  authMode: "local" | "sso" | "ldap";
  accessTokenMinutes: number;
  refreshTokenDays: number;
}

const token = () => randomBytes(32).toString("base64url");

export class PlannerOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  private readonly accessTokens = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, Grant>();

  constructor(private readonly options: OAuthProviderOptions) {}

  get resource(): URL {
    return this.options.resource;
  }

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: async (clientId) => {
      const stored = await this.options.storage.get("oauthClient", clientId);
      return stored ? (stored.registration as unknown as OAuthClientInformationFull) : undefined;
    },
    registerClient: async (client) => {
      const info = client as OAuthClientInformationFull;
      const now = nowIso();
      await this.options.storage.save("oauthClient", {
        id: info.client_id,
        version: 0,
        createdAt: now,
        createdBy: "oauth-registration",
        updatedAt: now,
        updatedBy: "oauth-registration",
        registration: info as unknown as Record<string, unknown>,
      });
      return info;
    },
  };

  /** Show the sign-in and consent page; the decision arrives at `decide` or `completeSso`. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    if (params.resource && !this.isOurResource(params.resource))
      throw new InvalidTargetError("Tokens can only be issued for this server's MCP endpoint");
    this.prune();
    const pendingId = token();
    this.pending.set(pendingId, { client, params, expiresAt: Date.now() + PENDING_TTL_MS });
    this.sendPage(res, pendingId, null);
  }

  /** Approve (after a successful password sign-in) or deny a pending authorization. */
  async decide(
    pendingId: string,
    decision: "approve" | "deny",
    signIn: () => Promise<User>,
    res: Response,
  ): Promise<void> {
    const pending = this.getPending(pendingId);
    if (!pending) {
      res.status(400).type("text/plain").send("This sign-in request has expired. Start again.");
      return;
    }
    if (decision === "deny") {
      this.pending.delete(pendingId);
      res.redirect(302, this.redirectWith(pending, { error: "access_denied" }));
      return;
    }
    let user: User;
    try {
      user = await signIn();
    } catch {
      this.sendPage(res, pendingId, "Wrong username or password.");
      return;
    }
    res.redirect(302, this.approve(pendingId, pending, user));
  }

  /** Finish a pending authorization after an SSO sign-in; returns where to send the browser. */
  completeSso(pendingId: string, user: User): string | null {
    const pending = this.getPending(pendingId);
    return pending ? this.approve(pendingId, pending, user) : null;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now())
      throw new InvalidGrantError("Invalid or expired authorization code");
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode); // single use
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now())
      throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== code.redirectUri)
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource && !this.isOurResource(resource))
      throw new InvalidTargetError("Tokens can only be issued for this server's MCP endpoint");
    return this.issueTokens(code.clientId, code.userId, code.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = this.refreshTokens.get(refreshToken);
    this.refreshTokens.delete(refreshToken); // rotation: each refresh token is used once
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt < Date.now())
      throw new InvalidGrantError("Invalid or expired refresh token");
    if (resource && !this.isOurResource(resource))
      throw new InvalidTargetError("Tokens can only be issued for this server's MCP endpoint");
    const narrowed = scopes?.length ? scopes.filter((s) => grant.scopes.includes(s)) : grant.scopes;
    return this.issueTokens(grant.clientId, grant.userId, narrowed);
  }

  /** OAuth access tokens, or session tokens from /api/auth/login. */
  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const grant = this.accessTokens.get(accessToken);
    if (grant && grant.expiresAt >= Date.now())
      return {
        token: accessToken,
        clientId: grant.clientId,
        scopes: grant.scopes,
        expiresAt: Math.floor(grant.expiresAt / 1000),
        resource: this.options.resource,
        extra: { userId: grant.userId },
      };
    if (grant) this.accessTokens.delete(accessToken);
    const session = this.options.sessions.resolveSession(accessToken);
    if (session)
      return {
        token: accessToken,
        clientId: "planner-session",
        scopes: [MCP_SCOPE],
        expiresAt: Math.floor(session.expiresAt / 1000),
        resource: this.options.resource,
        extra: { userId: session.userId },
      };
    throw new InvalidTokenError("Invalid or expired token");
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    for (const store of [this.accessTokens, this.refreshTokens]) {
      if (store.get(request.token)?.clientId === client.client_id) store.delete(request.token);
    }
  }

  // --- helpers ---------------------------------------------------------------

  private approve(pendingId: string, pending: PendingAuthorization, user: User): string {
    this.pending.delete(pendingId);
    const code = token();
    this.codes.set(code, {
      clientId: pending.client.client_id,
      userId: user.id,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      scopes: [MCP_SCOPE],
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    return this.redirectWith(pending, { code });
  }

  private async issueTokens(clientId: string, userId: string, scopes: string[]) {
    if (!(await this.options.users.get(userId)))
      throw new InvalidGrantError("The user no longer exists");
    this.prune();
    const accessToken = token();
    const refreshToken = token();
    const expiresIn = this.options.accessTokenMinutes * 60;
    this.accessTokens.set(accessToken, {
      clientId,
      userId,
      scopes,
      expiresAt: Date.now() + expiresIn * 1000,
    });
    this.refreshTokens.set(refreshToken, {
      clientId,
      userId,
      scopes,
      expiresAt: Date.now() + this.options.refreshTokenDays * 86_400_000,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private getPending(pendingId: string): PendingAuthorization | null {
    const pending = this.pending.get(pendingId);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(pendingId);
      return null;
    }
    return pending;
  }

  private redirectWith(pending: PendingAuthorization, params: Record<string, string>): string {
    const target = new URL(pending.params.redirectUri);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    if (pending.params.state) target.searchParams.set("state", pending.params.state);
    return target.href;
  }

  private sendPage(res: Response, pendingId: string, error: string | null): void {
    const pending = this.pending.get(pendingId)!;
    res
      .status(error ? 401 : 200)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // No framing (clickjacking) and nothing but our inline styles.
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      })
      .send(
        renderAuthorizePage({
          pendingId,
          clientName: pending.client.client_name ?? "An MCP client",
          redirectHost: new URL(pending.params.redirectUri).host,
          authMode: this.options.authMode,
          error,
        }),
      );
  }

  private isOurResource(resource: URL): boolean {
    const strip = (u: URL) => u.href.replace(/#.*$/, "").replace(/\/$/, "");
    return strip(resource) === strip(this.options.resource);
  }

  private prune(): void {
    const now = Date.now();
    for (const map of [this.pending, this.codes, this.accessTokens, this.refreshTokens])
      for (const [k, v] of map) if (v.expiresAt < now) map.delete(k);
  }
}
