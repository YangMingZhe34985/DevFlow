import { randomUUID } from "node:crypto";

import type { NewAgentEvent } from "@devflow/shared";
import { describe, expect, it } from "vitest";

import { renderEvent } from "../src/terminal.js";

describe("CLI Unicode terminal rendering", () => {
  it("preserves Docker and LLM Unicode output", () => {
    const event: NewAgentEvent = {
      runId: randomUUID(),
      stepId: randomUUID(),
      type: "TOOL_RESULT",
      occurredAt: new Date().toISOString(),
      payload: {
        name: "runCommand",
        ok: true,
        output: {
          exitCode: 0,
          stdout: "测试通过：你好，DevFlow 🚀",
          stderr: "",
        },
      },
    };

    expect(
      renderEvent(event)
        .map(({ text }) => text)
        .join("\n"),
    ).toContain("测试通过：你好，DevFlow 🚀");
  });
});
