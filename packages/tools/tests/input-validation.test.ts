import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toolInputValidationDetails } from "../src/index.js";

describe("toolInputValidationDetails", () => {
  it("preserves nested field and array indices instead of flattening away the failed location", () => {
    const schema = z.object({ requests: z.array(z.object({ paths: z.array(z.string()) })) });
    const input = { requests: [{ paths: ["src/one.ts", 5] }] };
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected invalid parameters");
    expect(toolInputValidationDetails("readMany", schema, input, parsed.error)).toMatchObject({
      fieldErrors: { requests: expect.any(Array) },
      recovery: {
        fieldIssues: [
          {
            path: ["requests", 0, "paths", 1],
            expectedType: "string",
            receivedType: "number",
          },
        ],
      },
    });
  });

  it("reports required fields, strict unknown fields and current numerical boundaries", () => {
    const schema = z.strictObject({
      maxBytes: z.number().int().positive().max(16384),
      path: z.string(),
    });
    const input = { maxBytes: 200000, paths: ["src/one.ts"] };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("Expected invalid parameters");
    const details = toolInputValidationDetails("readFile", schema, input, parsed.error);
    expect(details).toMatchObject({
      recovery: {
        argumentSchema: {
          required: ["maxBytes", "path"],
          properties: { maxBytes: { maximum: 16384 } },
        },
        fieldIssues: expect.arrayContaining([
          {
            path: ["path"],
            code: "invalid_type",
            message: expect.any(String),
            expectedType: "string",
            receivedType: "undefined",
          },
          {
            path: [],
            code: "unrecognized_keys",
            message: expect.any(String),
            receivedType: "object",
            unrecognizedKeys: ["paths"],
          },
          {
            path: ["maxBytes"],
            code: "too_big",
            message: expect.any(String),
            receivedType: "number",
          },
        ]),
      },
    });
  });

  it("retains custom validation errors when a JSON schema cannot represent the tool", () => {
    const schema = z.custom<Date>((value) => value instanceof Date, "A Date object is required.");
    const input = "2026-10-09";
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("Expected invalid parameters");
    expect(toolInputValidationDetails("custom", schema, input, parsed.error)).toMatchObject({
      category: "INVALID_ARGUMENT",
      recovery: {
        kind: "CORRECT_TOOL_ARGUMENTS",
        fieldIssues: [
          {
            path: [],
            code: "custom",
            message: "A Date object is required.",
            receivedType: "string",
          },
        ],
      },
    });
  });
});
