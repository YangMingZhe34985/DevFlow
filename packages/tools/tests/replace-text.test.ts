import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DevflowError } from "@devflow/shared";
import type { ToolContext } from "../src/contracts.js";
import { replaceText } from "../src/replace-text.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(initial: string, race = false) {
  let content = initial;
  let writes = 0;
  const context = {
    signal: AbortSignal.timeout(1000),
    sandbox: {
      readFile: async () => ({ path: "a.ts", content, truncated: false, fileSha256: sha(content) }),
      writeFile: async (input: { content: string; expectedSha256: string }) => {
        if (race) content += "concurrent";
        if (sha(content) !== input.expectedSha256)
          throw new DevflowError({ code: "CONFLICT", message: "CAS failed" });
        writes++;
        content = input.content;
        return { path: "a.ts", sha256: sha(content), sizeBytes: Buffer.byteLength(content) };
      },
    },
  } as unknown as ToolContext;
  return { context, content: () => content, writes: () => writes };
}
describe("exact replaceText", () => {
  it("diagnoses an actual multiline LF/CRLF mismatch, then explicitly corrects it without changing unrelated bytes", async () => {
    const initial = '你好\r\nconst a = 1;\r\nconst b = 2;\r\nconst literal = "\\r\\n";';
    const f = fixture(initial);
    const edit = {
      path: "a.ts",
      oldText: "const a = 1;\nconst b = 2;\n",
      newText: "const a = 3;\nconst b = 4;\n",
      expectedSha256: sha(initial),
      expectedOccurrences: 1,
    };
    await expect(replaceText(edit, f.context)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("lineEndingMode=MATCH_FILE"),
      details: { fileLineEndings: "CRLF", oldTextLineEndings: "LF", occurrences: 0 },
    });
    expect(f.content()).toBe(initial);
    expect(f.writes()).toBe(0);
    const result = await replaceText({ ...edit, lineEndingMode: "MATCH_FILE" }, f.context);
    const expected = initial.replace("a = 1", "a = 3").replace("b = 2", "b = 4");
    expect(f.content()).toBe(expected);
    expect(result).toMatchObject({
      beforeSha256: sha(initial),
      sha256: sha(expected),
      lineEndingMode: "MATCH_FILE",
      fileLineEndings: "CRLF",
      normalizedLineEndings: true,
      replacements: 1,
    });
    expect(f.content().endsWith("\n")).toBe(false);
    expect(f.writes()).toBe(1);
    await replaceText(
      { ...edit, oldText: "a = 3", newText: "a = 5", expectedSha256: result.sha256 },
      f.context,
    );
    expect(f.content()).toBe(expected.replace("a = 3", "a = 5"));
  });
  it("matches CRLF parameters to LF source only when explicitly requested, without interpreting literal escapes", async () => {
    const initial = 'const literal = "\\r\\n";\nconst a = 1;\n';
    const f = fixture(initial);
    const result = await replaceText(
      {
        path: "a.ts",
        oldText: initial.replaceAll("\n", "\r\n"),
        newText: initial.replace("a = 1", "a = 2").replaceAll("\n", "\r\n"),
        expectedSha256: sha(initial),
        expectedOccurrences: 1,
        lineEndingMode: "MATCH_FILE",
      },
      f.context,
    );
    expect(f.content()).toBe(initial.replace("a = 1", "a = 2"));
    expect(result.fileLineEndings).toBe("LF");
    expect(f.writes()).toBe(1);
  });
  it.each([
    { content: "a\r\nb\nc", oldText: "a\r\nb", newText: "x" },
    { content: "a\rb", oldText: "a", newText: "x" },
    { content: "a\r\nb\r\n", oldText: "a\r\nb\n", newText: "x" },
    { content: "a\r\nb\r\n", oldText: "a", newText: "x\r\ny\n" },
    { content: "a\r\nb\r\n", oldText: "a", newText: "x\ry" },
  ])(
    "rejects ambiguous newline styles in MATCH_FILE without writing ($content)",
    async ({ content, oldText, newText }) => {
      const f = fixture(content);
      await expect(
        replaceText(
          {
            path: "a.ts",
            oldText,
            newText,
            expectedSha256: sha(content),
            expectedOccurrences: 1,
            lineEndingMode: "MATCH_FILE",
          },
          f.context,
        ),
      ).rejects.toThrow("LINE_ENDING_UNSUPPORTED");
      expect(f.content()).toBe(content);
      expect(f.writes()).toBe(0);
    },
  );
  it("does not normalize mixed source in literal mode, guess escapes, relax uniqueness or bypass SHA/CAS", async () => {
    const mixed = fixture("a\r\nb\nc");
    await replaceText(
      {
        path: "a.ts",
        oldText: "a\r\nb\nc",
        newText: "x\r\ny\nc",
        expectedSha256: sha(mixed.content()),
        expectedOccurrences: 1,
      },
      mixed.context,
    );
    expect(mixed.content()).toBe("x\r\ny\nc");
    const f = fixture("a\r\nb\r\na\r\nb\r\n");
    const edit = {
      path: "a.ts",
      oldText: "a\nb\n",
      newText: "x\ny\n",
      expectedSha256: sha(f.content()),
      expectedOccurrences: 1,
      lineEndingMode: "MATCH_FILE" as const,
    };
    await expect(replaceText(edit, f.context)).rejects.toThrow("TEXT_MATCH_COUNT");
    await expect(replaceText({ ...edit, expectedOccurrences: 2 }, f.context)).rejects.toThrow(
      "LINE_ENDING_MATCH_REQUIRES_UNIQUE",
    );
    await expect(replaceText({ ...edit, expectedSha256: sha("stale") }, f.context)).rejects.toThrow(
      "STALE",
    );
    await expect(replaceText({ ...edit, oldText: "a\\r\\nb" }, f.context)).rejects.toThrow(
      "TEXT_MATCH_COUNT",
    );
    expect(f.writes()).toBe(0);
    const raced = fixture("a\r\nb\r\n", true);
    await expect(
      replaceText({ ...edit, expectedSha256: sha(raced.content()) }, raced.context),
    ).rejects.toThrow("CAS");
    expect(raced.writes()).toBe(0);
  });
  it("does not manufacture a newline style for a single-line file and reports normalized no-op", async () => {
    const f = fixture("a");
    await replaceText(
      {
        path: "a.ts",
        oldText: "a",
        newText: "b\r\nc",
        expectedSha256: sha("a"),
        expectedOccurrences: 1,
        lineEndingMode: "MATCH_FILE",
      },
      f.context,
    );
    expect(f.content()).toBe("b\r\nc");
    const result = await replaceText(
      {
        path: "a.ts",
        oldText: "b\nc",
        newText: "b\nc",
        expectedSha256: sha(f.content()),
        expectedOccurrences: 1,
        lineEndingMode: "MATCH_FILE",
      },
      f.context,
    );
    expect(result.status).toBe("NO_OP");
    expect(f.writes()).toBe(1);
  });
  it("supports unicode/CRLF and sequential edits using the returned complete SHA", async () => {
    const f = fixture("你好\r\nconst a = 1;\r\n");
    const first = await replaceText(
      {
        path: "a.ts",
        oldText: "a = 1",
        newText: "a = 2",
        expectedSha256: sha(f.content()),
        expectedOccurrences: 1,
      },
      f.context,
    );
    const second = await replaceText(
      {
        path: "a.ts",
        oldText: "a = 2",
        newText: "a = 3",
        expectedSha256: first.sha256,
        expectedOccurrences: 1,
      },
      f.context,
    );
    expect(f.content()).toBe("你好\r\nconst a = 3;\r\n");
    expect(second.sha256).toBe(sha(f.content()));
    expect(f.writes()).toBe(2);
  });
  it("rejects ambiguous text and stale hashes without writing", async () => {
    const f = fixture("x x");
    await expect(
      replaceText(
        {
          path: "a.ts",
          oldText: "x",
          newText: "y",
          expectedSha256: sha("x x"),
          expectedOccurrences: 1,
        },
        f.context,
      ),
    ).rejects.toThrow(/MATCH_COUNT/);
    await expect(
      replaceText(
        {
          path: "a.ts",
          oldText: "x",
          newText: "y",
          expectedSha256: sha("other"),
          expectedOccurrences: 2,
        },
        f.context,
      ),
    ).rejects.toThrow(/STALE/);
    expect(f.writes()).toBe(0);
  });
  it("reports no-op without a write, and fails an intervening change atomically", async () => {
    const f = fixture("x");
    expect(
      await replaceText(
        {
          path: "a.ts",
          oldText: "x",
          newText: "x",
          expectedSha256: sha("x"),
          expectedOccurrences: 1,
        },
        f.context,
      ),
    ).toMatchObject({ status: "NO_OP" });
    expect(f.writes()).toBe(0);
    const raced = fixture("x", true);
    await expect(
      replaceText(
        {
          path: "a.ts",
          oldText: "x",
          newText: "y",
          expectedSha256: sha("x"),
          expectedOccurrences: 1,
        },
        raced.context,
      ),
    ).rejects.toThrow(/CAS/);
    expect(raced.content()).toBe("xconcurrent");
    expect(raced.writes()).toBe(0);
  });
});
