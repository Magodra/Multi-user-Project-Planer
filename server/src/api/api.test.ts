/** REST API over real HTTP: auth flow, CORS for file:// clients, error mapping, MCP endpoint auth. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import type { LoginResult, Project } from "@planning/shared";
import { parseConfig } from "../config/config.js";
import { createAuthProvider } from "../auth/createAuthProvider.js";
import { SessionStore } from "../auth/sessions.js";
import { Services } from "../services/Services.js";
import { fileBackend } from "../testing/backends.js";
import { createApp } from "./app.js";

const configText = (allowFileClient: boolean) => `{
  // comments are allowed
  "backend": "file",
  "server": { "port": 0, "allowedOrigins": ["https://planning.example.com"], "allowFileClient": ${allowFileClient} },
  "auth": { "mode": "local", "local": { "passwordMinLength": 8, "sessionTimeoutMinutes": 5 } }
}`;

async function start(allowFileClient: boolean) {
  const { storage, cleanup } = await fileBackend.create();
  const config = parseConfig(configText(allowFileClient), {});
  const services = new Services(storage, { passwordMinLength: 8, roleMapping: {} });
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

describe("REST API", () => {
  let ctx: Awaited<ReturnType<typeof start>>;
  afterEach(async () => ctx.stop());

  const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  describe("with file clients disallowed", () => {
    beforeEach(async () => (ctx = await start(false)));

    it("runs setup, login, and authenticated calls with a bearer token", async () => {
      expect(await (await fetch(`${ctx.base}/api/auth/info`)).json()).toEqual({
        mode: "local",
        setupRequired: true,
      });
      const setup = await fetch(
        `${ctx.base}/api/auth/setup`,
        json("POST", {
          username: "admin",
          displayName: "Admin",
          email: "",
          password: "long-password",
        }),
      );
      expect(setup.status).toBe(201);
      expect(
        (
          await fetch(
            `${ctx.base}/api/auth/setup`,
            json("POST", { username: "x", displayName: "x", email: "", password: "long-password" }),
          )
        ).status,
      ).toBe(403);

      expect((await fetch(`${ctx.base}/api/projects`)).status).toBe(401);
      const badLogin = await fetch(
        `${ctx.base}/api/auth/login`,
        json("POST", { username: "admin", password: "wrong-password" }),
      );
      expect(badLogin.status).toBe(401);
      const login = (await (
        await fetch(
          `${ctx.base}/api/auth/login`,
          json("POST", { username: "admin", password: "long-password" }),
        )
      ).json()) as LoginResult;
      expect(login.user).not.toHaveProperty("passwordHash");
      const auth = { Authorization: `Bearer ${login.token}` };

      const created = await fetch(`${ctx.base}/api/projects`, json("POST", { name: "P" }, auth));
      expect(created.status).toBe(201);
      const project = (await created.json()) as Project;
      expect(
        (
          (await (await fetch(`${ctx.base}/api/projects`, { headers: auth })).json()) as Project[]
        ).map((p) => p.id),
      ).toEqual([project.id]);

      const invalid = await fetch(`${ctx.base}/api/projects`, json("POST", { name: "" }, auth));
      expect(invalid.status).toBe(400);
      expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
      expect((await fetch(`${ctx.base}/api/plans/unknown-id/view`, { headers: auth })).status).toBe(
        404,
      );

      await fetch(`${ctx.base}/api/auth/logout`, json("POST", undefined, auth));
      expect((await fetch(`${ctx.base}/api/projects`, { headers: auth })).status).toBe(401);
    });

    it("rejects file:// (Origin: null) and unknown origins, allows configured ones", async () => {
      expect(
        (await fetch(`${ctx.base}/api/auth/info`, { headers: { Origin: "null" } })).status,
      ).toBe(403);
      expect(
        (await fetch(`${ctx.base}/api/auth/info`, { headers: { Origin: "https://evil.example" } }))
          .status,
      ).toBe(403);
      const ok = await fetch(`${ctx.base}/api/auth/info`, {
        headers: { Origin: "https://planning.example.com" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("access-control-allow-origin")).toBe("https://planning.example.com");
    });

    it("requires authentication on the MCP endpoint", async () => {
      expect(
        (
          await fetch(
            `${ctx.base}/mcp`,
            json("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
          )
        ).status,
      ).toBe(401);
      expect((await fetch(`${ctx.base}/mcp`)).status).toBe(405);
    });
  });

  describe("with file clients allowed", () => {
    beforeEach(async () => (ctx = await start(true)));

    it("accepts Origin: null and answers preflight requests", async () => {
      const res = await fetch(`${ctx.base}/api/auth/info`, { headers: { Origin: "null" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("null");
      const preflight = await fetch(`${ctx.base}/api/projects`, {
        method: "OPTIONS",
        headers: {
          Origin: "null",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
        "authorization",
      );
    });
  });
});
