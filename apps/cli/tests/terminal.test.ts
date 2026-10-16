import { describe, expect, it } from "vitest";

import { renderEvent } from "../src/terminal.js";

describe("CLI Unicode terminal rendering", () => {
  it("preserves Docker and LLM Unicode output", () => {
    const text = renderEvent({
      type: "tool",
      turn: 1,
      call: { id: "1", name: "bash", input: { command: "npm test" } },
      isError: false,
      durationMs: 5,
      content: "exit_code: 0\n测试通过：你好，DevFlow 🚀",
    })
      .map(({ text }) => text)
      .join("\n");
    expect(text).toContain("[tool] bash -> ok");
    expect(text).toContain("测试通过：你好，DevFlow 🚀");
  });

  it("sends failed tool results to stderr", () => {
    const lines = renderEvent({
      type: "tool",
      turn: 2,
      call: { id: "2", name: "edit_file", input: {} },
      isError: true,
      durationMs: 1,
      content: "old_text not found",
    });
    expect(lines.every((line) => line.stream === "stderr")).toBe(true);
  });
});
