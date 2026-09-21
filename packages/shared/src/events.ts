import { z } from "zod";

import { EntityIdSchema, type RunId, type StepId, type ToolCallId } from "./ids.js";

export const AgentEventTypeSchema = z.enum([
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
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export const EventLevelSchema = z.enum(["TRACE", "DEBUG", "INFO", "WARN", "ERROR"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;

export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;

export const AgentEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: EntityIdSchema,
  runId: EntityIdSchema,
  stepId: EntityIdSchema.optional(),
  toolCallId: EntityIdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime({ offset: true }),
  type: AgentEventTypeSchema,
  level: EventLevelSchema,
  payload: JsonValueSchema,
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export interface NewAgentEvent {
  runId: RunId;
  stepId?: StepId;
  toolCallId?: ToolCallId;
  type: AgentEventType;
  level?: EventLevel;
  occurredAt: string;
  payload: JsonValue;
}

export interface EventSink {
  append(event: NewAgentEvent): Promise<AgentEvent>;
}

// TODO(P2-observability): replace broad payloads with a gradually expanded
// discriminated union and add centralized redaction/truncation before storage.
