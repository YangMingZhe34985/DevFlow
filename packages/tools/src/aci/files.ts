import type { SandboxSession } from "@devflow/sandbox";
import { z } from "zod";

import { defineAciTool, type AciTool } from "./contracts.js";

// Both scripts run inside the sandbox with node, resolve paths against the real
// /workspace and refuse anything (including symlinks) that escapes it.
const GUARD = String.raw`
const fs = require("node:fs"), path = require("node:path");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.realpathSync("/workspace");
const inside = (p) => p === root || p.startsWith(root + path.sep);
const target = path.resolve(root, input.path);
if (!inside(target)) { console.log(JSON.stringify({ error: "Path is outside /workspace." })); process.exit(0); }
const exists = fs.existsSync(target);
if (exists && !inside(fs.realpathSync(target))) { console.log(JSON.stringify({ error: "Path resolves outside /workspace." })); process.exit(0); }
const numbered = (lines, first) => lines.map((l, i) => String(first + i).padStart(6) + "\t" + l).join("\n");
`;

const READ_SCRIPT =
  GUARD +
  String.raw`
if (!exists) { console.log(JSON.stringify({ error: "File not found: " + input.path })); process.exit(0); }
if (fs.statSync(target).isDirectory()) { console.log(JSON.stringify({ error: input.path + " is a directory; use bash ls." })); process.exit(0); }
const lines = fs.readFileSync(target, "utf8").split(/\r?\n/);
if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
const start = Math.max(1, input.start || 1);
let end = Math.min(lines.length, input.end || start + input.maxLines - 1, start + input.maxLines - 1);
let body = numbered(lines.slice(start - 1, end), start);
while (body.length > input.maxChars && end > start) { end = start + Math.floor((end - start) / 2); body = numbered(lines.slice(start - 1, end), start); }
console.log(JSON.stringify({ body, start, end, total: lines.length }));
`;

const EDIT_SCRIPT =
  GUARD +
  String.raw`
const count = (text, needle) => { let n = 0, i = text.indexOf(needle); while (i !== -1) { n++; i = text.indexOf(needle, i + needle.length); } return n; };
const lineOf = (text, index) => text.slice(0, index).split("\n").length;
if (!exists) {
  if (input.oldText !== "") { console.log(JSON.stringify({ error: "File not found: " + input.path + ". To create a file, pass an empty old_text." })); process.exit(0); }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!inside(fs.realpathSync(path.dirname(target)))) { console.log(JSON.stringify({ error: "Parent resolves outside /workspace." })); process.exit(0); }
  fs.writeFileSync(target, input.newText);
  console.log(JSON.stringify({ created: true, lines: input.newText.split("\n").length }));
  process.exit(0);
}
if (input.oldText === "") { console.log(JSON.stringify({ error: input.path + " already exists; old_text must quote the text to replace." })); process.exit(0); }
let content = fs.readFileSync(target, "utf8"), oldText = input.oldText, newText = input.newText;
let matches = count(content, oldText);
if (matches === 0 && content.includes("\r\n") && !oldText.includes("\r\n")) {
  const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
  if (count(content, crlf(oldText)) > 0) { oldText = crlf(oldText); newText = crlf(newText); matches = count(content, oldText); }
}
if (matches === 0) {
  const probe = input.oldText.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
  const near = [];
  content.split(/\r?\n/).forEach((l, i) => { if (probe && l.includes(probe) && near.length < 5) near.push(i + 1); });
  console.log(JSON.stringify({ error: "old_text was not found in " + input.path + (near.length ? ". Its first line appears at line(s) " + near.join(", ") + "; re-read the file and copy the text exactly." : ". Re-read the file and copy the text exactly, including indentation.") }));
  process.exit(0);
}
if (matches > 1 && !input.replaceAll) {
  const at = []; let i = content.indexOf(oldText); while (i !== -1) { at.push(lineOf(content, i)); i = content.indexOf(oldText, i + oldText.length); }
  console.log(JSON.stringify({ error: "old_text matches " + matches + " times (lines " + at.join(", ") + "). Include more surrounding lines to make it unique, or set replace_all." }));
  process.exit(0);
}
const first = content.indexOf(oldText);
const updated = input.replaceAll ? content.split(oldText).join(newText) : content.slice(0, first) + newText + content.slice(first + oldText.length);
fs.writeFileSync(target, updated);
const lines = updated.split(/\r?\n/);
const from = Math.max(1, lineOf(updated, first) - 3);
const to = Math.min(lines.length, lineOf(updated, first) + newText.split("\n").length + 2);
console.log(JSON.stringify({ replaced: input.replaceAll ? matches : 1, snippet: numbered(lines.slice(from - 1, to), from) }));
`;

async function runScript(
  sandbox: SandboxSession,
  script: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const result = await sandbox.exec(
    {
      program: "node",
      args: ["-e", script],
      stdin: JSON.stringify(input),
      timeoutMs: 30_000,
      maxOutputBytes: 2_000_000,
    },
    signal,
  );
  if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout).slice(0, 2000));
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export interface FileToolOptions {
  sandbox: SandboxSession;
  /** Returns a reason when the path must not be edited (for example, graded tests). */
  protectedPath?: (path: string) => string | undefined;
}

export function createReadFileTool(options: FileToolOptions): AciTool {
  const maxLines = 600;
  return defineAciTool({
    name: "read_file",
    description: `Read a text file with line numbers. Paths are relative to /workspace. Reads at most ${maxLines} lines per call; pass start_line/end_line to page through larger files.`,
    inputSchema: z.object({
      path: z.string().min(1),
      start_line: z.number().int().positive().optional(),
      end_line: z.number().int().positive().optional(),
    }),
    readOnly: true,
    async run({ path, start_line, end_line }, signal) {
      const out = await runScript(
        options.sandbox,
        READ_SCRIPT,
        { path, start: start_line, end: end_line, maxLines, maxChars: 40_000 },
        signal,
      );
      if (typeof out.error === "string") return { isError: true, content: out.error };
      const more =
        Number(out.end) < Number(out.total)
          ? `\n[Showing lines ${String(out.start)}-${String(out.end)} of ${String(out.total)}. Continue with start_line=${Number(out.end) + 1}.]`
          : "";
      return { content: `${String(out.body)}${more}` };
    },
  });
}

export function createEditFileTool(options: FileToolOptions): AciTool {
  return defineAciTool({
    name: "edit_file",
    description:
      "Replace exact text in a file, or create a new file. old_text must match the file exactly (including indentation) and be unique unless replace_all is true. To create a file, pass an empty old_text. Returns the edited region with line numbers.",
    inputSchema: z.object({
      path: z.string().min(1),
      old_text: z.string().describe("Exact text to replace; empty to create a new file."),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    readOnly: false,
    async run({ path, old_text, new_text, replace_all }, signal) {
      const blocked = options.protectedPath?.(path.replace(/^\.\//u, ""));
      if (blocked) return { isError: true, content: blocked };
      if (old_text === new_text && old_text !== "")
        return {
          isError: true,
          content: "old_text and new_text are identical; nothing to change.",
        };
      const out = await runScript(
        options.sandbox,
        EDIT_SCRIPT,
        { path, oldText: old_text, newText: new_text, replaceAll: replace_all ?? false },
        signal,
      );
      if (typeof out.error === "string") return { isError: true, content: out.error };
      if (out.created) return { content: `Created ${path} (${String(out.lines)} lines).` };
      return {
        content: `Edited ${path} (${String(out.replaced)} replacement${out.replaced === 1 ? "" : "s"}):\n${String(out.snippet)}`,
      };
    },
  });
}
