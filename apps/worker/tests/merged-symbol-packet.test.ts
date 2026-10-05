import { expect, it } from "vitest";
import { sourceSlice, validateExecutionContract } from "../src/runs/execution-packet.js";
import { hash } from "../src/localization/contracts.js";

const signal = new AbortController().signal;
it("uses the implementation when a valid TypeScript type and value share the target name", async () => {
  const content =
    "export interface $Thing {value:number}\nexport const $Thing = (value:number) => value + 1;\n";
  const source = {
    manifest: async () => ({ entries: [], incomplete: false }),
    lookup: async () => ({
      path: "src/a.ts",
      kind: "FILE" as const,
      sizeBytes: Buffer.byteLength(content),
      contentHash: hash(content),
    }),
    read: async () => ({ content, truncated: false }),
  };
  const contract = {
    version: "execution-contract-v1" as const,
    editTargets: [
      {
        path: "src/a.ts",
        symbol: "$Thing",
        operation: "MODIFY" as const,
        rationale: "Fix runtime behavior",
      },
    ],
    inspectTargets: [],
    verificationHints: [],
    unresolvedQuestions: [],
  };
  await expect(validateExecutionContract(contract, source, signal)).resolves.toMatchObject({
    editTargets: [{ symbol: "$Thing" }],
  });
  const slice = await sourceSlice("src/a.ts", "$Thing", content, 0, "EDIT", signal);
  expect(slice.startLine).toBe(2);
  expect(slice.code).toContain("value + 1");
  expect(slice.code).not.toContain("interface");
});
it("resolves the same binding in a large lexical source while retaining bounded and partial provenance", async () => {
  const content =
    "// padding\n".repeat(7000) +
    "export interface $Thing {value:number}\nexport const $Thing = (value:number) => value + 1;\n";
  const slice = await sourceSlice("src/a.ts", "$Thing", content, 0, "EDIT", signal);
  expect(slice.startLine).toBe(7002);
  expect(slice.code).toContain("value + 1");
  expect(slice.complete).toBe(false);
  expect(slice.fullFile).toBe(false);
  expect(slice.contentHash).toBe(hash(content));
});
it("keeps two runtime declarations ambiguous even when a type also shares the name", async () => {
  const content =
    "// padding\n".repeat(7000) + "interface same {}\nfunction same() {}\nfunction same() {}\n";
  await expect(sourceSlice("src/a.ts", "same", content, 0, "EDIT", signal)).rejects.toMatchObject({
    code: "PLAN_TARGET_AMBIGUOUS",
  });
});
