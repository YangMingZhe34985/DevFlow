import { createHash } from "node:crypto";

import type { LanguageModelPort, ModelMessage, ModelRequest, ModelResponse } from "@devflow/agent";
import { DevflowError } from "@devflow/shared";
import type { z } from "zod";

type StructuredFailureKind = "EMPTY_OUTPUT" | "INVALID_JSON" | "SCHEMA_MISMATCH";

interface StructuredFailure {
  kind: StructuredFailureKind;
  message: string;
  rawText?: string;
  rawTextHash?: string;
  issues?: readonly { path: string; code: string; message: string }[];
}

export interface StructuredOutputAttempt {
  purpose: string;
  formatRepair: boolean;
  response: ModelResponse;
  failure?: StructuredFailure;
}

export interface GenerateStructuredOutputInput<T> {
  model: LanguageModelPort;
  schema: z.ZodType<T>;
  name: string;
  description: string;
  purpose: string;
  messages: readonly ModelMessage[];
  signal: AbortSignal;
  onRequest?(input: { purpose: string; formatRepair: boolean }): Promise<void>;
  onResponse?(attempt: StructuredOutputAttempt): Promise<void>;
  onGenerationError?(input: {
    purpose: string;
    formatRepair: boolean;
    latencyMs: number;
    error: unknown;
  }): Promise<void>;
}

export interface GenerateStructuredOutputResult<T> {
  value: T;
  attempts: readonly StructuredOutputAttempt[];
  formatRepairAttempts: number;
}

/**
 * Generate and validate one semantic result. A malformed non-empty response is
 * allowed exactly one schema-constrained formatting pass. That pass receives
 * no task, repository, test, plan, or diff context.
 */
export async function generateStructuredOutput<T>(
  input: GenerateStructuredOutputInput<T>,
): Promise<GenerateStructuredOutputResult<T>> {
  const attempts: StructuredOutputAttempt[] = [];
  const initial = await generateAttempt(input, input.messages, false);
  attempts.push(initial);
  const initialValue = validatedValue(initial.response, input.schema);
  if (initialValue.success) {
    await input.onResponse?.(initial);
    return { value: initialValue.value, attempts, formatRepairAttempts: 0 };
  }
  attempts[0] = { ...initial, failure: initialValue.failure };
  await input.onResponse?.(attempts[0]!);

  if (initialValue.failure.kind === "EMPTY_OUTPUT" || initialValue.failure.rawText === undefined) {
    throw invalidOutputError(input.purpose, attempts);
  }

  const repairMessages: ModelMessage[] = [
    {
      role: "SYSTEM",
      content:
        "You are a lossless JSON format converter. Preserve the supplied decision and meaning exactly. Do not review, infer, add, remove, or improve content. Return only the schema-conforming object requested by the response format.",
    },
    {
      role: "USER",
      content: JSON.stringify({
        rawOutput: truncate(initialValue.failure.rawText, 32 * 1024),
        validationErrors: initialValue.failure.issues ?? [
          { path: "", code: initialValue.failure.kind, message: initialValue.failure.message },
        ],
      }),
    },
  ];
  const repaired = await generateAttempt(input, repairMessages, true);
  attempts.push(repaired);
  const repairedValue = validatedValue(repaired.response, input.schema);
  if (repairedValue.success) {
    await input.onResponse?.(repaired);
    return { value: repairedValue.value, attempts, formatRepairAttempts: 1 };
  }
  attempts[1] = { ...repaired, failure: repairedValue.failure };
  await input.onResponse?.(attempts[1]!);
  throw invalidOutputError(input.purpose, attempts);
}

async function generateAttempt<T>(
  input: GenerateStructuredOutputInput<T>,
  messages: readonly ModelMessage[],
  formatRepair: boolean,
): Promise<StructuredOutputAttempt> {
  const purpose = formatRepair ? `${input.purpose}_FORMAT_REPAIR` : input.purpose;
  await input.onRequest?.({ purpose, formatRepair });
  const request: ModelRequest = {
    messages,
    tools: [],
    output: {
      name: input.name,
      description: input.description,
      schema: input.schema,
    },
    settings: { reasoningEffort: "none" },
  };
  const startedAt = Date.now();
  try {
    const response = await input.model.generate(request, { signal: input.signal });
    return { purpose, formatRepair, response };
  } catch (error) {
    await input.onGenerationError?.({
      purpose,
      formatRepair,
      latencyMs: Math.max(0, Date.now() - startedAt),
      error,
    });
    throw error;
  }
}

function validatedValue<T>(
  response: ModelResponse,
  schema: z.ZodType<T>,
): { success: true; value: T } | { success: false; failure: StructuredFailure } {
  if (response.structuredOutput?.status === "ERROR") {
    return {
      success: false,
      failure: {
        kind: response.structuredOutput.code,
        message: response.structuredOutput.message,
        ...(response.structuredOutput.rawText === undefined
          ? {}
          : { rawText: response.structuredOutput.rawText }),
        ...(response.structuredOutput.rawTextHash === undefined
          ? {}
          : { rawTextHash: response.structuredOutput.rawTextHash }),
        ...(response.structuredOutput.issues === undefined
          ? {}
          : {
              issues: response.structuredOutput.issues.slice(0, 50).map((issue) => ({
                path: issue.path.slice(0, 500),
                code: issue.code ?? "validation",
                message: issue.message.slice(0, 1_000),
              })),
            }),
      },
    };
  }

  if (response.output !== undefined) {
    const parsed = schema.safeParse(response.output);
    if (parsed.success) return { success: true, value: parsed.data };
    const rawText = response.text ?? JSON.stringify(response.output);
    return {
      success: false,
      failure: schemaFailure(parsed.error, rawText),
    };
  }

  const rawText = response.text?.trim();
  if (rawText === undefined || rawText.length === 0) {
    return {
      success: false,
      failure: { kind: "EMPTY_OUTPUT", message: "The model returned no structured output." },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    return {
      success: false,
      failure: {
        kind: "INVALID_JSON",
        message: error instanceof Error ? error.message : "The output was not valid JSON.",
        rawText,
        rawTextHash: hash(rawText),
      },
    };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { success: true, value: parsed.data };
  return { success: false, failure: schemaFailure(parsed.error, rawText) };
}

function schemaFailure(error: z.ZodError, rawText?: string): StructuredFailure {
  return {
    kind: "SCHEMA_MISMATCH",
    message: "The model output did not match the required schema.",
    ...(rawText === undefined ? {} : { rawText, rawTextHash: hash(rawText) }),
    issues: error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join(".").slice(0, 500),
      code: issue.code,
      message: issue.message.slice(0, 1_000),
    })),
  };
}

function invalidOutputError(
  purpose: string,
  attempts: readonly StructuredOutputAttempt[],
): DevflowError {
  return new DevflowError({
    code: "MODEL_OUTPUT_INVALID",
    message: `${purpose} did not produce a valid structured result.`,
    details: {
      stage: purpose,
      attempts: attempts.map(({ purpose: attemptPurpose, formatRepair, response, failure }) => ({
        purpose: attemptPurpose,
        formatRepair,
        finishReason: response.finishReason,
        outputLength: failure?.rawText?.length ?? response.text?.length ?? 0,
        outputHash:
          failure?.rawTextHash ??
          (response.text === undefined || response.text.length === 0
            ? undefined
            : hash(response.text)),
        error:
          failure === undefined
            ? undefined
            : {
                kind: failure.kind,
                message: failure.message,
                issues: failure.issues,
              },
      })),
    },
  });
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = "\n...[truncated]";
  const contentLimit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentLimit) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}${suffix}`;
}
