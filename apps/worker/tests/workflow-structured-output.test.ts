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
  it("uses explicit compact Review recovery settings and discards even valid truncated JSON", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({ verdict: "PASS", summary: "partial", issues: [] }),
        finishReason: "LENGTH",
      }),
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({ verdict: "FAIL", summary: "fresh", issues: [] }),
      }),
    ]);
    const result = await generateStructuredOutput({
      model,
      schema,
      name: "review_result",
      description: "Review",
      purpose: "REVIEW",
      messages: [{ role: "USER", content: "original large evidence" }],
      settings: { reasoningEffort: "high", maxOutputTokens: 16384 },
      rejectLength: true,
      lengthRegeneration: true,
      lengthRecovery: {
        messages: [{ role: "USER", content: "complete current evidence and counterevidence" }],
        settings: { reasoningEffort: "low", maxOutputTokens: 16384 },
      },
      signal: new AbortController().signal,
    });
    expect(result.value.verdict).toBe("FAIL");
    expect(model.requests[1]?.settings).toEqual({ reasoningEffort: "low", maxOutputTokens: 16384 });
    expect(JSON.stringify(model.requests[1]?.messages)).not.toContain("partial");
  });
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
    expect(model.requests[0]?.settings?.reasoningEffort).toBeUndefined();
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

  it("regenerates a truncated decision from original context once, without repairing the partial JSON", async () => {
    const model = new FakeLanguageModel([
      fakeModelResponse({ toolCalls: [], text: '{"verdict":', finishReason: "LENGTH" }),
      fakeModelResponse({
        toolCalls: [],
        text: JSON.stringify({ verdict: "PASS", summary: "ok", issues: [] }),
      }),
    ]);
    const onResponse = vi.fn();
    const result = await generateStructuredOutput({
      model,
      schema,
      name: "localization",
      description: "decision",
      purpose: "LOCALIZATION",
      messages: [{ role: "USER", content: "original evidence" }],
      signal: new AbortController().signal,
      settings: { maxOutputTokens: 4096 },
      lengthRegeneration: true,
      onResponse,
    });
    expect(result.regenerationAttempts).toBe(1);
    expect(result.formatRepairAttempts).toBe(0);
    expect(model.requests[1]?.messages).toEqual(model.requests[0]?.messages);
    expect(model.requests[1]?.settings).toEqual({ maxOutputTokens: 4096, reasoningEffort: "none" });
    expect(result.attempts[0]?.failure?.kind).toBe("INVALID_JSON");
    expect(result.attempts[1]?.purpose).toBe("LOCALIZATION_LENGTH_REGENERATION");
    expect(onResponse).toHaveBeenCalledTimes(2);
  });

  it("stops after one empty LENGTH regeneration and records both failed attempts", async () => {
    const model = new FakeLanguageModel(
      Array.from({ length: 2 }, () =>
        fakeModelResponse({ toolCalls: [], text: "", finishReason: "LENGTH" }),
      ),
    );
    await expect(
      generateStructuredOutput({
        model,
        schema,
        name: "localization",
        description: "decision",
        purpose: "LOCALIZATION",
        messages: [{ role: "USER", content: "evidence" }],
        signal: new AbortController().signal,
        lengthRegeneration: true,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      details: {
        attempts: [
          { regeneration: false, finishReason: "LENGTH", error: { kind: "EMPTY_OUTPUT" } },
          { regeneration: true, finishReason: "LENGTH", error: { kind: "EMPTY_OUTPUT" } },
        ],
      },
    });
    expect(model.requests).toHaveLength(2);
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
