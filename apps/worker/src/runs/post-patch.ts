import { contentHash, type PostPatchController } from "@devflow/agent";
import { SandboxGitService } from "@devflow/git";
import type { SandboxSession } from "@devflow/sandbox";
import {
  DevflowError,
  type AgentPlan,
  type MutationResult,
  type VerificationContract,
} from "@devflow/shared";
import type { ToolExecutionRequest, ToolExecutionResult } from "@devflow/tools";
import { patchTargetPaths } from "./working-set.js";

export function requestPaths(request: ToolExecutionRequest): string[] {
  const args = request.input as Record<string, unknown> | null;
  if (!args || typeof args !== "object") return [];
  const paths =
    request.name === "applyPatch" && typeof args.patch === "string"
      ? (patchTargetPaths(args.patch) ?? [])
      : typeof args.path === "string"
        ? [args.path]
        : Array.isArray(args.paths)
          ? args.paths.filter((p): p is string => typeof p === "string")
          : [];
  return [...new Set(paths.map((p) => p.replaceAll("\\", "/").replace(/^(\.\/)+/u, "")))];
}

export function plannedTargets(plan: AgentPlan, known: readonly string[]): string[] {
  const scope = plannedTargetScope(plan, known);
  return scope.blockers.length
    ? []
    : scope.requiredTargets.length
      ? scope.requiredTargets
      : scope.targets;
}

export function plannedTargetScope(
  plan: AgentPlan,
  known: readonly string[],
): { targets: string[]; requiredTargets: string[]; blockers: string[] } {
  // File references in inspect/test/preserve steps are NOT edit obligations. No
  // file-type or benchmark-fixture exception: tests may be explicit edit targets.
  const pathsIn = (text: string) =>
    [
      ...text.matchAll(
        /(?:^|[\s`("'])((?:[\w@.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|json|yaml|yml|md|css|html))(?=$|[\s`)"',;:])/gmu,
      ),
    ].map((m) => m[1]!);
  const edit =
    /^\s*(?:edit|fix|repair|update|change|modify|replace|implement|correct|add|remove|apply)\b|^\s*(?:修改|修复|更新|替换|新增|删除)/iu;
  const preserve =
    /\b(?:preserve|unchanged|unmodified|do not|don't|without (?:modifying|changing|editing)|leave|keep)\b|保持|保留|不要修改|不修改/iu;
  const explicit: string[] = [],
    protectedReferences = new Set<string>();
  for (const text of plan.steps.length
    ? plan.steps.map((s) => `${s.title}: ${s.description}`)
    : [plan.summary]) {
    let editing = false;
    for (const clause of text.split(/\n|[,;，。]|(?<=[.!?])\s+|\b(?:and|while|but)\b/iu)) {
      const paths = pathsIn(clause);
      if (preserve.test(clause)) {
        for (const p of paths) protectedReferences.add(p);
        editing = false;
      } else if (
        /^\s*(?:inspect|read|review|run|verify|test|validate|check)\b|^\s*(?:检查|阅读|运行|验证|测试)/iu.test(
          clause,
        )
      )
        editing = false;
      else {
        editing ||= edit.test(clause) || edit.test(clause.split(":").slice(1).join(":"));
        if (editing) explicit.push(...paths);
      }
    }
  }
  // Conflicting constraints fail closed: the protected reference cannot be changed,
  // and no readiness is manufactured by deleting an explicit edit obligation.
  return {
    targets: [...new Set([...explicit, ...known.filter((p) => !protectedReferences.has(p))])],
    requiredTargets: [...new Set(explicit)],
    blockers: explicit
      .filter((p) => protectedReferences.has(p))
      .map((p) => `CONFLICTING_PLAN_TARGET:${p}`),
  };
}

export function normalizeMutation(
  result: ToolExecutionResult,
  before: Record<string, string>,
  after: Record<string, string>,
  paths: string[],
  revision: number,
): MutationResult {
  const output =
    result.ok && result.output && typeof result.output === "object"
      ? (result.output as Record<string, unknown>)
      : {};
  const observed =
    paths.length > 0 && paths.every((p) => before[p] !== undefined && after[p] !== undefined);
  const changedFiles = paths.filter(
    (p) => before[p] !== undefined && after[p] !== undefined && before[p] !== after[p],
  );
  const workspaceChanged = changedFiles.length > 0;
  const applied = result.ok && output.applied !== false && observed && workspaceChanged;
  const reason = !result.ok
    ? `${result.error.code}:${result.error.message}`
    : output.applied === false
      ? "PATCH_REJECTED"
      : !observed
        ? "MUTATION_NOT_FULLY_OBSERVED"
        : !workspaceChanged
          ? "CONTENT_IDENTICAL"
          : "CONTENT_CHANGED";
  return {
    status: applied
      ? "APPLIED"
      : !result.ok || output.applied === false
        ? "REJECTED"
        : !observed
          ? "FAILED"
          : "NO_OP",
    executionSucceeded: result.ok,
    mutationAttempted: true,
    mutationApplied: applied,
    workspaceChanged,
    reason,
    beforeRevision: revision,
    afterRevision: revision + (workspaceChanged ? 1 : 0),
    changedFiles,
    currentHashes: after,
  };
}

export async function observePostPatchTool(input: {
  controller: PostPatchController;
  request: ToolExecutionRequest;
  sandbox: SandboxSession;
  signal: AbortSignal;
  execute: () => Promise<ToolExecutionResult>;
}): Promise<ToolExecutionResult> {
  const { controller, request, sandbox, signal } = input;
  const paths = requestPaths(request);
  const mutation = ["writeFile", "replaceText", "applyPatch", "runCommand"].includes(request.name);
  const started = Date.now();
  const readHashes = async (targets: readonly string[]): Promise<Record<string, string>> => {
    const hashes: Record<string, string> = {};
    for (const path of targets.slice(0, 16)) {
      signal.throwIfAborted();
      try {
        const file = await sandbox.readFile({ path, maxBytes: 65536 }, signal);
        if (file.fileSha256) hashes[path] = file.fileSha256;
        else if (!file.truncated) hashes[path] = contentHash(file.content);
      } catch (error) {
        if (signal.aborted) throw error;
        // Only an explicit missing-file result establishes absence. Permission/IO failures do not.
        if (error instanceof DevflowError && error.code === "NOT_FOUND") hashes[path] = "ABSENT";
      }
    }
    return hashes;
  };
  const before = mutation ? await readHashes(paths) : {};
  if (request.name === "writeFile" && paths.length === 1) {
    const args = request.input as Record<string, unknown>;
    const expected = before[paths[0]!];
    if (expected && expected !== "ABSENT" && args.expectedSha256 === undefined)
      request.input = { ...args, expectedSha256: expected };
  }
  let result = await input.execute();
  if (result.ok && ["readFile", "batchReadFiles"].includes(request.name)) {
    const output = result.output as Record<string, unknown>;
    const files =
      request.name === "readFile"
        ? [output]
        : Array.isArray(output.files)
          ? (output.files as Record<string, unknown>[])
          : [];
    for (const file of files) {
      if (
        typeof file.path === "string" &&
        typeof file.content === "string" &&
        controller.targets.includes(file.path)
      )
        controller.currentReads.set(file.path, {
          content: file.content.slice(0, 4096),
          truncated: !!file.truncated || file.content.length > 4096,
        });
    }
  }
  if (mutation) {
    const after = await readHashes(paths);
    const normalized = normalizeMutation(result, before, after, paths, controller.revision);
    controller.observeMutation(normalized, paths);
    result = { ...result, mutation: normalized, durationMs: Date.now() - started };
  }
  if (request.name === "gitDiff" && controller.active) {
    const args = (request.input ?? {}) as Record<string, unknown>;
    // A scoped/cached/base-relative view is not authoritative completion evidence,
    // but cannot invalidate an already current global diff at the same revision.
    if (args.base || args.cached || args.paths) return result;
    const output = result.ok ? (result.output as Record<string, unknown>) : {};
    const patch = typeof output.patch === "string" ? output.patch : "";
    const diffPaths = patchTargetPaths(patch) ?? [];
    const hashes = await readHashes([...controller.changed]);
    let valid =
      result.ok &&
      output.truncated === false &&
      !args.base &&
      !args.cached &&
      !args.paths &&
      [...controller.hashes].every(([p, hash]) => hashes[p] === hash && hash !== "ABSENT");
    try {
      // A filtered diff cannot hide staged, untracked or unrelated files from readiness.
      const status = await new SandboxGitService().status(sandbox, signal);
      const statusPaths = status.files.map((f) => f.path);
      valid &&= statusPaths.every((p) => diffPaths.includes(p));
      controller.unexpectedFiles = statusPaths.filter((p) => !controller.targets.includes(p));
    } catch (error) {
      if (signal.aborted) throw error;
      valid = false;
    }
    for (const [path, hash] of controller.hashes) {
      if (hashes[path] !== hash) controller.failures.set(path, `STALE_CURRENT_TARGET:${path}`);
    }
    const unexpected = controller.unexpectedFiles;
    controller.observeDiff(patch, diffPaths, valid);
    controller.unexpectedFiles = [...new Set([...unexpected, ...controller.unexpectedFiles])];
    result = { ...result, durationMs: Date.now() - started };
  }
  return result;
}

export function verificationContract(
  execution: VerificationContract["execution"],
  test: VerificationContract["test"],
  review: VerificationContract["review"],
): VerificationContract {
  // No task-provided string or model confidence establishes a trusted base-fail reproduction.
  return {
    execution,
    test,
    review,
    issue: "VERIFICATION_INCONCLUSIVE",
    reason: "ISSUE_REPRODUCTION_NOT_ESTABLISHED",
  };
}
