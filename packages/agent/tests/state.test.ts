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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("AgentState persistence", () => {
  it("serializes and validates a state round trip", () => {
    const runId = randomUUID();
    const state = createInitialAgentState(runId, [{ role: "USER", content: "修复 Unicode 测试" }]);
    const serializer = new AgentStateSerializer();

    expect(serializer.deserialize(serializer.serialize(state))).toEqual(state);
    expect(() => serializer.deserialize('{"schemaVersion":2}')).toThrow(
      "Persisted AgentState is invalid",
    );
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
