import type { WorkingCode } from "@devflow/agent";
import type { RunResult } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";

/** Verify provenance only. Semantic disagreements still go to independent Review. */
export async function checkRepairResponse(
  response: RunResult["phaseCompletion"],
  observed: readonly WorkingCode[],
  sandbox: SandboxSession,
  signal: AbortSignal,
  onRead?: () => void,
): Promise<RunResult["phaseCompletion"]> {
  if (!response) return undefined;
  let linked = Boolean(response.evidence?.length);
  for (const citation of response.evidence ?? []) {
    const seen = observed.some(
      (s) =>
        s.path === citation.path &&
        s.contentHash === citation.fileSha256 &&
        s.code.includes(citation.quote),
    );
    if (!seen) {
      linked = false;
      continue;
    }
    try {
      onRead?.();
      const current = await sandbox.readFile({ path: citation.path, maxBytes: 1 }, signal);
      if (current.fileSha256 !== citation.fileSha256) linked = false;
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      linked = false;
    }
  }
  return { ...response, evidenceStatus: linked ? "CURRENT_SOURCE_LINKED" : "UNVERIFIED" };
}
