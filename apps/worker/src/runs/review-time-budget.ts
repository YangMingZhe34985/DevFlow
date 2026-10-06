import type { WorkerEnvironment } from "../config/env.js";

export function reviewTimeReserve(environment: WorkerEnvironment, recoveryUsed = 0): number {
  return (
    environment.DEVFLOW_REVIEW_REQUEST_TIMEOUT_MS +
    (recoveryUsed < 2 ? environment.DEVFLOW_REVIEW_RECOVERY_TIMEOUT_MS : 0) +
    environment.DEVFLOW_FINALIZE_TIMEOUT_MS
  );
}

/** Restore the earliest known expiry, including historical budget checkpoints. */
export function restoredWorkflowTiming(
  checkpoints: readonly { deadlineAt?: unknown; limits?: { timeoutMs?: unknown } }[],
  now: number,
  elapsedMs: number,
  configuredTimeoutMs: number,
  explicitTimeoutMs?: number,
): { startedAt: number; timeoutMs: number; deadlineAt: number } {
  const saved = checkpoints
    .filter(
      (c) =>
        typeof c.deadlineAt === "string" &&
        Number.isFinite(Date.parse(c.deadlineAt)) &&
        typeof c.limits?.timeoutMs === "number" &&
        c.limits.timeoutMs > 0,
    )
    .sort((a, b) => Date.parse(String(a.deadlineAt)) - Date.parse(String(b.deadlineAt)))[0];
  // A larger explicit limit cannot rewrite the saved duration paired with the
  // absolute expiry; otherwise a second restart would infer a different start.
  const timeoutMs = Math.min(
    explicitTimeoutMs ?? (saved?.limits?.timeoutMs as number | undefined) ?? configuredTimeoutMs,
    (saved?.limits?.timeoutMs as number | undefined) ?? Infinity,
  );
  const startedAt = saved
    ? Date.parse(String(saved.deadlineAt)) - Number(saved.limits!.timeoutMs)
    : now - elapsedMs;
  return {
    startedAt,
    timeoutMs,
    deadlineAt: Math.min(
      startedAt + timeoutMs,
      saved ? Date.parse(String(saved.deadlineAt)) : Infinity,
    ),
  };
}
