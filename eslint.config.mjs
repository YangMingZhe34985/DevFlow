import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/.next-*/**",
      "**/coverage/**",
      "**/node_modules/**",
      "packages/database/src/generated/**",
      // Versioned P11 fixture programs are intentionally tiny external inputs,
      // not production source governed by this repository's lint globals.
      "tests/fixtures/benchmarks/**",
      ".devflow/**",
      ".codex/**",
      ".claude/**",
      "docs/performance/**",
      "benchmarks/real-issues/**",
      "datasets/**",
      "tests/fixtures/planner-*/**",
      "scripts/{execute-recovery-v*,oracle-coverage-v*,plan-factorial-v*,plan-agent,phase171,phase172,real-issues}/**",
      "scripts/{real-dataset-*,score-real-dataset,stage-*,staged-planner-*,summarize-*,localization-graph-fix-replay,review-length-recovery-live,build-historical-benchmark}.mjs",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
