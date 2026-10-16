/** External-set entry; no duplicate agent loop. Private grading runs after disposal. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { DockerSandboxManager, type LocalRepositorySnapshot } from "@devflow/sandbox";
import { runAttempts, type AttemptsInput } from "../../../apps/worker/src/autonomous/attempts.js";
import { runChecks } from "../../../apps/worker/src/autonomous/solve.js";
import { protectedPath, type PublicFixture } from "./adapter.js";
import { auditBoundary, mapOfficial, type OfficialCaseReport } from "./scoring.js";
import { authorizeLive, BatchBudget, runWithinBudget, redact } from "./live-budget.js";
import { imageRestoreView } from "./snapshot-restore.js";

const { values: args } = parseArgs({
  options: {
    cases: { type: "string" },
    script: { type: "string", default: "empty" },
    live: { type: "boolean", default: false },
    python: { type: "string" },
    campaign: { type: "string", default: "stage2-v1" },
    "budget-cny": { type: "string" },
    "per-case-cny": { type: "string" },
    // Same solver defaults as scripts/v4/phase0-dataset.ts so both suites are comparable.
    reasoning: { type: "string", default: "low" },
    "max-output": { type: "string", default: "8192" },
  },
});
// Validate authorization before importing any provider configuration.
const authorization = args.live
  ? authorizeLive({
      ...(args.cases === undefined ? {} : { cases: args.cases }),
      ...(args["budget-cny"] === undefined ? {} : { budgetCny: args["budget-cny"] }),
      ...(args["per-case-cny"] === undefined ? {} : { perCaseCny: args["per-case-cny"] }),
    })
  : undefined;
if (!["golden", "empty", "wrong"].includes(args.script)) throw Error("Unknown scripted control");
if (!args.python) throw Error("--python must name the frozen harness-compatible Python runtime");
if (!/^[a-z0-9-]+$/.test(args.campaign)) throw Error("Invalid campaign identity");
const suite = path.resolve(".devflow/external-set-suite");
const json = async (filename: string) => JSON.parse(await fs.readFile(filename, "utf8"));
const selectedCases = authorization?.cases ?? (args.cases ?? "X11").split(",");
let frozenManifest:
  | {
      cases: {
        caseId: string;
        imageId: string;
        snapshotSha256: string;
        publicProfileSha256: string;
      }[];
    }
  | undefined;
if (args.live) {
  const manifest = await json(path.join(suite, "manifest.json"));
  if (
    manifest.readyForLive !== true ||
    !selectedCases.every((c) =>
      manifest.cases.some((entry: { caseId: string }) => entry.caseId === c),
    )
  )
    throw Error("Requested cases are not in the final audited manifest");
  frozenManifest = manifest;
}
const liveModels = args.live ? (await import("./live-models.js")).configuredModels() : undefined;
const experiment = args.live
  ? path.join(suite, "private", "experiments", args.campaign + "-" + randomUUID())
  : undefined;
if (experiment) await fs.mkdir(experiment, { recursive: true });
const ledger =
  authorization && experiment
    ? new BatchBudget(path.join(experiment, "budget.json"), authorization)
    : undefined;
await ledger?.initialize();
const modeTag = args.live ? "live" : args.script;
const active = await json(path.join(suite, "private", "r2", "active-bridges.json")).catch(
  () => ({}),
);
for (const caseId of selectedCases) {
  const startedAt = Date.now();
  if (!/^X[A-Z0-9]+$/.test(caseId)) throw Error("Invalid case identity");
  const fixture: PublicFixture = await json(path.join(suite, "public", caseId, "fixture.json"));
  const snapshotText = await fs.readFile(
    path.join(suite, "public", caseId, "snapshot.json"),
    "utf8",
  );
  if (createHash("sha256").update(snapshotText).digest("hex") !== fixture.snapshotSha256)
    throw Error("Snapshot changed");
  const snapshot: LocalRepositorySnapshot = JSON.parse(snapshotText);
  snapshot.files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const privateDirectory = path.join(suite, "private", fixture.source.instanceId);
  const preparation = await json(path.join(privateDirectory, "preparation.json"));
  const profileText = await fs.readFile(
    path.join(suite, "public", caseId, "public-profile.json"),
    "utf8",
  );
  const publicProfileSha256 = createHash("sha256").update(profileText).digest("hex");
  if (
    JSON.stringify(JSON.parse(profileText)) !== JSON.stringify(fixture.publicChecks) ||
    publicProfileSha256 !== preparation.publicProfileSha256
  )
    throw Error("Public profile changed after preparation");
  if (frozenManifest) {
    const frozen = frozenManifest.cases.find((c) => c.caseId === caseId);
    if (
      !frozen ||
      frozen.imageId !== fixture.imageId ||
      frozen.snapshotSha256 !== fixture.snapshotSha256 ||
      frozen.publicProfileSha256 !== publicProfileSha256
    )
      throw Error("Live fixture differs from final manifest");
  }
  for (const [name, sha] of Object.entries(preparation.privateHashes))
    if (
      createHash("sha256")
        .update(await fs.readFile(path.join(privateDirectory, name)))
        .digest("hex") !== sha
    )
      throw Error("Private fixture changed: " + name);
  const bridgeDirectory = path.join(suite, active[caseId] ?? `private/bridge/${caseId}`);
  const audit = await json(path.join(bridgeDirectory, "rootfs-audit.json"));
  const bridge = await json(path.join(bridgeDirectory, "image.json"));
  if (fixture.imageId !== bridge.imageId || audit.imageId !== fixture.imageId || !audit.passed)
    throw Error("Audit image mismatch");
  const restoreSnapshot = imageRestoreView(snapshot, {
    imageId: fixture.imageId,
    auditImageId: audit.imageId,
    sourceBaseCommit: bridge.sourceBaseCommit,
    strongAuditPassed: audit.strongAuditPassed === true,
  });
  if (
    args.live &&
    (fixture.publicChecks.status !== "CONFIGURED" ||
      !fixture.publicChecks.checks.length ||
      audit.strongAuditPassed !== true)
  )
    throw Error("Live case lacks verified public checks or R2 strong audit");
  const scripted =
    args.live || args.script === "empty"
      ? { edits: [] }
      : await json(path.join(bridgeDirectory, "scripted-input.json"));
  const output = experiment
    ? path.join(experiment, caseId)
    : path.join(suite, "private", "stage2-runs", args.campaign, caseId, modeTag);
  await fs.mkdir(output, { recursive: true });
  // Each experiment identity is single-use; callers cannot silently overwrite it.
  const claimed = await fs.open(path.join(output, "dispatch.json"), "wx");
  await claimed.writeFile(
    JSON.stringify({
      caseId,
      imageId: fixture.imageId,
      snapshotSha256: fixture.snapshotSha256,
      script: modeTag,
      paid: args.live,
    }),
  );
  await claimed.close();
  const caseBudget = ledger ? await ledger.reserve(caseId) : undefined;
  if (ledger && caseBudget === undefined) {
    await fs.writeFile(
      path.join(output, "result.json"),
      JSON.stringify({
        caseId,
        status: "NOT_RUN",
        stopReason: "BATCH_BUDGET",
        requestIssued: false,
      }),
    );
    continue;
  }
  let settled = false;
  let edits = !args.live && args.script === "golden" ? scripted.edits : [];
  if (!args.live && args.script === "wrong") {
    const first = scripted.edits[0];
    if (!first) throw Error("Wrong-patch control needs an editable source file");
    const comment = first.path.endsWith(".py")
      ? "# external-set negative control"
      : "// external-set negative control";
    edits = [
      {
        path: first.path,
        old_text: first.old_text,
        new_text: first.old_text + "\n" + comment + "\n",
      },
    ];
  }
  for (const edit of edits)
    if (protectedPath(edit.path)) throw Error("Scripted control would edit a protected path");
  const responses = edits.length
    ? [
        fakeModelResponse({
          toolCalls: edits.map((edit: unknown, i: number) => ({
            id: `edit-${i}`,
            name: "edit_file",
            input: edit,
          })),
        }),
      ]
    : [];
  responses.push(
    fakeModelResponse({
      toolCalls: [
        { id: "submit", name: "submit", input: { summary: `Free ${args.script} control` } },
      ],
    }),
  );
  const manager = new DockerSandboxManager({
    image: fixture.imageId,
    workspaceRoot: process.cwd(),
  });
  let session: Awaited<ReturnType<typeof manager.create>> | undefined;
  // One deadline for the whole case: the sandbox session must outlive every attempt.
  const runSignal = AbortSignal.timeout(args.live ? 1_500_000 : 300_000);
  const events: unknown[] = [];
  let result;
  try {
    const solveInput: AttemptsInput = {
      sandboxFactory: async () => {
        if (session) {
          await session.dispose();
          session = undefined;
        }
        session = await manager.create(
          {
            runId: randomUUID(),
            owner: { executionOwner: "external-set", dispatchRevision: 0, segment: randomUUID() },
            repository: {
              sourceUri: path.join(suite, "public-base", caseId),
              snapshot: restoreSnapshot,
            },
            environment: fixture.publicChecks.runtimeEnvironment ?? {},
            limits: {
              cpuCount: 2,
              memoryMb: 4096,
              pids: 512,
              timeoutMs: args.live ? 1_500_000 : 300_000,
              networkEnabled: false,
            },
          },
          runSignal,
        );
        const info = JSON.parse(execFileSync("docker", ["inspect", session.id]).toString())[0];
        if (info.Config.Labels["devflow.suite"] !== "external-set")
          throw Error("Container ownership mismatch");
        const observed = await session.exec(
          {
            program: "bash",
            args: [
              "-c",
              'id -u; node --version; git log --all --format=%T | sort -u | wc -l; test ! -e /eval.sh && test ! -e /gold.patch && test ! -e /candidate.patch; test "$(readlink -f /testbed)" = /workspace',
            ],
          },
          AbortSignal.timeout(20_000),
        );
        const lines = observed.stdout.trim().split("\n");
        const boundary = {
          flattened: bridge.flattened,
          gitRoots: audit.gitRoots,
          distinctTrees: Number(lines[2]),
          privateMatches: audit.findings.length,
          imageId: fixture.imageId,
          auditedImageId: audit.imageId,
          network: info.HostConfig.NetworkMode,
          user: lines[0] ?? "",
        };
        if (observed.exitCode !== 0 || !auditBoundary(boundary))
          throw Error("Runtime boundary failed");
        await fs.writeFile(
          path.join(output, "runtime-audit.json"),
          JSON.stringify(boundary, null, 2),
        );
        return session;
      },
      maxAttempts: liveModels?.maxAttempts ?? 1,
      issue: { title: fixture.task.title, body: fixture.task.description },
      checks: fixture.publicChecks.checks,
      maxRevisions: args.live ? 2 : 0,
      protectedPath,
      model: liveModels?.solver.model ?? new FakeLanguageModel(responses),
      ...(liveModels
        ? {
            settings: {
              ...liveModels.solver.settings,
              reasoningEffort: args.reasoning as never,
              maxOutputTokens: Number(args["max-output"]),
            },
            price: liveModels.solver.price,
            review: liveModels.review,
          }
        : {}),
      limits: {
        maxTurns: args.live ? 80 : 10,
        deadlineAt: Date.now() + (args.live ? 1_500_000 : 300_000),
        ...(liveModels ? { maxInputTokens: liveModels.solver.contextTokens } : {}),
      },
      signal: runSignal,
      onEvent: (event) => {
        events.push(event);
      },
    };
    result =
      caseBudget === undefined
        ? await runAttempts(solveInput)
        : await runWithinBudget(solveInput, caseBudget);
    if (ledger) {
      settled = true;
      await ledger.settle(caseId, result.usage.costMicros + result.usage.unconfirmedCostMicros);
    }
    if (!args.live && result.selected.kernel.stopReason !== "SUBMITTED")
      throw Error("Control did not submit");
    // The existing solver intentionally skips verification when no files changed.
    // Still run the same public checks on the empty negative control, without
    // another model turn or claiming that an empty patch fixes the issue.
    const verification = result.selected.verification ?? {
      checks: args.live
        ? []
        : await runChecks(session!, fixture.publicChecks.checks, AbortSignal.timeout(120_000), 115),
      protectedChanges: [],
    };
    if (
      !args.live &&
      args.script !== "wrong" &&
      (verification.checks.length !== fixture.publicChecks.checks.length ||
        verification.checks.some((check) => check.status !== "PASS"))
    )
      throw Error("Scripted candidate public validation failed");
    await fs.writeFile(path.join(output, "candidate.diff"), result.selected.patch);
    await fs.writeFile(
      path.join(output, "runtime-result.json"),
      JSON.stringify(
        {
          usage: result.usage,
          attempts: result.attempts.length,
          revisions: result.attempts.reduce((n, a) => n + a.solve.revisions, 0),
          reviewCostMicros: result.attempts.at(-1)?.solve.reviewSpentMicros ?? 0,
          changedFiles: result.selected.changedFiles,
          stop: result.selected.kernel.stopReason,
          publicProfile: fixture.publicChecks.status,
          publicValidation: verification.checks.length
            ? verification.checks.every((c) => c.status === "PASS")
              ? "PASS"
              : "FAIL"
            : "NOT_RUN",
          verification,
          review: result.selected.review?.verdict ?? "NOT_RUN",
          paid: args.live,
          elapsedSeconds: (Date.now() - startedAt) / 1000,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await fs.writeFile(
      path.join(output, "result.json"),
      redact(
        {
          caseId,
          status: "ERROR",
          stopReason: "RUNTIME_OR_VALIDATION_ERROR",
          error: error instanceof Error ? error.message : "Unknown error",
          durationSeconds: (Date.now() - startedAt) / 1000,
          usage: result?.usage,
          attempts: result?.attempts.length ?? 0,
          revisions: result?.attempts.reduce((n, a) => n + a.solve.revisions, 0) ?? 0,
          totalCostMicros: result?.usage.costMicros ?? null,
          unconfirmedCostMicros: result?.usage.unconfirmedCostMicros ?? caseBudget ?? null,
          reviewCostMicros: result?.attempts.at(-1)?.solve.reviewSpentMicros ?? null,
          tokenUsage: result?.usage ?? null,
          officialResolved: false,
          strictPatchPass: false,
          review: result?.selected.review?.verdict ?? "NOT_RUN",
        },
        process.env,
      ),
    );
    throw args.live ? Error("External live execution failed; see redacted private result") : error;
  } finally {
    if (ledger && !settled) await ledger.settle(caseId);
    await fs.writeFile(path.join(output, "events.json"), redact(events, process.env));
    await session?.dispose();
  }
  // Solver is disposed before private grading artifacts are read or copied.
  const campaign = (experiment ? path.basename(experiment) : args.campaign) + "-" + modeTag;
  if (result.selected.changedFiles.some((p) => !!protectedPath(p))) {
    await fs.writeFile(
      path.join(output, "result.json"),
      redact(
        {
          caseId,
          officialResolved: false,
          strictPatchPass: false,
          stopReason: "PROTECTED_CHANGES",
          usage: result.usage,
          attempts: result.attempts.length,
          review: result.selected.review?.verdict ?? "NOT_RUN",
          durationSeconds: (Date.now() - startedAt) / 1000,
        },
        process.env,
      ),
    );
    continue;
  }
  try {
    execFileSync(
      args.python,
      [
        "-B",
        "-X",
        "utf8",
        "scripts/v4/external-set/stage1_preflight.py",
        "--cases",
        caseId,
        "--campaign",
        campaign,
        "--patch-file",
        path.join(output, "candidate.diff"),
        ...(preparation.materializeBase ? ["--materialize-base"] : []),
        ...(preparation.pytestReportAll ? ["--pytest-report-all"] : []),
      ],
      { timeout: 360_000, stdio: "inherit" },
    );
    const scoreDirectory = path.join(suite, "private", "preflight", campaign, caseId, "bridge-1");
    const raw = await json(path.join(scoreDirectory, "result.json"));
    const report: OfficialCaseReport = (
      await json(path.join(scoreDirectory, "official-report.json"))
    )[fixture.source.instanceId];
    const record = await json(path.join(privateDirectory, "record.json"));
    const mapped = mapOfficial(
      report,
      { f2p: record.FAIL_TO_PASS, p2p: record.PASS_TO_PASS },
      {
        nonemptyPatch: !!result.selected.patch.trim(),
        protectedChanges: result.selected.changedFiles.filter((p) => !!protectedPath(p)),
        network: raw.network,
        durationSeconds: raw.durationSeconds,
      },
    );
    await fs.writeFile(path.join(output, "score.json"), JSON.stringify(mapped, null, 2));
    if (!args.live && mapped.strictPatchPass !== (args.script === "golden"))
      throw Error("Unexpected control verdict: " + caseId);
    await fs.writeFile(
      path.join(output, "result.json"),
      redact(
        {
          caseId,
          ...mapped,
          attempts: result.attempts.length,
          revisions: result.attempts.reduce((n, a) => n + a.solve.revisions, 0),
          review: result.selected.review?.verdict ?? "NOT_RUN",
          totalCostMicros: result.usage.costMicros,
          unconfirmedCostMicros: result.usage.unconfirmedCostMicros,
          reviewCostMicros: result.attempts.at(-1)?.solve.reviewSpentMicros ?? 0,
          tokenUsage: result.usage,
          durationSeconds: (Date.now() - startedAt) / 1000,
          stopReason: result.selected.kernel.stopReason,
          strictWorkflowPass:
            mapped.strictPatchPass &&
            result.selected.verification?.passed === true &&
            result.selected.review?.verdict === "PASS",
        },
        process.env,
      ),
    );
    console.log(JSON.stringify({ caseId, script: modeTag, ...mapped }));
  } catch (error) {
    await fs.writeFile(
      path.join(output, "result.json"),
      redact(
        {
          caseId,
          officialResolved: false,
          strictPatchPass: false,
          stopReason: "GRADING_ERROR",
          error: error instanceof Error ? error.message : "Unknown error",
          usage: result.usage,
          attempts: result.attempts.length,
          durationSeconds: (Date.now() - startedAt) / 1000,
        },
        process.env,
      ),
    );
    throw args.live ? Error("External live grading failed; see redacted private result") : error;
  }
}
