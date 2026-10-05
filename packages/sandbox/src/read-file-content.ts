import { createHash } from "node:crypto";
import type { ReadFileRequest, ReadFileResult } from "./contracts.js";

export function validateReadFileRequest(input: ReadFileRequest): void {
  const maxBytes = input.maxBytes ?? 200_000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000)
    throw new Error("READ_INVALID_BYTES: maxBytes must be between 1 and 1000000.");
  if (input.expectedSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(input.expectedSha256))
    throw new Error("READ_INVALID_SHA: expectedSha256 must be a complete SHA-256.");
  if (input.startLine !== undefined || input.endLine !== undefined) {
    if (
      !Number.isSafeInteger(input.startLine) ||
      !Number.isSafeInteger(input.endLine) ||
      input.startLine! < 1 ||
      input.endLine! < input.startLine! ||
      input.endLine! - input.startLine! + 1 > 300
    )
      throw new Error("READ_INVALID_RANGE: supply both positive bounds, at most 300 lines.");
  }
}

/** Also embedded verbatim in the sandbox's Node script; keep dependencies explicit. */
export function readFileContent(
  source: Buffer,
  input: ReadFileRequest,
  crypto: { createHash: typeof createHash } = { createHash },
): ReadFileResult {
  const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
  const fileSha256 = digest(source);
  if (input.expectedSha256 && input.expectedSha256 !== fileSha256)
    throw new Error(
      "READ_STALE_SHA: file changed; search/read its current version before editing.",
    );
  const ranged = input.startLine !== undefined;
  const maxBytes = ranged
    ? Math.min(input.maxBytes ?? 16_384, 16_384)
    : (input.maxBytes ?? 200_000);
  let selected: Buffer;
  let range: Partial<ReadFileResult> = {};
  if (ranged) {
    const lines = source.toString("utf8").match(/[^\n]*\n|[^\n]+$/gu) ?? [""];
    const startLine = input.startLine!;
    if (startLine > lines.length)
      throw new Error(`READ_RANGE_OUT_OF_BOUNDS: file has ${lines.length} lines.`);
    const chunks: string[] = [];
    let length = 0;
    for (let i = startLine - 1; i < Math.min(input.endLine!, lines.length); i++) {
      const chunk = lines[i]!;
      const size = Buffer.byteLength(chunk);
      if (length + size > maxBytes) break;
      chunks.push(chunk);
      length += size;
    }
    if (!chunks.length)
      throw new Error("READ_LINE_TOO_LARGE: first requested line exceeds the snippet byte limit.");
    selected = Buffer.from(chunks.join(""));
    const endLine = startLine + chunks.length - 1;
    range = {
      startLine,
      endLine,
      totalLines: lines.length,
      ...(endLine < lines.length
        ? {
            recovery: {
              path: input.path,
              startLine: endLine + 1,
              endLine: Math.min(lines.length, endLine + 300),
              maxBytes,
              expectedSha256: fileSha256,
            },
          }
        : {}),
    };
  } else {
    let end = Math.min(source.length, maxBytes);
    if (end < source.length) while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
    selected = source.subarray(0, end);
  }
  return {
    path: input.path,
    content: selected.toString("utf8"),
    encoding: "utf8",
    fileSha256,
    snippetSha256: digest(selected),
    sizeBytes: source.length,
    truncated: ranged
      ? range.startLine !== 1 || range.endLine !== range.totalLines
      : source.length > selected.length,
    ...range,
  };
}
