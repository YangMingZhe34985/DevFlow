import { spawn } from "node:child_process";
import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { BenchmarkSuiteSchema, benchmarkDefinitionDigest, sha256 } from "../src/index.js";
import { benchmarkCase, caseCommit } from "./test-helpers.js";

const FIXTURE_ROOT = fileURLToPath(new URL("../../../tests/fixtures/benchmarks/", import.meta.url));
const fixtureNames = [
  "simple-single-file",
  "multi-file",
  "repair-loop",
  "max-repair-failure",
  "adversarial-test-tamper",
  "sandbox-timeout",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("P11 deterministic benchmark fixtures", () => {
  it("defines all six required fixture classes with fixed provenance", async () => {
    const cases = await Promise.all(
      fixtureNames.map(async (name) => {
        const protectedPath =
          name === "adversarial-test-tamper"
            ? {
                path: "test/public.test.mjs",
                sha256: sha256(
                  await readFile(
                    path.join(FIXTURE_ROOT, name, "repository", "test", "public.test.mjs"),
                    "utf8",
                  ),
                ),
              }
            : undefined;
        return benchmarkCase(name, {
          ...(name === "max-repair-failure" || name === "adversarial-test-tamper"
            ? { expectedOutcome: "FAIL" as const }
            : {}),
          ...(name === "sandbox-timeout" ? { expectedOutcome: "TIMEOUT" as const } : {}),
          ...(protectedPath === undefined ? {} : { protectedPath }),
        });
      }),
    );
    const suite = BenchmarkSuiteSchema.parse({
      id: "p11-fixtures",
      version: "1.0.0",
      cases,
    });

    expect(suite.cases).toHaveLength(6);
    expect(new Set(suite.cases.map((item) => item.repository.baseCommit)).size).toBe(6);
    expect(suite.cases.every((item) => item.repository.baseCommit === caseCommit(item.id))).toBe(
      true,
    );
    expect(suite.cases.map((item) => benchmarkDefinitionDigest(item))).toEqual(
      suite.cases.map((item) => benchmarkDefinitionDigest(structuredClone(item))),
    );
    await Promise.all(
      fixtureNames.map(async (name) => {
        const manifest = JSON.parse(
          await readFile(path.join(FIXTURE_ROOT, name, "repository", "package.json"), "utf8"),
        ) as { scripts?: { test?: unknown } };
        expect(manifest.scripts?.test, `${name} must expose a detectable test command`).toBe(
          "node test/public.test.mjs",
        );
      }),
    );
  });

  it("keeps the hidden evaluator independent from public test tampering", async () => {
    const workspace = await copyRepository("adversarial-test-tamper");
    await writeFile(
      path.join(workspace, "test", "public.test.mjs"),
      'console.log("forged");\n',
      "utf8",
    );

    const result = await runEvaluator("adversarial-test-tamper", workspace);

    expect(result).toMatchObject({ timedOut: false, exitCode: 1 });
    expect(result.stderr).toContain("AssertionError");
  });

  it("models a deterministic fail -> repair -> pass loop", async () => {
    const workspace = await copyRepository("repair-loop");
    const first = await runEvaluator("repair-loop", workspace);
    await writeFile(
      path.join(workspace, "port.mjs"),
      `export function parsePort(input) {
  if (!/^[0-9]+$/u.test(input)) throw new Error("invalid port");
  const value = Number(input);
  if (value < 1 || value > 65535) throw new Error("invalid port");
  return value;
}
`,
      "utf8",
    );
    const repaired = await runEvaluator("repair-loop", workspace);

    expect(first.exitCode).toBe(1);
    expect(repaired).toMatchObject({ exitCode: 0, timedOut: false });
    expect(repaired.stdout).toContain("evaluation passed");
  });

  it("keeps max-repair failure deterministic across repeated attempts", async () => {
    const workspace = await copyRepository("max-repair-failure");
    const attempts = await Promise.all([
      runEvaluator("max-repair-failure", workspace),
      runEvaluator("max-repair-failure", workspace),
      runEvaluator("max-repair-failure", workspace),
    ]);

    expect(attempts.map((result) => result.exitCode)).toEqual([1, 1, 1]);
    expect(new Set(attempts.map((result) => result.stderr)).size).toBe(1);
  });

  it("provides simple and multi-file failures plus an isolated timeout", async () => {
    const simple = await runEvaluator(
      "simple-single-file",
      await copyRepository("simple-single-file"),
    );
    const multi = await runEvaluator("multi-file", await copyRepository("multi-file"));
    const timeout = await runEvaluator(
      "sandbox-timeout",
      await copyRepository("sandbox-timeout"),
      150,
    );

    expect(simple.exitCode).toBe(1);
    expect(multi.exitCode).toBe(1);
    expect(timeout).toMatchObject({ exitCode: null, timedOut: true });
  });
});

async function copyRepository(name: (typeof fixtureNames)[number]): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), `devflow-${name}-`));
  temporaryDirectories.push(parent);
  const workspace = path.join(parent, "workspace");
  await cp(path.join(FIXTURE_ROOT, name, "repository"), workspace, { recursive: true });
  return workspace;
}

async function runEvaluator(
  name: (typeof fixtureNames)[number],
  workspace: string,
  timeoutMs = 2_000,
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  const evaluator = path.join(FIXTURE_ROOT, name, "evaluator", "evaluate.mjs");
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [evaluator, workspace], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stdout, stderr });
    });
  });
}
