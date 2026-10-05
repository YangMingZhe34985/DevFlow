import { createHash } from "node:crypto";

export type PatchFailureKind =
  | "FORMAT_INVALID"
  | "CONTEXT_MISMATCH"
  | "STALE_SOURCE"
  | "TARGET_FORBIDDEN"
  | "UNSUPPORTED_PATCH"
  | "NO_CHANGE"
  | "APPLY_FAILED";
export type PatchCompatibility =
  | { status: "UNCHANGED"; patch: string }
  | {
      status: "NORMALIZED";
      patch: string;
      path: string;
      expectedHash: string;
      repairs: string[];
    }
  | { status: "REJECTED"; kind: PatchFailureKind; message: string };

/** Narrow syntax compatibility, never semantic repair or fuzzy matching. */
export function normalizePatchCandidate(input: {
  patch: string;
  targets: readonly { path: string; operation: string }[];
  current: ReadonlyMap<string, { content: string; expectedHash: string }>;
}): PatchCompatibility {
  const reject = (kind: PatchFailureKind, message: string): PatchCompatibility => ({
    status: "REJECTED",
    kind,
    message,
  });
  if (Buffer.byteLength(input.patch) > 2_000_000)
    return reject("FORMAT_INVALID", "Patch exceeds byte limit.");
  const lines = input.patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let needsRepair = false;
  const repairs: string[] = [];
  if (lines.at(-1) === "*** End Patch") {
    lines.pop();
    needsRepair = true;
    repairs.push("REMOVE_TRAILING_END_PATCH_MARKER");
  }
  const headers = lines.flatMap((line, i) => (line.startsWith("--- ") ? [i] : []));
  for (const i of headers) {
    const oldPath = lines[i]!.slice(4),
      newPath = lines[i + 1]?.slice(4);
    const name = oldPath === "/dev/null" ? newPath?.slice(2) : oldPath.slice(2);
    const target = input.targets.find((t) => t.path === name);
    const operation =
      oldPath === "/dev/null" ? "CREATE" : newPath === "/dev/null" ? "DELETE" : "MODIFY";
    if (
      !target ||
      target.operation !== operation ||
      !lines[i + 1]?.startsWith("+++ ") ||
      (oldPath !== "/dev/null" && oldPath !== `a/${name}`) ||
      (newPath !== "/dev/null" && newPath !== `b/${name}`)
    )
      return reject(
        "TARGET_FORBIDDEN",
        "Patch path and operation must match the approved edit obligation.",
      );
  }
  // Standard multi-file/create/delete patches remain under the existing Git path.
  if (headers.length !== 1)
    return needsRepair || lines.some((l) => l === "@@")
      ? reject("UNSUPPORTED_PATCH", "Compatibility accepts one existing MODIFY file only.")
      : { status: "UNCHANGED", patch: input.patch };
  const header = headers[0]!;
  const from = lines[header]!.match(/^--- a\/(.+)$/u)?.[1];
  const to = lines[header + 1]?.match(/^\+\+\+ b\/(.+)$/u)?.[1];
  if (!from || from !== to)
    return needsRepair || lines.some((l) => l === "@@")
      ? reject(
          "UNSUPPORTED_PATCH",
          "Compatibility requires identical explicit a/ and b/ file paths.",
        )
      : { status: "UNCHANGED", patch: input.patch };
  const hunks: { body: string[]; old: string[]; next: string[] }[] = [];
  let hasNoNewlineMarker = false;
  for (let i = header + 2; i < lines.length;) {
    const marker = lines[i++]!;
    const parsed = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(marker);
    if (marker !== "@@" && !parsed)
      return reject(
        "FORMAT_INVALID",
        "Expected a unified hunk header; unsupported text was not discarded.",
      );
    if (!parsed) {
      needsRepair = true;
      repairs.push("REBUILD_MISSING_HUNK_HEADER");
    }
    const body: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("@@")) {
      const line = lines[i++]!;
      if (line === "\\ No newline at end of file") {
        hasNoNewlineMarker = true;
        continue;
      }
      if (!/^[ +-]/u.test(line))
        return reject(
          "UNSUPPORTED_PATCH",
          "Only explicit context/add/remove hunk lines can be normalized.",
        );
      body.push(line);
    }
    const old = body.filter((l) => l[0] !== "+").map((l) => l.slice(1));
    const next = body.filter((l) => l[0] !== "-").map((l) => l.slice(1));
    if (
      parsed &&
      (Number(parsed[2] ?? 1) !== old.length || Number(parsed[4] ?? 1) !== next.length)
    ) {
      needsRepair = true;
      repairs.push("RECOUNT_HUNK_BODY");
    }
    hunks.push({ body, old, next });
  }
  if (!needsRepair) return { status: "UNCHANGED", patch: input.patch };
  if (hasNoNewlineMarker)
    return reject(
      "UNSUPPORTED_PATCH",
      "No-newline markers are preserved only in standard patches.",
    );
  if (!input.targets.some((t) => t.path === from && t.operation === "MODIFY"))
    return reject("TARGET_FORBIDDEN", "Normalization cannot create an edit obligation.");
  if (
    header > 2 ||
    lines
      .slice(0, header)
      .some(
        (l) =>
          l !== `diff --git a/${from} b/${from}` &&
          !/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100644| 100755)?$/u.test(l),
      )
  )
    return reject(
      "UNSUPPORTED_PATCH",
      "Metadata, mode changes, renames and unknown envelopes cannot be normalized.",
    );
  const current = input.current.get(from);
  if (
    !current ||
    createHash("sha256").update(current.content).digest("hex") !== current.expectedHash
  )
    return reject(
      "STALE_SOURCE",
      "Current content hash must match the approved execution evidence.",
    );
  if (current.content.includes("\r") || !current.content.endsWith("\n"))
    return reject(
      "UNSUPPORTED_PATCH",
      "Compatibility currently requires LF text with a final newline; original bytes were preserved.",
    );
  if (!hunks.length || hunks.length > 16)
    return reject("FORMAT_INVALID", "Expected 1–16 bounded hunks.");
  const source = current.content.slice(0, -1).split("\n");
  const edits: { start: number; end: number; next: string[] }[] = [];
  for (const hunk of hunks) {
    if (!hunk.old.length || hunk.body.every((l) => l[0] === " "))
      return reject("NO_CHANGE", "A nonempty old block and a real edit are required.");
    const matches: number[] = [];
    for (let i = 0; i <= source.length - hunk.old.length; i++) {
      if (hunk.old.every((line, j) => line === source[i + j])) matches.push(i);
      if (matches.length > 1) break;
    }
    if (matches.length !== 1)
      return reject(
        "CONTEXT_MISMATCH",
        `Old block has ${matches.length ? "multiple" : "zero"} exact matches; no location was guessed.`,
      );
    edits.push({
      start: matches[0]!,
      end: matches[0]! + hunk.old.length,
      next: hunk.next,
    });
  }
  edits.sort((a, b) => a.start - b.start);
  if (edits.some((e, i) => i > 0 && edits[i - 1]!.end > e.start))
    return reject("CONTEXT_MISMATCH", "Overlapping hunks cannot be normalized.");
  const groups: { start: number; end: number; edits: typeof edits }[] = [];
  for (const edit of edits) {
    const start = Math.max(0, edit.start - 3),
      end = Math.min(source.length, edit.end + 3);
    const last = groups.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.edits.push(edit);
    } else groups.push({ start, end, edits: [edit] });
  }
  const output = [`--- a/${from}`, `+++ b/${from}`];
  let offset = 0;
  for (const group of groups) {
    const body: string[] = [];
    let cursor = group.start;
    for (const edit of group.edits) {
      body.push(...source.slice(cursor, edit.start).map((l) => " " + l));
      body.push(...source.slice(edit.start, edit.end).map((l) => "-" + l));
      body.push(...edit.next.map((l) => "+" + l));
      cursor = edit.end;
    }
    body.push(...source.slice(cursor, group.end).map((l) => " " + l));
    const oldCount = group.end - group.start;
    const newCount = body.filter((l) => l[0] !== "-").length;
    output.push(
      `@@ -${group.start + 1},${oldCount} +${group.start + offset + 1},${newCount} @@`,
      ...body,
    );
    offset += newCount - oldCount;
  }
  const patch = output.join("\n") + "\n";
  if (Buffer.byteLength(patch) > 2_000_000)
    return reject("FORMAT_INVALID", "Normalized patch exceeds byte limit.");
  return {
    status: "NORMALIZED",
    patch,
    path: from,
    expectedHash: current.expectedHash,
    repairs: [...new Set([...repairs, "ADD_EXACT_UNCHANGED_CONTEXT"])],
  };
}
