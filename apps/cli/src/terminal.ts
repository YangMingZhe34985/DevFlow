import type { NewAgentEvent } from "@devflow/shared";

export interface TerminalLine {
  stream: "stdout" | "stderr";
  text: string;
}

export function configureUtf8Terminal(): void {
  process.stdout.setDefaultEncoding("utf8");
  process.stderr.setDefaultEncoding("utf8");
  process.env.LANG ??= "C.UTF-8";
  process.env.LC_ALL ??= "C.UTF-8";
}

export function printEvent(event: NewAgentEvent): void {
  for (const line of renderEvent(event)) {
    const target = line.stream === "stderr" ? process.stderr : process.stdout;
    target.write(`${line.text}\n`);
  }
}

export function renderEvent(event: NewAgentEvent): TerminalLine[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  switch (event.type) {
    case "LLM_REQUEST":
      return [
        {
          stream: "stdout",
          text: `\n[step] Asking the model (messages=${String(payload.messageCount)}, attempt=${String(payload.attempt)})`,
        },
      ];
    case "TOOL_CALL":
      return [
        {
          stream: "stdout",
          text: `[tool] ${String(payload.name)} (${String(payload.permission)})`,
        },
      ];
    case "TOOL_RESULT": {
      const lines: TerminalLine[] = [
        {
          stream: payload.ok === true ? "stdout" : "stderr",
          text: `[tool] ${String(payload.name)} -> ${payload.ok === true ? "ok" : "failed"}`,
        },
      ];
      if (payload.name === "runCommand" && payload.ok === true && isRecord(payload.output)) {
        lines.push({ stream: "stdout", text: `       exit=${String(payload.output.exitCode)}` });
        if (typeof payload.output.stdout === "string" && payload.output.stdout.trim().length > 0) {
          lines.push({
            stream: "stdout",
            text: indent(payload.output.stdout.trim().slice(0, 4_000)),
          });
        }
        if (typeof payload.output.stderr === "string" && payload.output.stderr.trim().length > 0) {
          lines.push({
            stream: "stderr",
            text: indent(payload.output.stderr.trim().slice(0, 4_000)),
          });
        }
      }
      return lines;
    }
    case "RUN_FAILED":
    case "RUN_CANCELLED":
      return [{ stream: "stderr", text: `[run] ${event.type.toLowerCase()}` }];
    default:
      return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function indent(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => `       ${line}`)
    .join("\n");
}
