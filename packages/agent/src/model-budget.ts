import { z } from "zod";
import type { ModelMessage, ModelToolDescriptor } from "./model.js";
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
