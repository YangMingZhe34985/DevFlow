import { expect, it } from "vitest";
import { optimizeContextProjection, recoverContextAtom } from "../src/context-projection.js";
import type { ModelMessage, ModelRequest } from "../src/model.js";
const request = (messages: ModelMessage[]): ModelRequest => ({
  messages,
  tools: [],
  settings: { maxOutputTokens: 8192 },
});
const diagnostic = {
  assertion: "expected all declared dependencies to succeed before join",
  trace: "source.py:88: failure\n".repeat(160),
};

it("interns only verbatim duplicate records while retaining Task, latest approval, diff, unfinished work and unique counterevidence", async () => {
  const plan = {
    approvalScope: { files: [{ path: "source.py" }] },
    behavior: "Preserve retry deduplication",
  };
  const history: ModelMessage[] = [
    { role: "USER", content: "Task:\nFix retried prerequisite readiness" },
    {
      role: "USER",
      content:
        "Stable Coding task state:\n" +
        JSON.stringify({
          diagnostic,
          counterevidence: "COUNTEREVIDENCE: changing the helper alone failed",
        }),
    },
    {
      role: "USER",
      content: "Approved plan (follow this plan):\n" + JSON.stringify(plan, null, 2),
    },
    {
      role: "USER",
      content:
        "Stable Coding task state:\n" +
        JSON.stringify({ diagnostic, unfinishedWork: ["scheduler terminal success"] }),
    },
    {
      role: "USER",
      content: JSON.stringify({
        diff: "--- source.py\n+++ source.py\n+changed",
        currentSha: "a".repeat(64),
      }),
    },
  ];
  const original = structuredClone(history);
  const result = await optimizeContextProjection({
    request: request(history),
    history,
    maxBytes: 6500,
  });
  expect(history).toEqual(original);
  expect(result.artifact.afterBytes).toBeLessThan(result.artifact.beforeBytes);
  expect(result.artifact.references.length).toBeGreaterThan(0);
  expect(JSON.stringify(result.request.messages)).toContain(
    "COUNTEREVIDENCE: changing the helper alone failed",
  );
  expect(JSON.stringify(result.request.messages)).toContain("scheduler terminal success");
  const approved = result.request.messages.find(
    (m) => m.role === "USER" && m.content.startsWith("Approved plan"),
  )!;
  expect(JSON.parse((approved.content as string).split("\n").slice(1).join("\n"))).toEqual(plan);
  expect(
    recoverContextAtom(result.artifact.evidence, result.artifact.references[0]!.sha256),
  ).toEqual(diagnostic);
  const changed = structuredClone(result.artifact.evidence);
  changed.sections[`atom:${result.artifact.references[0]!.sha256}`] = "forged";
  expect(() => recoverContextAtom(changed, result.artifact.references[0]!.sha256)).toThrow(
    /changed/,
  );
});

it("does not confuse identical record IDs or create a self-reference", async () => {
  const history: ModelMessage[] = [0, 1, 2].map(() => ({
    role: "USER",
    content: "Stable Coding task state:\n" + JSON.stringify(diagnostic),
  }));
  const result = await optimizeContextProjection({ request: request(history), maxBytes: 7000 });
  expect(new Set(result.artifact.records.map((r) => r.id)).size).toBe(3);
  expect(
    result.artifact.references.every((r) => r.record === result.artifact.records.at(-1)!.id),
  ).toBe(true);
});

it("never mechanically cuts a necessary source; reports a gap before dispatch", async () => {
  const history: ModelMessage[] = [
    { role: "USER", content: "Task:\nPreserve the tail implementation" },
    {
      role: "ASSISTANT",
      content: "",
      toolCalls: [{ id: "read", name: "readFile", input: { path: "source.py" } }],
    },
    {
      role: "TOOL",
      toolCallId: "read",
      toolName: "readFile",
      isError: false,
      content: {
        path: "source.py",
        fileSha256: "a".repeat(64),
        content: "def implementation():\n".repeat(900) + "ESSENTIAL_TAIL",
        truncated: false,
      },
    },
  ];
  await expect(
    optimizeContextProjection({
      request: request(history),
      maxBytes: 6000,
      priorityPaths: ["source.py"],
    }),
  ).rejects.toMatchObject({ details: { requestIssued: false, missingBytes: expect.any(Number) } });
  const enough = await optimizeContextProjection({ request: request(history), maxBytes: 50000 });
  expect(JSON.stringify(enough.request.messages)).toContain("ESSENTIAL_TAIL");
  expect(JSON.stringify(enough.request.messages)).not.toContain('"truncated":true');
});

it("invalidates source after mutation while retaining current diagnosis and counterevidence", async () => {
  const history: ModelMessage[] = [
    {
      role: "ASSISTANT",
      content: "",
      toolCalls: [{ id: "read", name: "readFile", input: { path: "source.py" } }],
    },
    {
      role: "TOOL",
      toolCallId: "read",
      toolName: "readFile",
      isError: false,
      content: { path: "source.py", content: "OLD_IMPLEMENTATION" },
    },
    {
      role: "ASSISTANT",
      content: "",
      toolCalls: [{ id: "edit", name: "replaceText", input: { path: "source.py" } }],
    },
    {
      role: "TOOL",
      toolCallId: "edit",
      toolName: "replaceText",
      isError: false,
      content: { applied: true },
    },
    {
      role: "USER",
      content: "Stable Coding task state: COUNTEREVIDENCE: public failure remains after mutation",
    },
  ];
  const result = await optimizeContextProjection({
    request: request(history),
    history,
    maxBytes: 12000,
  });
  expect(JSON.stringify(result.request.messages)).not.toContain("OLD_IMPLEMENTATION");
  expect(JSON.stringify(result.artifact.evidence)).toContain("OLD_IMPLEMENTATION");
  expect(JSON.stringify(result.request.messages)).toContain("COUNTEREVIDENCE");
});

it("selects whole older unrelated source records and keeps the newest interaction and relevant file", async () => {
  const history: ModelMessage[] = [{ role: "USER", content: "Task:\nFix source.py" }];
  for (const [id, path] of [
    ["unrelated", "elsewhere.py"],
    ["relevant", "source.py"],
  ])
    history.push(
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: id!, name: "readFile", input: { path } }],
      },
      {
        role: "TOOL",
        toolName: "readFile",
        toolCallId: id!,
        isError: false,
        content: {
          path,
          fileSha256: "a".repeat(64),
          content: path + "\n" + "unique-source\n".repeat(250),
          truncated: false,
        },
      },
    );
  const result = await optimizeContextProjection({
    request: request(history),
    maxBytes: 5500,
    priorityPaths: ["source.py"],
  });
  expect(result.artifact.omitted.some((r) => r.reason === "P1_UNRELATED_WHOLE_RECORD")).toBe(true);
  expect(JSON.stringify(result.request.messages)).toContain("source.py");
  const calls = result.request.messages.flatMap((m) =>
    m.role === "ASSISTANT" ? (m.toolCalls?.map((c) => c.id) ?? []) : [],
  );
  for (const m of result.request.messages)
    if (m.role === "TOOL") expect(calls).toContain(m.toolCallId);
});
