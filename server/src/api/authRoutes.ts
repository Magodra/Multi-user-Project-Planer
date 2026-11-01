import { Router } from "express";
import type { AuthInfo, LoginResult, User } from "@planning/shared";
import { loginInput, setupInput } from "@planning/shared";
import { ForbiddenError, UnauthorizedError, ValidationError } from "../domain/errors.js";
import type { AuthProvider } from "../auth/AuthProvider.js";
import type { SessionStore } from "../auth/sessions.js";
import type { AppConfig } from "../config/config.js";
import type { Services } from "../services/Services.js";
import { toPublicUser } from "../services/UserService.js";
import type { PlannerOAuthProvider } from "../auth/oauth/PlannerOAuthProvider.js";
import { OAUTH_SSO_CONTEXT } from "../auth/oauth/routes.js";
import { authenticate, ctxOf } from "./middleware.js";

export function authRoutes(
  services: Services,
  provider: AuthProvider,
  sessions: SessionStore,
  config: AppConfig,
  oauth: PlannerOAuthProvider | null = null,
): Router {
  const router = Router();
  const auth = authenticate(services, sessions);

  const issue = (user: User): LoginResult => ({
    ...sessions.create(user.id),
    user: toPublicUser(user),
  });

  router.get("/api/auth/info", async (_req, res) => {
    const info: AuthInfo = {
      mode: provider.mode,
      setupRequired: provider.mode === "local" && !(await services.users.hasUsers()),
    };
    res.json(info);
  });

  /** Create the first administrator (local mode, only while no users exist). */
  router.post("/api/auth/setup", async (req, res) => {
    if (provider.mode !== "local")
      throw new ForbiddenError("Setup is only available in local mode");
    const user = await services.users.setupFirstAdmin(setupInput.parse(req.body));
    res.status(201).json(issue(user));
  });

  router.post("/api/auth/login", async (req, res) => {
    if (!provider.login)
      throw new ForbiddenError(`Password login is not available in ${provider.mode} mode`);
    const { username, password } = loginInput.parse(req.body);
    res.json(issue(await provider.login(username, password)));
  });

  router.post("/api/auth/logout", auth, (req, res) => {
    sessions.revoke(req.token!);
    res.status(204).end();
  });

  router.get("/api/auth/me", auth, (req, res) => {
    res.json(toPublicUser(ctxOf(req).user));
  });

  if (provider.startRedirect && provider.completeRedirect && config.auth.sso) {
    const sso = config.auth.sso;
    router.get("/api/auth/sso/start", async (_req, res) => {
      res.redirect((await provider.startRedirect!()).href);
    });
    // The callback path comes from the configured redirect URI.
    router.get(new URL(sso.redirectUri).pathname, async (req, res) => {
      const callbackUrl = new URL(req.originalUrl, sso.redirectUri);
      const { user, context } = await provider.completeRedirect!(callbackUrl);
      // SSO sign-in for an MCP OAuth authorization: back to the MCP client.
      if (oauth && context?.startsWith(OAUTH_SSO_CONTEXT)) {
        const target = oauth.completeSso(context.slice(OAUTH_SSO_CONTEXT.length), user);
        if (!target) throw new ValidationError("This sign-in request has expired. Start again.");
        res.redirect(target);
        return;
      }
      const { token } = sessions.create(user.id);
      const code = sessions.issueCode(token);
      const target = new URL(sso.postLoginRedirect ?? new URL("/", sso.redirectUri).href);
      target.hash = `/auth/complete?code=${encodeURIComponent(code)}`;
      res.redirect(target.href);
    });
  }

  /** Exchange the one-time SSO code for a bearer token. */
  router.post("/api/auth/sso/exchange", async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "";
    if (!code) throw new ValidationError("code is required");
    const token = sessions.redeemCode(code);
    const userId = token ? sessions.resolve(token) : null;
    const user = userId ? await services.users.get(userId) : null;
    if (!token || !user) throw new UnauthorizedError("Login code is invalid or expired");
    const result: LoginResult = { token, expiresAt: "", user: toPublicUser(user) };
    res.json(result);
  });

  return router;
}
