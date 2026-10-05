import { describe, expect, it } from "vitest";
import { prepareStageContext, recoverContextMessage } from "../src/stage-context.js";
import type { ModelMessage } from "../src/model.js";
describe("static stage context", () => {
  it("keeps full history and recoverable hashes while removing old successful interaction groups", () => {
    const history: ModelMessage[] = [
      { role: "SYSTEM", content: "Never expand permissions" },
      { role: "USER", content: "Issue" },
    ];
    for (let i = 0; i < 8; i++)
      history.push(
        {
          role: "ASSISTANT",
          content: "",
          toolCalls: [{ id: String(i), name: "readFile", input: { path: "a" } }],
        },
        {
          role: "TOOL",
          toolCallId: String(i),
          toolName: "readFile",
          isError: i === 4,
          content: i === 4 ? "latest error" : "x".repeat(1200),
        },
      );
    const artifact = prepareStageContext({ stage: "EXECUTE", history, maxBytes: 4300 });
    expect(artifact.omitted.length).toBeGreaterThan(0);
    expect(artifact.history).toEqual(history);
    expect(JSON.stringify(artifact.view)).toContain("latest error");
    expect(artifact.view[0]?.content).toBe("Never expand permissions");
    expect(recoverContextMessage(artifact, 3)).toEqual(history[3]);
    const calls = artifact.view.flatMap((m) =>
      m.role === "ASSISTANT" ? (m.toolCalls?.map((c) => c.id) ?? []) : [],
    );
    for (const m of artifact.view) if (m.role === "TOOL") expect(calls).toContain(m.toolCallId);
    artifact.history[3] = { role: "USER", content: "tampered" };
    expect(() => recoverContextMessage(artifact, 3)).toThrow(/hash/);
  });
  it("marks reads stale after replaceText without deleting the original evidence", () => {
    const history: ModelMessage[] = [
      { role: "ASSISTANT", content: "", toolCalls: [{ id: "read", name: "readFile", input: {} }] },
      {
        role: "TOOL",
        toolCallId: "read",
        toolName: "readFile",
        isError: false,
        content: { path: "a", content: "old" },
      },
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: "edit", name: "replaceText", input: {} }],
      },
      {
        role: "TOOL",
        toolCallId: "edit",
        toolName: "replaceText",
        isError: false,
        content: { status: "APPLIED" },
      },
    ];
    const artifact = prepareStageContext({ stage: "REPAIR", history, workspaceRevision: 1 });
    expect(artifact.view[1]?.content).toMatchObject({ stale: true });
    expect(artifact.history[1]?.content).toEqual({ path: "a", content: "old" });
  });
  it("never trims pinned constraints/errors/counterevidence to fabricate a fitting request", () => {
    expect(() =>
      prepareStageContext({
        stage: "REVIEW",
        history: [{ role: "SYSTEM", content: "x".repeat(4000) }],
        maxBytes: 1000,
      }),
    ).toThrow(/no request/);
  });
  it("projects the newest large source result while preserving identity, authority, pairing and full recovery", () => {
    const code = "export const value = 1;\r\n".repeat(10000);
    const history: ModelMessage[] = [
      { role: "SYSTEM", content: "Approved writes only: src/a.ts; revision=3" },
      { role: "USER", content: "Issue: fix default without breaking existing values" },
      {
        role: "ASSISTANT",
        content: "",
        toolCalls: [{ id: "read", name: "readFile", input: { path: "src/a.ts" } }],
      },
      {
        role: "TOOL",
        toolCallId: "read",
        toolName: "readFile",
        isError: false,
        content: {
          path: "src/a.ts",
          content: code,
          fileSha256: "a".repeat(64),
          sizeBytes: Buffer.byteLength(code),
          workspaceRevision: 3,
          truncated: false,
        },
      },
    ];
    const artifact = prepareStageContext({
      stage: "REPAIR",
      history,
      authoritative: { approval: "src/a.ts", revision: 3 },
    });
    expect(artifact.viewBytes).toBeLessThan(96000);
    expect(artifact.projected).toHaveLength(1);
    expect(recoverContextMessage(artifact, 3)).toEqual(history[3]);
    const tool = artifact.view.find((m) => m.role === "TOOL")!;
    expect(tool.content).toMatchObject({
      fileSha256: "a".repeat(64),
      workspaceRevision: 3,
      truncated: true,
      recovery: { expectedSha256: "a".repeat(64), maxBytes: 8192 },
    });
    expect(JSON.stringify(artifact.view)).toContain("Approved writes only");
    expect(JSON.stringify(artifact.view)).toContain('"toolCallId":"read"');
    expect(history[3]).toMatchObject({ content: { content: code, truncated: false } });
  });
  it("does not project arbitrary tool failures or policy data", () => {
    const history: ModelMessage[] = [
      { role: "ASSISTANT", content: "", toolCalls: [{ id: "err", name: "readFile", input: {} }] },
      {
        role: "TOOL",
        toolCallId: "err",
        toolName: "readFile",
        isError: true,
        content: "failure".repeat(20000),
      },
    ];
    expect(() => prepareStageContext({ stage: "REPAIR", history })).toThrow("no request");
  });
  it("rejects incomplete tool groups before constructing a provider request", () => {
    expect(() =>
      prepareStageContext({
        stage: "EXECUTE",
        history: [
          {
            role: "ASSISTANT",
            content: "",
            toolCalls: [{ id: "pending", name: "readFile", input: {} }],
          },
        ],
      }),
    ).toThrow(/unfinished tool/);
    expect(() =>
      prepareStageContext({
        stage: "EXECUTE",
        history: [
          {
            role: "TOOL",
            toolCallId: "unknown",
            toolName: "readFile",
            content: "data",
            isError: false,
          },
        ],
      }),
    ).toThrow(/orphan tool/);
  });
});
