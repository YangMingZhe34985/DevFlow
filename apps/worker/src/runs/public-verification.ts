import { createHash } from "node:crypto";
import { PublicVerificationProfileSchema, type PublicVerificationProfile } from "@devflow/eval";
import type { CommandResult, SandboxSession } from "@devflow/sandbox";

export const VERIFICATION_ORDER = ["build", "typecheck", "lint", "test"] as const;
export interface PublicCheckResult {
  kind: (typeof VERIFICATION_ORDER)[number];
  status: "PASS" | "FAIL" | "NOT_RUN" | "NOT_CONFIGURED";
  source?: string;
  command?: PublicVerificationProfile["checks"][number]["command"];
  result?: CommandResult;
  reason?: string;
}
export interface PublicVerificationResult extends CommandResult {
  profileSha256: string;
  checks: PublicCheckResult[];
  toolExecutions: number;
}

export async function discoverPublicVerification(
  sandbox: SandboxSession,
  signal: AbortSignal,
  beforeRead?: (executions: number) => unknown,
) {
  await beforeRead?.(0);
  const listing = await sandbox.listFiles({ path: ".", recursive: false, maxEntries: 200 }, signal);
  let toolExecutions = 1;
  const checks: PublicVerificationProfile["checks"] = [];
  if (listing.entries.some((e) => e.path.replace(/^\.\//u, "") === "package.json")) {
    await beforeRead?.(toolExecutions);
    const file = await sandbox.readFile({ path: "package.json", maxBytes: 200_000 }, signal);
    toolExecutions++;
    // A malformed manifest is a failed check, never "no tests" success.
    const manifest = JSON.parse(file.content) as { scripts?: Record<string, unknown> };
    for (const kind of VERIFICATION_ORDER)
      if (typeof manifest.scripts?.[kind] === "string") {
        checks.push({
          kind,
          source: `package.json#scripts.${kind}`,
          command: {
            program: "npm",
            args: kind === "test" ? ["test"] : ["run", kind],
            cwd: ".",
            environment: {},
          },
        });
      }
  } else {
    // Preserve legacy single-command discovery. Additional checks require an explicit host profile.
    const names = new Set(listing.entries.map((e) => e.path.replace(/^\.\//u, "")));
    const legacy = ["pyproject.toml", "pytest.ini", "setup.cfg"].some((name) => names.has(name))
      ? {
          program: "python",
          args: ["-m", "pytest"],
          source: "public Python test configuration (legacy)",
        }
      : names.has("Cargo.toml")
        ? { program: "cargo", args: ["test"], source: "Cargo.toml (legacy)" }
        : names.has("go.mod")
          ? { program: "go", args: ["test", "./..."], source: "go.mod (legacy)" }
          : undefined;
    if (legacy)
      checks.push({
        kind: "test",
        source: legacy.source,
        command: { program: legacy.program, args: legacy.args, cwd: ".", environment: {} },
      });
  }
  return { profile: PublicVerificationProfileSchema.parse({ version: 1, checks }), toolExecutions };
}

/** One shared deadline, fail fast, with a preflight before every actual command. */
export async function runPublicVerification(input: {
  sandbox: SandboxSession;
  profile: PublicVerificationProfile;
  signal: AbortSignal;
  timeoutMs: number;
  beforeCommand?: (executions: number) => number | Promise<number>;
  now?: () => number;
}): Promise<PublicVerificationResult> {
  const profile = PublicVerificationProfileSchema.parse(input.profile);
  const now = input.now ?? Date.now,
    started = now();
  const deadline = started + Math.min(300_000, input.timeoutMs);
  const checks: PublicCheckResult[] = [];
  let stopped: string | undefined,
    executions = 0;
  for (const kind of VERIFICATION_ORDER) {
    const configured = profile.checks.filter((c) => c.kind === kind);
    if (!configured.length) checks.push({ kind, status: "NOT_CONFIGURED" });
    for (const check of configured) {
      if (stopped) {
        checks.push({ ...check, status: "NOT_RUN", reason: stopped });
        continue;
      }
      try {
        const available = await input.beforeCommand?.(executions);
        const remaining = Math.min(deadline - now(), available ?? Infinity);
        if (remaining <= 0) throw new Error("PUBLIC_VERIFICATION_DEADLINE_EXHAUSTED");
        const result = await input.sandbox.exec(
          {
            ...check.command,
            timeoutMs: Math.min(remaining, check.command.timeoutMs ?? 300_000),
            maxOutputBytes: 500_000,
          },
          input.signal,
        );
        executions++;
        const pass = result.exitCode === 0 && !result.timedOut && !result.outputTruncated;
        checks.push({ ...check, status: pass ? "PASS" : "FAIL", result });
        if (!pass) stopped = `PUBLIC_CHECK_FAILED:${kind}`;
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
        checks.push({ ...check, status: "NOT_RUN", reason: stopped });
      }
    }
  }
  const streams = (name: "stdout" | "stderr") =>
    checks
      .map(
        (c) =>
          `[public ${c.kind}: ${c.status}${c.reason ? ` ${c.reason}` : ""}]\n${c.result?.[name] ?? ""}`,
      )
      .join("\n");
  return {
    exitCode: stopped ? checks.find((c) => c.status === "FAIL")?.result?.exitCode || 1 : 0,
    stdout: streams("stdout"),
    stderr: streams("stderr"),
    durationMs: Math.max(0, now() - started),
    timedOut: checks.some((c) => c.result?.timedOut) || now() >= deadline,
    outputTruncated: checks.some((c) => c.result?.outputTruncated),
    checks,
    toolExecutions: executions,
    profileSha256: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
  };
}
