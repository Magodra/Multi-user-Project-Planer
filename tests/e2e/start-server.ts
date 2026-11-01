/**
 * Started by Playwright's webServer: builds the client, prepares a copy of it
 * for file:// with client-config.js pointing at the server, clears test data
 * and starts the server.
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const tmp = path.join(here, ".tmp");

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
execSync("npm run build -w @planning/client", { cwd: root, stdio: "inherit" });

const fileClient = path.join(tmp, "file-client");
cpSync(path.join(root, "client/dist"), fileClient, { recursive: true });
writeFileSync(
  path.join(fileClient, "client-config.js"),
  'window.PLANNING_CLIENT_CONFIG = { apiUrl: "http://localhost:8181" };\n',
);

process.env.PLANNING_CONFIG = path.join(here, "config.e2e.json");
await import("../../server/src/index.js");
