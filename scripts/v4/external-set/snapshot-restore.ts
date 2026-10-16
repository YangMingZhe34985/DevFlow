import type { LocalRepositorySnapshot } from "@devflow/sandbox";

/** Images already contain audited base links. Core restore creates links without
 * replacing existing ones; retain those exact image entries in the restore view.
 * The full immutable input and its SHA remain unchanged. */
export function imageRestoreView(
  snapshot: LocalRepositorySnapshot,
  identity: {
    imageId: string;
    auditImageId: string;
    sourceBaseCommit: string;
    strongAuditPassed: boolean;
  },
): LocalRepositorySnapshot {
  if (!snapshot.files.some((file) => file.kind === "SYMLINK")) return snapshot;
  if (
    !identity.strongAuditPassed ||
    identity.imageId !== identity.auditImageId ||
    snapshot.sourceHead !== identity.sourceBaseCommit
  )
    throw Error("Cannot reuse links without current immutable image/base audit");
  const files = snapshot.files.filter((file) => file.kind !== "SYMLINK");
  return { ...snapshot, files, totalBytes: files.reduce((n, file) => n + file.sizeBytes, 0) };
}
