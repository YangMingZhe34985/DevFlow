CREATE TABLE "RunTeamState" (
  "runId" UUID NOT NULL PRIMARY KEY,
  "revision" INTEGER NOT NULL,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "RunTeamState_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "AgentInstance" (
  "runId" UUID NOT NULL, "id" TEXT NOT NULL, "role" TEXT NOT NULL, "status" TEXT NOT NULL,
  "value" JSONB NOT NULL, "sha256" TEXT NOT NULL,
  CONSTRAINT "AgentInstance_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "AgentInstance_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunTeamState"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentInstance_runId_status_idx" ON "AgentInstance"("runId", "status");
CREATE TABLE "AgentTask" (
  "runId" UUID NOT NULL, "id" TEXT NOT NULL, "agentId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "value" JSONB NOT NULL, "sha256" TEXT NOT NULL,
  CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "AgentTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunTeamState"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentTask_runId_agentId_status_idx" ON "AgentTask"("runId", "agentId", "status");
CREATE TABLE "AgentMessage" (
  "runId" UUID NOT NULL, "id" TEXT NOT NULL, "sequence" INTEGER NOT NULL, "recipient" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "value" JSONB NOT NULL, "sha256" TEXT NOT NULL,
  CONSTRAINT "AgentMessage_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "AgentMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunTeamState"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AgentMessage_runId_idempotencyKey_key" ON "AgentMessage"("runId", "idempotencyKey");
CREATE UNIQUE INDEX "AgentMessage_runId_sequence_key" ON "AgentMessage"("runId", "sequence");
CREATE INDEX "AgentMessage_runId_recipient_sequence_idx" ON "AgentMessage"("runId", "recipient", "sequence");
CREATE TABLE "SharedEvidence" (
  "runId" UUID NOT NULL, "id" TEXT NOT NULL, "valid" BOOLEAN NOT NULL,
  "value" JSONB NOT NULL, "sha256" TEXT NOT NULL,
  CONSTRAINT "SharedEvidence_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "SharedEvidence_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunTeamState"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SharedEvidence_runId_valid_idx" ON "SharedEvidence"("runId", "valid");
CREATE TABLE "AgentOperation" (
  "runId" UUID NOT NULL, "id" TEXT NOT NULL, "agentId" TEXT NOT NULL, "status" TEXT NOT NULL,
  "value" JSONB NOT NULL, "sha256" TEXT NOT NULL,
  CONSTRAINT "AgentOperation_pkey" PRIMARY KEY ("runId", "id"),
  CONSTRAINT "AgentOperation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "RunTeamState"("runId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AgentOperation_runId_status_idx" ON "AgentOperation"("runId", "status");
