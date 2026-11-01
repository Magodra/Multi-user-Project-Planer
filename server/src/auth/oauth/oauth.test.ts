/**
 * MCP OAuth over real HTTP: discovery, dynamic client registration, the
 * sign-in page, authorization code + PKCE, MCP calls with the access token,
 * refresh rotation and revocation. Session tokens keep working at /mcp.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoginResult } from "@planning/shared";
import { parseConfig } from "../../config/config.js";
import { createApp } from "../../api/app.js";
import { Services } from "../../services/Services.js";
import { fileBackend } from "../../testing/backends.js";
import type { AuthProvider } from "../AuthProvider.js";
import { createAuthProvider } from "../createAuthProvider.js";
import { SessionStore } from "../sessions.js";

const ISSUER = "http://localhost:8080";
const RESOURCE = `${ISSUER}/mcp`;
const REDIRECT = "https://chat.example.com/connector/oauth/callback";
const PASSWORD = "long-password";

async function start() {
  const { storage, cleanup } = await fileBackend.create();
  const config = parseConfig(
    `{
      "backend": "file",
      "server": { "port": 0 },
      "mcp": { "oauth": { "enabled": true, "issuerUrl": "${ISSUER}" } },
      "auth": { "mode": "local", "local": { "passwordMinLength": 8, "sessionTimeoutMinutes": 5 } }
    }`,
    {},
  );
  const services = new Services(storage, { passwordMinLength: 8, roleMapping: {} });
  await services.users.setupFirstAdmin({
    username: "admin",
    displayName: "Admin",
    email: "",
    password: PASSWORD,
  });
  const sessions = new SessionStore(5);
  const app = createApp({
    services,
    provider: createAuthProvider(config.auth, services.users),
    sessions,
    config,
  });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, stop: async () => (await new Promise((r) => server.close(r)), await cleanup()) };
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
  redirect: "manual" as const,
});

describe("MCP OAuth", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => (ctx = await start()));
  afterEach(async () => ctx.stop());

  const register = async () => {
    const res = await fetch(`${ctx.base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { client_id: string }).client_id;
  };

  /** Open the sign-in page for a fresh authorization request; returns its pending id. */
  const openSignIn = async (clientId: string, challenge: string) => {
    const url = new URL(`${ctx.base}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      resource: RESOURCE,
    }))
      url.searchParams.set(k, v);
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await page.text();
    expect(html).toContain("Allow ChatGPT to use Project Planner?");
    return /name="pending" value="([^"]+)"/.exec(html)![1]!;
  };

  const token = async (fields: Record<string, string>) => {
    const res = await fetch(`${ctx.base}/token`, form(fields));
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };

  /** tools/list over Streamable HTTP (stateless: one JSON-RPC request per POST). */
  const listTools = async (accessToken: string) => {
    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = text.startsWith("{") ? text : /^data: (.*)$/m.exec(text)![1]!;
    const body = JSON.parse(json) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t) => t.name);
  };

  it("advertises discovery metadata and challenges unauthenticated MCP calls", async () => {
    const as = (await (
      await fetch(`${ctx.base}/.well-known/oauth-authorization-server`)
    ).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: `${ISSUER}/`,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      code_challenge_methods_supported: ["S256"],
    });
    const rs = (await (
      await fetch(`${ctx.base}/.well-known/oauth-protected-resource/mcp`)
    ).json()) as Record<string, unknown>;
    expect(rs).toMatchObject({ resource: RESOURCE, authorization_servers: [`${ISSUER}/`] });

    const res = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      `resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("signs in, issues tokens bound to the MCP endpoint, refreshes and revokes", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const pending = await openSignIn(clientId, challenge);

    const wrong = await fetch(
      `${ctx.base}/oauth/authorize/decision`,
      form({ pending, decision: "approve", username: "admin", password: "nope-nope" }),
    );
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong username or password");

    const ok = await fetch(
      `${ctx.base}/oauth/authorize/decision`,
      form({ pending, decision: "approve", username: "admin", password: PASSWORD }),
    );
    expect(ok.status).toBe(302);
    const callback = new URL(ok.headers.get("location")!);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT);
    expect(callback.searchParams.get("state")).toBe("state-123");
    const code = callback.searchParams.get("code")!;

    // PKCE is checked: a wrong verifier fails.
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: pkce().verifier,
          redirect_uri: REDIRECT,
        })
      ).status,
    ).toBe(400);
    const issued = await token({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ token_type: "Bearer", scope: "planning" });
    // A code is used once.
    expect(
      (
        await token({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
        })
      ).body.error,
    ).toBe("invalid_grant");

    expect(await listTools(issued.body.access_token!)).toContain("list_projects");

    // Refresh tokens rotate.
    const refreshed = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: issued.body.refresh_token!,
    });
    expect(refreshed.status).toBe(200);
    expect(
      (
        await token({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: issued.body.refresh_token!,
        })
      ).body.error,
    ).toBe("invalid_grant");

    // Revoked access tokens stop working.
    const revoke = await fetch(
      `${ctx.base}/revoke`,
      form({ client_id: clientId, token: refreshed.body.access_token! }),
    );
    expect(revoke.status).toBe(200);
    const after = await fetch(`${ctx.base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${refreshed.body.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(401);
  });

  it("returns access_denied when the user denies, and refuses other resources", async () => {
    const clientId = await register();
    const pending = await openSignIn(clientId, pkce().challenge);
    const denied = await fetch(
      `${ctx.base}/oauth/authorize/decision`,
      form({ pending, decision: "deny" }),
    );
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("state-123");

    const url = new URL(`${ctx.base}/authorize`);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: "https://elsewhere.example.com/mcp",
    }))
      url.searchParams.set(k, v);
    const other = await fetch(url, { redirect: "manual" });
    expect(new URL(other.headers.get("location")!).searchParams.get("error")).toBe(
      "invalid_target",
    );
  });

  it("still accepts session tokens from /api/auth/login at the MCP endpoint", async () => {
    const login = (await (
      await fetch(`${ctx.base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: PASSWORD }),
      })
    ).json()) as LoginResult;
    expect(await listTools(login.token)).toContain("list_projects");
  });
});

describe("MCP OAuth with single sign-on", () => {
  it("sends the user through the identity provider and back to the MCP client", async () => {
    const { storage, cleanup } = await fileBackend.create();
    const config = parseConfig(
      `{
        "backend": "file",
        "mcp": { "oauth": { "enabled": true, "issuerUrl": "${ISSUER}" } },
        "auth": {
          "mode": "sso",
          "sso": {
            "protocol": "oidc", "issuer": "https://idp.example.com", "clientId": "planning",
            "clientSecret": "secret", "redirectUri": "${ISSUER}/auth/callback"
          }
        }
      }`,
      {},
    );
    const services = new Services(storage, { passwordMinLength: 8, roleMapping: {} });
    const user = await services.users.upsertExternal({
      source: "sso",
      username: "sso-user",
      displayName: "SSO User",
      email: "",
      groups: [],
    });
    // A stand-in identity provider: the context travels in the callback URL.
    const provider: AuthProvider = {
      mode: "sso",
      startRedirect: async (context) =>
        new URL(`https://idp.example.com/authorize?ctx=${encodeURIComponent(context ?? "")}`),
      completeRedirect: async (callbackUrl) => ({
        user,
        context: callbackUrl.searchParams.get("ctx"),
      }),
    };
    const app = createApp({ services, provider, sessions: new SessionStore(5), config });
    const server: Server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const registration = (await (
        await fetch(`${base}/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
        })
      ).json()) as { client_id: string };
      const { verifier, challenge } = pkce();
      const url = new URL(`${base}/authorize`);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: registration.client_id,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }))
        url.searchParams.set(k, v);
      const html = await (await fetch(url)).text();
      const ssoLink = /href="(\/oauth\/authorize\/sso\?pending=[^"]+)"/.exec(html)![1]!;

      const toIdp = await fetch(`${base}${ssoLink}`, { redirect: "manual" });
      const ctx = new URL(toIdp.headers.get("location")!).searchParams.get("ctx")!;
      expect(ctx).toMatch(/^oauth:/);
      const back = await fetch(`${base}/auth/callback?ctx=${encodeURIComponent(ctx)}`, {
        redirect: "manual",
      });
      const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
      const tokens = await fetch(
        `${base}/token`,
        form({
          grant_type: "authorization_code",
          client_id: registration.client_id,
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT,
        }),
      );
      expect(tokens.status).toBe(200);
    } finally {
      await new Promise((r) => server.close(r));
      await cleanup();
    }
  });
});
