import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { normalizePatchCandidate } from "../src/patch-normalization.js";
import { GUARDED_PATCH_SCRIPT } from "../src/guarded-patch-script.js";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const source =
  "export function overlaps(a, b) {\n  const left = [\n    a.start,\n    a.end,\n  ].sort();\n  const right = [\n    b.start,\n    b.end,\n  ].sort();\n  return left[0] < right[1];\n}\n";
const malformed =
  "--- a/a.ts\n+++ b/a.ts\n@@\n   const left = [\n     a.start,\n     a.end,\n-  ].sort();\n+  ].sort((a, b) => a - b);\n   const right = [\n     b.start,\n     b.end,\n-  ].sort();\n+  ].sort((a, b) => a - b);\n*** End Patch";
const prepare = (patch = malformed, content = source, expectedHash = digest(content)) =>
  normalizePatchCandidate({
    patch,
    targets: [{ path: "a.ts", operation: "MODIFY" }],
    current: new Map([["a.ts", { content, expectedHash }]]),
  });
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(content = source) {
  const d = await mkdtemp(path.join(tmpdir(), "devflow-patch-"));
  dirs.push(d);
  await writeFile(path.join(d, "a.ts"), content);
  return d;
}
function apply(d: string, patch: string, expectedHashes: Record<string, string | null>) {
  return JSON.parse(
    execFileSync(process.execPath, ["-e", GUARDED_PATCH_SCRIPT], {
      cwd: d,
      input: JSON.stringify({ patch, expectedHashes }),
      encoding: "utf8",
      windowsHide: true,
    }),
  );
}
it("repairs the observed bare hunk/end marker only through exact source and applies the intended two edits", async () => {
  const d = await fixture();
  expect(apply(d, malformed, { "a.ts": digest(source) })).toMatchObject({
    applied: false,
    patchFailure: { kind: "FORMAT_INVALID" },
  });
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(source);
  const fixed = prepare();
  expect(fixed.status).toBe("NORMALIZED");
  if (fixed.status !== "NORMALIZED") return;
  expect(apply(d, fixed.patch, { "a.ts": digest(source) })).toMatchObject({
    applied: true,
    changedFiles: ["a.ts"],
  });
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(
    source.replaceAll("].sort();", "].sort((a, b) => a - b);"),
  );
});
it("recounts malformed counts but preserves valid standard patches verbatim", () => {
  const fixed = prepare();
  if (fixed.status !== "NORMALIZED") throw new Error("Expected normalized fixture");
  expect(prepare(fixed.patch)).toEqual({
    status: "UNCHANGED",
    patch: fixed.patch,
  });
  expect(
    prepare(fixed.patch.replace(/@@ -\d+,\d+ \+\d+,\d+ @@/, "@@ -1,999 +1,999 @@")),
  ).toMatchObject({ status: "NORMALIZED" });
});
it("diagnoses malformed repeated file sections without guessing or writing", () => {
  const patch =
    "--- a/a.ts\n+++ b/a.ts\n@@ -1,6 +1,12 @@\n-old\n+new\n--- a/a.ts\n+++ b/a.ts\n@@ -4,7 +4,9 @@\n-old2\n+new2\n";
  expect(prepare(patch)).toMatchObject({ status: "REJECTED", kind: "FORMAT_INVALID" });
  const result = prepare(patch);
  if (result.status !== "REJECTED") throw new Error("expected rejection");
  expect(result.message).toContain("Repeated file sections");
  expect(result.message).toContain("Line 3");
  expect(result.message).toContain("Line 8");
  expect(result.message).toContain("without rereading unchanged source");
});
it("never guesses among zero or duplicate old-block matches, stale hashes or unknown envelopes", () => {
  expect(prepare(malformed, source.replace("a.start", "changed"))).toMatchObject({
    status: "REJECTED",
    kind: "CONTEXT_MISMATCH",
  });
  expect(prepare(malformed, source + source)).toMatchObject({
    status: "REJECTED",
    kind: "CONTEXT_MISMATCH",
  });
  expect(prepare(malformed, source, "0".repeat(64))).toMatchObject({
    status: "REJECTED",
    kind: "STALE_SOURCE",
  });
  expect(prepare("*** Begin Patch\n" + malformed)).toMatchObject({
    status: "REJECTED",
    kind: "UNSUPPORTED_PATCH",
  });
});
it.each(["LF", "CRLF"])(
  "normalizes malformed %s patch payloads against uniform CRLF source and preserves its bytes",
  async (patchEnding) => {
    const content = source.replaceAll("\n", "\r\n");
    const candidate = patchEnding === "CRLF" ? malformed.replaceAll("\n", "\r\n") : malformed;
    const fixed = prepare(candidate, content);
    expect(fixed.status).toBe("NORMALIZED");
    if (fixed.status !== "NORMALIZED") throw new Error("Expected normalized CRLF fixture");
    expect(fixed.expectedHash).toBe(digest(content));
    expect(fixed.repairs).toContain("PRESERVE_CRLF_SOURCE");
    const d = await fixture(content);
    expect(apply(d, fixed.patch, { "a.ts": digest(content) })).toMatchObject({
      applied: true,
      changedFiles: ["a.ts"],
    });
    expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(
      content.replaceAll("].sort();", "].sort((a, b) => a - b);"),
    );
    expect(prepare(fixed.patch, content)).toEqual({ status: "UNCHANGED", patch: fixed.patch });
  },
);
it("adapts valid LF hunk payloads to exact CRLF source, while preserving valid CRLF patches verbatim", async () => {
  const base = prepare();
  if (base.status !== "NORMALIZED") throw new Error("Expected LF fixture");
  const content = source.replaceAll("\n", "\r\n");
  const fixed = prepare(base.patch, content);
  expect(fixed.status).toBe("NORMALIZED");
  if (fixed.status !== "NORMALIZED") return;
  expect(fixed.repairs).toContain("MATCH_SOURCE_LINE_ENDINGS");
  const d = await fixture(content);
  expect(apply(d, fixed.patch, { "a.ts": digest(content) }).applied).toBe(true);
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(
    content.replaceAll("].sort();", "].sort((a, b) => a - b);"),
  );
  const physicalCrLf = fixed.patch.replace(/(?<!\r)\n/gu, "\r\n");
  expect(prepare(physicalCrLf, content)).toEqual({ status: "UNCHANGED", patch: physicalCrLf });
  const physicalFixture = await fixture(content);
  expect(apply(physicalFixture, physicalCrLf, { "a.ts": digest(content) }).applied).toBe(true);
  expect(await readFile(path.join(physicalFixture, "a.ts"), "utf8")).toBe(
    content.replaceAll("].sort();", "].sort((a, b) => a - b);"),
  );
});
it("normalizes uniform CRLF patch serialization to LF source without changing literal backslash text", async () => {
  const content = 'const literal = "\\r\\n";\nconst value = 1;\n';
  const candidate =
    '--- a/a.ts\r\n+++ b/a.ts\r\n@@\r\n const literal = "\\r\\n";\r\n-const value = 1;\r\n+const value = 2;\r\n';
  const fixed = prepare(candidate, content);
  if (fixed.status !== "NORMALIZED") throw new Error("Expected normalized serialized patch");
  const d = await fixture(content);
  expect(apply(d, fixed.patch, { "a.ts": digest(content) }).applied).toBe(true);
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(
    content.replace("value = 1", "value = 2"),
  );
});
it("rejects mixed or lone-CR compatibility inputs, missing final newlines, stale SHA and ambiguous CRLF blocks", () => {
  const crlf = source.replaceAll("\n", "\r\n");
  for (const content of [
    crlf.replace("\r\n", "\n"),
    source.replace("\n", "\r"),
    crlf.slice(0, -2),
  ]) {
    expect(prepare(malformed, content)).toMatchObject({
      status: "REJECTED",
      kind: "UNSUPPORTED_PATCH",
    });
  }
  expect(
    prepare(malformed.replace("   const left = [\n", "   const left = [\r\n"), crlf),
  ).toMatchObject({ status: "REJECTED", kind: "UNSUPPORTED_PATCH" });
  expect(prepare(malformed, crlf, "0".repeat(64))).toMatchObject({
    status: "REJECTED",
    kind: "STALE_SOURCE",
  });
  expect(prepare(malformed, crlf + crlf)).toMatchObject({
    status: "REJECTED",
    kind: "CONTEXT_MISMATCH",
  });
});
it("rejects another target and overlapping hunks", () => {
  expect(prepare(malformed.replaceAll("a.ts", "other.ts"))).toMatchObject({
    status: "REJECTED",
    kind: "TARGET_FORBIDDEN",
  });
  const body = malformed.split("@@\n")[1]!.replace("*** End Patch", "");
  expect(prepare("--- a/a.ts\n+++ b/a.ts\n@@\n" + body + "@@\n" + body)).toMatchObject({
    status: "REJECTED",
    kind: "CONTEXT_MISMATCH",
  });
});
it("preserves valid no-newline patches and rejects unapproved delete/create operations", () => {
  const patch =
    "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
  expect(prepare(patch)).toEqual({ status: "UNCHANGED", patch });
  expect(prepare("--- a/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n")).toMatchObject({
    status: "REJECTED",
    kind: "TARGET_FORBIDDEN",
  });
  expect(prepare("--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new\n")).toMatchObject({
    status: "REJECTED",
    kind: "TARGET_FORBIDDEN",
  });
});
it("guarded apply refuses stale version and outside targets without any file change", async () => {
  const d = await fixture();
  const fixed = prepare();
  if (fixed.status !== "NORMALIZED") throw new Error("fixture");
  expect(apply(d, fixed.patch, { "a.ts": "0".repeat(64) })).toMatchObject({
    applied: false,
    patchFailure: { kind: "STALE_SOURCE" },
  });
  expect(
    apply(d, fixed.patch.replaceAll("a.ts", "b.ts"), {
      "a.ts": digest(source),
    }),
  ).toMatchObject({
    applied: false,
    patchFailure: { kind: "TARGET_FORBIDDEN" },
  });
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(source);
});
it("checks a mixed valid/invalid candidate atomically, leaving every file unchanged", async () => {
  const d = await fixture();
  await writeFile(path.join(d, "b.ts"), "different\n");
  const fixed = prepare();
  if (fixed.status !== "NORMALIZED") throw new Error("fixture");
  const patch = fixed.patch + "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-absent\n+bad\n";
  expect(apply(d, patch, { "a.ts": digest(source), "b.ts": digest("different\n") }).applied).toBe(
    false,
  );
  expect(await readFile(path.join(d, "a.ts"), "utf8")).toBe(source);
  expect(await readFile(path.join(d, "b.ts"), "utf8")).toBe("different\n");
});
it("refuses symbolic-link parents before mutation", async () => {
  const d = await fixture(),
    outside = await fixture();
  await symlink(outside, path.join(d, "linked"), "junction");
  const fixed = prepare();
  if (fixed.status !== "NORMALIZED") throw new Error("fixture");
  expect(
    apply(d, fixed.patch.replaceAll("a.ts", "linked/a.ts"), {
      "linked/a.ts": digest(source),
    }),
  ).toMatchObject({
    applied: false,
    patchFailure: { kind: "TARGET_FORBIDDEN" },
  });
  expect(await readFile(path.join(outside, "a.ts"), "utf8")).toBe(source);
});
