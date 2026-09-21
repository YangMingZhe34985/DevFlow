import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DefaultEvaluationRunner,
  JsonFileEvaluationResultStore,
  type EvaluationTarget,
} from "../src/index.js";
import {
  benchmarkCase,
  benchmarkSuite,
  executionProfile,
  observation,
  pricingConfiguration,
} from "./test-helpers.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("JsonFileEvaluationResultStore", () => {
  it("atomically persists isolated case and suite documents", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonFileEvaluationResultStore(directory);
    const first = benchmarkCase("first");
    const second = benchmarkCase("second");
    const target = targetFor([first, second]);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store, {
      idFactory: () => {
        const next = ids.shift();
        if (next === undefined) throw new Error("No deterministic id remaining.");
        return next;
      },
    });

    const suiteResult = await runner.runSuite(
      benchmarkSuite([first, second]),
      executionProfile(),
      target,
    );
    const persistedCases = await store.listCases(suiteResult.suiteId);

    expect(persistedCases).toHaveLength(2);
    await expect(
      store.loadSuite(suiteResult.suiteId, suiteResult.suiteExecutionId),
    ).resolves.toEqual(suiteResult);
    const allFiles = await listFilesRecursively(directory);
    expect(allFiles.filter((name) => name.endsWith(".json"))).toHaveLength(3);
    expect(allFiles.some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("is append-only, idempotent and ignores an interrupted temporary document", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonFileEvaluationResultStore(directory);
    const testCase = benchmarkCase();
    const runner = new DefaultEvaluationRunner(pricingConfiguration(), store);
    const result = await runner.runCase(
      { id: "suite", version: "1" },
      testCase,
      executionProfile(),
      targetFor([testCase]),
    );

    await expect(store.saveCase(result)).resolves.toBeUndefined();
    const caseDirectory = path.join(directory, "cases", "suite");
    await writeFile(path.join(caseDirectory, "orphaned-write.tmp"), "{", "utf8");
    await expect(store.listCases("suite")).resolves.toEqual([result]);
    await expect(store.saveCase({ ...result, success: false })).rejects.toBeDefined();
  });

  it("rejects traversal in storage identifiers", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonFileEvaluationResultStore(directory);
    await expect(store.loadCase("../escape", randomUUID())).rejects.toThrow("safe path segment");
  });
});

function targetFor(cases: readonly ReturnType<typeof benchmarkCase>[]): EvaluationTarget {
  return {
    async execute(request) {
      const testCase = cases.find(
        (candidate) => candidate.repository.sourceUri === request.agent.repository.sourceUri,
      );
      if (testCase === undefined) throw new Error("Unexpected fixture.");
      return observation(testCase);
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-eval-store-"));
  directories.push(directory);
  return directory;
}

async function listFilesRecursively(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of await readdir(directory)) {
    const child = path.join(directory, name);
    try {
      result.push(...(await listFilesRecursively(child)));
    } catch {
      result.push(child);
    }
  }
  return result;
}
