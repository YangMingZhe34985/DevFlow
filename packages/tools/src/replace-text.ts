import { createHash } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { ToolContext } from "./contracts.js";

type LineEndings = "NONE" | "LF" | "CRLF" | "MIXED" | "LONE_CR";
function lineEndings(text: string): LineEndings {
  if (/\r(?!\n)/u.test(text)) return "LONE_CR";
  const crlf = /\r\n/u.test(text),
    lf = /(?<!\r)\n/u.test(text);
  return crlf && lf ? "MIXED" : crlf ? "CRLF" : lf ? "LF" : "NONE";
}

export async function replaceText(
  input: {
    path: string;
    oldText: string;
    newText: string;
    expectedSha256: string;
    expectedOccurrences: number;
    lineEndingMode?: "EXACT" | "MATCH_FILE";
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
  const lineEndingMode = input.lineEndingMode ?? "EXACT";
  const endings = {
    fileLineEndings: lineEndings(current.content),
    oldTextLineEndings: lineEndings(input.oldText),
    newTextLineEndings: lineEndings(input.newText),
  };
  let oldText = input.oldText,
    newText = input.newText;
  if (lineEndingMode === "MATCH_FILE") {
    if (Object.values(endings).some((kind) => kind === "MIXED" || kind === "LONE_CR"))
      throw new DevflowError({
        code: "CONFLICT",
        message:
          "LINE_ENDING_UNSUPPORTED: MATCH_FILE requires uniform LF/CRLF text; mixed endings or lone CR must use exact literal text. No write was attempted.",
        details: { ...endings, lineEndingMode },
      });
    if (input.expectedOccurrences !== 1)
      throw new DevflowError({
        code: "CONFLICT",
        message:
          "LINE_ENDING_MATCH_REQUIRES_UNIQUE: MATCH_FILE requires expectedOccurrences=1. No write was attempted.",
        details: { ...endings, lineEndingMode },
      });
    // Only actual newline characters are converted. Literal backslash escapes
    // remain literal, and matching/writing retain the complete original SHA.
    if (endings.fileLineEndings === "LF" || endings.fileLineEndings === "CRLF") {
      const newline = endings.fileLineEndings === "CRLF" ? "\r\n" : "\n";
      oldText = oldText.replace(/\r\n|\n/gu, newline);
      newText = newText.replace(/\r\n|\n/gu, newline);
    }
  }
  const normalizedLineEndings = oldText !== input.oldText || newText !== input.newText;
  const parts = current.content.split(oldText);
  const occurrences = parts.length - 1;
  if (occurrences !== input.expectedOccurrences)
    throw new DevflowError({
      code: "CONFLICT",
      message:
        `TEXT_MATCH_COUNT: expected ${input.expectedOccurrences}, found ${occurrences}; no write was attempted. ` +
        `File line endings=${endings.fileLineEndings}; oldText=${endings.oldTextLineEndings}; newText=${endings.newTextLineEndings}. ` +
        (lineEndingMode === "EXACT" &&
        [endings.fileLineEndings, endings.oldTextLineEndings].every((kind) =>
          ["LF", "CRLF"].includes(kind),
        ) &&
        endings.fileLineEndings !== endings.oldTextLineEndings
          ? "For this uniform newline mismatch, retry with explicit lineEndingMode=MATCH_FILE and a unique oldText; the source SHA has not changed."
          : "Use exact current literal text and the stated occurrence count; no location or escape sequence is guessed."),
      details: {
        ...endings,
        lineEndingMode,
        expectedOccurrences: input.expectedOccurrences,
        occurrences,
      },
    });
  const content = parts.join(newText);
  if (content === current.content)
    return {
      path: input.path,
      status: "NO_OP",
      changedFiles: [],
      sha256,
      sizeBytes: Buffer.byteLength(content),
      lineEndingMode,
      fileLineEndings: endings.fileLineEndings,
      normalizedLineEndings,
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
    lineEndingMode,
    fileLineEndings: endings.fileLineEndings,
    normalizedLineEndings,
  };
}
