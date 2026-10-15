import { expect, it } from "vitest";
import { sourceSlice } from "../src/runs/execution-packet.js";
import { hash } from "../src/localization/contracts.js";

const signal = new AbortController().signal;
it("uses the implementation when a valid TypeScript type and value share the target name", async () => {
  const content =
    "export interface $Thing {value:number}\nexport const $Thing = (value:number) => value + 1;\n";
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
it("rejects a target symbol that the source does not declare", async () => {
  const content = "export const present = 1;\n";
  await expect(
    sourceSlice("src/a.ts", "missing", content, 0, "EDIT", signal),
  ).rejects.toMatchObject({ code: "TARGET_SYMBOL_NOT_FOUND" });
});
