import { fileURLToPath } from "node:url";

import type { DatabaseAdapter, RunExecutionRecord } from "@devflow/database";
import {
  captureLocalRepositorySnapshot,
  decodeLocalRepositorySnapshot,
  encodeLocalRepositorySnapshot,
  LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME,
  localRepositorySnapshotMetadata,
  resolveLocalFilesystemPath,
  type LocalRepositorySnapshot,
} from "@devflow/sandbox";
import { DevflowError } from "@devflow/shared";

export const LOCAL_RUN_SNAPSHOT_ARTIFACT = LOCAL_REPOSITORY_SNAPSHOT_ARTIFACT_NAME;
const PROJECT_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export async function ensureLocalRunSnapshot(
  database: DatabaseAdapter,
  run: RunExecutionRecord,
  signal: AbortSignal,
): Promise<LocalRepositorySnapshot | undefined> {
  if (run.repository.sourceKind !== "LOCAL") return undefined;
  const existing = await findSnapshot(database, run.id);
  if (existing !== undefined) return existing;

  const sourcePath = localSourcePath(run.repository.sourceUri);
  const snapshot = await captureLocalRepositorySnapshot({
    sourceUri: run.repository.sourceUri,
    workspaceRoot: sourcePath,
    ...(run.task.baseRef === undefined ? {} : { baseRef: run.task.baseRef }),
    ...(run.task.baseCommitSha === undefined ? {} : { baseCommit: run.task.baseCommitSha }),
    signal,
  });
  await database.artifacts.create({
    runId: run.id,
    kind: "OTHER",
    name: LOCAL_RUN_SNAPSHOT_ARTIFACT,
    mimeType: "application/vnd.devflow.local-snapshot+json+gzip",
    content: encodeLocalRepositorySnapshot(snapshot),
    metadata: localRepositorySnapshotMetadata(snapshot),
  });
  return snapshot;
}

export async function requireLocalRunSnapshot(
  database: DatabaseAdapter,
  run: RunExecutionRecord,
): Promise<LocalRepositorySnapshot | undefined> {
  if (run.repository.sourceKind !== "LOCAL") return undefined;
  const snapshot = await findSnapshot(database, run.id);
  if (snapshot !== undefined) return snapshot;
  throw new DevflowError({
    code: "SANDBOX_FAILED",
    message:
      "The LOCAL repository snapshot captured before plan approval is missing; create a new run.",
    details: { runId: run.id, artifact: LOCAL_RUN_SNAPSHOT_ARTIFACT },
  });
}

async function findSnapshot(
  database: DatabaseAdapter,
  runId: string,
): Promise<LocalRepositorySnapshot | undefined> {
  const artifact = (await database.artifacts.list(runId)).find(
    (candidate) => candidate.kind === "OTHER" && candidate.name === LOCAL_RUN_SNAPSHOT_ARTIFACT,
  );
  if (artifact === undefined) return undefined;
  if (artifact.content === undefined) {
    throw new DevflowError({
      code: "SANDBOX_FAILED",
      message: "Persisted LOCAL repository snapshot does not contain snapshot data.",
      details: { runId, artifactId: artifact.id },
    });
  }
  return decodeLocalRepositorySnapshot(artifact.content);
}

function localSourcePath(sourceUri: string): string {
  return resolveLocalFilesystemPath(sourceUri, PROJECT_ROOT);
}
