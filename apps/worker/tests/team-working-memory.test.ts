import { expect, it } from "vitest";
import { teamWorkingMemory } from "../src/team/working-memory.js";
import type { TeamAgent } from "@devflow/shared";

it("retains earlier private gaps, hypotheses and counterarguments after four newer decisions and checkpoint restore", () => {
  const history: TeamAgent["history"] = [
    {
      input: { sourceIdentity: "base" },
      output: {
        summary: "COUNTEREVIDENCE: helper-only change cannot fix the consumer",
        actions: [
          {
            type: "RESULT",
            evidenceIds: [],
            hypotheses: ["consumer loses state"],
            missing: ["inspect persistence"],
          },
        ],
      },
    },
    ...Array.from({ length: 6 }, () => ({
      input: { sourceIdentity: "base" },
      output: {
        summary: "inspect",
        actions: [{ type: "READ" as const, path: "consumer.ts", startLine: 1, endLine: 20 }],
      },
    })),
  ];
  const memory = teamWorkingMemory(JSON.parse(JSON.stringify(history)), "base");
  expect(memory.hypotheses).toEqual(["consumer loses state"]);
  expect(memory.unresolvedOrUnreconciled).toEqual(["inspect persistence"]);
  expect(memory.investigatedDirections).toHaveLength(1);
  expect(memory.counterarguments).toHaveLength(1);
  expect(teamWorkingMemory(history, "changed").hypotheses).toEqual([]);
  expect(teamWorkingMemory(history, "changed").historical).toHaveLength(7);
});
