import type { KernelEvent } from "@devflow/agent";

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

export function printEvent(event: KernelEvent): void {
  for (const line of renderEvent(event)) {
    const target = line.stream === "stderr" ? process.stderr : process.stdout;
    target.write(`${line.text}\n`);
  }
}

export function renderEvent(event: KernelEvent): TerminalLine[] {
  switch (event.type) {
    case "model_request":
      return [{ stream: "stdout", text: `\n[turn ${String(event.turn)}] asking the model` }];
    case "model_error":
      return [
        {
          stream: "stderr",
          text: `[model] ${event.message}${event.willRetry ? " (retrying)" : ""}`,
        },
      ];
    case "tool":
      return [
        {
          stream: event.isError ? "stderr" : "stdout",
          text: `[tool] ${event.call.name} -> ${event.isError ? "error" : "ok"}`,
        },
        {
          stream: event.isError ? "stderr" : "stdout",
          text: indent(event.content.slice(0, 4_000)),
        },
      ];
    default:
      return [];
  }
}

function indent(value: string): string {
  return value
    .trim()
    .split(/\r?\n/u)
    .map((line) => `       ${line}`)
    .join("\n");
}
