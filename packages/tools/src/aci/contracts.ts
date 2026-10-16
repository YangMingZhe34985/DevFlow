import type { z } from "zod";

/**
 * Agent-Computer Interface tools: general engineering tools for an autonomous agent.
 * Results are plain text written for the model; host bookkeeping lives elsewhere.
 */
export interface AciToolResult {
  content: string;
  isError?: boolean;
  /** Set by the submit tool; the loop ends after this result. */
  submitted?: { summary: string };
}

export interface AciTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** True when the tool cannot change the workspace. */
  readonly readOnly: boolean;
  execute(input: unknown, signal: AbortSignal): Promise<AciToolResult>;
}

/** The sandbox cannot run anything more; retrying from the model only burns budget. */
const TERMINAL_SANDBOX_CODES = new Set([
  "SANDBOX_CANCELLED",
  "SANDBOX_LOST_OWNERSHIP",
  "SANDBOX_ALREADY_DISPOSED",
  "SANDBOX_PROCESS_FAILED",
]);

export function isTerminalSandboxError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TERMINAL_SANDBOX_CODES.has(code);
}

export function defineAciTool<T>(definition: {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  readOnly: boolean;
  run(input: T, signal: AbortSignal): Promise<AciToolResult>;
}): AciTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    readOnly: definition.readOnly,
    async execute(input, signal) {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success)
        return {
          isError: true,
          content: `Invalid arguments for ${definition.name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        };
      try {
        return await definition.run(parsed.data, signal);
      } catch (error) {
        if (signal.aborted || isTerminalSandboxError(error)) throw error;
        return {
          isError: true,
          content: `${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
