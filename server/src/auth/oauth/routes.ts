/**
 * Our part of the MCP OAuth flow: the decision posted from the sign-in page
 * and the SSO detour. Discovery, registration, /authorize and /token come
 * from the MCP SDK's router (see api/app.ts).
 */
import express, { Router } from "express";
import { UnauthorizedError } from "../../domain/errors.js";
import type { AuthProvider } from "../AuthProvider.js";
import type { PlannerOAuthProvider } from "./PlannerOAuthProvider.js";

/** Context passed through an SSO redirect so the callback can finish an OAuth authorization. */
export const OAUTH_SSO_CONTEXT = "oauth:";

export function oauthRoutes(oauth: PlannerOAuthProvider, provider: AuthProvider): Router {
  const router = Router();
  const field = (body: unknown, name: string) => {
    const value = (body as Record<string, unknown> | undefined)?.[name];
    return typeof value === "string" ? value : "";
  };

  router.post(
    "/oauth/authorize/decision",
    express.urlencoded({ extended: false, limit: "10kb" }),
    async (req, res) => {
      const decision = field(req.body, "decision") === "approve" ? "approve" : "deny";
      await oauth.decide(
        field(req.body, "pending"),
        decision,
        async () => {
          if (!provider.login) throw new UnauthorizedError("Use single sign-on");
          return provider.login(field(req.body, "username"), field(req.body, "password"));
        },
        res,
      );
    },
  );

  if (provider.startRedirect) {
    router.get("/oauth/authorize/sso", async (req, res) => {
      const pending = typeof req.query.pending === "string" ? req.query.pending : "";
      res.redirect((await provider.startRedirect!(`${OAUTH_SSO_CONTEXT}${pending}`)).href);
    });
  }
  return router;
}
