/**
 * Phase 0 control runner: one autonomous agent (bash/read/edit/submit) per case, on the
 * same frozen snapshots, dependency images, public profiles and trusted scorer as the
 * legacy batches. Fake scripted models cost nothing; live mode needs --live --spend-cap-cny.
 *
 *   node --env-file=.env --import tsx scripts/v4/phase0-dataset.ts --cases E10 --script golden
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createConfiguredLanguageModel,
  FakeLanguageModel,
  fakeModelResponse,
  type KernelEvent,
  type LanguageModelPort,
  type ModelRequest,
  type ModelResponse,
} from "@devflow/agent";
import { DockerSandboxManager, type CommandSpec, type SandboxSession } from "@devflow/sandbox";

import { runSolveAttempt, type PublicCheck } from "../../apps/worker/src/autonomous/attempt.ts";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.ts";
import { resolveStageModel } from "../../apps/worker/src/config/stage-models.ts";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const { values: args } = parseArgs({
  options: {
    cases: { type: "string", default: "E10" },
    repeats: { type: "string", default: "1" },
    suite: { type: "string", default: ".devflow/dataset-suite" },
    out: { type: "string" },
    script: { type: "string", default: "submit" },
    live: { type: "boolean", default: false },
    "spend-cap-cny": { type: "string" },
    "max-cost-cny": { type: "string", default: "4" },
    "max-turns": { type: "string", default: "80" },
    "timeout-min": { type: "string", default: "25" },
    reasoning: { type: "string", default: "low" },
    "max-output": { type: "string", default: "8192" },
    "context-tokens": { type: "string", default: "100000" },
  },
});

// Same CNY basis as the legacy ledger: Bailian busy-hour uncached upper rates.
const PRICE = { inputMicrosPerMillionTokens: 8_000_000, outputMicrosPerMillionTokens: 28_000_000 };
const CNY = 1_000_000;

interface Fixture {
  caseId: string;
  slug: string;
  family: string;
  repositoryPath: string;
  baseCommitSha: string;
  snapshot: { sourceHead: string; files: { path: string }[] };
  task: { title: string; description: string };
  config: { protectedPaths?: string[]; family: string; setupCommand?: CommandSpec };
  image?: { imageDigest: string; setupCommand?: CommandSpec };
  [key: string]: unknown;
}

const suite = path.resolve(ROOT, args.suite);
const readJson = async <T>(file: string) => JSON.parse(await fs.readFile(file, "utf8")) as T;
const inputs = await readJson<{ fixtures: Fixture[] }>(path.join(suite, "inputs.json"));
const images = await readJson<{ cases: { caseId: string; imageDigest: string }[] }>(
  path.join(suite, "images.json"),
);
const scorer = (await import(pathToFileURL(path.join(suite, "scorer.mjs")).href)) as {
  evaluateDatasetCandidate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  isProtectedDatasetPath(file: string, configured: string[]): boolean;
};

const live = args.live;
const spendCap = args["spend-cap-cny"] === undefined ? undefined : Number(args["spend-cap-cny"]);
if (live && !(spendCap !== undefined && spendCap > 0))
  throw new Error("Live runs spend money: pass --spend-cap-cny <total CNY> explicitly.");
const caseIds = args.cases.split(",").map((c) => c.trim().toUpperCase());
const repeats = Number(args.repeats);
const output = path.resolve(
  ROOT,
  args.out ??
    `.devflow/v4-phase0/${new Date().toISOString().replace(/[:.]/gu, "-")}-${args.script}`,
);
await fs.mkdir(output, { recursive: true });
let spentMicros = 0;
const summaries: Record<string, unknown>[] = [];

for (const caseId of caseIds)
  for (let repeat = 1; repeat <= repeats; repeat++) {
    if (
      live &&
      spendCap !== undefined &&
      spentMicros + Number(args["max-cost-cny"]) * CNY > spendCap * CNY
    ) {
      console.log(`Stopping: the next attempt could exceed the ${spendCap} CNY spend cap.`);
      break;
    }
    const summary = await runCase(caseId, repeat);
    spentMicros += Number((summary.usage as { costMicros?: number } | undefined)?.costMicros ?? 0);
    summaries.push(summary);
    await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summaries, null, 2));
  }
console.log(JSON.stringify(summaries.map(brief), null, 2));

async function runCase(caseId: string, repeat: number): Promise<Record<string, unknown>> {
  const fixture = inputs.fixtures.find((f) => f.caseId === caseId);
  const imageDigest = images.cases.find((i) => i.caseId === caseId)?.imageDigest;
  if (!fixture || !imageDigest) throw new Error(`Unknown case ${caseId}`);
  const profile = (
    await readJson<Record<string, { checks: PublicCheck[] }>>(
      path.join(suite, `public-profiles-quality-rerun-${caseId.toLowerCase()}.json`),
    )
  )[caseId]!;
  const dir = path.join(output, `${caseId}-${repeat}`);
  await fs.mkdir(dir, { recursive: true });
  const trajectory = await fs.open(path.join(dir, "trajectory.jsonl"), "w");
  const golden = await goldenFiles(fixture.slug);
  const protectedPaths = fixture.config.protectedPaths ?? [];
  const protectedPath = (file: string) =>
    scorer.isProtectedDatasetPath(file, protectedPaths)
      ? `${file} is protected: tests and build/test configuration grade your fix, so change source files instead. Put scratch scripts in /tmp.`
      : undefined;
  const controller = new AbortController();
  const started = Date.now();
  const deadlineAt = started + Number(args["timeout-min"]) * 60_000;
  const timer = setTimeout(() => controller.abort(), deadlineAt - started + 120_000);
  const manager = new DockerSandboxManager({ image: imageDigest, workspaceRoot: ROOT });
  let session: SandboxSession | undefined;
  let result: Record<string, unknown> = { caseId, repeat, script: live ? "live" : args.script };
  try {
    session = await manager.create(
      {
        runId: randomUUID(),
        owner: { executionOwner: "v4-phase0", dispatchRevision: 0, segment: randomUUID() },
        repository: {
          sourceUri: fixture.repositoryPath,
          snapshot: fixture.snapshot as never,
          baseCommit: fixture.snapshot.sourceHead,
        },
        limits: {
          cpuCount: 2,
          memoryMb: 4096,
          pids: 512,
          timeoutMs: 900_000,
          networkEnabled: false,
        },
        environment: sandboxEnvironment(fixture.family),
      },
      controller.signal,
    );
    await prepareEnvironment(session, fixture, controller.signal);
    const binding = live ? liveModel() : undefined;
    const model = binding?.model ?? scriptedModel(args.script, fixture, profile.checks);
    const attempt = await runSolveAttempt({
      sandbox: session,
      issue: { title: fixture.task.title, body: fixture.task.description },
      checks: profile.checks,
      model,
      ...(binding ? { settings: binding.settings } : {}),
      price: PRICE,
      limits: {
        maxTurns: Number(args["max-turns"]),
        maxCostMicros: Number(args["max-cost-cny"]) * CNY,
        deadlineAt,
        maxInputTokens: Number(args["context-tokens"]),
      },
      protectedPath,
      protectedSummary: `Existing tests and build/test configuration are fixed and grade your fix; do not edit them (${protectedPaths.join(", ")}). Put scratch scripts in /tmp.`,
      signal: controller.signal,
      onEvent: (event) =>
        trajectory.write(`${JSON.stringify(eventRecord(event))}\n`).then(() => {}),
    });
    await fs.writeFile(path.join(dir, "candidate.diff"), attempt.patch);
    await session.dispose();
    session = undefined;
    const score = await scorer.evaluateDatasetCandidate({
      fixture: { ...fixture, image: { imageDigest }, manifest: { environment: { imageDigest } } },
      patch: attempt.patch,
      imageDigest,
      outputDirectory: path.join(dir, "scoring"),
      signal: controller.signal,
    });
    const groups = score.groups as Record<string, { status: string }> | undefined;
    result = {
      ...result,
      stopReason: attempt.kernel.stopReason,
      summary: attempt.kernel.summary,
      error: attempt.kernel.error,
      turns: attempt.kernel.turns,
      usage: attempt.kernel.usage,
      costCny: attempt.kernel.usage.costMicros / CNY,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      changedFiles: attempt.changedFiles,
      excludedFiles: attempt.excludedFiles,
      goldenFiles: golden,
      goldenTouched: golden.filter((file) => attempt.changedFiles.includes(file)).length,
      strictPatchPass: score.strictPatchPass,
      integrity: (score.integrity as { status?: string } | undefined)?.status,
      groups: Object.fromEntries(Object.entries(groups ?? {}).map(([k, v]) => [k, v.status])),
      scoringError: (score.error as { message?: string } | undefined)?.message,
    };
  } catch (error) {
    result = { ...result, harnessError: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    await trajectory.close();
    if (session) await session.dispose().catch(() => {});
  }
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

function liveModel(): {
  model: LanguageModelPort;
  settings: { reasoningEffort: never; maxOutputTokens: number };
} {
  const binding = resolveStageModel("EXECUTE", loadWorkerEnvironment(process.env));
  const { contextMaxBytes: _ignored, ...config } = binding.config;
  return {
    model: createConfiguredLanguageModel(config),
    settings: {
      reasoningEffort: args.reasoning as never,
      maxOutputTokens: Number(args["max-output"]),
    },
  };
}

function sandboxEnvironment(family: string): Record<string, string> {
  return {
    CI: "true",
    NO_COLOR: "1",
    ...(family.toLowerCase() === "python"
      ? { PYTHONPATH: "/workspace/src:/workspace", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }
      : {}),
  };
}

// Mirrors the trusted scorer: node projects link the frozen image's dependencies.
async function prepareEnvironment(session: SandboxSession, fixture: Fixture, signal: AbortSignal) {
  const setup = fixture.image?.setupCommand ?? fixture.config.setupCommand;
  const command: CommandSpec | undefined =
    setup ??
    (/^(?:node|typescript|ts|vue)$/iu.test(fixture.family)
      ? {
          program: "node",
          args: [
            "-e",
            "const fs=require('node:fs'),path=require('node:path');fs.mkdirSync('node_modules');for(const name of fs.readdirSync('/opt/devflow-deps/node_modules')){if(['.tmp','.vite','.vite-temp','.cache'].includes(name))continue;fs.symlinkSync(path.join('/opt/devflow-deps/node_modules',name),path.join('node_modules',name),'dir');}",
          ],
          timeoutMs: 15_000,
          maxOutputBytes: 20_000,
        }
      : undefined);
  if (!command) return;
  const result = await session.exec(command, signal);
  if (result.exitCode !== 0)
    throw new Error(`Environment setup failed: ${result.stderr || result.stdout}`);
}

async function goldenFiles(slug: string): Promise<string[]> {
  const patch = await fs.readFile(
    path.join(ROOT, "datasets", slug, "benchmark", "injection.patch"),
    "utf8",
  );
  return [...patch.matchAll(/^\+\+\+ b\/(.+)$/gmu)].map((m) => m[1]!.trim());
}

function eventRecord(event: KernelEvent): Record<string, unknown> {
  if (event.type === "model")
    return {
      type: "model",
      turn: event.turn,
      text: event.response.text,
      toolCalls: event.response.toolCalls,
      finishReason: event.response.finishReason,
      usage: event.response.usage,
      reasoningTokens: event.response.reasoningTokens,
      latencyMs: event.response.latencyMs,
      costMicros: event.costMicros,
    };
  if (event.type === "tool")
    return { ...event, content: event.content.slice(0, 6000), at: new Date().toISOString() };
  return { ...event };
}

function brief(summary: Record<string, unknown>) {
  const {
    caseId,
    repeat,
    stopReason,
    turns,
    costCny,
    wallSeconds,
    strictPatchPass,
    groups,
    harnessError,
  } = summary;
  return {
    caseId,
    repeat,
    stopReason,
    turns,
    costCny,
    wallSeconds,
    strictPatchPass,
    groups,
    harnessError,
  };
}

/** Zero-cost scripted models that exercise the harness end to end. */
function scriptedModel(
  name: string,
  fixture: Fixture,
  checks: readonly PublicCheck[],
): LanguageModelPort {
  let id = 0;
  const step = (tool: string, input: unknown) =>
    fakeModelResponse({ toolCalls: [{ id: `s${++id}`, name: tool, input }] });
  const test = checks.find((c) => c.kind === "test") ?? checks.at(-1);
  const testCommand = test
    ? [test.command.program, ...test.command.args].map(shellQuote).join(" ")
    : "true";
  const submit = step("submit", { summary: `scripted ${name}` });
  if (name === "submit") return new FakeLanguageModel([submit]);
  if (name === "smoke")
    return new FakeLanguageModel([
      step("bash", { command: "git status --short | head -20; ls" }),
      step("bash", { command: `${testCommand} 2>&1 | tail -40`, timeout_seconds: 600 }),
      step("read_file", {
        path: fixture.snapshot.files.find((f) => /\.(ts|py|java|cpp|js)$/u.test(f.path))!.path,
        end_line: 20,
      }),
      step("edit_file", { path: "tests/devflow_probe.txt", old_text: "", new_text: "x" }),
      submit,
    ]);
  if (name === "golden")
    // Applies the reverse injection: validates export + scoring, never used as evidence.
    return new FakeLanguageModel([
      async (_request: ModelRequest): Promise<ModelResponse> => {
        const patch = (
          await fs.readFile(
            path.join(ROOT, "datasets", fixture.slug, "benchmark", "injection.patch"),
            "utf8",
          )
        ).replace(/\r\n/gu, "\n");
        return step("bash", {
          command: `git apply -R --whitespace=nowarn <<'DEVFLOW_EOF' && git diff --stat\n${patch}\nDEVFLOW_EOF`,
        });
      },
      step("bash", { command: `${testCommand} 2>&1 | tail -15`, timeout_seconds: 600 }),
      submit,
    ]);
  throw new Error(`Unknown script ${name}`);
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}
