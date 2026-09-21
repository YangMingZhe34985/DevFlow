import { FakeLanguageModel, fakeModelResponse } from "@devflow/agent";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { generateStructuredOutput } from "../src/runs/workflow-structured-output.js";

const schema = z
  .object({
    verdict: z.enum(["PASS", "FAIL"]),
    summary: z.string().min(1),
    issues: z.array(z.object({ severity: z.enum(["low", "medium", "high"]), message: z.string() })),
  })
  .strict();

describe("generateStructuredOutput", () => {
  it("accepts one valid schema-conforming result", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({ verdict: "PASS", summary: "ok", issues: [] }),
      }),
    ]);
    const result = await run(model);
    expect(result.value).toEqual({ verdict: "PASS", summary: "ok", issues: [] });
    expect(result.formatRepairAttempts).toBe(0);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.output?.schema).toBe(schema);
    expect(model.requests[0]?.settings?.reasoningEffort).toBe("none");
  });

  it("treats fenced JSON as malformed and performs one context-free format repair", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        text: '```json\n{"verdict":"PASS","summary":"ok","issues":[]}\n```',
      }),
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({ verdict: "PASS", summary: "ok", issues: [] }),
      }),
    ]);
    const onResponse = vi.fn(async () => undefined);
    const result = await run(model, onResponse);
    expect(result.formatRepairAttempts).toBe(1);
    expect(model.requests).toHaveLength(2);
    const repairPrompt = model.requests[1]?.messages
      .map(({ content }) => String(content))
      .join("\n");
    expect(repairPrompt).toContain("rawOutput");
    expect(repairPrompt).not.toContain("SECRET_TASK_CONTEXT");
    expect(repairPrompt).not.toContain("Diff:");
    expect(onResponse).toHaveBeenCalledTimes(2);
  });

  it("distinguishes schema mismatch and fails closed after exactly one repair", async () => {
    const invalid = JSON.stringify({ approved: true, summary: "legacy", findings: [] });
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: invalid }),
      fakeModelResponse({ toolCalls: [], text: invalid }),
    ]);
    await expect(run(model)).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      details: {
        attempts: [
          { error: { kind: "SCHEMA_MISMATCH" } },
          { formatRepair: true, error: { kind: "SCHEMA_MISMATCH" } },
        ],
      },
    });
    expect(model.requests).toHaveLength(2);
  });

  it("does not invent semantics when the initial output is empty", async () => {
    const model = new FakeLanguageModel([fakeModelResponse({ toolCalls: [], text: "" })]);
    await expect(run(model)).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
    expect(model.requests).toHaveLength(1);
  });
});

async function run(
  model: FakeLanguageModel,
  onResponse?: Parameters<typeof generateStructuredOutput>[0]["onResponse"],
) {
  return await generateStructuredOutput({
    model,
    schema,
    name: "review_result",
    description: "Independent review result",
    purpose: "REVIEW",
    messages: [
      { role: "SYSTEM", content: "Review evidence." },
      { role: "USER", content: "SECRET_TASK_CONTEXT\nDiff:\nsecret" },
    ],
    signal: new AbortController().signal,
    ...(onResponse === undefined ? {} : { onResponse }),
  });
}
