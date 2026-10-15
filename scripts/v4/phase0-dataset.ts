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
  kernelCost,
  type KernelEvent,
  type KernelPrice,
  type LanguageModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelReasoningEffort,
} from "@devflow/agent";
import { DockerSandboxManager, type CommandSpec, type SandboxSession } from "@devflow/sandbox";

import { type PublicCheck } from "../../apps/worker/src/autonomous/solve.ts";
import { runAttempts } from "../../apps/worker/src/autonomous/attempts.ts";
import { reviewSettings } from "../../apps/worker/src/autonomous/review.ts";
import { loadWorkerEnvironment } from "../../apps/worker/src/config/env.ts";
import { resolveStageModel } from "../../apps/worker/src/config/stage-models.ts";
import { serialScore } from "./scoring-queue.ts";

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
    "max-revisions": { type: "string", default: "2" },
    // Bailian bills implicit prompt-cache hits at 20% of the input rate; 0 keeps the
    // uncached upper basis used by the legacy batches.
    "cached-price-ratio": { type: "string", default: "0" },
    concurrency: { type: "string", default: "1" },
  },
});

// Same CNY basis as the legacy ledger: Bailian busy-hour uncached upper rates.
const UNCACHED = {
  inputMicrosPerMillionTokens: 8_000_000,
  outputMicrosPerMillionTokens: 28_000_000,
};
const cachedRatio = Number(args["cached-price-ratio"]);
const PRICE =
  cachedRatio > 0
    ? {
        ...UNCACHED,
        cachedInputMicrosPerMillionTokens: Math.round(
          UNCACHED.inputMicrosPerMillionTokens * cachedRatio,
        ),
      }
    : UNCACHED;
const CNY = 1_000_000;

interface Fixture {
  caseId: string;
  slug: string;
  family: string;
  repositoryPath: string;
  baseCommitSha: string;
  snapshot: { sourceHead: string; files: { path: string; contentBase64?: string }[] };
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
const summaries: Record<string, unknown>[] = [];
const queue = caseIds.flatMap((caseId) =>
  Array.from({ length: repeats }, (_, i) => ({ caseId, repeat: i + 1 })),
);
const perAttemptCap = Number(args["max-cost-cny"]) * CNY;
let spentMicros = 0;
let inFlight = 0;
// Every in-flight attempt holds its full cost ceiling until it settles.
const worker = async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (live && spentMicros + (inFlight + 1) * perAttemptCap > spendCap! * CNY) {
      console.log(`Skipping ${job.caseId}-${job.repeat}: it could exceed the ${spendCap} CNY cap.`);
      continue;
    }
    inFlight += 1;
    const summary = await runCase(job.caseId, job.repeat);
    inFlight -= 1;
    const usage = summary.usage as
      { costMicros?: number; unconfirmedCostMicros?: number } | undefined;
    spentMicros += (usage?.costMicros ?? 0) + (usage?.unconfirmedCostMicros ?? 0);
    summaries.push(summary);
    await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summaries, null, 2));
  }
};
await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency)) }, worker));
console.log(JSON.stringify(summaries.map(brief), null, 2));
console.log(
  `Total cost (configured cache-aware prices, including unconfirmed upper bound): ${(spentMicros / CNY).toFixed(4)} CNY`,
);

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
    file.startsWith("/") || file.split("/").includes("..")
      ? `${file} is outside the repository: edit files under /workspace, or put scratch files in /tmp.`
      : scorer.isProtectedDatasetPath(file, protectedPaths)
        ? `${file} is protected: tests and build/test configuration grade your fix, so change source files instead. Put scratch scripts in /tmp.`
        : undefined;
  let reviewActive = false;
  let uncachedMicros = 0;
  const controller = new AbortController();
  const started = Date.now();
  const deadlineAt = started + Number(args["timeout-min"]) * 60_000;
  const timer = setTimeout(() => controller.abort(), deadlineAt - started + 120_000);
  const manager = new DockerSandboxManager({ image: imageDigest, workspaceRoot: ROOT });
  let session: SandboxSession | undefined;
  let result: Record<string, unknown> = { caseId, repeat, script: live ? "live" : args.script };
  try {
    const sandboxFactory = async () => {
      await session?.dispose();
      session = await manager.create(
        {
          runId: randomUUID(),
          owner: { executionOwner: "v4-phase0", dispatchRevision: 0, segment: randomUUID() },
          repository: {
            sourceUri: fixture.repositoryPath,
            snapshot: fixture.snapshot as never,
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
      return session;
    };
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://unused:unused@localhost/unused",
      ...process.env,
    });
    const binding = live ? liveModel() : undefined;
    const model = binding?.model ?? scriptedModel(args.script, fixture, profile.checks);
    const reviewer =
      environment.DEVFLOW_AUTONOMOUS_REVIEW === "1"
        ? live
          ? liveModel("REVIEW")
          : {
              model: new FakeLanguageModel([
                fakeModelResponse({
                  toolCalls: [],
                  output: {
                    verdict: "PASS",
                    findings: [],
                    concerns: [],
                    summary: "Scripted review for harness verification only.",
                  },
                }),
              ]),
              settings: reviewSettings(
                "fake",
                {},
                {
                  maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
                  reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_REASONING,
                },
              ),
              triageSettings: reviewSettings(
                "fake",
                {},
                {
                  maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
                  reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING,
                },
              ),
              price: PRICE,
            }
        : undefined;
    const attempts = await runAttempts({
      sandboxFactory,
      maxAttempts: environment.DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS,
      issue: { title: fixture.task.title, body: fixture.task.description },
      checks: profile.checks,
      model,
      ...(binding ? { settings: binding.settings } : {}),
      price: PRICE,
      ...(reviewer
        ? {
            review: {
              ...reviewer,
              maxTurns: environment.DEVFLOW_AUTONOMOUS_REVIEW_TOOL_TURNS,
              reserve: environment.DEVFLOW_AUTONOMOUS_REVIEW_RESERVE,
            },
          }
        : {}),
      limits: {
        maxTurns: Number(args["max-turns"]),
        maxCostMicros: Number(args["max-cost-cny"]) * CNY,
        deadlineAt,
        maxInputTokens: Number(args["context-tokens"]),
      },
      maxRevisions: Number(args["max-revisions"]),
      protectedPath,
      protectedSummary: `Existing tests and build/test configuration are fixed and grade your fix; do not edit them (${protectedPaths.join(", ")}). Put scratch scripts in /tmp.`,
      signal: controller.signal,
      onEvent: async (event) => {
        if (event.type === "model")
          uncachedMicros += kernelCost(
            reviewActive ? (reviewer?.price ?? PRICE) : PRICE,
            event.response.usage.inputTokens,
            0,
            event.response.usage.outputTokens,
          );
        await trajectory.write(`${JSON.stringify(eventRecord(event))}\n`);
      },
      onAttemptComplete: async (result) => {
        await fs.writeFile(
          path.join(dir, `autonomous-transcript-attempt-${result.attempt}.json`),
          JSON.stringify(result),
        );
      },
      onReview: async (review, tier) => {
        reviewActive = review === undefined;
        await trajectory.write(
          `${JSON.stringify({ type: review ? "review_result" : "review_started", at: new Date().toISOString(), tier, review })}\n`,
        );
      },
      onVerification: async (verification, revision) => {
        const checks = verification.checks.map(({ output, ...rest }) => ({
          ...rest,
          output: output.slice(-3000),
        }));
        const record = { type: "verification", revision, ...verification, checks };
        await trajectory.write(`${JSON.stringify(record)}\n`);
      },
    });
    const attempt = attempts.selected;
    await fs.writeFile(path.join(dir, "candidate.diff"), attempt.patch);
    await session?.dispose();
    session = undefined;
    clearTimeout(timer);
    // Scoring has its own budget: the agent's deadline must not cut grading short.
    const score = await serialScore(() =>
      scorer.evaluateDatasetCandidate({
        fixture: { ...fixture, image: { imageDigest }, manifest: { environment: { imageDigest } } },
        patch: attempt.patch,
        imageDigest,
        outputDirectory: path.join(dir, "scoring"),
        signal: AbortSignal.timeout(30 * 60_000),
      }),
    );
    const groups = score.groups as Record<string, { status: string }> | undefined;
    result = {
      ...result,
      stopReason: attempt.kernel.stopReason,
      summary: attempt.kernel.summary,
      error: attempt.kernel.error,
      turns: attempts.turns,
      revisions: attempt.revisions,
      hostVerification: attempt.verification && {
        passed: attempt.verification.passed,
        checks: attempt.verification.checks.map((check) => `${check.kind}:${check.status}`),
      },
      review: attempt.review
        ? {
            verdict: attempt.review.verdict,
            findings: attempt.review.findings.length,
            tier: attempt.review.tier,
            concerns: attempt.review.concernCount,
            costMicros: attempt.review.costMicros,
          }
        : null,
      attempts: attempts.attempts.length,
      selectedAttempt: attempts.selectedAttempt,
      usage: attempts.usage,
      costCny: attempts.usage.costMicros / CNY,
      priceBasis: cachedRatio > 0 ? `cached-hits-at-${cachedRatio}` : "uncached-upper",
      uncachedBasisCny: uncachedMicros / CNY,
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

function liveModel(stage: "EXECUTE" | "REVIEW" = "EXECUTE"): {
  model: LanguageModelPort;
  settings: {
    reasoningEffort?: ModelReasoningEffort;
    maxOutputTokens?: number;
  };
  price?: KernelPrice;
} {
  const environment = loadWorkerEnvironment(process.env);
  const binding = resolveStageModel(stage, environment);
  const { contextMaxBytes: _ignored, ...config } = binding.config;
  const prices = JSON.parse(process.env.DEVFLOW_MODEL_PRICES_JSON ?? "{}") as Record<
    string,
    KernelPrice
  >;
  const price = prices[`${binding.provenance.provider}:${binding.provenance.model}`];
  if (stage === "REVIEW" && !price)
    throw new Error("Reviewer requires a configured price in DEVFLOW_MODEL_PRICES_JSON.");
  return {
    model: createConfiguredLanguageModel(config),
    ...(price ? { price } : {}),
    ...(stage === "REVIEW"
      ? {
          triageSettings: reviewSettings(config.model, binding.settings, {
            maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
            reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING,
          }),
        }
      : {}),
    settings:
      stage === "REVIEW"
        ? reviewSettings(config.model, binding.settings, {
            maxOutputTokens: environment.DEVFLOW_AUTONOMOUS_REVIEW_MAX_OUTPUT,
            reasoningEffort: environment.DEVFLOW_AUTONOMOUS_REVIEW_REASONING,
          })
        : {
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
  if (name === "paths") {
    // Path forms real models use: absolute /workspace paths, ./ prefixes and /tmp scratch.
    const source = fixture.snapshot.files.find((f) => f.path.startsWith("src/"))!;
    const firstLine = Buffer.from(source.contentBase64 ?? "", "base64")
      .toString("utf8")
      .split("\n")[0]!;
    return new FakeLanguageModel([
      step("read_file", { path: `/workspace/${source.path}`, end_line: 3 }),
      step("edit_file", {
        path: `/workspace/${source.path}`,
        old_text: firstLine,
        new_text: `${firstLine} `,
      }),
      step("edit_file", {
        path: `./${source.path}`,
        old_text: `${firstLine} `,
        new_text: firstLine,
      }),
      step("edit_file", {
        path: `/workspace/${source.path}`,
        old_text: firstLine,
        new_text: `${firstLine}\n`,
      }),
      step("edit_file", { path: "/tmp/devflow-repro.txt", old_text: "", new_text: "scratch\n" }),
      step("read_file", { path: "/tmp/devflow-repro.txt" }),
      step("edit_file", {
        path: "/workspace/tests/devflow_probe.txt",
        old_text: "",
        new_text: "x",
      }),
      step("edit_file", { path: "/etc/passwd", old_text: "root", new_text: "x" }),
      step("bash", { command: "git status --short" }),
      submit,
    ]);
  }
  if (name === "golden" || name === "revise") {
    // Restores the golden bytes of injected files through edit_file. "golden" fixes all of
    // them; "revise" leaves the last one for after host verification fails, exercising the
    // revision loop. Both validate tooling and scoring and are never agent evidence.
    const content = (files: { path: string; contentBase64?: string }[], file: string) =>
      Buffer.from(files.find((f) => f.path === file)?.contentBase64 ?? "", "base64").toString(
        "utf8",
      );
    const golden = (fixture.goldenSnapshot as { files: { path: string }[] }).files;
    const restore = (files: string[]) =>
      fakeModelResponse({
        toolCalls: files.map((file) => ({
          id: `s${++id}`,
          name: "edit_file",
          input: {
            path: file,
            old_text: content(fixture.snapshot.files, file),
            new_text: content(golden, file),
          },
        })),
      });
    const check = step("bash", {
      command: `git diff --stat; ${testCommand} 2>&1 | tail -15`,
      timeout_seconds: 600,
    });
    return new FakeLanguageModel([
      async () => {
        const files = await goldenFiles(fixture.slug);
        return restore(name === "revise" ? files.slice(0, -1) : files);
      },
      check,
      submit,
      async (request: ModelRequest): Promise<ModelResponse> => {
        const feedback = request.messages.at(-1);
        if (feedback?.role !== "USER" || !feedback.content.includes("verification"))
          throw new Error("revise script expected host verification feedback");
        return restore((await goldenFiles(fixture.slug)).slice(-1));
      },
      step("submit", { summary: "scripted revise: fixed after host feedback" }),
    ]);
  }
  throw new Error(`Unknown script ${name}`);
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}
