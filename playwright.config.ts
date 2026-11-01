import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const fileClientUrl = pathToFileURL(path.resolve("tests/e2e/.tmp/file-client/index.html")).href;

// The same build runs in both modes (CLAUDE.md §2 "Client deployment modes").
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { trace: "retain-on-failure" },
  webServer: {
    command: "npx tsx --conditions=source tests/e2e/start-server.ts",
    url: "http://localhost:8181/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
  },
  projects: [
    {
      name: "hosted",
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:8181/index.html" },
    },
    { name: "file", use: { ...devices["Desktop Chrome"], baseURL: fileClientUrl } },
  ],
});
