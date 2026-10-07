import { canonicalJson, sha256 } from "@devflow/eval";
import { SandboxGitService } from "@devflow/git";
import { DevflowError, type AgentPlan } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import { z } from "zod";
import { graphPathAllowed } from "../localization/relation-graph.js";
import { extractRepairDiagnostics } from "./workflow-context.js";
import { resolveRepairDiagnostics } from "./repair-diagnostics.js";

const Identity = z.union([z.string().regex(/^[a-f0-9]{64}$/u), z.literal("ABSENT")]);
export const ScopeReplanStateSchema = z.object({
  version: z.literal(1),
  used: z.literal(1),
  preparation: z
    .object({
      reads: z.number().int().nonnegative(),
      sourceBytes: z.number().int().nonnegative(),
      cacheHits: z.number().int().nonnegative(),
      readLimit: z.number().int().min(0).max(8).optional(),
      plannedReadPaths: z.array(z.string()).optional(),
      omittedTestPaths: z.array(z.string()).optional(),
      navigationReadAllowance: z.number().int().min(0).max(2).optional(),
      metadataOperations: z.number().int().nonnegative().optional(),
      metadataCacheHits: z.number().int().nonnegative().optional(),
      downstreamToolReserve: z.number().int().nonnegative().optional(),
    })
    .optional(),
  evidenceRecords: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().int().positive().optional(),
        currentSha256: z.string(),
        hostRegion: z
          .object({
            startLine: z.number().int().positive(),
            endLine: z.number().int().positive(),
            quote: z.string(),
            selection: z.enum(["PUBLIC_SYMBOL_OVERLAP", "MODEL_SYMBOL_HINT"]),
          })
          .optional(),
        testEvidence: z
          .array(
            z.object({
              path: z.string(),
              fileSha256: z.string(),
              startLine: z.number().int().positive(),
              endLine: z.number().int().positive(),
              quote: z.string(),
              source: z.enum(["HOST_DIAGNOSTIC_READ", "MODEL_CITATION"]),
            }),
          )
          .optional(),
        basis: z.enum(["DIRECT_DIAGNOSTIC", "TEST_EVIDENCE"]),
        diagnosticPaths: z.array(z.string()),
        relationship: z.literal("HYPOTHESIS_FOR_PLANNER"),
      }),
    )
    .optional(),
  status: z.enum(["RESERVED", "WAITING_APPROVAL", "RESUMED", "BLOCKED"]),
  previousApprovalId: z.string().min(1),
  baseCommitSha: z.string().min(1),
  taskBaseCommitSha: z.string().optional(),
  sourceManifestHash: z.string().optional(),
  planSha256: z.string().optional(),
  repairAttempts: z.number().int().nonnegative(),
  reviewAttempts: z.number().int().nonnegative(),
  repairInFlight: z.boolean().optional(),
  reason: z.string(),
  diagnostic: z.string(),
  candidatePaths: z.array(z.string()).max(8),
  profileSha256: z.string().optional(),
  testResult: z
    .object({
      exitCode: z.number().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number(),
      timedOut: z.boolean(),
      outputTruncated: z.boolean(),
    })
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        baselineSha256: Identity,
        currentSha256: Identity,
        content: z.string().nullable(),
      }),
    )
    .max(16),
  patchSha256: z.string().optional(),
});
export type ScopeReplanState = z.infer<typeof ScopeReplanStateSchema>;
export const approvedPlanIdentity = (plan: AgentPlan) => sha256(canonicalJson(plan));

/** Model requests are hints. A real public diagnostic and current host source are required. */
export function verifiedReplanPaths(
  requested: readonly string[],
  diagnostic: string,
  approved: readonly string[],
  allowed: (path: string) => boolean,
  repositoryPaths: readonly string[] = extractRepairDiagnostics(diagnostic).map((d) => d.path),
  manifestComplete = true,
) {
  const locations = new Set(
    resolveRepairDiagnostics(diagnostic, repositoryPaths, manifestComplete).resolved.map(
      (d) => d.path,
    ),
  );
  const candidates = requested.length ? requested : [...locations];
  return [...new Set(candidates)]
    .filter(
      (path) =>
        graphPathAllowed(path) && allowed(path) && !approved.includes(path) && locations.has(path),
    )
    .slice(0, 8);
}

export async function captureReplanCandidate(input: {
  sandbox: SandboxSession;
  paths: readonly string[];
  baseCommitSha: string;
  signal: AbortSignal;
  beforeRead: () => void;
}): Promise<Pick<ScopeReplanState, "files" | "patchSha256">> {
  const git = new SandboxGitService();
  input.beforeRead();
  if ((await git.head(input.sandbox, input.signal)) !== input.baseCommitSha)
    throw new Error("REPLAN_BASE_IDENTITY_CHANGED");
  input.beforeRead();
  const status = await input.sandbox.exec(
    {
      program: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs: 20_000,
      maxOutputBytes: 500_000,
    },
    input.signal,
  );
  if (status.exitCode !== 0 || status.timedOut || status.outputTruncated)
    throw new Error("REPLAN_STATUS_INCOMPLETE");
  const records = status.stdout.split("\0").filter(Boolean);
  const changedPaths = new Set<string>();
  // Every current untracked path is expanded; a directory prefix cannot conceal extra writes.
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record.startsWith("## ")) continue;
    const paths = [record.slice(3)];
    if (/^[RC]|^.[RC]/u.test(record) && records[i + 1]) paths.push(records[++i]!);
    for (const path of paths) {
      if (!input.paths.includes(path)) throw new Error(`REPLAN_UNAPPROVED_CANDIDATE:${path}`);
      changedPaths.add(path);
    }
  }
  const files: ScopeReplanState["files"] = [];
  let bytes = 0;
  for (const path of changedPaths) {
    if (!graphPathAllowed(path)) throw new Error("REPLAN_INVALID_CANDIDATE_PATH");
    input.beforeRead();
    const baseline = await input.sandbox.exec(
      {
        program: "git",
        args: ["show", `${input.baseCommitSha}:${path}`],
        timeoutMs: 20_000,
        maxOutputBytes: 512 * 1024,
      },
      input.signal,
    );
    if (baseline.timedOut || baseline.outputTruncated)
      throw new Error("REPLAN_BASE_SOURCE_INCOMPLETE");
    const baselineSha256 = baseline.exitCode === 0 ? sha256(baseline.stdout) : "ABSENT";
    if (
      baseline.exitCode !== 0 &&
      !/does not exist|exists on disk, but not in/u.test(baseline.stderr)
    )
      throw new Error("REPLAN_BASE_SOURCE_UNAVAILABLE");
    input.beforeRead();
    let content: string | null = null,
      currentSha256: string = "ABSENT";
    try {
      const source = await input.sandbox.readFile({ path, maxBytes: 512 * 1024 }, input.signal);
      if (source.truncated || !source.fileSha256 || sha256(source.content) !== source.fileSha256)
        throw new Error("REPLAN_CURRENT_SOURCE_INCOMPLETE");
      content = source.content;
      currentSha256 = source.fileSha256;
    } catch (error) {
      if (!(error instanceof DevflowError && error.code === "NOT_FOUND")) throw error;
    }
    bytes += Buffer.byteLength(content ?? "");
    if (bytes > 1024 * 1024) throw new Error("REPLAN_CHECKPOINT_TOO_LARGE");
    files.push({ path, baselineSha256, currentSha256, content });
  }
  return {
    files,
    patchSha256: sha256(
      canonicalJson(files.map((f) => [f.path, f.baselineSha256, f.currentSha256])),
    ),
  };
}

export async function restoreReplanCandidate(input: {
  state: ScopeReplanState;
  sandbox: SandboxSession;
  oldApprovedPaths: readonly string[];
  signal: AbortSignal;
  beforeRead: () => void;
}) {
  const { state, sandbox, signal } = input;
  const git = new SandboxGitService();
  input.beforeRead();
  if ((await git.head(sandbox, signal)) !== state.baseCommitSha)
    throw new Error("REPLAN_RESTORE_BASE_MISMATCH");
  input.beforeRead();
  const clean = await sandbox.exec(
    {
      program: "git",
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      timeoutMs: 20000,
      maxOutputBytes: 500000,
    },
    signal,
  );
  if (clean.exitCode !== 0 || clean.timedOut || clean.outputTruncated || clean.stdout.trim())
    throw new Error("REPLAN_RESTORE_WORKSPACE_NOT_CLEAN");
  if (
    state.patchSha256 !==
    sha256(canonicalJson(state.files.map((f) => [f.path, f.baselineSha256, f.currentSha256])))
  )
    throw new Error("REPLAN_CHECKPOINT_IDENTITY_MISMATCH");
  // Validate every record before any restore write.
  for (const file of state.files) {
    if (
      !input.oldApprovedPaths.includes(file.path) ||
      !graphPathAllowed(file.path) ||
      (file.content === null
        ? file.currentSha256 !== "ABSENT"
        : sha256(file.content) !== file.currentSha256)
    )
      throw new Error("REPLAN_CHECKPOINT_SCOPE_OR_CONTENT_INVALID");
    input.beforeRead();
    try {
      const source = await sandbox.readFile({ path: file.path, maxBytes: 1 }, signal);
      if (source.fileSha256 !== file.baselineSha256)
        throw new Error("REPLAN_RESTORE_SOURCE_MISMATCH");
    } catch (error) {
      if (!(
        error instanceof DevflowError &&
        error.code === "NOT_FOUND" &&
        file.baselineSha256 === "ABSENT"
      ))
        throw error;
    }
  }
  for (const file of state.files)
    if (file.currentSha256 !== file.baselineSha256) {
      input.beforeRead();
      if (file.content !== null)
        await sandbox.writeFile(
          {
            path: file.path,
            content: file.content,
            ...(file.baselineSha256 !== "ABSENT" ? { expectedSha256: file.baselineSha256 } : {}),
          },
          signal,
        );
      else {
        const deleted = await sandbox.exec(
          {
            program: "node",
            args: ["-e", "require('node:fs').unlinkSync(process.argv[1])", file.path],
            timeoutMs: 10_000,
          },
          signal,
        );
        if (deleted.exitCode !== 0) throw new Error("REPLAN_RESTORE_DELETE_FAILED");
      }
    }
  for (const file of state.files) {
    input.beforeRead();
    try {
      const source = await sandbox.readFile({ path: file.path, maxBytes: 1 }, signal);
      if (source.fileSha256 !== file.currentSha256)
        throw new Error("REPLAN_RESTORED_SOURCE_MISMATCH");
    } catch (error) {
      if (!(
        error instanceof DevflowError &&
        error.code === "NOT_FOUND" &&
        file.currentSha256 === "ABSENT"
      ))
        throw error;
    }
  }
}
