ALTER TYPE "WorkflowStage" ADD VALUE 'WAITING_PUSH_APPROVAL';
ALTER TYPE "WorkflowStage" ADD VALUE 'PUSH';
ALTER TYPE "WorkflowStage" ADD VALUE 'WAITING_PR_APPROVAL';
ALTER TYPE "WorkflowStage" ADD VALUE 'CREATE_PR';

ALTER TYPE "ArtifactKind" ADD VALUE 'GITHUB_CHANGESET';

ALTER TYPE "ApprovalKind" ADD VALUE 'GITHUB_PUSH';
ALTER TYPE "ApprovalKind" ADD VALUE 'GITHUB_PULL_REQUEST';

CREATE TABLE "GitHubPublication" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITHUB',
    "repositoryOwner" TEXT NOT NULL,
    "repositoryName" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "branchName" TEXT NOT NULL,
    "pushOperationKey" TEXT NOT NULL,
    "changesArtifactId" UUID,
    "commitSha" TEXT,
    "branchUrl" TEXT,
    "pullRequestOperationKey" TEXT,
    "pullRequestNumber" INTEGER,
    "pullRequestUrl" TEXT,
    "pullRequestState" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "GitHubPublication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "GitHubPublication_runId_fkey" FOREIGN KEY ("runId")
      REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GitHubPublication_commit_sha_check"
      CHECK ("commitSha" IS NULL OR "commitSha" ~ '^[0-9a-fA-F]{40}$'),
    CONSTRAINT "GitHubPublication_pr_number_check"
      CHECK ("pullRequestNumber" IS NULL OR "pullRequestNumber" > 0),
    CONSTRAINT "GitHubPublication_pr_state_check"
      CHECK ("pullRequestState" IS NULL OR "pullRequestState" IN ('open', 'closed'))
);

CREATE UNIQUE INDEX "GitHubPublication_runId_key" ON "GitHubPublication"("runId");
CREATE UNIQUE INDEX "GitHubPublication_pushOperationKey_key"
  ON "GitHubPublication"("pushOperationKey");
CREATE UNIQUE INDEX "GitHubPublication_pullRequestOperationKey_key"
  ON "GitHubPublication"("pullRequestOperationKey");
CREATE UNIQUE INDEX "GitHubPublication_repositoryOwner_repositoryName_branchName_key"
  ON "GitHubPublication"("repositoryOwner", "repositoryName", "branchName");
CREATE INDEX "GitHubPublication_repositoryOwner_repositoryName_createdAt_idx"
  ON "GitHubPublication"("repositoryOwner", "repositoryName", "createdAt");

-- Duplicate/stalled deliveries must not create a second unresolved side-effect approval.
CREATE UNIQUE INDEX "Approval_one_pending_github_push_per_run_key"
  ON "Approval"("runId")
  WHERE "kind" = 'GITHUB_PUSH' AND "status" = 'PENDING';
CREATE UNIQUE INDEX "Approval_one_pending_github_pr_per_run_key"
  ON "Approval"("runId")
  WHERE "kind" = 'GITHUB_PULL_REQUEST' AND "status" = 'PENDING';
