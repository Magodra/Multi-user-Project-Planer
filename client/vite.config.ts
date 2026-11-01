import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const server = process.env.PLANNING_SERVER_URL ?? "http://localhost:8080";

// One index.html with all JS/CSS inlined, so the same build works hosted and
// from file:// (CLAUDE.md §2 "Client deployment modes"). No code splitting.
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  resolve: { conditions: ["source", ...defaultClientConditions] },
  build: {
    target: "es2022",
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 10_000,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": server,
      "/mcp": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
});
