CREATE TABLE "RepositoryIndexEntry" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepositoryIndexEntry_pkey" PRIMARY KEY ("scope", "key")
);
CREATE INDEX "RepositoryIndexEntry_createdAt_idx" ON "RepositoryIndexEntry"("createdAt");
