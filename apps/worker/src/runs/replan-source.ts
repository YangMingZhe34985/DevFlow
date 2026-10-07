import { DevflowError } from "@devflow/shared";
import type { SandboxSession } from "@devflow/sandbox";
import type { IndexEntry, IndexSource } from "../localization/contracts.js";
import { graphPathAllowed } from "../localization/relation-graph.js";
import type { ReplanEvidenceReader } from "./replan-evidence.js";

/** One immutable workspace revision. Recreate after mutation or checkpoint restore. */
export function replanSource(input: {
  sandbox: SandboxSession;
  reader: ReplanEvidenceReader;
  entries: readonly IndexEntry[];
  complete: boolean;
  revision: string;
  beforeMetadata: () => Promise<void>;
  onCacheHit?: () => void;
}): IndexSource {
  const entries = new Map(input.entries.map((entry) => [entry.path, entry]));
  const directories = new Set<string>(["."]);
  const absent = new Set<string>();
  for (const path of entries.keys()) {
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      directories.add(parent);
    }
  }
  return {
    identity: input.revision,
    fileCount: entries.size,
    async manifest(signal) {
      signal.throwIfAborted();
      input.onCacheHit?.();
      return { entries: [...entries.values()], incomplete: !input.complete };
    },
    async lookup(path, signal) {
      signal.throwIfAborted();
      if (path !== "." && !graphPathAllowed(path)) throw new Error("REPLAN_FORBIDDEN_SOURCE");
      if (directories.has(path)) {
        input.onCacheHit?.();
        return { path, kind: "DIRECTORY", sizeBytes: 0 };
      }
      if (absent.has(path)) {
        input.onCacheHit?.();
        return undefined;
      }
      let entry = entries.get(path);
      if (!entry) {
        // A complete, validated host manifest plus checkpoint overlay is an
        // explicit absence observation for this immutable revision.
        if (input.complete) {
          absent.add(path);
          input.onCacheHit?.();
          return undefined;
        }
        await input.beforeMetadata();
        try {
          const listing = await input.sandbox.listFiles(
            { path, recursive: false, maxEntries: 1 },
            signal,
          );
          const found = listing.entries.find((item) => item.path === path);
          entry = found ? { ...found, sizeBytes: found.sizeBytes ?? 0 } : undefined;
          if (!entry && listing.truncated) throw new Error("REPLAN_METADATA_UNKNOWN");
          // An empty listing is not an explicit NOT_FOUND observation.
          if (!entry) throw new Error("REPLAN_METADATA_UNKNOWN");
          entries.set(path, entry);
        } catch (error) {
          if (error instanceof DevflowError && error.code === "NOT_FOUND") {
            absent.add(path);
            return undefined;
          }
          throw error;
        }
      } else input.onCacheHit?.();
      if (entry.kind !== "FILE") return entry;
      const current = await input.reader.read(path);
      return { ...entry, sizeBytes: current.sizeBytes, contentHash: current.contentHash };
    },
    async read(path, signal) {
      signal.throwIfAborted();
      const file = await input.reader.read(path);
      return { content: file.content, truncated: false };
    },
  };
}

/** Reservations are capacity checks, not tool consumption. Physical IO is charged once. */
export function replanOperationReserve(
  oldPaths: number,
  publicChecks: number,
  knownManifest: boolean,
  actual?: {
    changedPaths: number;
    sourceReads: number;
    candidatePaths: number;
    cachedReads?: number;
  },
) {
  const changed = actual?.changedPaths ?? oldPaths;
  const operations = {
    sourceReads: Math.min(8, Math.max(0, (actual?.sourceReads ?? 8) - (actual?.cachedReads ?? 0))),
    metadata: knownManifest ? 0 : Math.min(8, actual?.candidatePaths ?? 8),
    checkpoint: 3 + 2 * changed,
    checkpointRestore: 2 + 3 * changed,
    repairContext: 2 + Math.min(8, actual?.candidatePaths ?? oldPaths + 2),
    editCorrectionFinish: 3,
    publicChecks: 1 + Math.max(1, publicChecks),
    reviewReads: 8, // diff, bounded six source reads, final candidate capture
  };
  const downstream =
    operations.checkpointRestore +
    operations.repairContext +
    operations.editCorrectionFinish +
    operations.publicChecks +
    operations.reviewReads;
  return { operations, downstream, total: Object.values(operations).reduce((a, b) => a + b, 0) };
}
