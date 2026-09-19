import { DevflowError } from "@devflow/shared";

import type { ToolDefinition, ToolDescriptor } from "./contracts.js";

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new DevflowError({
        code: "VALIDATION_ERROR",
        message: `Tool '${tool.name}' is already registered.`,
      });
    }

    this.tools.set(tool.name, tool as unknown as ToolDefinition<unknown, unknown>);
  }

  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDescriptor[] {
    return [...this.tools.values()]
      .map(({ name, description, inputSchema, permission, timeoutMs }) => ({
        name,
        description,
        inputSchema,
        permission,
        timeoutMs,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
