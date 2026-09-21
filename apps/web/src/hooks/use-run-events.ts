"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiUrl, listRunEvents } from "../lib/api";
import type { AgentEvent } from "../lib/types";

const PAGE_SIZE = 500;
const NAMED_EVENT_TYPES = [
  "RUN_STARTED",
  "PLAN_GENERATED",
  "PLAN_APPROVED",
  "PLAN_REJECTED",
  "STEP_STARTED",
  "STEP_COMPLETED",
  "LLM_REQUEST",
  "LLM_RESPONSE",
  "TOOL_CALL",
  "TOOL_RESULT",
  "TEST_STARTED",
  "TEST_RESULT",
  "REPAIR_STARTED",
  "REPAIR_COMPLETED",
  "REVIEW_STARTED",
  "REVIEW_RESULT",
  "WORKFLOW_CHECKPOINT",
  "DIFF_GENERATED",
  "PUSH_APPROVAL_REQUIRED",
  "PUSH_APPROVED",
  "PUSH_COMPLETED",
  "PUSH_REJECTED",
  "PR_APPROVAL_REQUIRED",
  "PR_APPROVED",
  "PR_CREATED",
  "PR_REJECTED",
  "GITHUB_OPERATION_FAILED",
  "APPROVAL_REQUIRED",
  "RUN_FAILED",
  "RUN_COMPLETED",
  "RUN_CANCELLED",
] as const;

export type StreamState =
  "idle" | "loading-history" | "connecting" | "live" | "retrying" | "closed";

export interface RunEventStream {
  events: readonly AgentEvent[];
  state: StreamState;
  error?: string;
  reconnect(): void;
}

export function useRunEvents(
  runId: string | undefined,
  initialEvents: readonly AgentEvent[] = [],
): RunEventStream {
  const [events, setEvents] = useState<readonly AgentEvent[]>([]);
  const [state, setState] = useState<StreamState>(runId === undefined ? "idle" : "loading-history");
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const eventMapRef = useRef(new Map<number, AgentEvent>());
  const initialEventsRef = useRef(initialEvents);

  initialEventsRef.current = initialEvents;

  const publish = useCallback((incoming: readonly AgentEvent[]) => {
    let changed = false;
    for (const event of incoming) {
      if (!isAgentEvent(event) || eventMapRef.current.has(event.sequence)) continue;
      eventMapRef.current.set(event.sequence, event);
      changed = true;
    }
    if (!changed) return;
    setEvents(
      [...eventMapRef.current.values()].sort((left, right) => left.sequence - right.sequence),
    );
  }, []);

  useEffect(() => {
    if (runId === undefined) return;

    let disposed = false;
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempt = 0;
    const historyController = new AbortController();

    eventMapRef.current = new Map();

    const latestSequence = (): number | undefined => {
      const sequences = [...eventMapRef.current.keys()];
      return sequences.length === 0 ? undefined : Math.max(...sequences);
    };

    const connect = (): void => {
      if (disposed) return;
      setState(reconnectAttempt === 0 ? "connecting" : "retrying");
      const afterSequence = latestSequence();
      source = new EventSource(
        apiUrl(`/runs/${encodeURIComponent(runId)}/events/stream`, { afterSequence }),
        { withCredentials: true },
      );

      const handleEvent = (message: MessageEvent<string>): void => {
        const event = parseEvent(message.data);
        if (event === undefined) return;
        publish([event]);
        setError(undefined);
      };

      const handleStreamEnd = (): void => {
        source?.close();
        source = undefined;
        setState("closed");
        setError(undefined);
      };

      const handleStreamError = (message: MessageEvent<string>): void => {
        const control = parseControlEvent(message.data);
        setState("retrying");
        setError(control ?? "事件流暂时不可用，等待重新连接。");
      };

      source.onopen = () => {
        reconnectAttempt = 0;
        setState("live");
        setError(undefined);
      };
      source.onmessage = handleEvent;
      for (const eventType of NAMED_EVENT_TYPES) {
        source.addEventListener(eventType, handleEvent as EventListener);
      }
      source.addEventListener("stream-end", handleStreamEnd);
      source.addEventListener("stream-error", handleStreamError as EventListener);
      source.onerror = () => {
        source?.close();
        source = undefined;
        if (disposed) return;
        reconnectAttempt += 1;
        setState("retrying");
        setError("实时连接已中断，正在从最后一个 sequence 重放。");
        const delay = Math.min(1_000 * 2 ** Math.min(reconnectAttempt - 1, 4), 15_000);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const replayAndConnect = async (): Promise<void> => {
      // Yield once so effect setup remains a subscription boundary. State is
      // updated from the async replay callback rather than synchronously in the effect.
      await Promise.resolve();
      if (disposed) return;
      setEvents([]);
      publish(initialEventsRef.current);
      setState("loading-history");
      setError(undefined);
      try {
        let cursor: number | undefined;
        for (;;) {
          const page = await listRunEvents(runId, cursor, PAGE_SIZE, historyController.signal);
          if (disposed) return;
          publish(page);
          if (page.length < PAGE_SIZE) break;
          const nextCursor = page.reduce(
            (max, event) => Math.max(max, event.sequence),
            cursor ?? -1,
          );
          if (nextCursor === cursor) break;
          cursor = nextCursor;
        }
      } catch (historyError) {
        if (historyController.signal.aborted || disposed) return;
        setError(errorMessage(historyError));
      }
      connect();
    };

    void replayAndConnect();

    return () => {
      disposed = true;
      historyController.abort();
      source?.close();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    };
  }, [generation, publish, runId]);

  const reconnect = useCallback(() => {
    setGeneration((current) => current + 1);
  }, []);

  return useMemo(
    () => ({ events, state, ...(error === undefined ? {} : { error }), reconnect }),
    [error, events, reconnect, state],
  );
}

function parseEvent(serialized: string): AgentEvent | undefined {
  try {
    const parsed = JSON.parse(serialized) as unknown;
    const record = asObject(parsed);
    const candidate = record?.event ?? record?.data ?? parsed;
    return isAgentEvent(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function parseControlEvent(serialized: string): string | undefined {
  try {
    const parsed = asObject(JSON.parse(serialized) as unknown);
    const error = asObject(parsed?.error);
    return typeof error?.message === "string" ? error.message : undefined;
  } catch {
    return undefined;
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  const record = asObject(value);
  return (
    record?.schemaVersion === 1 &&
    typeof record.eventId === "string" &&
    typeof record.runId === "string" &&
    typeof record.sequence === "number" &&
    Number.isInteger(record.sequence) &&
    typeof record.occurredAt === "string" &&
    typeof record.type === "string" &&
    typeof record.level === "string" &&
    "payload" in record
  );
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "无法载入 Run 事件。";
}
