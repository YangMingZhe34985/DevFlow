import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFileContent, validateReadFileRequest } from "../src/read-file-content.js";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
describe("bounded source range identity", () => {
  it("reads line 3502 without prefix inflation and preserves raw CRLF/SHA", () => {
    const source = "// padding\r\n".repeat(3501) + "export const $ZodDefault = 1;\r\n" + "tail\r\n";
    const result = readFileContent(Buffer.from(source), {
      path: "schemas.ts",
      startLine: 3502,
      endLine: 3502,
    });
    expect(result).toMatchObject({
      content: "export const $ZodDefault = 1;\r\n",
      startLine: 3502,
      endLine: 3502,
      totalLines: 3503,
      fileSha256: sha(source),
      snippetSha256: sha(result.content),
      truncated: true,
      recovery: { startLine: 3503, endLine: 3503, expectedSha256: sha(source) },
    });
    expect(Buffer.byteLength(result.content)).toBeLessThan(100);
  });
  it("clips complete Unicode lines, exposes actual bounds and clamps EOF", () => {
    const source = Buffer.from("甲🧪\n乙🧪\n尾");
    const result = readFileContent(source, {
      path: "unicode.ts",
      startLine: 1,
      endLine: 10,
      maxBytes: 9,
    });
    expect(result.content).toBe("甲🧪\n");
    expect(result.endLine).toBe(1);
    expect(result.recovery).toMatchObject({ startLine: 2, endLine: 3 });
    expect(readFileContent(source, { path: "unicode.ts", startLine: 3, endLine: 10 }).endLine).toBe(
      3,
    );
    expect(() =>
      readFileContent(source, { path: "unicode.ts", startLine: 1, endLine: 1, maxBytes: 1 }),
    ).toThrow("READ_LINE_TOO_LARGE");
  });
  it("rejects stale SHA and ranges beyond EOF", () => {
    expect(() =>
      readFileContent(Buffer.from("current"), { path: "a", expectedSha256: sha("old") }),
    ).toThrow("READ_STALE_SHA");
    expect(() =>
      readFileContent(Buffer.from("one\n"), { path: "a", startLine: 2, endLine: 2 }),
    ).toThrow("READ_RANGE_OUT_OF_BOUNDS");
  });
  it.each([
    { startLine: 1 },
    { endLine: 2 },
    { startLine: 0, endLine: 1 },
    { startLine: 5, endLine: 3 },
    { startLine: 1, endLine: 301 },
  ])("rejects invalid request before IO: %j", (range) => {
    expect(() => validateReadFileRequest({ path: "a", ...range })).toThrow("READ_INVALID_RANGE");
  });
});
