ALTER TABLE "Run"
ADD COLUMN "maxReviewRetries" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "dispatchRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failureDetails" JSONB;

ALTER TABLE "Run" DROP CONSTRAINT "Run_nonnegative_metrics_check";
ALTER TABLE "Run" ADD CONSTRAINT "Run_nonnegative_metrics_check" CHECK (
    "maxSteps" > 0 AND
    "maxTestRetries" >= 0 AND
    "maxReviewRetries" >= 0 AND
    "dispatchRevision" >= 0 AND
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

-- At most one unresolved plan approval may exist for a Run. This makes a
-- recovered or duplicate planning job idempotent at the persistence boundary.
CREATE UNIQUE INDEX "Approval_one_pending_plan_per_run_key"
ON "Approval" ("runId")
WHERE "kind" = 'PLAN' AND "status" = 'PENDING';
