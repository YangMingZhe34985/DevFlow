import { describe, expect, it } from "vitest";

import { loadWorkerEnvironment } from "../src/config/env.js";

describe("Worker runtime budget configuration", () => {
  it("provides safe structured-output, reasoning, and token defaults", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
    });

    expect(environment).toMatchObject({
      LLM_STRUCTURED_OUTPUT_MODE: "auto",
      LLM_REASONING_PROFILE: "efficient",
      DEVFLOW_MAX_TOTAL_TOKENS: 250_000,
    });
    expect(environment.DEVFLOW_MAX_MODEL_CALLS).toBeUndefined();
    expect(environment.DEVFLOW_MAX_TOOL_CALLS).toBeUndefined();
  });

  it("accepts explicit modes and positive budget overrides", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
      LLM_STRUCTURED_OUTPUT_MODE: "json-schema",
      LLM_REASONING_PROFILE: "provider-default",
      DEVFLOW_MAX_MODEL_CALLS: "31",
      DEVFLOW_MAX_TOOL_CALLS: "75",
      DEVFLOW_MAX_TOTAL_TOKENS: "125000",
    });

    expect(environment).toMatchObject({
      LLM_STRUCTURED_OUTPUT_MODE: "json-schema",
      LLM_REASONING_PROFILE: "provider-default",
      DEVFLOW_MAX_MODEL_CALLS: 31,
      DEVFLOW_MAX_TOOL_CALLS: 75,
      DEVFLOW_MAX_TOTAL_TOKENS: 125_000,
    });
  });

  it("treats empty optional budget overrides as unset", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
      DEVFLOW_MAX_MODEL_CALLS: "",
      DEVFLOW_MAX_TOOL_CALLS: "  ",
    });

    expect(environment.DEVFLOW_MAX_MODEL_CALLS).toBeUndefined();
    expect(environment.DEVFLOW_MAX_TOOL_CALLS).toBeUndefined();
  });
});
