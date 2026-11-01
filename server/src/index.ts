import { createServer } from "node:http";
import { createApp } from "./api/app.js";
import { createAuthProvider } from "./auth/createAuthProvider.js";
import { SessionStore } from "./auth/sessions.js";
import { loadConfig } from "./config/config.js";
import { attachWebSocket } from "./realtime/websocket.js";
import { Services } from "./services/Services.js";
import { createStorage } from "./storage/createStorage.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await createStorage(config);
  const services = new Services(storage, {
    passwordMinLength: config.auth.local.passwordMinLength,
    roleMapping: config.auth.roleMapping,
  });
  const provider = createAuthProvider(config.auth, services.users);
  const sessions = new SessionStore(config.auth.local.sessionTimeoutMinutes);
  const app = createApp({ services, provider, sessions, config });
  const server = createServer(app);
  attachWebSocket(server, {
    services,
    sessions,
    allowedOrigins: config.server.allowedOrigins,
    allowFileClient: config.server.allowFileClient,
  });

  server.listen(config.server.port, () => {
    const backend =
      config.backend === "file" ? `file (${config.file.path})` : `sql (${config.sql.dialect})`;
    console.log(
      `Planning server on http://localhost:${config.server.port} — backend: ${backend}, auth: ${config.auth.mode}`,
    );
    if (config.mcp.enabled)
      console.log(`MCP endpoint: http://localhost:${config.server.port}${config.mcp.path}`);
  });

  const shutdown = () => {
    server.close(() => void storage.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
