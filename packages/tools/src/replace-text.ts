import { createHash } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { ToolContext } from "./contracts.js";

export async function replaceText(
  input: {
    path: string;
    oldText: string;
    newText: string;
    expectedSha256: string;
    expectedOccurrences: number;
  },
  context: ToolContext,
) {
  const current = await context.sandbox.readFile(
    { path: input.path, maxBytes: 1_000_000 },
    context.signal,
  );
  const sha256 = createHash("sha256").update(current.content).digest("hex");
  if (
    current.truncated ||
    sha256 !== input.expectedSha256 ||
    (current.fileSha256 && current.fileSha256 !== sha256)
  )
    throw new DevflowError({
      code: "CONFLICT",
      message: "STALE_OR_INCOMPLETE_FILE: read the current file hash before replacing text.",
    });
  const parts = current.content.split(input.oldText);
  const occurrences = parts.length - 1;
  if (occurrences !== input.expectedOccurrences)
    throw new DevflowError({
      code: "CONFLICT",
      message: `TEXT_MATCH_COUNT: expected ${input.expectedOccurrences}, found ${occurrences}; no write was attempted.`,
    });
  const content = parts.join(input.newText);
  if (content === current.content)
    return {
      path: input.path,
      status: "NO_OP",
      changedFiles: [],
      sha256,
      sizeBytes: Buffer.byteLength(content),
    };
  const written = await context.sandbox.writeFile(
    { path: input.path, content, expectedSha256: sha256 },
    context.signal,
  );
  return {
    path: written.path,
    applied: true,
    status: "APPLIED",
    changedFiles: [written.path],
    beforeSha256: sha256,
    sha256: written.sha256,
    sizeBytes: written.sizeBytes,
    replacements: occurrences,
  };
}
