import { createHash } from "node:crypto";
import { DevflowError, type RunResult } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";

/** Only recognized reporter timing fields; behavior, IDs, positions and values stay verbatim. */
export function stableFailureStream(text: string): string {
  return text
    .replace(/\r\n/gu, "\n")
    .split("\n")
    .map((line) => {
      if (
        /^=*[ \t]*\d+ (?:failed|passed|skipped|error|errors|deselected|xfailed|xpassed)(?:, \d+ (?:failed|passed|skipped|error|errors|deselected|xfailed|xpassed))* in \d+(?:\.\d+)?s(?: \(\d+:\d+(?::\d+)?\))?[ \t]*=*$/u.test(
          line,
        )
      )
        return line.replace(/ in \d+(?:\.\d+)?s(?: \(\d+:\d+(?::\d+)?\))?/u, " in <reporter-time>");
      if (
        /^\s*(?:Start at\s+\d{2}:\d{2}:\d{2}|Duration\s+\d+(?:\.\d+)?[ms]+(?:\s+\([^\n]*\))?)\s*$/u.test(
          line,
        )
      )
        return (
          line
            .trim()
            .split(/\s+/u)
            .slice(0, line.includes("Start at") ? 2 : 1)
            .join(" ") + " <reporter-time>"
        );
      if (/^\s*[✓✔]\s+.*(?:\(\d+ tests?\))\s+\d+(?:\.\d+)?(?:ms|s)\s*$/u.test(line))
        return line.replace(/\d+(?:\.\d+)?(?:ms|s)\s*$/u, "<reporter-time>");
      if (
        /^\[INFO\] (?:Total time:\s+\d+(?:\.\d+)? s|Finished at: \d{4}-\d{2}-\d{2}T[\d:.+Z-]+)\s*$/u.test(
          line,
        )
      )
        return line.replace(/: .+$/u, ": <reporter-time>");
      if (/^Total Test time \(real\) =\s+\d+(?:\.\d+)? sec\s*$/u.test(line))
        return "Total Test time (real) = <reporter-time>";
      return line;
    })
    .join("\n");
}

/** Current identities of every host-approved editable file; missing files have an explicit identity. */
export async function repairSourceIdentity(
  sandbox: SandboxSession,
  paths: readonly string[],
  signal: AbortSignal,
  beforeRead: () => void,
) {
  if (!paths.length) return undefined;
  const rows: [string, string][] = [];
  for (const path of [...new Set(paths)].sort()) {
    beforeRead();
    try {
      const file = await sandbox.readFile({ path, maxBytes: 1 }, signal);
      if (!file.fileSha256) return undefined;
      rows.push([path, file.fileSha256]);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof DevflowError && error.code === "NOT_FOUND") rows.push([path, "ABSENT"]);
      else return undefined;
    }
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function repeatedVerificationReason(input: {
  before?: string | undefined;
  after?: string | undefined;
  previousFailed: boolean;
  response?: RunResult["phaseCompletion"];
}) {
  if (!input.previousFailed || !input.before || input.before !== input.after) return undefined;
  const response = input.response;
  if (response?.outcome === "SCOPE_CONFLICT") return "SCOPE_CONFLICT";
  if (
    response?.evidenceStatus === "CURRENT_SOURCE_LINKED" &&
    ["ALREADY_SATISFIED", "CONTRADICTED"].includes(response.outcome)
  )
    return undefined;
  return "UNCHANGED_CANDIDATE_AND_PUBLIC_FAILURE";
}
