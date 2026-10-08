import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  repairContextSourcePaths,
  repairDiagnosticTasks,
  sourceEvidenceRecord,
} from "./repair-tasks.js";
import type { CurrentSourceCache } from "./current-source-cache.js";
import { stableFailureStream } from "./repair-convergence.js";
import { resolveRepairDiagnostics } from "./repair-diagnostics.js";
export { extractRepairDiagnostics } from "./repair-diagnostics.js";
import type { WorkingCode } from "@devflow/agent";
import { DevflowError } from "@devflow/shared";

import type { SandboxGitService } from "@devflow/git";
import { parseGitHubRepositoryUri, type GitHubProvider } from "@devflow/github";
import {
  readFileContent,
  validateReadFileRequest,
  type CommandResult,
  type SandboxSession,
} from "@devflow/sandbox";

const REPOSITORY_CONTEXT_LIMIT = 180 * 1024;
const REPAIR_CONTEXT_LIMIT = 32 * 1024;
const PRELOAD_TOTAL_LIMIT = 200 * 1024;
const PRELOAD_FILE_LIMIT = 20;
const REVIEW_CONTEXT_LIMIT = 176 * 1024;

export interface DeterministicContext {
  text: string;
  toolExecutions: number;
  toolLatencyMs: number;
  toolWorkRecorded?: boolean;
}

export interface RepositoryComplexityProfile {
  availability: "COMPLETE" | "TRUNCATED" | "UNAVAILABLE";
  fileCount?: number;
  totalBytes?: number;
  relevantFileCount?: number;
  languageIndicators: readonly string[];
  frameworkIndicators: readonly string[];
  manifestFiles: readonly string[];
  moduleCount?: number;
  testAvailability: "AVAILABLE" | "NOT_DETECTED" | "UNKNOWN";
  testIndicators: readonly string[];
}

export interface RepositoryProfileEntry {
  path: string;
  sizeBytes?: number;
  kind?: "FILE" | "SYMLINK" | "DIRECTORY";
}

interface RepositoryProfileTask {
  title: string;
  description: string;
}

export interface RepairContext extends DeterministicContext {
  evidenceRecords?: ReturnType<typeof sourceEvidenceRecord>[];
  diagnosticTasks?: ReturnType<typeof repairDiagnosticTasks>;
  diagnosticResolution?: ReturnType<typeof resolveRepairDiagnostics>;
  stableTaskContext: string;
  currentSources: WorkingCode[];
  diffFingerprint: string;
  testFingerprint: string;
  changedFiles: readonly string[];
  evidence: { version: "repair-evidence-v1"; sections: Record<string, string> };
  evidenceSha256: string;
}

export function readRepairEvidence(
  input: {
    sha256: string;
    section: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
  },
  evidence: RepairContext["evidence"] | undefined,
) {
  if (!evidence || sha256(JSON.stringify(evidence)) !== input.sha256)
    throw new Error("Repair evidence is unavailable or its hash changed.");
  if (
    evidence.version !== "repair-evidence-v1" ||
    typeof evidence.sections[input.section] !== "string"
  )
    throw new Error(
      `Unknown public repair evidence section ${input.section}; valid sections: ${Object.keys(evidence.sections).join(", ")}.`,
    );
  if ((input.startLine === undefined) !== (input.endLine === undefined))
    throw new Error(
      'readEvidenceArtifact.startLine/endLine: supply both positive inclusive bounds (at most 300 lines), or omit both for lines 1..80. Example: {sha256, section:"diff", startLine:1, endLine:80}.',
    );
  const request = {
    path: input.section,
    startLine: input.startLine ?? 1,
    endLine: input.endLine ?? 80,
    maxBytes: 8192,
  };
  validateReadFileRequest(request);
  return {
    ...readFileContent(Buffer.from(evidence.sections[input.section]!), request),
    defaultRange: input.startLine === undefined,
    artifactSha256: input.sha256,
    historical: true,
    note: "Historical public repair evidence; read current workspace source before editing. This grants no permission.",
  };
}

export async function buildRepositoryContext(
  sandbox: SandboxSession,
  signal: AbortSignal,
  task?: RepositoryProfileTask,
): Promise<DeterministicContext & { repositoryProfile: RepositoryComplexityProfile }> {
  const startedAt = Date.now();
  const listing = await sandbox.listFiles({ path: ".", recursive: true, maxEntries: 500 }, signal);
  let executions = 1;
  const files = listing.entries
    .filter((entry) => entry.kind === "FILE" && isUsefulTextPath(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  const tree = listing.entries
    .filter((entry) => !isIgnoredPath(entry.path))
    .map((entry) => `${entry.kind === "DIRECTORY" ? "d" : "f"} ${entry.path}`)
    .join("\n");
  const totalSize = files.reduce((sum, entry) => sum + (entry.sizeBytes ?? PRELOAD_TOTAL_LIMIT), 0);
  const sections = [`Repository tree${listing.truncated ? " (truncated)" : ""}:\n${tree}`];

  if (files.length <= PRELOAD_FILE_LIMIT && totalSize <= PRELOAD_TOTAL_LIMIT) {
    const contents = await Promise.all(
      files.map(async (entry) => {
        try {
          const file = await sandbox.readFile({ path: entry.path, maxBytes: 64 * 1024 }, signal);
          return `--- ${file.path}${file.truncated ? " (truncated)" : ""}\n${file.content}`;
        } catch (error) {
          return `--- ${entry.path}\n[unreadable: ${errorMessage(error)}]`;
        }
      }),
    );
    executions += files.length;
    sections.push(`Small-repository file snapshot:\n${contents.join("\n\n")}`);
  } else {
    sections.push(
      "The repository is larger than the deterministic preload threshold. Use targeted batch reads or searches only for files relevant to the task.",
    );
  }

  return {
    text: truncate(sections.join("\n\n"), REPOSITORY_CONTEXT_LIMIT),
    toolExecutions: executions,
    toolLatencyMs: Math.max(0, Date.now() - startedAt),
    repositoryProfile: buildRepositoryComplexityProfile(listing.entries, {
      availability: listing.truncated ? "TRUNCATED" : "COMPLETE",
      ...(task === undefined ? {} : { task }),
    }),
  };
}

/**
 * Produces a bounded, content-free repository profile for PLAN and budget
 * selection. It deliberately uses paths and sizes only, so a LOCAL snapshot can
 * be profiled before approval without replaying source files into the model.
 */
export function buildRepositoryComplexityProfile(
  entries: readonly RepositoryProfileEntry[],
  options: {
    availability?: "COMPLETE" | "TRUNCATED";
    task?: RepositoryProfileTask;
  } = {},
): RepositoryComplexityProfile {
  const files = entries
    .filter((entry) => entry.kind !== "DIRECTORY" && !isIgnoredPath(entry.path))
    .map((entry) => ({ ...entry, path: entry.path.replaceAll("\\", "/") }));
  const paths = files.map(({ path }) => path);
  const manifests = paths.filter(isManifestPath).slice(0, 24);
  const tests = paths.filter(isTestPath).slice(0, 24);
  const taskTokens = taskSearchTokens(options.task);
  const relevantFileCount =
    taskTokens.length === 0
      ? undefined
      : paths.filter((path) => {
          const candidate = path.toLowerCase();
          return taskTokens.some((token) => candidate.includes(token));
        }).length;
  const moduleRoots = new Set(
    paths
      .map((path) => path.split("/")[0])
      .filter((segment): segment is string => segment !== undefined && segment.length > 0),
  );

  return {
    availability: options.availability ?? "COMPLETE",
    fileCount: files.length,
    totalBytes: files.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
    ...(relevantFileCount === undefined ? {} : { relevantFileCount }),
    languageIndicators: detectLanguages(paths),
    frameworkIndicators: detectFrameworks(paths),
    manifestFiles: manifests,
    moduleCount: moduleRoots.size,
    testAvailability: tests.length === 0 ? "NOT_DETECTED" : "AVAILABLE",
    testIndicators: tests,
  };
}

export function unavailableRepositoryComplexityProfile(): RepositoryComplexityProfile {
  return {
    availability: "UNAVAILABLE",
    languageIndicators: [],
    frameworkIndicators: [],
    manifestFiles: [],
    testAvailability: "UNKNOWN",
    testIndicators: [],
  };
}

export async function buildGitHubRepositoryComplexityProfile(input: {
  provider: Pick<GitHubProvider, "readRepositoryTree">;
  sourceUri: string;
  baseCommitSha?: string;
  task: RepositoryProfileTask;
  signal?: AbortSignal;
}): Promise<RepositoryComplexityProfile> {
  if (input.baseCommitSha === undefined || !/^[0-9a-f]{40}$/iu.test(input.baseCommitSha)) {
    return unavailableRepositoryComplexityProfile();
  }
  try {
    const tree = await input.provider.readRepositoryTree(
      {
        repository: parseGitHubRepositoryUri(input.sourceUri),
        baseCommitSha: input.baseCommitSha.toLowerCase(),
      },
      input.signal,
    );
    const entries = tree.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    }));
    return buildRepositoryComplexityProfile(entries, {
      availability: tree.truncated ? "TRUNCATED" : "COMPLETE",
      task: input.task,
    });
  } catch (error) {
    if (input.signal?.aborted === true) throw input.signal.reason ?? error;
    return unavailableRepositoryComplexityProfile();
  }
}

export async function buildRepairContext(
  git: SandboxGitService,
  sandbox: SandboxSession,
  test: CommandResult,
  signal: AbortSignal,
  extra?: string,
  options: {
    evidenceRecoveryAvailable?: boolean;
    workspaceRevision?: number;
    additionalSources?: readonly { path: string; line?: number | undefined }[];
    repositoryManifest?: { paths: readonly string[]; complete: boolean };
    beforeOperation?: () => void;
    sourceCache?: CurrentSourceCache;
  } = {},
): Promise<RepairContext> {
  const startedAt = Date.now();
  options.beforeOperation?.();
  const status = await git.status(sandbox, signal);
  options.beforeOperation?.();
  const diff = await git.diff(sandbox, { maxBytes: 80 * 1024 }, signal);
  let executions = 2;
  const diagnosticText = test.stdout + "\n" + test.stderr;
  const changedPaths = status.files.map(({ path }) => path.split(" -> ").at(-1) ?? path);
  let repositoryPaths = [
    ...new Set([...(options.repositoryManifest?.paths ?? []), ...changedPaths]),
  ];
  let manifestComplete = options.repositoryManifest?.complete ?? false;
  if (!options.repositoryManifest)
    try {
      options.beforeOperation?.();
      const listing = await sandbox.listFiles(
        { path: ".", recursive: true, maxEntries: 2000 },
        signal,
      );
      executions++;
      manifestComplete = !listing.truncated;
      repositoryPaths = listing.entries
        .filter((e) => e.kind === "FILE")
        .map((e) => e.path.replace(/^\.\//u, ""));
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof DevflowError && error.code === "EXECUTION_BUDGET_EXCEEDED") throw error;
    }
  const diagnosticResolution = resolveRepairDiagnostics(
    diagnosticText,
    repositoryPaths,
    manifestComplete,
  );
  const resolvedDiagnostics = diagnosticResolution.resolved;
  const changedFiles = repairContextSourcePaths({
    resolution: diagnosticResolution,
    changedPaths,
    ...(options.additionalSources ? { additionalSources: options.additionalSources } : {}),
  });
  const relevantFiles = await Promise.all(
    changedFiles.map(async (path) => {
      try {
        const section = diff.patch.split(`+++ b/${path}`)[1]?.split(/^diff --git /mu)[0] ?? "";
        const changedLine =
          resolvedDiagnostics.find((d) => d.path === path)?.line ??
          options.additionalSources?.find((source) => source.path === path)?.line ??
          Number(section.match(/^@@ [^+]*\+(\d+)/mu)?.[1] ?? 1);
        const startLine = Math.max(1, changedLine - 8);
        const cached = options.sourceCache?.source(sandbox, path);
        if (cached) {
          const lines = cached.content.split("\n");
          const selected: string[] = [];
          let bytes = 0;
          const maxBytes = Math.min(6000, Math.floor(6400 / Math.max(1, changedFiles.length)));
          for (const line of lines.slice(startLine - 1, startLine + 79)) {
            const next = Buffer.byteLength(line) + (selected.length ? 1 : 0);
            if (bytes + next > maxBytes) break;
            selected.push(line);
            bytes += next;
          }
          const endLine = Math.max(startLine, startLine + selected.length - 1);
          const partial = startLine > 1 || endLine < lines.length || !selected.length;
          return `--- ${path}:${startLine}..${endLine} SHA=${cached.contentHash}${partial ? " (partial)" : ""}\n${selected.join("\n")}`;
        }
        options.beforeOperation?.();
        executions++;
        const file = await sandbox.readFile(
          {
            path,
            startLine,
            endLine: startLine + 79,
            maxBytes: Math.min(6000, Math.floor(6400 / Math.max(1, changedFiles.length))),
          },
          signal,
        );
        if (file.fileSha256) options.sourceCache?.rememberIdentity(sandbox, path, file.fileSha256);
        return `--- ${file.path}:${file.startLine ?? startLine}..${file.endLine ?? "unknown"} SHA=${file.fileSha256 ?? "unavailable"}${file.truncated ? " (partial)" : ""}\n${file.content}`;
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof DevflowError && error.code === "EXECUTION_BUDGET_EXCEEDED")
        )
          throw error;
        return `--- ${path}\n[unreadable: ${errorMessage(error)}]`;
      }
    }),
  );
  const currentSources: RepairContext["currentSources"] = relevantFiles.flatMap((text, i) => {
    const match = text.match(/^--- .*?:(\d+)\.\.(\d+) SHA=([a-f0-9]{64})([^\n]*)\n([\s\S]*)$/u);
    return match
      ? [
          {
            path: changedFiles[i]!,
            startLine: Number(match[1]),
            endLine: Number(match[2]),
            contentHash: match[3]!,
            workspaceRevision: options.workspaceRevision ?? 0,
            code: match[5]!,
            complete: !match[4]!.includes("partial"),
            role: "TARGET" as const,
          },
        ]
      : [];
  });
  while (Buffer.byteLength(JSON.stringify(currentSources)) > 8192) currentSources.pop();
  const diagnosticTasks = repairDiagnosticTasks(diagnosticText, diagnosticResolution);
  const stableTestFingerprint = testResultFingerprint(test);
  const evidence = {
    version: "repair-evidence-v1" as const,
    sections: {
      diff: diff.patch,
      stdout: test.stdout,
      stderr: test.stderr,
      extra: extra ?? "",
      ...Object.fromEntries(changedFiles.map((path, i) => [`file:${path}`, relevantFiles[i]!])),
    },
  };
  const evidenceSha256 = sha256(JSON.stringify(evidence));
  const excerpt = (value: string, cap: number) => {
    if (Buffer.byteLength(value) <= cap) return value;
    const head = truncate(value, Math.floor(cap / 4));
    let tail = value.slice(-Math.floor(cap / 2));
    while (Buffer.byteLength(tail) > Math.floor(cap / 2)) tail = tail.slice(1);
    return `${head}\n[Middle omitted; full evidence is recoverable]\n${tail}`;
  };
  const text = truncate(
    [
      "Use the public Issue reproduction as well as existing tests; passing repository tests alone does not establish the reported Issue is fixed. Preserve existing behavior and protected tests.",
      options.evidenceRecoveryAvailable === false
        ? `Public repair evidence SHA=${evidenceSha256}; artifact recovery is disabled by tool policy. Use permitted current source reads. This reference does not grant write permission.`
        : `Full public repair evidence SHA=${evidenceSha256}; recover sections diff/stdout/stderr/extra/file:<path> with readEvidenceArtifact. This reference does not grant write permission.`,
      `Changed files: ${changedFiles.length === 0 ? "(none)" : changedFiles.join(", ")}`,
      `Current diff summary: files=${String(diff.filesChanged)} additions=${String(diff.additions ?? "unknown")} deletions=${String(diff.deletions ?? "unknown")} truncated=${String(diff.truncated)}`,
      `Current diff excerpt:\n${excerpt(diff.patch, 4096)}`,
      `Public validation identity: exitCode=${String(test.exitCode)} timedOut=${String(test.timedOut)} outputTruncated=${String(test.outputTruncated)} fingerprint=${stableTestFingerprint}. Unfinished diagnostic tasks are in stable task state.`,
      `Host source references (use evidenceRefs in finishPhase, or current exact quotes): ${JSON.stringify(currentSources.map((source) => sourceEvidenceRecord(source, evidenceSha256)))}`,
      currentSources.length === 0
        ? undefined
        : `Current host-read source (revision=${options.workspaceRevision ?? 0}; partial ranges do not authorize whole-file replacement):\n${JSON.stringify(currentSources)}`,
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join("\n\n"),
    REPAIR_CONTEXT_LIMIT,
  );
  return {
    text,
    diagnosticResolution,
    diagnosticTasks,
    evidenceRecords: currentSources.map((source) => sourceEvidenceRecord(source, evidenceSha256)),
    stableTaskContext: [
      stableRepairRequirements(extra ?? ""),
      "Unfinished diagnostic requirements (remain tasks after source edits):",
      JSON.stringify(diagnosticTasks),
      `Public test outcome (not automatically cleared by an edit): exitCode=${test.exitCode}; full log artifact SHA=${evidenceSha256}.`,
      "Preserve already-passing behavior and host scope. Report every supplied finding ID; source versions are separate evidence. A reply never bypasses Test or independent Review.",
    ].join("\n"),
    currentSources,
    toolExecutions: executions,
    toolWorkRecorded: options.beforeOperation !== undefined,
    toolLatencyMs: Math.max(0, Date.now() - startedAt),
    changedFiles,
    evidence,
    evidenceSha256,
    diffFingerprint: sha256(diff.patch),
    testFingerprint: stableTestFingerprint,
  };
}

function stableRepairRequirements(extra: string): string {
  const start = extra.indexOf("[");
  if (start >= 0) {
    try {
      const findings = JSON.parse(extra.slice(start));
      if (Array.isArray(findings))
        return (
          extra.slice(0, start) +
          JSON.stringify(
            findings.map((f) => ({
              findingId: f.findingId,
              kind: f.kind,
              severity: f.severity,
              message: f.message,
              behavior: f.behavior,
              note: "Original source citations are versioned evidence; refresh before edits or evidence responses.",
            })),
          )
        );
    } catch {
      /* Plain diagnostic context remains stable text. */
    }
  }
  return extra;
}

// Raw stdout/stderr remain in TEST_RESULT and artifacts. Only prompt presentation changes.
function conciseTestStream(value: string): string {
  let omitted = 0;
  const lines = stripVTControlCharacters(value)
    .split("\n")
    .filter((line) => {
      if (/^\s*✓\s+.+\(\d+ tests?\)\s+\d+(?:\.\d+)?(?:ms|s)\s*$/u.test(line)) {
        omitted++;
        return false;
      }
      return true;
    });
  return (
    lines.join("\n") +
    (omitted
      ? "\n[" +
        String(omitted) +
        " passing file summaries omitted; full raw output is retained in TEST_RESULT]"
      : "")
  );
}

export function compactTestOutput(result: CommandResult): string {
  return truncate(
    `exitCode=${String(result.exitCode)} durationMs=${String(result.durationMs)} timedOut=${String(result.timedOut)}\nstdout:\n${truncate(conciseTestStream(result.stdout), 20 * 1024)}\nstderr:\n${truncate(conciseTestStream(result.stderr), 20 * 1024)}`,
    48 * 1024,
  );
}

export function buildReviewContext(input: {
  title: string;
  description: string;
  plan: unknown;
  test: CommandResult & { skipped?: boolean };
  diff: string;
  sourceEvidence?: unknown;
  compact?: boolean;
}): string {
  // Internal policy can name private evaluator paths. Only its public rules
  // belong in the model projection; source reads still use the full policy.
  const evidence = input.sourceEvidence as
    { policy?: { protectTests?: boolean; protectInfrastructure?: boolean } } | undefined;
  const publicEvidence = evidence
    ? {
        ...evidence,
        policy: {
          protectTests: evidence.policy?.protectTests === true,
          protectInfrastructure: evidence.policy?.protectInfrastructure === true,
        },
      }
    : { unavailable: ["No current source supplied; do not assume missing branches are absent."] };
  const boundedEvidence = publicEvidence as typeof publicEvidence & {
    sources?: { path?: string; content?: string; fileSha256?: string; view?: string }[];
    findingHistory?: {
      path?: string;
      evidence?: { quote: string; fileSha256: string };
      scopeAssessment?: { baselineEvidence?: { path: string; quote: string } };
    }[];
    omittedSourceRanges?: number;
    repairResponse?: {
      evidenceStatus?: string;
      evidence?: { path: string; quote: string; fileSha256: string }[];
      findingResponses?: {
        evidenceStatus?: string;
        evidence?: { path: string; quote: string; fileSha256: string }[];
      }[];
    };
  };
  if (boundedEvidence.sources) {
    boundedEvidence.sources = [...boundedEvidence.sources];
    if (input.compact) {
      // Remove identical/covered records, never truncate a source or finding JSON record.
      boundedEvidence.sources = boundedEvidence.sources.filter(
        (row, index, rows) =>
          !rows.some(
            (other, j) =>
              j !== index &&
              other.path === row.path &&
              (other.view ?? "CURRENT") === (row.view ?? "CURRENT") &&
              other.fileSha256 === row.fileSha256 &&
              ((other.content === row.content && j < index) ||
                (other.content !== row.content &&
                  Boolean(other.content?.includes(row.content ?? "")))),
          ),
      );
    }
    const counterevidence = [
      ...(boundedEvidence.repairResponse?.evidenceStatus === "CURRENT_SOURCE_LINKED"
        ? (boundedEvidence.repairResponse.evidence ?? [])
        : []),
      ...(boundedEvidence.repairResponse?.findingResponses ?? []).flatMap((a) =>
        a.evidenceStatus === "CURRENT_SOURCE_LINKED" ? (a.evidence ?? []) : [],
      ),
    ];
    while (
      Buffer.byteLength(JSON.stringify(boundedEvidence)) > 64 * 1024 &&
      boundedEvidence.sources.length
    ) {
      const removable = boundedEvidence.sources.findIndex(
        (s) =>
          !counterevidence.some(
            (c) =>
              s.path === c.path && s.fileSha256 === c.fileSha256 && s.content?.includes(c.quote),
          ) &&
          !boundedEvidence.findingHistory?.some(
            (f) =>
              (s.view !== "BASELINE" &&
                s.path === f.path &&
                s.fileSha256 === f.evidence?.fileSha256 &&
                Boolean(s.content?.includes(f.evidence!.quote))) ||
              (s.view === "BASELINE" &&
                s.path === f.scopeAssessment?.baselineEvidence?.path &&
                Boolean(
                  f.scopeAssessment?.baselineEvidence &&
                  s.content?.includes(f.scopeAssessment.baselineEvidence.quote),
                )),
          ),
      );
      if (removable < 0)
        throw new Error("Review current counterevidence exceeds source cap; no request issued.");
      boundedEvidence.sources.splice(removable, 1);
      boundedEvidence.omittedSourceRanges = (boundedEvidence.omittedSourceRanges ?? 0) + 1;
    }
  }
  const planJson = JSON.stringify(
    input.compact
      ? {
          summary: (input.plan as { summary?: string })?.summary,
          approvalScope: (input.plan as { approvalScope?: unknown })?.approvalScope ?? null,
        }
      : input.plan,
    null,
    2,
  );
  const safePlan =
    Buffer.byteLength(planJson) <= 32 * 1024
      ? planJson
      : JSON.stringify({
          omitted: "Plan details exceeded projection cap; host scope still applies",
          approvalScope: (input.plan as { approvalScope?: unknown })?.approvalScope ?? null,
        });
  const sections = [
    `Task:\nSOURCE=ORIGINAL_ISSUE; authoritative task requirements.\n${truncate(`${input.title}\n${input.description}`, 24 * 1024)}`,
    `Approved plan:\nSOURCE=PLAN_INTERPRETATION; cannot independently expand task requirements.\n${safePlan}`,
    `Current source and host protection policy:\n${JSON.stringify(boundedEvidence)}`,
    `Test evidence${input.test.skipped === true ? " (SKIPPED: no supported command was detected)" : ""}:\n${truncate(compactTestOutput(input.test), (input.compact ? 8 : 32) * 1024)}`,
  ];
  const remaining = REVIEW_CONTEXT_LIMIT - Buffer.byteLength(sections.join("\n\n")) - 16;
  if (remaining < 64)
    throw new Error("Review mandatory evidence exceeds projection cap; no request issued.");
  sections.push(
    `Diff:\n${truncate(input.diff, Math.min((input.compact ? 16 : 96) * 1024, remaining))}`,
  );
  return sections.join("\n\n");
}

export function progressFingerprint(diffFingerprint: string, testFingerprint: string): string {
  return sha256(`${diffFingerprint}:${testFingerprint}`);
}

export function testResultFingerprint(result: CommandResult): string {
  return sha256(
    [
      `exitCode=${String(result.exitCode)}`,
      `timedOut=${String(result.timedOut)}`,
      `outputTruncated=${String(result.outputTruncated)}`,
      `profile=${String((result as CommandResult & { profileSha256?: string }).profileSha256 ?? "legacy")}`,
      stableFailureStream(result.stdout),
      stableFailureStream(result.stderr),
    ].join("\n"),
  );
}

function isUsefulTextPath(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  return !/\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|lock)$/iu.test(path);
}

function isIgnoredPath(path: string): boolean {
  return /(?:^|\/)(?:\.git|node_modules|dist|build|coverage|\.next|vendor)(?:\/|$)/u.test(
    path.replaceAll("\\", "/"),
  );
}

function isManifestPath(path: string): boolean {
  return /(?:^|\/)(?:package\.json|pnpm-workspace\.yaml|turbo\.json|nx\.json|tsconfig(?:\.[^/]*)?\.json|pyproject\.toml|requirements(?:-[^/]*)?\.txt|setup\.cfg|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|composer\.json)$/iu.test(
    path,
  );
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__|specs?)(?:\/|$)|(?:\.|_)(?:test|spec)\.[^/]+$/iu.test(
    path,
  );
}

function taskSearchTokens(task: RepositoryProfileTask | undefined): string[] {
  if (task === undefined) return [];
  const ignored = new Set([
    "about",
    "after",
    "before",
    "change",
    "feature",
    "implement",
    "please",
    "project",
    "should",
    "task",
    "test",
    "the",
    "this",
    "修复",
    "实现",
    "功能",
    "任务",
    "项目",
  ]);
  return [
    ...new Set(
      `${task.title} ${task.description}`
        .toLowerCase()
        .split(/[^\p{L}\p{N}_-]+/u)
        .filter((token) => token.length >= 3 && !ignored.has(token)),
    ),
  ].slice(0, 24);
}

function detectLanguages(paths: readonly string[]): string[] {
  const extensions = new Map<string, string>([
    [".ts", "TypeScript"],
    [".tsx", "TypeScript/React"],
    [".js", "JavaScript"],
    [".jsx", "JavaScript/React"],
    [".py", "Python"],
    [".rs", "Rust"],
    [".go", "Go"],
    [".java", "Java"],
    [".kt", "Kotlin"],
    [".cs", "C#"],
    [".php", "PHP"],
    [".rb", "Ruby"],
  ]);
  const detected = new Set<string>();
  for (const path of paths) {
    const match = /\.[^./]+$/u.exec(path.toLowerCase());
    const language = match === null ? undefined : extensions.get(match[0]);
    if (language !== undefined) detected.add(language);
  }
  return [...detected].slice(0, 12);
}

function detectFrameworks(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => path.toLowerCase());
  const indicators: [RegExp, string][] = [
    [/(?:^|\/)next\.config\.[^/]+$/u, "Next.js"],
    [/(?:^|\/)nest-cli\.json$/u, "NestJS"],
    [/(?:^|\/)angular\.json$/u, "Angular"],
    [/(?:^|\/)vite\.config\.[^/]+$/u, "Vite"],
    [/(?:^|\/)prisma\/schema\.prisma$/u, "Prisma"],
    [/(?:^|\/)manage\.py$/u, "Django"],
    [/(?:^|\/)app\/.*\.tsx$/u, "React"],
  ];
  return indicators
    .filter(([pattern]) => normalized.some((path) => pattern.test(path)))
    .map(([, name]) => name);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n...[truncated]";
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentLimit) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
