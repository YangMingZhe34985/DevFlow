import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  BenchmarkSuiteResultSchema,
  EvaluationResultSchema,
  type BenchmarkSuiteResult,
  type EvaluationResult,
  type EvaluationResultStore,
} from "./contracts.js";
import { canonicalJson } from "./canonical.js";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

/**
 * Append-only, crash-safe local persistence. Each JSON document is written to
 * a sibling temporary file and atomically hard-linked into place. The link is
 * exclusive, so a repeated execution cannot overwrite an existing result.
 */
export class JsonFileEvaluationResultStore implements EvaluationResultStore {
  constructor(private readonly directory: string) {}

  async saveCase(resultInput: EvaluationResult): Promise<void> {
    const result = EvaluationResultSchema.parse(resultInput);
    await writeImmutableJson(this.casePath(result.suiteId, result.executionId), result);
  }

  async saveSuite(resultInput: BenchmarkSuiteResult): Promise<void> {
    const result = BenchmarkSuiteResultSchema.parse(resultInput);
    await writeImmutableJson(this.suitePath(result.suiteId, result.suiteExecutionId), result);
  }

  async loadCase(suiteId: string, executionId: string): Promise<EvaluationResult | undefined> {
    return await readOptional(this.casePath(suiteId, executionId), EvaluationResultSchema.parse);
  }

  async loadSuite(
    suiteId: string,
    suiteExecutionId: string,
  ): Promise<BenchmarkSuiteResult | undefined> {
    return await readOptional(
      this.suitePath(suiteId, suiteExecutionId),
      BenchmarkSuiteResultSchema.parse,
    );
  }

  async listCases(suiteId: string): Promise<readonly EvaluationResult[]> {
    assertSegment(suiteId, "suiteId");
    const directory = path.join(this.directory, "cases", suiteId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const results = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) =>
          EvaluationResultSchema.parse(
            JSON.parse(await readFile(path.join(directory, name), "utf8")),
          ),
        ),
    );
    return results.sort(
      (left, right) =>
        left.provenance.startedAt.localeCompare(right.provenance.startedAt) ||
        left.executionId.localeCompare(right.executionId),
    );
  }

  private casePath(suiteId: string, executionId: string): string {
    assertSegment(suiteId, "suiteId");
    assertUuid(executionId, "executionId");
    return path.join(this.directory, "cases", suiteId, `${executionId}.json`);
  }

  private suitePath(suiteId: string, suiteExecutionId: string): string {
    assertSegment(suiteId, "suiteId");
    assertUuid(suiteExecutionId, "suiteExecutionId");
    return path.join(this.directory, "suites", suiteId, `${suiteExecutionId}.json`);
  }
}

export class InMemoryEvaluationResultStore implements EvaluationResultStore {
  private readonly cases = new Map<string, EvaluationResult>();
  private readonly suites = new Map<string, BenchmarkSuiteResult>();

  async saveCase(resultInput: EvaluationResult): Promise<void> {
    const result = EvaluationResultSchema.parse(resultInput);
    saveImmutable(this.cases, `${result.suiteId}/${result.executionId}`, result);
  }

  async saveSuite(resultInput: BenchmarkSuiteResult): Promise<void> {
    const result = BenchmarkSuiteResultSchema.parse(resultInput);
    saveImmutable(this.suites, `${result.suiteId}/${result.suiteExecutionId}`, result);
  }

  async loadCase(suiteId: string, executionId: string): Promise<EvaluationResult | undefined> {
    return this.cases.get(`${suiteId}/${executionId}`);
  }

  async loadSuite(
    suiteId: string,
    suiteExecutionId: string,
  ): Promise<BenchmarkSuiteResult | undefined> {
    return this.suites.get(`${suiteId}/${suiteExecutionId}`);
  }

  async listCases(suiteId: string): Promise<readonly EvaluationResult[]> {
    return [...this.cases.values()].filter((result) => result.suiteId === suiteId);
  }
}

async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const serialized = `${canonicalJson(value)}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    await link(temporaryPath, filePath);
    await rm(temporaryPath, { force: true });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (await sameExistingContent(filePath, serialized)) return;
    throw error;
  }
}

async function sameExistingContent(filePath: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(filePath, "utf8")) === expected;
  } catch {
    return false;
  }
}

async function readOptional<T>(
  filePath: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  try {
    return parse(JSON.parse(await readFile(filePath, "utf8")));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function saveImmutable<T>(store: Map<string, T>, key: string, value: T): void {
  const existing = store.get(key);
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(`Evaluation result '${key}' is immutable.`);
  }
  store.set(key, value);
}

function assertSegment(value: string, name: string): void {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`${name} is not a safe path segment.`);
}

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
