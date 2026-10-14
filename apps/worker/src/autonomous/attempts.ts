import { kernelCost, type KernelResume, type KernelUsage } from "@devflow/agent";
import type { SandboxSession } from "@devflow/sandbox";

import { emptyUsage } from "./review.js";
import {
  runAutonomousSolve,
  solverTaskMessage,
  SOLVER_SYSTEM_PROMPT,
  type SolveInput,
  type SolveResult,
} from "./solve.js";

export interface AttemptResult {
  attempt: number;
  solve: SolveResult;
}
export interface AttemptsResult {
  attempts: AttemptResult[];
  selectedAttempt: number;
  selected: SolveResult;
  usage: KernelUsage;
  turns: number;
}
export interface AttemptsInput extends Omit<SolveInput, "sandbox"> {
  sandboxFactory(attempt: number): Promise<SandboxSession>;
  maxAttempts?: number;
  completed?: AttemptResult[];
  currentAttempt?: number;
  /** Test seam; all production and evaluation callers use runAutonomousSolve. */
  solve?: typeof runAutonomousSolve;
  onAttemptStarted?(attempt: number, resume: KernelResume | undefined): void | Promise<void>;
  onAttemptComplete?(result: AttemptResult): void | Promise<void>;
}

export function candidatePriority(solve: SolveResult): number {
  if (!solve.verification?.passed) return 0;
  if (solve.review?.verdict === "PASS") return 3;
  if (solve.review?.verdict === "NEEDS_EVIDENCE") return 2;
  return 1;
}
export function changedLines(patch: string): number {
  return patch.split("\n").filter((line) => /^[+-]/u.test(line) && !/^\+\+\+ |^--- /u.test(line))
    .length;
}
export function selectCandidate(attempts: readonly AttemptResult[]): AttemptResult {
  if (!attempts.length) throw new Error("No autonomous candidates to select.");
  return [...attempts].sort(
    (a, b) =>
      candidatePriority(b.solve) - candidatePriority(a.solve) ||
      changedLines(a.solve.patch) - changedLines(b.solve.patch) ||
      a.attempt - b.attempt,
  )[0]!;
}
export function failureSummary(solve: SolveResult): string {
  return JSON.stringify({
    changedFiles: solve.changedFiles,
    unresolvedChecks: solve.verification?.checks
      .filter((check) => check.status !== "PASS")
      .map(({ kind, status, output }) => ({ kind, status, output: output.slice(-2000) })),
    protectedChanges: solve.verification?.protectedChanges,
    blockingFindings: solve.review?.findings.filter((finding) => finding.severity === "blocking"),
    agentSummary: solve.kernel.summary?.slice(0, 2000),
  });
}

/** Attempts are sequential, independent and share one hard ledger and absolute deadline. */
export async function runAttempts(input: AttemptsInput): Promise<AttemptsResult> {
  const attempts = [...(input.completed ?? [])];
  let resume = input.resume;
  let usage = resume?.usage ?? attempts.at(-1)?.solve.kernel.usage ?? emptyUsage();
  let turns = resume?.turns ?? attempts.at(-1)?.solve.kernel.turns ?? 0;
  const enough = () => {
    const task = solverTaskMessage({
      ...input,
      failureSummary: attempts.at(-1) ? failureSummary(attempts.at(-1)!.solve) : "",
    });
    const prompt = [
      { role: "SYSTEM", content: SOLVER_SYSTEM_PROMPT },
      { role: "USER", content: task },
    ];
    const worstCase = input.price
      ? kernelCost(
          input.price,
          Math.ceil(Buffer.byteLength(JSON.stringify(prompt)) / 3),
          0,
          input.settings?.maxOutputTokens ?? 8192,
        )
      : 0;
    return (
      turns < input.limits.maxTurns &&
      (input.limits.deadlineAt === undefined || Date.now() < input.limits.deadlineAt) &&
      (input.limits.maxCostMicros === undefined ||
        (usage.costMicros + usage.unconfirmedCostMicros <
          input.limits.maxCostMicros * (input.review ? 1 - (input.review.reserve ?? 0.15) : 1) &&
          usage.costMicros + usage.unconfirmedCostMicros + worstCase <=
            input.limits.maxCostMicros * (input.review ? 1 - (input.review.reserve ?? 0.15) : 1)))
    );
  };
  let attempt = Math.max(input.currentAttempt ?? 1, (attempts.at(-1)?.attempt ?? 0) + 1);
  // Even an exhausted first attempt must return an honest stop reason and any restored diff.
  while (
    attempt <= (input.maxAttempts ?? 2) &&
    (!attempts.length || !!resume?.messages.length || enough())
  ) {
    input.signal.throwIfAborted();
    const previous = attempts.at(-1)?.solve;
    if (previous && previous.verification?.passed !== false && previous.review?.verdict !== "FAIL")
      break;
    await input.onAttemptStarted?.(attempt, resume ?? { messages: [], usage, turns });
    const sandbox = await input.sandboxFactory(attempt);
    const solve = await (input.solve ?? runAutonomousSolve)({
      ...input,
      sandbox,
      ...(previous ? { failureSummary: failureSummary(previous) } : {}),
      resume: resume ?? { messages: [], usage, turns },
      resumeRevisions: resume ? (input.resumeRevisions ?? 0) : 0,
    });
    const result = { attempt, solve };
    attempts.push(result);
    usage = solve.kernel.usage;
    turns = solve.kernel.turns;
    await input.onAttemptComplete?.(result);
    resume = undefined;
    attempt += 1;
  }
  const selected = selectCandidate(attempts);
  return { attempts, selectedAttempt: selected.attempt, selected: selected.solve, usage, turns };
}
