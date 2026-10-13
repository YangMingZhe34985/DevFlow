import { expect, it } from "vitest";
import { sourceRangeReferences } from "../src/context-source.js";
import { optimizeContextProjection } from "../src/context-projection.js";
import { DevflowError } from "@devflow/shared";
import type { ModelMessage } from "../src/model.js";

const lines = Array.from(
  { length: 100 },
  (_, i) => `const value${i} = "original evidence ${i}";\n`,
);
const full = {
  id: "full",
  path: "source.ts",
  fileSha256: "a".repeat(64),
  startLine: 1,
  endLine: 100,
  content: lines.join(""),
};
const subset = {
  ...full,
  id: "subset",
  startLine: 20,
  endLine: 70,
  content: lines.slice(19, 70).join(""),
};

it("references only same-path/SHA verbatim contained ranges, without transitive owners", () => {
  const smallest = {
    ...subset,
    id: "smallest",
    startLine: 30,
    endLine: 60,
    content: lines.slice(29, 60).join(""),
  };
  const refs = sourceRangeReferences([full, subset, smallest]);
  expect(refs.get("subset")?.id).toBe("full");
  expect(refs.get("smallest")?.id).toBe("full");
  for (const changed of [
    { ...subset, fileSha256: "b".repeat(64) },
    { ...subset, path: "other.ts" },
    { ...subset, endLine: 71 },
    { ...subset, content: subset.content.replace("original", "changed") },
  ])
    expect(sourceRangeReferences([full, changed]).size).toBe(0);
});

function messages(): ModelMessage[] {
  return [full, subset].flatMap(({ id, ...source }) => [
    {
      role: "ASSISTANT" as const,
      content: "",
      toolCalls: [{ id, name: "readFile", input: { path: source.path } }],
    },
    {
      role: "TOOL" as const,
      toolName: "readFile",
      toolCallId: id,
      isError: false,
      content: source,
    },
  ]);
}
it("keeps the complete owner visible and preserves history when differently wrapped read ranges overlap", async () => {
  const history = messages(),
    original = structuredClone(history);
  const result = await optimizeContextProjection({
    request: { messages: history, tools: [] },
    maxBytes: 12000,
  });
  expect(result.artifact.sourceReferences).toHaveLength(1);
  expect(
    result.request.messages.some(
      (m) => m.role === "TOOL" && (m.content as { content?: unknown }).content === full.content,
    ),
  ).toBe(true);
  expect(result.artifact.afterBytes).toBeLessThan(result.artifact.beforeBytes);
  expect(history).toEqual(original);
});
it("can project an oversized provider candidate before dispatch instead of failing on before measurement", async () => {
  let preparations = 0;
  const result = await optimizeContextProjection({
    request: { messages: messages(), tools: [] },
    maxBytes: 6500,
    prepare: async (r) => {
      preparations++;
      const size = Buffer.byteLength(JSON.stringify(r));
      if (size > 6500)
        throw new DevflowError({
          code: "VALIDATION_ERROR",
          message: "too large",
          details: { requestIssued: false, requiredBytes: size, maxBytes: 6500 },
        });
      return r;
    },
  });
  expect(preparations).toBeGreaterThan(1);
  expect(result.artifact.afterBytes).toBeLessThan(6500);
});
