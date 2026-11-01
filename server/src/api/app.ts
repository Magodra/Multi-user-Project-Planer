import express, { type Express, type Request } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import type { AuthProvider } from "../auth/AuthProvider.js";
import type { SessionStore } from "../auth/sessions.js";
import type { AppConfig } from "../config/config.js";
import { mcpHandler } from "../mcp/http.js";
import type { Services } from "../services/Services.js";
import { authRoutes } from "./authRoutes.js";
import { authenticate, errorHandler, isOriginAllowed, userFromOAuth } from "./middleware.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { MCP_SCOPE, PlannerOAuthProvider } from "../auth/oauth/PlannerOAuthProvider.js";
import { oauthRoutes } from "../auth/oauth/routes.js";
import { apiRoutes } from "./routes.js";

export interface AppDeps {
  services: Services;
  provider: AuthProvider;
  sessions: SessionStore;
  config: AppConfig;
}

export function createApp({ services, provider, sessions, config }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  if (config.server.trustProxy) app.set("trust proxy", true);

  // MCP OAuth: the SDK router serves discovery metadata, client registration,
  // /authorize, /token and /revoke. Mounted before our CORS and origin checks:
  // these endpoints are meant for any MCP client (they set their own CORS).
  const oauthConfig = config.mcp.oauth;
  const oauth =
    config.mcp.enabled && oauthConfig.enabled && oauthConfig.issuerUrl
      ? new PlannerOAuthProvider({
          storage: services.storage,
          users: services.users,
          sessions,
          resource: new URL(config.mcp.path, oauthConfig.issuerUrl),
          authMode: provider.mode,
          accessTokenMinutes: oauthConfig.accessTokenMinutes,
          refreshTokenDays: oauthConfig.refreshTokenDays,
        })
      : null;
  if (oauth) {
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: new URL(oauthConfig.issuerUrl!),
        resourceServerUrl: oauth.resource,
        scopesSupported: [MCP_SCOPE],
        resourceName: "Project Planner",
      }),
    );
  }
  const allowed = (req: Request) =>
    isOriginAllowed(
      req.headers.origin,
      [...config.server.allowedOrigins, `${req.protocol}://${req.get("host")}`],
      config.server.allowFileClient,
    );
  app.use(
    cors((req, cb) =>
      cb(null, {
        origin: allowed(req as Request),
        allowedHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version"],
        exposedHeaders: ["Content-Disposition", "Mcp-Session-Id"],
        maxAge: 600,
      }),
    ),
  );
  // Reject cross-origin requests from origins that are not allowed (CORS alone only hides responses).
  app.use((req, res, next) => {
    if (!allowed(req)) {
      res.status(403).json({ error: { code: "FORBIDDEN", message: "Origin not allowed" } });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "5mb" }));

  app.get("/api/health", (_req, res) => void res.json({ status: "ok" }));
  app.use(authRoutes(services, provider, sessions, config, oauth));
  if (oauth) app.use(oauthRoutes(oauth, provider));

  const auth = authenticate(services, sessions);
  app.use("/api", auth, apiRoutes(services));

  if (config.mcp.enabled) {
    // With OAuth: 401s carry WWW-Authenticate with the resource metadata URL,
    // so clients can discover how to sign in. Session tokens keep working.
    const mcpAuth = oauth
      ? [
          requireBearerAuth({
            verifier: oauth,
            resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauth.resource),
            expectedResource: oauth.resource,
          }),
          userFromOAuth(services),
        ]
      : [auth];
    app.post(config.mcp.path, ...mcpAuth, mcpHandler(services));
    app.all(config.mcp.path, (_req, res) => {
      res
        .status(405)
        .set("Allow", "POST")
        .json({
          error: { code: "METHOD_NOT_ALLOWED", message: "Use POST (stateless Streamable HTTP)" },
        });
    });
  }

  // Hosted mode: serve the single-file client build.
  if (config.server.clientDir && existsSync(config.server.clientDir)) {
    app.use(express.static(config.server.clientDir, { index: "index.html" }));
  }

  app.use(
    (_req, res) =>
      void res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } }),
  );
  app.use(errorHandler);
  return app;
}
