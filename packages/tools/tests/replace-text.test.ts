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
