import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: "@knowy/core/testing", replacement: src("./packages/core/src/testing/index.ts") },
      { find: "@knowy/core", replacement: src("./packages/core/src/index.ts") },
      { find: "@knowy/index-memory", replacement: src("./packages/index-memory/src/index.ts") },
      { find: "@knowy/store-memory", replacement: src("./packages/store-memory/src/index.ts") },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["packages/*/src/**"] },
  },
});
