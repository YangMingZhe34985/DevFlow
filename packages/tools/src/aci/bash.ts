import type { SandboxSession } from "@devflow/sandbox";
import { z } from "zod";

import { defineAciTool, type AciTool } from "./contracts.js";

export interface BashToolOptions {
  sandbox: SandboxSession;
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
  /** Characters of output shown to the model; the full log stays in the sandbox. */
  maxOutputChars?: number;
}

// The sandbox treats exit codes 124/137 as a session-level timeout and retires the
// container, so the command enforces its own deadline and reports it as 125.
const WRAPPER = [
  'mkdir -p /tmp/devflow; log="/tmp/devflow/$1.log"',
  'timeout --signal=TERM --kill-after=2s "$2s" bash -c "$3" > "$log" 2>&1 < /dev/null',
  "rc=$?",
  'cat "$log"',
  'if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then echo "[command timed out after $2s]"; exit 125; fi',
  'exit "$rc"',
].join("\n");

export function createBashTool(options: BashToolOptions): AciTool {
  const defaultTimeout = options.defaultTimeoutSeconds ?? 120;
  const maxTimeout = options.maxTimeoutSeconds ?? 600;
  const maxChars = options.maxOutputChars ?? 12_000;
  let sequence = 0;
  return defineAciTool({
    name: "bash",
    description: [
      "Run a bash command in /workspace inside an isolated Linux sandbox (no network).",
      "Use it to explore (rg -n, find, ls, sed -n 'a,bp'), run tests and builds, run scripts, and inspect git diff.",
      `stdout and stderr are merged. Long output is truncated to its head and tail; the full log path is shown so you can grep it. Default timeout ${defaultTimeout}s, max ${maxTimeout}s.`,
      "Commands do not read stdin and state such as cd does not persist between calls.",
    ].join(" "),
    inputSchema: z.object({
      command: z.string().min(1).describe("The bash command to run."),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(maxTimeout)
        .optional()
        .describe(`Optional timeout in seconds (default ${defaultTimeout}).`),
    }),
    readOnly: false,
    async run({ command, timeout_seconds }, signal) {
      const seconds = timeout_seconds ?? defaultTimeout;
      const id = `out-${++sequence}`;
      const result = await options.sandbox.exec(
        {
          program: "bash",
          args: ["-c", WRAPPER, "devflow-bash", id, String(seconds), command],
          timeoutMs: (seconds + 15) * 1000,
          maxOutputBytes: 4_000_000,
        },
        signal,
      );
      const output = truncateMiddle(
        result.stdout + result.stderr,
        maxChars,
        `/tmp/devflow/${id}.log`,
      );
      return {
        content: `exit_code: ${result.exitCode ?? "unknown"}\n${output || "(no output)"}`,
        isError: false,
      };
    },
  });
}

export function truncateMiddle(text: string, maxChars: number, fullLogPath?: string): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars / 3);
  const tail = maxChars - head;
  const omitted = text.length - head - tail;
  const where = fullLogPath ? ` Full output: ${fullLogPath}` : "";
  return `${text.slice(0, head)}\n\n[... ${omitted} characters omitted.${where} ...]\n\n${text.slice(-tail)}`;
}
