import type { JsonValue } from "@devflow/shared";
import { z } from "zod";

/** A correction hint is not a retry grant, a parsed input, or an authorization decision. */
export function toolInputValidationDetails(
  toolName: string,
  inputSchema: z.ZodType,
  input: unknown,
  error: z.ZodError,
): Record<string, JsonValue> {
  const invalidTypePaths = new Set(
    error.issues
      .filter((issue) => issue.code === "invalid_type")
      .map((issue) => pathKey(issue.path)),
  );
  let argumentSchema: JsonValue | undefined;
  try {
    argumentSchema = z.toJSONSchema(inputSchema, { unrepresentable: "any" }) as JsonValue;
  } catch {
    // Some custom schemas cannot be represented. Their original field diagnostics still apply.
  }
  return {
    ...error.flatten(),
    failureOrigin: "INPUT_VALIDATION",
    category: "INVALID_ARGUMENT",
    toolExecuted: false,
    recovery: {
      kind: "CORRECT_TOOL_ARGUMENTS",
      toolName,
      fieldIssues: error.issues
        // Type mismatches can produce misleading length checks on the rejected value.
        // Keep the authoritative type error; validate field constraints after an explicit correction.
        .filter(
          (issue) => issue.code === "invalid_type" || !invalidTypePaths.has(pathKey(issue.path)),
        )
        .map((issue) => ({
          path: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          code: issue.code,
          message: issue.message,
          receivedType: valueType(valueAtPath(input, issue.path)),
          ...(issue.code === "invalid_type" ? { expectedType: issue.expected } : {}),
          ...(issue.code === "unrecognized_keys" ? { unrecognizedKeys: issue.keys } : {}),
        })),
      ...(argumentSchema === undefined ? {} : { argumentSchema }),
      instruction:
        "Construct a new JSON argument object matching this tool's schema. Array fields must be JSON arrays, not stringified arrays or XML argument markup. The rejected input was not executed. Do not repeat it unchanged; correction remains subject to remaining resources, permissions, and the host's bounded recovery allowance.",
    },
  };
}

function pathKey(path: readonly PropertyKey[]): string {
  return JSON.stringify(path.map((part) => (typeof part === "number" ? part : String(part))));
}

function valueAtPath(input: unknown, path: readonly PropertyKey[]): unknown {
  let value = input;
  for (const part of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<PropertyKey, unknown>)[part];
  }
  return value;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
