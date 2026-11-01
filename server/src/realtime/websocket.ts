/**
 * Live updates. Browsers cannot set headers on WebSockets, so the client
 * authenticates with its first message ({type:"auth", token}) and then
 * subscribes to a project.
 */
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { RealtimeClientMessage, RealtimeMessage, User } from "@planning/shared";
import type { SessionStore } from "../auth/sessions.js";
import type { Services } from "../services/Services.js";
import { isOriginAllowed } from "../api/middleware.js";

const AUTH_TIMEOUT_MS = 10_000;

interface Client {
  socket: WebSocket;
  user: User | null;
  projects: Set<string>;
}

export function attachWebSocket(
  server: Server,
  deps: {
    services: Services;
    sessions: SessionStore;
    allowedOrigins: string[];
    allowFileClient: boolean;
  },
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const self = `http://${req.headers.host}`;
    const selfTls = `https://${req.headers.host}`;
    if (
      url.pathname !== "/ws" ||
      !isOriginAllowed(
        req.headers.origin,
        [...deps.allowedOrigins, self, selfTls],
        deps.allowFileClient,
      )
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: RealtimeMessage) => ws.send(JSON.stringify(msg));

  wss.on("connection", (ws: WebSocket) => {
    const client: Client = { socket: ws, user: null, projects: new Set() };
    clients.add(client);
    const timer = setTimeout(
      () => !client.user && ws.close(4401, "Authentication timeout"),
      AUTH_TIMEOUT_MS,
    );

    ws.on("message", async (data) => {
      let msg: RealtimeClientMessage;
      try {
        msg = JSON.parse(String(data)) as RealtimeClientMessage;
      } catch {
        return send(ws, { type: "error", message: "Malformed message" });
      }
      if (msg.type === "auth") {
        const userId = deps.sessions.resolve(msg.token);
        client.user = userId ? await deps.services.users.get(userId) : null;
        if (!client.user) return ws.close(4401, "Invalid token");
        clearTimeout(timer);
        return send(ws, { type: "ready" });
      }
      if (msg.type === "subscribe") {
        if (!client.user) return ws.close(4401, "Not authenticated");
        const ctx = { user: client.user, origin: "UI" as const };
        if (await deps.services.access.canDo(ctx, msg.projectId, null, "project.read"))
          client.projects.add(msg.projectId);
        else send(ws, { type: "error", message: "No access to project" });
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      clients.delete(client);
    });
  });

  deps.services.events.subscribe((event) => {
    const msg: RealtimeMessage = { type: "changed", ...event };
    for (const c of clients) {
      if (c.user && c.projects.has(event.projectId) && c.socket.readyState === c.socket.OPEN)
        send(c.socket, msg);
    }
  });

  return wss;
}
