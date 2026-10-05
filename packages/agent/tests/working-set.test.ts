import { expect, it } from "vitest";
import {
  contentHash,
  deduplicateContext,
  invalidateHistoricalReads,
  type WorkingSet,
} from "../src/working-set.js";
import type { ModelMessage } from "../src/model.js";
const code = "export const untouched = 42;\n";
const ws: WorkingSet = {
  version: "working-set-v1",
  evidenceVersion: "v",
  workspaceRevision: 0,
  targetFiles: ["a.ts"],
  targetSymbols: [],
  relevantCode: [
    {
      path: "a.ts",
      contentHash: contentHash(code),
      startLine: 1,
      endLine: 2,
      workspaceRevision: 0,
      code,
      complete: true,
      role: "TARGET",
    },
  ],
  requiredInterfaces: [],
  relevantTests: [],
  constraints: [],
  uncertainty: [],
  missingInformation: [],
  evidenceSufficient: true,
  requiresAdditionalExploration: false,
};
const read: ModelMessage = {
  role: "TOOL",
  toolCallId: "r1",
  toolName: "readFile",
  isError: false,
  content: { path: "a.ts", content: code, truncated: false },
};
it("references exact code already visible, but not expired, absent or truncated evidence", () => {
  const evidence: ModelMessage = {
    role: "USER",
    content: `Repository/stage evidence:\n${JSON.stringify(ws)}`,
  };
  expect(deduplicateContext([evidence, read], ws)[1]).toMatchObject({
    content: { note: "already available in current context" },
  });
  expect(deduplicateContext([read], ws)[0]).toEqual(read);
  expect(deduplicateContext([evidence, read], ws, 1)[1]).toEqual(read);
  expect(
    deduplicateContext([evidence, read], {
      ...ws,
      relevantCode: [{ ...ws.relevantCode[0]!, complete: false }],
    })[1],
  ).toEqual(read);
});
it("removes the synthesized snapshot duplicate while retaining the actual tool code", () => {
  const messages: ModelMessage[] = [
    {
      role: "USER",
      content: `Latest relevant file snapshots (newer reads replace older versions):\n${JSON.stringify([{ path: "a.ts", content: code }])}`,
    },
    read,
    { ...read, toolCallId: "r2" },
  ];
  const result = deduplicateContext(messages);
  expect(result[1]).toEqual(read);
  expect(result[2]).toMatchObject({ content: { evidenceRef: { toolCallId: "r1" } } });
  expect(JSON.stringify(result).split("export const untouched")).toHaveLength(2);
});
it("does not merge different versions or different paths with equal content", () => {
  const other = { ...read, toolCallId: "r2", content: { path: "b.ts", content: code } };
  expect(deduplicateContext([read, other])).toEqual([read, other]);
});
it("retains identical snippets at distinct line ranges and complete source versions", () => {
  const first = {
    ...read,
    content: {
      path: "a.ts",
      content: code,
      startLine: 100,
      endLine: 101,
      fileSha256: "a".repeat(64),
      workspaceRevision: 0,
    },
  };
  const nextRange = {
    ...first,
    toolCallId: "r2",
    content: { ...first.content, startLine: 200, endLine: 201 },
  };
  const nextVersion = {
    ...first,
    toolCallId: "r3",
    content: { ...first.content, fileSha256: "b".repeat(64) },
  };
  expect(deduplicateContext([first, nextRange, nextVersion])).toEqual([
    first,
    nextRange,
    nextVersion,
  ]);
  expect(deduplicateContext([first, { ...first, toolCallId: "r4" }])[1]).toMatchObject({
    content: {
      startLine: 100,
      endLine: 101,
      fileSha256: "a".repeat(64),
      evidenceRef: { toolCallId: "r1" },
    },
  });
});
it("marks older read content stale after a mutation, including partial failed writes", () => {
  const history: ModelMessage[] = [
    read,
    { role: "ASSISTANT", content: "", toolCalls: [{ id: "w", name: "writeFile", input: {} }] },
    { ...read, toolCallId: "new" },
  ];
  const projected = invalidateHistoricalReads(history);
  expect(projected[0]).toMatchObject({ content: { stale: true } });
  expect(projected[2]).toEqual(history[2]);
});
