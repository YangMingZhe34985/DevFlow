import { Inject, Injectable, Optional, type MessageEvent } from "@nestjs/common";
import { Observable } from "rxjs";

import type { DatabaseAdapter, RunRecord } from "@devflow/database";
import { DevflowError, type AgentEvent, type RunStatus } from "@devflow/shared";

import { DATABASE } from "../../infrastructure/tokens.js";

export const RUN_EVENT_STREAM_OPTIONS = Symbol("RUN_EVENT_STREAM_OPTIONS");

export interface RunEventStreamOptions {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  batchSize: number;
}

const DEFAULT_OPTIONS: RunEventStreamOptions = {
  pollIntervalMs: 250,
  heartbeatIntervalMs: 15_000,
  batchSize: 100,
};

@Injectable()
export class RunEventStreamService {
  private readonly options: RunEventStreamOptions;

  constructor(
    @Inject(DATABASE) private readonly database: DatabaseAdapter,
    @Optional()
    @Inject(RUN_EVENT_STREAM_OPTIONS)
    options?: Partial<RunEventStreamOptions>,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  stream(runId: string, afterSequence: number): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let active = true;
      let cursor = afterSequence;
      let nextPoll: ReturnType<typeof setTimeout> | undefined;
      let lastActivityAt = Date.now();

      const schedule = (delayMs: number): void => {
        if (!active) return;
        nextPoll = setTimeout(() => void poll(), delayMs);
      };

      const emitEvents = (events: readonly AgentEvent[]): number => {
        let emitted = 0;
        for (const event of events) {
          if (!active || event.sequence <= cursor) continue;
          subscriber.next({
            id: String(event.sequence),
            type: event.type,
            data: event,
          });
          cursor = event.sequence;
          emitted += 1;
        }
        if (emitted > 0) lastActivityAt = Date.now();
        return emitted;
      };

      const endStream = (run: RunRecord): void => {
        active = false;
        subscriber.next({
          id: String(cursor),
          type: "stream-end",
          data: { runId, status: run.status, lastSequence: cursor },
        });
        subscriber.complete();
      };

      const endWithError = (error: unknown): void => {
        active = false;
        const normalized =
          error instanceof DevflowError
            ? error.toJSON()
            : {
                code: "DATABASE_FAILED",
                message: "The persisted event stream is temporarily unavailable.",
                retryable: true,
              };
        subscriber.next({
          id: String(cursor),
          type: "stream-error",
          data: { runId, lastSequence: cursor, error: normalized },
        });
        subscriber.complete();
      };

      const poll = async (): Promise<void> => {
        try {
          const events = await this.database.events.list(runId, {
            afterSequence: cursor,
            limit: this.options.batchSize,
          });
          if (!active) return;
          emitEvents(events);

          if (events.length === this.options.batchSize) {
            schedule(0);
            return;
          }

          const run = await this.database.runs.findById(runId);
          if (!active) return;
          if (run === null) {
            endWithError(
              new DevflowError({
                code: "NOT_FOUND",
                message: `Run '${runId}' was not found.`,
              }),
            );
            return;
          }

          if (isTerminal(run.status)) {
            // Re-read after observing the terminal state. This closes the race where
            // an event commits between the first read and the terminal status read.
            const tail = await this.database.events.list(runId, {
              afterSequence: cursor,
              limit: this.options.batchSize,
            });
            if (!active) return;
            if (emitEvents(tail) > 0) {
              schedule(0);
              return;
            }
            endStream(run);
            return;
          }

          if (Date.now() - lastActivityAt >= this.options.heartbeatIntervalMs) {
            subscriber.next({
              // A comment-only message is a protocol heartbeat. Nest deliberately
              // does not synthesize an id for comments, so reconnect cursors remain
              // tied exclusively to persisted event sequences.
              comment: `heartbeat run=${runId} sequence=${cursor}`,
            });
            lastActivityAt = Date.now();
          }
          schedule(this.options.pollIntervalMs);
        } catch (error) {
          if (!active) return;
          // Once an SSE response is open, surfacing an Observable error makes
          // Nest synthesize an unrelated event id. Preserve the durable cursor
          // by ending with an explicit control event instead.
          endWithError(error);
        }
      };

      void poll();

      return () => {
        active = false;
        if (nextPoll !== undefined) clearTimeout(nextPoll);
      };
    });
  }
}

function isTerminal(status: RunStatus): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"].includes(status);
}
