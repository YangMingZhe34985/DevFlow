import type { DatabaseAdapter } from "@devflow/database";
import { SandboxGitService } from "@devflow/git";
import type { SandboxSession } from "@devflow/sandbox";
import type { RunResult } from "@devflow/shared";

/** Read-only salvage, independent of the failed request's signal. Never changes the verdict. */
export async function preserveInterruptedWorkflow(input: {
  database: DatabaseAdapter;
  sandbox: SandboxSession;
  failed: RunResult;
  timeoutMs: number;
  finalize(signal: AbortSignal): Promise<RunResult>;
}): Promise<RunResult> {
  const signal = AbortSignal.timeout(input.timeoutMs);
  const work = async () => {
    const diff = await new SandboxGitService().diff(input.sandbox, { maxBytes: 300_000 }, signal);
    signal.throwIfAborted();
    await input.database.artifacts.create({
      runId: input.failed.runId,
      kind: "OTHER",
      name: "interrupted-candidate-v1.json",
      mimeType: "application/json",
      content: JSON.stringify({
        version: 1,
        status: input.failed.status,
        error: input.failed.error,
        ...diff,
      }),
      metadata: { visibility: "HOST_ONLY" },
    });
    signal.throwIfAborted();
    const reports = (await input.database.artifacts.list(input.failed.runId)).filter(
      (a) => a.kind === "REVIEW_REPORT",
    );
    signal.throwIfAborted();
    await input.database.artifacts.create({
      runId: input.failed.runId,
      kind: "OTHER",
      name: "interrupted-findings-v1.json",
      mimeType: "application/json",
      content: JSON.stringify({
        version: 1,
        status: input.failed.status,
        reports: reports.map((a) => ({ name: a.name, content: a.content })),
      }),
      metadata: { visibility: "HOST_ONLY" },
    });
    signal.throwIfAborted();
    return await input.finalize(signal);
  };
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
