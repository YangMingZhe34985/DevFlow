import type { SandboxSession } from "@devflow/sandbox";

export const REVIEW_CONTEXT_BYTES = 40_000;

/** One host read, without model tools. Consecutive numbered lines form merged intervals. */
export async function readReviewContext(
  sandbox: SandboxSession,
  diff: string,
  signal: AbortSignal,
) {
  const result = await sandbox.exec(
    {
      program: "node",
      args: [
        "-e",
        String.raw`
const fs = require("node:fs"), path = require("node:path");
const { diff, cap } = JSON.parse(fs.readFileSync(0, "utf8"));
const files = new Map();
let file, header = true;
const decode = s => s.startsWith('"') ? JSON.parse(s.replace(/(?:\\[0-7]{3})+/g, run => JSON.stringify(Buffer.from(run.match(/[0-7]{3}/g).map(n => parseInt(n, 8))).toString("utf8")).slice(1, -1))) : s;
for (const line of diff.split("\n")) {
  if (line.startsWith("diff --git ")) { file = undefined; header = true; }
  if (header && line.startsWith("+++ ")) {
    file = decode(line.slice(4));
    if (file === "/dev/null") file = undefined;
    else { file = file.replace(/^b\//, ""); if (!files.has(file)) files.set(file, []); }
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (file && hunk) { header = false; files.get(file).push([Math.max(1, +hunk[1]), Math.max(1, +hunk[2] || 1)]); }
}
const rows = [], diagnostics = [];
for (const [file, hunks] of files) {
  try {
    const resolved = fs.realpathSync(path.resolve("/workspace", file));
    const relative = path.relative("/workspace", resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("outside workspace");
    const lines = fs.readFileSync(resolved, "utf8").split("\n"), distances = new Map();
    for (const [start, count] of hunks) {
      const end = Math.min(lines.length, start + count - 1);
      for (let n = Math.max(1, start - 60); n <= Math.min(lines.length, end + 60); n++) {
        const distance = Math.max(start - n, n - end, 0);
        distances.set(n, Math.min(distances.get(n) ?? Infinity, distance));
      }
    }
    for (const [n, distance] of distances) rows.push({ file, n, distance, text: file + ":" + n + ": " + lines[n - 1] + "\n" });
  } catch { diagnostics.push("[context unavailable: " + file + "]\n"); }
}
const marker = "[context truncated; nearest changed lines retained]\n";
let bytes = Buffer.byteLength(marker), truncated = false;
const kept = [];
for (const row of rows.sort((a,b) => a.distance - b.distance)) {
  const size = Buffer.byteLength(row.text);
  if (bytes + size > cap) { truncated = true; continue; }
  bytes += size; kept.push(row);
}
let output = kept.sort((a,b) => a.file.localeCompare(b.file) || a.n - b.n).map(r => r.text).join("");
for (const note of diagnostics) {
  if (bytes + Buffer.byteLength(note) <= cap) { output += note; bytes += Buffer.byteLength(note); }
  else truncated = true;
}
process.stdout.write(output + (truncated ? marker : ""));
`,
      ],
      stdin: JSON.stringify({ diff, cap: REVIEW_CONTEXT_BYTES }),
      timeoutMs: 60_000,
      maxOutputBytes: REVIEW_CONTEXT_BYTES,
    },
    signal,
  );
  if (result.exitCode !== 0 || result.outputTruncated)
    return "[context unavailable: host read failed; request concrete concerns if needed]";
  return result.stdout;
}
