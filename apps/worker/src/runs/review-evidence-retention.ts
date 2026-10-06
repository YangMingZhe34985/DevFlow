import { z } from "zod";
import { PhaseCompletionSchema, type ReviewResult } from "@devflow/shared";
import type { ReviewEvidence } from "./review-evidence.js";
import type { ReviewSourceCache } from "./review-supplement.js";
import { hash } from "../localization/contracts.js";

export const RetainedReviewEvidenceSchema = z.object({
  version: z.literal(1),
  workspaceRevision: z.number().int().nonnegative(),
  baselineRevision: z.string().optional(),
  repairResponse: PhaseCompletionSchema.optional(),
  sources: z.array(
    z.object({
      path: z.string().min(1),
      content: z.string(),
      fileSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
      partial: z.boolean(),
      view: z.enum(["CURRENT", "BASELINE"]).optional(),
    }),
  ),
});
export type RetainedReviewEvidence = z.infer<typeof RetainedReviewEvidenceSchema>;

/** Host records survive a rejected write/Repair. Source identity is independently
 * checked; a retained quote never grants permission or closes a finding. */
export async function retainReviewEvidence(input: {
  previous?: RetainedReviewEvidence | undefined;
  current: ReviewEvidence;
  findings: ReviewResult["findings"];
  baselineRevision: string;
  cache: readonly ReviewSourceCache[];
  signal: AbortSignal;
  verifyCurrent: (path: string) => Promise<string | undefined>;
  cacheVerified?: (entry: ReviewSourceCache) => void;
}): Promise<void> {
  const previous = input.previous;
  if (
    !previous ||
    !input.findings.some(
      (f) => !["RESOLVED", "CONTRADICTED", "DEFERRED"].includes(f.disposition ?? "OPEN"),
    )
  )
    return;
  const checked = new Map<string, string | undefined>(
    input.current.sources
      .filter((s) => (s.view ?? "CURRENT") === "CURRENT" && s.fileSha256)
      .map((s) => [s.path, s.fileSha256]),
  );
  for (const row of previous.sources) {
    input.signal.throwIfAborted();
    if (!row.fileSha256) continue;
    let valid = false;
    const view = row.view ?? "CURRENT";
    if (view === "BASELINE") {
      const cached = input.cache.find(
        (c) => c.key === `BASELINE:${input.baselineRevision}:${row.path}`,
      );
      valid =
        previous.baselineRevision === input.baselineRevision &&
        Boolean(
          cached &&
          hash(cached.content) === row.fileSha256 &&
          cached.sha256 === row.fileSha256 &&
          cached.content.includes(row.content),
        );
    } else {
      if (!checked.has(row.path)) {
        try {
          checked.set(row.path, await input.verifyCurrent(row.path));
        } catch (error) {
          input.signal.throwIfAborted();
          input.current.unavailable.push(
            `${row.path}: RETAINED_SOURCE_UNVERIFIED: ${String(error).slice(0, 500)}`,
          );
          checked.set(row.path, undefined);
        }
      }
      valid = checked.get(row.path) === row.fileSha256;
      // Full source cache checks the stored range too when available.
      const cached = input.cache.find(
        (c) => c.sha256 === row.fileSha256 && c.key.endsWith(`:${row.path}`),
      );
      if (
        cached &&
        (hash(cached.content) !== row.fileSha256 || !cached.content.includes(row.content))
      )
        valid = false;
      if (valid && cached)
        input.cacheVerified?.({
          ...cached,
          key: `CURRENT:${input.current.workspaceRevision}:${row.path}`,
        });
    }
    if (!valid) {
      input.current.unavailable.push(`${view}:${row.path}: RETAINED_SOURCE_STALE_OR_UNVERIFIED`);
      continue;
    }
    if (
      !input.current.sources.some(
        (s) =>
          s.path === row.path &&
          (s.view ?? "CURRENT") === view &&
          s.fileSha256 === row.fileSha256 &&
          s.startLine <= row.startLine &&
          (s.endLine ?? Infinity) >= (row.endLine ?? Infinity),
      )
    )
      input.current.sources.push({
        path: row.path,
        content: row.content,
        fileSha256: row.fileSha256,
        startLine: row.startLine,
        partial: row.partial,
        ...(row.endLine === undefined ? {} : { endLine: row.endLine }),
        ...(row.view === undefined ? {} : { view: row.view }),
      });
  }
}
