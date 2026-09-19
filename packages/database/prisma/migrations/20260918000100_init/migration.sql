CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "RepositorySourceKind" AS ENUM ('LOCAL', 'GIT');
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED', 'ARCHIVED');
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT');
CREATE TYPE "WorkflowStage" AS ENUM ('START', 'ANALYZE_REPOSITORY', 'ANALYZE_TASK', 'GENERATE_PLAN', 'WAITING_APPROVAL', 'EXECUTE', 'TEST', 'FIX', 'REVIEW', 'GENERATE_DIFF', 'DONE', 'FAILED', 'CANCELLED');
CREATE TYPE "StepStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');
CREATE TYPE "ToolCallStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DENIED', 'TIMED_OUT', 'CANCELLED');
CREATE TYPE "EventLevel" AS ENUM ('TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR');
CREATE TYPE "ArtifactKind" AS ENUM ('PLAN', 'PATCH', 'DIFF', 'TEST_REPORT', 'REVIEW_REPORT', 'LOG', 'OTHER');
CREATE TYPE "ApprovalKind" AS ENUM ('PLAN', 'TOOL_CALL');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

CREATE TABLE "Repository" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourceKind" "RepositorySourceKind" NOT NULL,
    "sourceUri" TEXT NOT NULL,
    "defaultBranch" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "baseRef" TEXT,
    "baseCommit" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Run" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "idempotencyKey" TEXT,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStage" "WorkflowStage" NOT NULL DEFAULT 'START',
    "baseCommit" TEXT,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "modelConfig" JSONB,
    "maxSteps" INTEGER NOT NULL DEFAULT 25,
    "maxTestRetries" INTEGER NOT NULL DEFAULT 3,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "modelCallCount" INTEGER NOT NULL DEFAULT 0,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "modelLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "toolLatencyMs" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(18,8),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "summary" TEXT,
    "executionOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "cancelRequestedAt" TIMESTAMPTZ(3),
    "nextEventSequence" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Step" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stage" "WorkflowStage" NOT NULL,
    "status" "StepStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ToolCall" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "externalCallId" TEXT,
    "name" TEXT NOT NULL,
    "status" "ToolCallStatus" NOT NULL DEFAULT 'PENDING',
    "input" JSONB NOT NULL,
    "output" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Event" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" UUID,
    "toolCallId" UUID,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "level" "EventLevel" NOT NULL DEFAULT 'INFO',
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Artifact" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" UUID,
    "kind" "ArtifactKind" NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "uri" TEXT,
    "content" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Approval" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "stepId" UUID,
    "toolCallId" UUID,
    "kind" "ApprovalKind" NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "request" JSONB NOT NULL,
    "resolution" JSONB,
    "comment" TEXT,
    "actorId" TEXT,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Repository_createdAt_idx" ON "Repository"("createdAt");
CREATE INDEX "Task_repositoryId_createdAt_idx" ON "Task"("repositoryId", "createdAt");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE UNIQUE INDEX "Run_idempotencyKey_key" ON "Run"("idempotencyKey");
CREATE INDEX "Run_taskId_createdAt_idx" ON "Run"("taskId", "createdAt");
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");
CREATE INDEX "Run_status_leaseExpiresAt_idx" ON "Run"("status", "leaseExpiresAt");
CREATE INDEX "Step_runId_status_idx" ON "Step"("runId", "status");
CREATE UNIQUE INDEX "Step_runId_sequence_key" ON "Step"("runId", "sequence");
CREATE INDEX "ToolCall_runId_createdAt_idx" ON "ToolCall"("runId", "createdAt");
CREATE INDEX "ToolCall_stepId_idx" ON "ToolCall"("stepId");
CREATE INDEX "ToolCall_name_status_idx" ON "ToolCall"("name", "status");
CREATE UNIQUE INDEX "ToolCall_runId_externalCallId_key" ON "ToolCall"("runId", "externalCallId");
CREATE INDEX "Event_runId_occurredAt_idx" ON "Event"("runId", "occurredAt");
CREATE INDEX "Event_type_occurredAt_idx" ON "Event"("type", "occurredAt");
CREATE UNIQUE INDEX "Event_runId_sequence_key" ON "Event"("runId", "sequence");
CREATE INDEX "Artifact_runId_kind_createdAt_idx" ON "Artifact"("runId", "kind", "createdAt");
CREATE INDEX "Approval_runId_status_requestedAt_idx" ON "Approval"("runId", "status", "requestedAt");
CREATE INDEX "Approval_toolCallId_idx" ON "Approval"("toolCallId");

ALTER TABLE "Task" ADD CONSTRAINT "Task_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Run" ADD CONSTRAINT "Run_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Step" ADD CONSTRAINT "Step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Event" ADD CONSTRAINT "Event_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "ToolCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_toolCallId_fkey" FOREIGN KEY ("toolCallId") REFERENCES "ToolCall"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Run" ADD CONSTRAINT "Run_nonnegative_metrics_check" CHECK (
    "maxSteps" > 0 AND
    "maxTestRetries" >= 0 AND
    "stepCount" >= 0 AND
    "retryCount" >= 0 AND
    "modelCallCount" >= 0 AND
    "toolCallCount" >= 0 AND
    "durationMs" >= 0 AND
    "modelLatencyMs" >= 0 AND
    "toolLatencyMs" >= 0 AND
    "inputTokens" >= 0 AND
    "outputTokens" >= 0 AND
    "totalTokens" >= 0 AND
    "nextEventSequence" >= 0
);
ALTER TABLE "Step" ADD CONSTRAINT "Step_nonnegative_values_check" CHECK (
    "sequence" >= 0 AND ("durationMs" IS NULL OR "durationMs" >= 0)
);
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_nonnegative_duration_check" CHECK (
    "durationMs" IS NULL OR "durationMs" >= 0
);
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_content_or_uri_check" CHECK (
    "content" IS NOT NULL OR "uri" IS NOT NULL
);
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_resolution_time_check" CHECK (
    ("status" = 'PENDING' AND "resolvedAt" IS NULL) OR
    ("status" <> 'PENDING' AND "resolvedAt" IS NOT NULL)
);
