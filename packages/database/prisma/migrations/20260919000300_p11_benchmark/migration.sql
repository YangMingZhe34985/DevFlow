CREATE TYPE "BenchmarkExecutionStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'EVALUATING',
  'SUCCEEDED',
  'FAILED',
  'INTERRUPTED'
);

CREATE TABLE "BenchmarkSuiteExecution" (
  "id" UUID NOT NULL,
  "suiteId" TEXT NOT NULL,
  "suiteVersion" TEXT NOT NULL,
  "status" "BenchmarkExecutionStatus" NOT NULL DEFAULT 'RUNNING',
  "profile" JSONB NOT NULL,
  "pricingVersion" TEXT NOT NULL,
  "metrics" JSONB,
  "result" JSONB,
  "failure" JSONB,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "BenchmarkSuiteExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BenchmarkCaseExecution" (
  "id" UUID NOT NULL,
  "suiteExecutionId" UUID,
  "suiteId" TEXT NOT NULL,
  "suiteVersion" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "caseVersion" TEXT NOT NULL,
  "status" "BenchmarkExecutionStatus" NOT NULL DEFAULT 'QUEUED',
  "runId" UUID,
  "definitionDigest" TEXT NOT NULL,
  "definition" JSONB NOT NULL,
  "profile" JSONB NOT NULL,
  "observation" JSONB,
  "metrics" JSONB,
  "provenance" JSONB,
  "result" JSONB,
  "failure" JSONB,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "BenchmarkCaseExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BenchmarkCaseExecution_runId_key" ON "BenchmarkCaseExecution"("runId");
CREATE INDEX "BenchmarkSuiteExecution_suiteId_suiteVersion_startedAt_idx"
  ON "BenchmarkSuiteExecution"("suiteId", "suiteVersion", "startedAt");
CREATE INDEX "BenchmarkSuiteExecution_status_updatedAt_idx"
  ON "BenchmarkSuiteExecution"("status", "updatedAt");
CREATE INDEX "BenchmarkCaseExecution_suiteId_caseId_startedAt_idx"
  ON "BenchmarkCaseExecution"("suiteId", "caseId", "startedAt");
CREATE INDEX "BenchmarkCaseExecution_suiteExecutionId_startedAt_idx"
  ON "BenchmarkCaseExecution"("suiteExecutionId", "startedAt");
CREATE INDEX "BenchmarkCaseExecution_status_updatedAt_idx"
  ON "BenchmarkCaseExecution"("status", "updatedAt");

ALTER TABLE "BenchmarkCaseExecution"
  ADD CONSTRAINT "BenchmarkCaseExecution_suiteExecutionId_fkey"
  FOREIGN KEY ("suiteExecutionId") REFERENCES "BenchmarkSuiteExecution"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "BenchmarkCaseExecution"
  ADD CONSTRAINT "BenchmarkCaseExecution_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "Run"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
