import { z } from "zod";

export const ExecutionModeSchema = z.enum(["workflow", "team", "single"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const TeamConfigurationSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(2).default(2),
  maxInvestigators: z.number().int().min(1).max(4).default(4),
  maxTasks: z.number().int().min(1).max(12).default(12),
  maxMessages: z.number().int().min(1).max(64).default(64),
});
export type TeamConfiguration = z.infer<typeof TeamConfigurationSchema>;
export const TeamMessageTypeSchema = z.enum([
  "REQUEST_EVIDENCE",
  "EVIDENCE_RESULT",
  "CHALLENGE",
  "BLOCKER",
  "TASK_RESULT",
  "SCOPE_CHANGE_REQUEST",
]);
export type TeamMessageType = z.infer<typeof TeamMessageTypeSchema>;
const refs = z.array(z.string().min(1).max(128)).max(16);
const text = z.string().min(1).max(2000);
export const TeamActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("DELEGATE"),
    key: z.string().min(1).max(80),
    goal: text,
    evidenceIds: refs,
    dependsOn: refs.default([]),
  }),
  z.strictObject({
    type: z.literal("SEND"),
    toAgentId: z.string().min(1),
    taskId: z.string().min(1),
    messageType: TeamMessageTypeSchema,
    body: text,
    evidenceIds: refs,
    replyTo: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("CANCEL"), taskId: z.string(), reason: text }),
  z.strictObject({
    type: z.literal("READ"),
    path: z.string().min(1).max(1024),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal("SEARCH"), query: z.string().min(2).max(300) }),
  z.strictObject({
    type: z.literal("RELATIONS"),
    paths: z.array(z.string().min(1).max(1024)).min(1).max(4),
    symbols: z.array(z.string().max(120)).max(8),
  }),
  z.strictObject({
    type: z.literal("RESULT"),
    evidenceIds: refs,
    hypotheses: z.array(text).max(6),
    missing: z.array(text).max(8),
  }),
  z.strictObject({
    type: z.literal("PROPOSE_PLAN"),
    evidenceIds: refs,
    missing: z.array(text).max(8),
  }),
  z.strictObject({
    type: z.literal("STOP"),
    reason: z.enum(["STALLED", "INSUFFICIENT_EVIDENCE"]),
    missing: z.array(text).max(8),
  }),
]);
export type TeamAction = z.infer<typeof TeamActionSchema>;
export const TeamDecisionSchema = z.strictObject({
  summary: text,
  actions: z.array(TeamActionSchema).min(1).max(4),
});
export type TeamDecision = z.infer<typeof TeamDecisionSchema>;

export interface TeamLease {
  owner: string;
  dispatchRevision: number;
}
export interface TeamEvidence {
  id: string;
  runId: string;
  repositoryId: string;
  sourceIdentity: string;
  kind: "SOURCE_OBSERVATION" | "VALIDATION_OBSERVATION" | "INTERPRETATION" | "HYPOTHESIS";
  path?: string;
  fileSha256?: string;
  startLine?: number;
  endLine?: number;
  content: string;
  contentSha256: string;
  sourceOperationId: string;
  supports: string[];
  valid: boolean;
}
export interface TeamAgent {
  id: string;
  runId: string;
  sessionId: string;
  role: "COORDINATOR" | "INVESTIGATOR" | "SOLVER";
  status: "READY" | "RUNNING" | "COMPLETED" | "BLOCKED" | "CANCELLED";
  taskIds: string[];
  decisionCount: number;
  inboxCursor: number;
  /** Full private history is persisted, never broadcast to peers. */
  history: { input: unknown; output: TeamDecision }[];
  noProgress: number;
  seenActions: string[];
  observedEvidenceIds: string[];
}
export interface TeamTask {
  id: string;
  key: string;
  parentTaskId?: string;
  agentId: string;
  goal: string;
  dependsOn: string[];
  evidenceIds: string[];
  status: "READY" | "RUNNING" | "WAITING" | "COMPLETED" | "BLOCKED" | "CANCELLED";
  result?: { summary: string; evidenceIds: string[]; hypotheses: string[]; missing: string[] };
  reason?: string;
}
export interface TeamMessage {
  id: string;
  sequence: number;
  from: string;
  to: string;
  taskId: string;
  type: TeamMessageType;
  body: string;
  evidenceIds: string[];
  replyTo?: string;
  idempotencyKey: string;
  sourceIdentity: string;
}
export interface TeamOperation {
  id: string;
  agentId: string;
  taskId?: string;
  kind: "MODEL" | "TOOL";
  status: "PREPARED" | "INFLIGHT" | "COMPLETED" | "NOT_ISSUED" | "UNKNOWN";
  input: unknown;
  output?: unknown;
  error?: string;
}
export interface TeamSnapshot {
  version: 1;
  runId: string;
  repositoryId: string;
  sourceIdentity: string;
  revision: number;
  config: TeamConfiguration;
  mode: "team" | "single";
  status: "RUNNING" | "READY_FOR_PLAN" | "STOPPED";
  coordinatorId: string;
  agents: TeamAgent[];
  tasks: TeamTask[];
  messages: TeamMessage[];
  evidence: TeamEvidence[];
  operations: TeamOperation[];
  stopReason?: string;
  missing: string[];
  selectedEvidenceIds: string[];
  modelBindings?: Record<string, unknown>;
}
