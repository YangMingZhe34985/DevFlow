import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@devflow/agent": fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
      "@devflow/database": fileURLToPath(
        new URL("./packages/database/src/index.ts", import.meta.url),
      ),
      "@devflow/eval": fileURLToPath(new URL("./packages/eval/src/index.ts", import.meta.url)),
      "@devflow/git": fileURLToPath(new URL("./packages/git/src/index.ts", import.meta.url)),
      "@devflow/github": fileURLToPath(new URL("./packages/github/src/index.ts", import.meta.url)),
      "@devflow/sandbox": fileURLToPath(
        new URL("./packages/sandbox/src/index.ts", import.meta.url),
      ),
      "@devflow/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@devflow/tools": fileURLToPath(new URL("./packages/tools/src/index.ts", import.meta.url)),
      "@devflow/workflow": fileURLToPath(
        new URL("./packages/workflow/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/tests/**/*.test.ts", "apps/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/src/index.ts", "packages/database/src/generated/**"],
    },
  },
});
