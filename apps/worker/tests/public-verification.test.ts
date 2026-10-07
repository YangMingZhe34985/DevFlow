import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import {
  discoverPublicVerification,
  runPublicVerification,
} from "../src/runs/public-verification.js";
import { extractRepairDiagnostics } from "../src/runs/workflow-context.js";

const result = (exitCode = 0, stdout = "ok") => ({
  exitCode,
  stdout,
  stderr: "",
  durationMs: 10,
  timedOut: false,
  outputTruncated: false,
});
describe("public validation and diagnostic handoff", () => {
  it("discovers only public npm scripts and stops on the E03 compiler regression", async () => {
    const exec = vi.fn(async () =>
      result(
        2,
        "src/composables/useSettingsTabSync.ts(18,7): error TS6133: 'navigationPending' is declared but its value is never read.",
      ),
    );
    const sandbox = {
      exec,
      listFiles: vi.fn(async () => ({ entries: [{ path: "package.json" }] })),
      readFile: vi.fn(async () => ({
        content: JSON.stringify({
          scripts: {
            test: "vitest",
            build: "tsc && vite build",
            typecheck: "tsc",
            lint: "eslint",
            private: "scorer",
          },
        }),
      })),
    } as unknown as SandboxSession;
    const { profile } = await discoverPublicVerification(sandbox, AbortSignal.timeout(10_000));
    const tested = await runPublicVerification({
      sandbox,
      profile,
      timeoutMs: 300_000,
      signal: AbortSignal.timeout(10_000),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(tested.checks.map((c) => c.status)).toEqual(["FAIL", "NOT_RUN", "NOT_RUN", "NOT_RUN"]);
    expect(extractRepairDiagnostics(tested.stdout)[0]).toMatchObject({
      path: "src/composables/useSettingsTabSync.ts",
      line: 18,
    });
  });
  it("shares its deadline and checks the budget before each command", async () => {
    let time = 0;
    const exec = vi.fn(async () => {
      time += 30;
      return result();
    });
    const tested = await runPublicVerification({
      sandbox: { exec } as unknown as SandboxSession,
      profile: {
        version: 1,
        checks: ["build", "test"].map((kind) => ({
          kind: kind as "build" | "test",
          source: "public project configuration",
          command: { program: "python", args: [], cwd: ".", environment: {} },
        })),
      },
      timeoutMs: 40,
      now: () => time,
      signal: AbortSignal.timeout(10_000),
      beforeCommand: (count) => {
        if (count === 1) throw new Error("TOOL_BUDGET_EXCEEDED");
        return 40;
      },
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(tested.exitCode).not.toBe(0);
    expect(tested.checks.at(-1)).toMatchObject({
      status: "NOT_RUN",
      reason: "TOOL_BUDGET_EXCEEDED",
    });
    expect(tested.checks[1]?.status).toBe("NOT_CONFIGURED");
  });
  it("extracts compiler locations and closest Python project frames, rejecting external paths", () => {
    expect(
      extractRepairDiagnostics(
        "tests/cli.py:29: in test_cli\ntests/conftest.py:94: in __call__\nsrc/service.py:140: in resolve\nsrc/registry.py:115: in lookup_execution",
      )[0],
    ).toMatchObject({ path: "src/registry.py", line: 115 });
    expect(
      extractRepairDiagnostics(
        'File "/workspace/src/pyplugin/services/execution_service.py", line 140, in run\nFile "/workspace/src/pyplugin/registry/registry.py", line 115, in lookup_execution\nFile "/usr/lib/python/site-packages/x.py", line 20',
      ),
    ).toEqual([
      expect.objectContaining({ path: "src/pyplugin/registry/registry.py", line: 115 }),
      expect.objectContaining({ path: "src/pyplugin/services/execution_service.py", line: 140 }),
    ]);
    expect(
      extractRepairDiagnostics(
        "[ERROR] src/main/java/App.java:[9,2] error\nsrc/main.cpp:12:3: error: x\nsrc/module.py:24: error: incompatible type",
      )[0]?.path,
    ).toBe("src/main/java/App.java");
    expect(extractRepairDiagnostics("/outside/src/module.py:24: error")).toEqual([]);
  });
});
