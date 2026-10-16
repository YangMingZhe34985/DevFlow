import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import {
  discoverPublicVerification,
  runPublicVerification,
} from "../src/runs/public-verification.js";

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
});
