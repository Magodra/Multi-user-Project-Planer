import * as oidc from "openid-client";
import type { User } from "@planning/shared";
import { UnauthorizedError } from "../domain/errors.js";
import type { AppConfig } from "../config/config.js";
import type { UserService } from "../services/UserService.js";
import type { AuthProvider } from "./AuthProvider.js";

type SsoConfig = NonNullable<AppConfig["auth"]["sso"]>;

const PENDING_TTL_MS = 10 * 60_000;

/** OpenID Connect authorization code flow with PKCE. Hosted mode only (redirects cannot return to file://). */
export class OidcAuthProvider implements AuthProvider {
  readonly mode = "sso" as const;
  private configuration: Promise<oidc.Configuration> | null = null;
  private readonly pending = new Map<
    string,
    { verifier: string; context: string | null; expiresAt: number }
  >();

  constructor(
    private readonly config: SsoConfig,
    private readonly users: UserService,
  ) {}

  private discover(): Promise<oidc.Configuration> {
    this.configuration ??= oidc.discovery(
      new URL(this.config.issuer),
      this.config.clientId,
      this.config.clientSecret,
    );
    return this.configuration;
  }

  async startRedirect(context?: string): Promise<URL> {
    const configuration = await this.discover();
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k);
    this.pending.set(state, {
      verifier,
      context: context ?? null,
      expiresAt: now + PENDING_TTL_MS,
    });
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.config.redirectUri,
      scope: "openid profile email",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
    });
  }

  async completeRedirect(callbackUrl: URL): Promise<{ user: User; context: string | null }> {
    const state = callbackUrl.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now())
      throw new UnauthorizedError("Login session expired");
    const tokens = await oidc.authorizationCodeGrant(await this.discover(), callbackUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: state,
    });
    const claims = tokens.claims();
    if (!claims) throw new UnauthorizedError("Identity provider returned no ID token");
    const rawGroups = claims[this.config.groupClaim];
    const groups = Array.isArray(rawGroups)
      ? rawGroups.map(String)
      : typeof rawGroups === "string"
        ? [rawGroups]
        : [];
    const username = String(claims.preferred_username ?? claims.email ?? claims.sub);
    const user = await this.users.upsertExternal({
      source: "sso",
      username,
      displayName: String(claims.name ?? username),
      email: String(claims.email ?? ""),
      groups,
    });
    return { user, context: pending.context };
  }
}
