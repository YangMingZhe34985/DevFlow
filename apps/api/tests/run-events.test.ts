import type { AddressInfo } from "node:net";

import { NestFactory } from "@nestjs/core";
import { filter, firstValueFrom, timeout } from "rxjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ApprovalStore,
  DatabaseAdapter,
  EventQuery,
  EventStore,
  RepositoryStore,
  RunRecord,
  RunRepository,
  TaskStore,
} from "@devflow/database";
import type { AgentEvent, NewAgentEvent, RunQueuePort, RunStatus } from "@devflow/shared";

import { AppModule } from "../src/app.module.js";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { RunEventStreamService } from "../src/modules/runs/run-event-stream.service.js";
import { resolveEventCursor } from "../src/modules/runs/runs.controller.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const TASK_ID = "00000000-0000-4000-8000-000000000002";

describe("run event cursor", () => {
  it("prefers Last-Event-ID and falls back to the query cursor", () => {
    expect(resolveEventCursor(" 7 ", "2")).toBe(7);
    expect(resolveEventCursor(undefined, "2")).toBe(2);
    expect(resolveEventCursor("", undefined)).toBe(0);
    expect(() => resolveEventCursor("not-a-sequence", "2")).toThrow();
  });
});

describe("RunEventStreamService", () => {
  it("emits heartbeats without advancing the persisted event cursor and stops on unsubscribe", async () => {
    const database = new FakeDatabase();
    database.reset("RUNNING", []);
    const service = new RunEventStreamService(database, {
      pollIntervalMs: 2,
      heartbeatIntervalMs: 5,
      batchSize: 10,
    });

    const heartbeat = await firstValueFrom(
      service.stream(RUN_ID, 4).pipe(
        filter((message) => message.comment?.startsWith("heartbeat") === true),
        timeout(1_000),
      ),
    );
    expect(heartbeat.id).toBeUndefined();
    expect(heartbeat.data).toBeUndefined();
    expect(heartbeat.comment).toContain(`run=${RUN_ID} sequence=4`);

    const callsAfterUnsubscribe = database.listCalls;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(database.listCalls).toBe(callsAfterUnsubscribe);
  });
});

describe("run event HTTP API", () => {
  const database = new FakeDatabase();
  const queue: RunQueuePort = {
    async enqueue() {},
    async cancel() {
      return false;
    },
    async ping() {},
    async close() {},
  };
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:5432/unused";
    process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
    app = await NestFactory.create(AppModule.register({ database, runQueue: queue }), {
      logger: false,
      forceCloseConnections: true,
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  beforeEach(() => {
    database.reset("RUNNING", [event(1), event(2), event(3), event(4)]);
  });

  afterAll(async () => {
    await app.close();
  });

  it("paginates persisted history with an exclusive sequence cursor", async () => {
    const first = await fetch(`${baseUrl}/runs/${RUN_ID}/events?afterSequence=1&limit=2`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
      nextSequence: 3,
      hasMore: true,
    });

    const second = await fetch(`${baseUrl}/runs/${RUN_ID}/events?afterSequence=3&limit=2`);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      events: [{ sequence: 4 }],
      nextSequence: 4,
      hasMore: false,
    });
  });

  it("validates history cursors and returns not found for an unknown run", async () => {
    const invalid = await fetch(`${baseUrl}/runs/${RUN_ID}/events?afterSequence=-1`);
    expect(invalid.status).toBe(400);

    database.removeRun();
    const missing = await fetch(`${baseUrl}/runs/${RUN_ID}/events`);
    expect(missing.status).toBe(404);
  });

  it("replays from Last-Event-ID, streams new events once, and closes at terminal state", async () => {
    database.reset("RUNNING", [event(1), event(2)]);
    setTimeout(() => {
      database.addEvent(event(3));
      database.setStatus("SUCCEEDED");
    }, 30);

    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`${baseUrl}/runs/${RUN_ID}/events/stream?afterSequence=0`, {
      headers: { "Last-Event-ID": "1" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const messages = await readSse(response);
    clearTimeout(watchdog);
    const persisted = messages.filter((message) => message.event !== "stream-end");
    expect(persisted.map((message) => message.id)).toEqual(["2", "3"]);
    expect(persisted.map((message) => message.data.sequence)).toEqual([2, 3]);
    expect(messages.at(-1)).toMatchObject({
      event: "stream-end",
      data: { status: "SUCCEEDED", lastSequence: 3 },
    });
  });

  it("uses the query cursor when Last-Event-ID is absent", async () => {
    database.setStatus("SUCCEEDED");
    const response = await fetch(`${baseUrl}/runs/${RUN_ID}/events/stream?afterSequence=3`);
    const messages = await readSse(response);
    expect(messages.filter((message) => message.event !== "stream-end")).toMatchObject([
      { id: "4", data: { sequence: 4 } },
    ]);
  });

  it("streams and replays a structured terminal failure before stream-end", async () => {
    database.reset("RUNNING", [event(1)]);
    setTimeout(() => {
      database.addEvent(failureEvent(2));
      database.setStatus("FAILED");
    }, 30);

    const liveMessages = await readSse(
      await fetch(`${baseUrl}/runs/${RUN_ID}/events/stream?afterSequence=1`),
    );
    expect(liveMessages).toMatchObject([
      {
        id: "2",
        event: "RUN_FAILED",
        data: {
          sequence: 2,
          payload: {
            stage: "EXECUTE",
            code: "SANDBOX_FAILED",
            message: "Failed to create Docker sandbox.",
          },
        },
      },
      { event: "stream-end", data: { status: "FAILED", lastSequence: 2 } },
    ]);

    const replayMessages = await readSse(
      await fetch(`${baseUrl}/runs/${RUN_ID}/events/stream?afterSequence=0`),
    );
    expect(replayMessages.map((message) => message.event)).toEqual([
      "STEP_COMPLETED",
      "RUN_FAILED",
      "stream-end",
    ]);
    expect(replayMessages.at(1)).toMatchObject({
      id: "2",
      data: { sequence: 2, payload: { code: "SANDBOX_FAILED" } },
    });
  });
});

class FakeDatabase implements DatabaseAdapter {
  readonly repositories = {} as RepositoryStore;
  readonly tasks = {} as TaskStore;
  readonly approvals = {} as ApprovalStore;
  readonly runs: RunRepository;
  readonly events: EventStore;
  listCalls = 0;
  private run: RunRecord | null = null;
  private persistedEvents: AgentEvent[] = [];

  constructor() {
    this.runs = {
      findById: async () => this.run,
    } as unknown as RunRepository;
    this.events = {
      append: async (input) => this.append(input),
      list: async (runId, query) => this.listEvents(runId, query),
    };
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async ping(): Promise<void> {}

  reset(status: RunStatus, events: readonly AgentEvent[]): void {
    this.run = run(status);
    this.persistedEvents = [...events];
    this.listCalls = 0;
  }

  removeRun(): void {
    this.run = null;
  }

  setStatus(status: RunStatus): void {
    if (this.run !== null) this.run = { ...this.run, status };
  }

  addEvent(value: AgentEvent): void {
    this.persistedEvents.push(value);
  }

  private async listEvents(runId: string, query: EventQuery = {}): Promise<AgentEvent[]> {
    this.listCalls += 1;
    const afterSequence = query.afterSequence ?? 0;
    const limit = query.limit ?? 100;
    return this.persistedEvents
      .filter((item) => item.runId === runId && item.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }

  private async append(input: NewAgentEvent): Promise<AgentEvent> {
    const value: AgentEvent = {
      ...input,
      schemaVersion: 1,
      eventId: `00000000-0000-4000-8000-${String(this.persistedEvents.length + 1).padStart(12, "0")}`,
      sequence: this.persistedEvents.length + 1,
      level: input.level ?? "INFO",
    };
    this.persistedEvents.push(value);
    return value;
  }
}

function run(status: RunStatus): RunRecord {
  return {
    id: RUN_ID,
    taskId: TASK_ID,
    status,
    currentStage: status === "SUCCEEDED" ? "DONE" : "EXECUTE",
    maxSteps: 25,
    maxTestRetries: 3,
    retryCount: 0,
    cancellationRequested: false,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function event(sequence: number): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    runId: RUN_ID,
    sequence,
    occurredAt: "2026-09-19T00:00:00.000Z",
    type: sequence === 4 ? "RUN_COMPLETED" : "STEP_COMPLETED",
    level: "INFO",
    payload: { sequence },
  };
}

function failureEvent(sequence: number): AgentEvent {
  return {
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    runId: RUN_ID,
    sequence,
    occurredAt: "2026-09-19T00:00:00.000Z",
    type: "RUN_FAILED",
    level: "ERROR",
    payload: {
      status: "FAILED",
      stage: "EXECUTE",
      terminalStage: "FAILED",
      code: "SANDBOX_FAILED",
      message: "Failed to create Docker sandbox.",
    },
  };
}

interface ParsedSseMessage {
  id?: string;
  event?: string;
  data: Record<string, unknown>;
}

async function readSse(response: Response): Promise<ParsedSseMessage[]> {
  if (response.body === null) throw new Error("SSE response did not include a body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const messages: ParsedSseMessage[] = [];
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed !== null) messages.push(parsed);
    }
    if (chunk.done) return messages;
  }
}

function parseSseBlock(block: string): ParsedSseMessage | null {
  let id: string | undefined;
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    if (line.startsWith("event:")) eventName = line.slice(6).trimStart();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return {
    ...(id === undefined ? {} : { id }),
    ...(eventName === undefined ? {} : { event: eventName }),
    data: JSON.parse(data.join("\n")) as Record<string, unknown>,
  };
}
