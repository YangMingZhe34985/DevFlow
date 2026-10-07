import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentStateSerializer,
  createInitialAgentState,
  JsonFileAgentStateStore,
} from "../src/index.js";
import { invalidateHistoricalReads } from "../src/working-set.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentState persistence", () => {
  it("retains and validates trusted mutation observations after restore", () => {
    const messages = [
      {
        role: "TOOL" as const,
        toolCallId: "r",
        toolName: "readFile",
        isError: false,
        content: { path: "a.ts", content: "current" },
      },
      {
        role: "ASSISTANT" as const,
        content: "",
        toolCalls: [{ id: "w", name: "replaceText", input: { path: "a.ts" } }],
      },
      {
        role: "TOOL" as const,
        toolCallId: "w",
        toolName: "replaceText",
        isError: true,
        content: { code: "CONFLICT" },
        mutation: {
          status: "REJECTED" as const,
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
        },
      },
    ];
    const serializer = new AgentStateSerializer();
    const state = createInitialAgentState(randomUUID(), messages);
    const restored = serializer.deserialize(serializer.serialize(state));
    expect(restored.messages).toEqual(messages);
    expect(invalidateHistoricalReads(restored.messages)).toEqual(messages);
    const deleted = JSON.parse(serializer.serialize(state));
    deleted.messages[2].mutation.currentHashes["a.ts"] = "ABSENT";
    expect(serializer.deserialize(JSON.stringify(deleted)).messages[2]).toMatchObject({
      mutation: { currentHashes: { "a.ts": "ABSENT" } },
    });
    const invalid = JSON.parse(serializer.serialize(state));
    invalid.messages[2].mutation.observationComplete = "true";
    expect(() => serializer.deserialize(JSON.stringify(invalid))).toThrow(
      "Persisted AgentState is invalid",
    );
    invalid.messages[2].mutation.observationComplete = true;
    invalid.messages[2].mutation.currentHashes["a.ts"] = "truncated-sha";
    expect(() => serializer.deserialize(JSON.stringify(invalid))).toThrow(
      "Persisted AgentState is invalid",
    );
  });
  it("serializes and validates a state round trip", () => {
    const runId = randomUUID();
    const state = createInitialAgentState(runId, [{ role: "USER", content: "修复 Unicode 测试" }]);
    const serializer = new AgentStateSerializer();

    expect(serializer.deserialize(serializer.serialize(state))).toEqual(state);
    expect(() => serializer.deserialize('{"schemaVersion":2}')).toThrow(
      "Persisted AgentState is invalid",
    );
  });

  it("defaults newly added runtime counters when restoring a legacy checkpoint", () => {
    const state = createInitialAgentState(randomUUID(), [{ role: "USER", content: "legacy" }]);
    const legacy = JSON.parse(JSON.stringify(state)) as {
      metrics: Record<string, unknown>;
    };
    delete legacy.metrics.toolExecutions;
    delete legacy.metrics.cacheHits;
    delete legacy.metrics.duplicateToolCalls;
    delete legacy.metrics.stalledDetections;
    delete legacy.metrics.reasoningTokens;

    expect(new AgentStateSerializer().deserialize(JSON.stringify(legacy)).metrics).toMatchObject({
      toolExecutions: 0,
      cacheHits: 0,
      duplicateToolCalls: 0,
      stalledDetections: 0,
      reasoningTokens: 0,
    });
  });

  it("persists and restores state from an atomic JSON file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-agent-state-"));
    temporaryDirectories.push(directory);
    const store = new JsonFileAgentStateStore(directory);
    const state = createInitialAgentState(randomUUID(), [{ role: "USER", content: "persist me" }]);

    await store.save(state);

    expect(await store.load(state.runId)).toEqual(state);
    expect(await store.load(randomUUID())).toBeUndefined();
  });

  it("replaces repeated checkpoints without leaving temporary files", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "devflow-agent-state-replace-"));
    temporaryDirectories.push(directory);
    const store = new JsonFileAgentStateStore(directory);
    const initial = createInitialAgentState(randomUUID(), [
      { role: "USER", content: "persist every checkpoint" },
    ]);
    const completed = {
      ...initial,
      phase: "COMPLETED" as const,
      stepCount: 2,
      metrics: {
        modelCalls: 2,
        toolCalls: 1,
        toolExecutions: 1,
        cacheHits: 0,
        duplicateToolCalls: 0,
        stalledDetections: 0,
        reasoningTokens: 0,
        retries: 1,
        modelLatencyMs: 123,
        toolLatencyMs: 45,
        tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      finalResult: {
        runId: initial.runId,
        status: "SUCCEEDED" as const,
        summary: "done",
        metrics: {
          durationMs: 200,
          steps: 2,
          modelCalls: 2,
          toolCalls: 1,
          retries: 1,
          modelLatencyMs: 123,
          toolLatencyMs: 45,
          tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      },
    };

    await store.save(initial);
    await store.save({ ...initial, phase: "THINKING", stepCount: 1 });
    await store.save(completed);

    expect(await store.load(initial.runId)).toEqual(completed);
    expect(await readdir(directory)).toEqual([`${initial.runId}.json`]);
  });
});
