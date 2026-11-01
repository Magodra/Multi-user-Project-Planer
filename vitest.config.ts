import { defineConfig } from "vitest/config";

// One Vitest run covers all workspaces. The "source" export condition makes
// `@planning/shared` resolve to its TypeScript sources instead of `dist`.
export default defineConfig({
  resolve: { conditions: ["source", "module", "browser", "development|production"] },
  ssr: { resolve: { conditions: ["source", "module", "node", "development|production"] } },
  test: {
    include: ["{shared,server,client}/src/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
