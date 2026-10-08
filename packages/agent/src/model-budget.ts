import { z } from "zod";
import { createHash } from "node:crypto";
import { DevflowError } from "@devflow/shared";
import type { ModelMessage, ModelToolDescriptor, ModelRequest } from "./model.js";

export const inputHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function serializeModelRequest(request: ModelRequest): string {
  return JSON.stringify({
    messages: request.messages,
    tools: request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
    })),
    output:
      request.output === undefined
        ? null
        : {
            name: request.output.name ?? "devflow_output",
            description: request.output.description ?? null,
            schema: z.toJSONSchema(request.output.schema),
          },
    settings: request.settings ?? null,
  });
}
export function preparedInput(request: ModelRequest) {
  const input = request.inputProjection;
  if (!input) return undefined;
  if (
    input.requestFingerprint !== inputHash(serializeModelRequest(request)) ||
    input.fingerprint !== inputHash(input.serialized) ||
    input.wireBytes !== Buffer.byteLength(input.serialized) ||
    input.serializedBytes !== Math.max(input.wireBytes, Buffer.byteLength(input.guardSerialized)) ||
    input.estimatedInputTokens !== Math.ceil(input.serializedBytes / 3)
  )
    throw new DevflowError({
      code: "CONFLICT",
      message:
        "INPUT_PROJECTION_STALE: request or serialized input identity changed; no request issued.",
      details: { requestIssued: false },
    });
  return input;
}
/** Same conservative UTF-8 estimator used by pre-patch and provider preflight. */
export function estimateModelInput(
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDescriptor[],
): number {
  return Math.ceil(
    Buffer.byteLength(
      JSON.stringify({
        messages,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          schema: z.toJSONSchema(t.inputSchema),
        })),
      }),
    ) / 3,
  );
}
