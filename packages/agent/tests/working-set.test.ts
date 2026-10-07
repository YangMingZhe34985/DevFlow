import { expect, it } from "vitest";
import {
  contentHash,
  deduplicateContext,
  invalidateHistoricalReads,
  type WorkingSet,
} from "../src/working-set.js";
import type { ModelMessage } from "../src/model.js";
import type { MutationResult } from "@devflow/shared";
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

const observedNoChange: MutationResult = {
  status: "REJECTED",
  executionSucceeded: false,
  mutationAttempted: true,
  mutationApplied: false,
  workspaceChanged: false,
  reason: "TEXT_MATCH_COUNT",
  beforeRevision: 1,
  afterRevision: 1,
  changedFiles: [],
  currentHashes: { "a.ts": "a".repeat(64) },
  observationComplete: true,
  affectedPaths: ["a.ts"],
};
function mutationHistory(mutation?: MutationResult): ModelMessage[] {
  return [
    read,
    { ...read, toolCallId: "r2", content: { path: "b.ts", content: code } },
    {
      role: "ASSISTANT",
      content: "",
      toolCalls: [{ id: "w", name: "replaceText", input: { path: "a.ts" } }],
    },
    {
      role: "TOOL",
      toolCallId: "w",
      toolName: "replaceText",
      isError: true,
      content: { code: "CONFLICT" },
      ...(mutation ? { mutation } : {}),
    },
    { ...read, toolCallId: "fresh" },
  ];
}

it("retains current evidence after a completely observed rejected/no-op edit", () => {
  const history = mutationHistory(observedNoChange);
  expect(invalidateHistoricalReads(history)).toEqual(history);
  expect(
    invalidateHistoricalReads(mutationHistory({ ...observedNoChange, status: "NO_OP" })),
  ).toEqual(mutationHistory({ ...observedNoChange, status: "NO_OP" }));
});

it("invalidates only changed files even when a failed edit partially wrote bytes", () => {
  const history = mutationHistory({
    ...observedNoChange,
    status: "FAILED",
    mutationApplied: true,
    workspaceChanged: true,
    afterRevision: 2,
    changedFiles: ["a.ts"],
    affectedPaths: ["a.ts", "b.ts"],
  });
  const result = invalidateHistoricalReads(history);
  expect(result[0]).toMatchObject({ content: { path: "a.ts", stale: true } });
  expect(result.slice(1)).toEqual(history.slice(1));
  expect(invalidateHistoricalReads(result)).toEqual(result);
});

it("keeps failures without a complete host observation conservative", () => {
  for (const mutation of [undefined, { ...observedNoChange, observationComplete: undefined }]) {
    const history = mutationHistory(mutation);
    expect(invalidateHistoricalReads(history)[0]).toMatchObject({ content: { stale: true } });
  }
  const history = mutationHistory();
  // A model-authored payload cannot replace the trusted top-level observation.
  history[3] = { ...history[3]!, content: { mutation: observedNoChange } } as ModelMessage;
  expect(invalidateHistoricalReads(history)[0]).toMatchObject({ content: { stale: true } });
  expect(invalidateHistoricalReads(history)[1]).toMatchObject({ content: { stale: true } });
});

it("invalidates only known affected paths when their observation is incomplete", () => {
  const history = mutationHistory({ ...observedNoChange, observationComplete: false });
  const result = invalidateHistoricalReads(history);
  expect(result[0]).toMatchObject({ content: { stale: true } });
  expect(result[1]).toEqual(history[1]);
  expect(result[4]).toEqual(history[4]);
});

it("handles orphaned tool observations and pathless legacy reads conservatively", () => {
  const history = mutationHistory({ ...observedNoChange, observationComplete: false });
  history.splice(2, 1);
  expect(invalidateHistoricalReads(history)[0]).toMatchObject({ content: { stale: true } });
  history[0] = { ...read, content: { content: code } };
  expect(invalidateHistoricalReads(history)[0]).toMatchObject({ content: { stale: true } });
});

it("projects batch/localization evidence by path and retains stable task records", () => {
  const changed = {
    ...observedNoChange,
    status: "APPLIED" as const,
    executionSucceeded: true,
    mutationApplied: true,
    workspaceChanged: true,
    afterRevision: 2,
    changedFiles: ["./src\\a.ts"],
  };
  const files = [
    { path: "src/a.ts", content: "old" },
    { path: "b.ts", content: "valid" },
  ];
  const history = mutationHistory(changed);
  history.splice(
    0,
    2,
    { ...read, toolName: "batchReadFiles", content: { files } },
    {
      ...read,
      toolCallId: "loc",
      toolName: "locateIssue",
      content: { sources: files, constraints: ["Keep public API"] },
    },
    { role: "USER", content: "Task: preserve the expected public behavior" },
  );
  const result = invalidateHistoricalReads(history);
  expect(result[0]).toMatchObject({
    content: { files: [{ path: "src/a.ts", stale: true }, files[1]] },
  });
  expect(result[1]).toMatchObject({
    content: {
      sources: [{ path: "src/a.ts", stale: true }, files[1]],
      constraints: ["Keep public API"],
    },
  });
  expect(result[2]).toEqual(history[2]);
});
