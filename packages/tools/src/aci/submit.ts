import { z } from "zod";

import { defineAciTool, type AciTool } from "./contracts.js";

export function createSubmitTool(): AciTool {
  return defineAciTool({
    name: "submit",
    description:
      "Finish the task. Call this once your fix is complete and verified. The current state of /workspace (git diff) is your submission.",
    inputSchema: z.object({
      summary: z
        .string()
        .min(1)
        .describe("What was wrong, what you changed, and how you verified it."),
    }),
    readOnly: true,
    async run({ summary }) {
      return { content: "Submitted.", submitted: { summary } };
    },
  });
}
