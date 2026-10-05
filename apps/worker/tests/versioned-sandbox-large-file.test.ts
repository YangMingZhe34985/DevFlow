import { expect, it, vi } from "vitest";
import type { SandboxSession } from "@devflow/sandbox";
import { replaceText } from "../../../packages/tools/src/replace-text.js";
import type { ToolContext } from "@devflow/tools";
import { revisionedSandbox } from "../src/localization/sources.js";
import { hash } from "../src/localization/contracts.js";

const original = "// padding\n".repeat(14000) + "export const value = 1;\n";
function fixture() {
  let current = original;
  const reads: number[] = [];
  const writeFile = vi.fn(
    async (input: { path: string; content: string; expectedSha256?: string }) => {
      expect(input.expectedSha256).toBe(hash(current));
      current = input.content;
      return { path: input.path, sha256: hash(current), sizeBytes: Buffer.byteLength(current) };
    },
  );
  const sandbox = {
    id: "versioned",
    workspacePath: "/workspace",
    writeFile,
    readFile: async ({ path, maxBytes = 200000 }: { path: string; maxBytes?: number }) => {
      reads.push(maxBytes);
      return {
        path,
        content: current.slice(0, maxBytes),
        fileSha256: hash(current),
        truncated: current.length > maxBytes,
        sizeBytes: Buffer.byteLength(current),
        encoding: "utf8",
      };
    },
  } as unknown as SandboxSession;
  return {
    reads,
    writeFile,
    sandbox,
    mutate: () => {
      current = original.replace("value = 1", "value = 3");
    },
  };
}

it("replaces an unchanged >64 KiB file using its complete hash after a bounded model read", async () => {
  const f = fixture(),
    tracked = revisionedSandbox(f.sandbox);
  const visible = await tracked.sandbox.readFile({ path: "src/large.ts", maxBytes: 4096 });
  expect(visible.truncated).toBe(true);
  const result = await replaceText(
    {
      path: "src/large.ts",
      oldText: "value = 1",
      newText: "value = 2",
      expectedSha256: visible.fileSha256!,
      expectedOccurrences: 1,
    },
    { sandbox: tracked.sandbox, signal: new AbortController().signal } as ToolContext,
  );
  expect(result.status).toBe("APPLIED");
  expect(result.sha256).toBe(hash(original.replace("value = 1", "value = 2")));
  expect(f.reads).toEqual([4096, 1_000_000, 1_000_000]);
  expect(f.writeFile).toHaveBeenCalledOnce();
});

it("still rejects an actual change after the first 64 KiB and attempts no write", async () => {
  const f = fixture(),
    tracked = revisionedSandbox(f.sandbox);
  await tracked.sandbox.readFile({ path: "src/large.ts", maxBytes: 1_000_000 });
  f.mutate();
  await expect(
    tracked.sandbox.writeFile({
      path: "src/large.ts",
      content: "replacement",
      expectedSha256: hash(original),
    }),
  ).rejects.toThrow("changed since evidence");
  expect(f.writeFile).not.toHaveBeenCalled();
});
