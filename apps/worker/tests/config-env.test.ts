import { describe, expect, it } from "vitest";

import { loadWorkerEnvironment } from "../src/config/env.js";

describe("Worker runtime configuration", () => {
  it("provides safe structured-output, deadline and autonomous defaults", () => {
    const environment = loadWorkerEnvironment({
      DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
    });

    expect(environment).toMatchObject({
      LLM_STRUCTURED_OUTPUT_MODE: "auto",
      DEVFLOW_TIMEOUT_MS: 1_500_000,
      DEVFLOW_AUTONOMOUS_REVIEW: "1",
      DEVFLOW_AUTONOMOUS_REVIEW_TRIAGE_REASONING: "none",
      DEVFLOW_AUTONOMOUS_MAX_ATTEMPTS: 2,
    });
    expect(environment.DEVFLOW_MAX_COST_MICROS).toBeUndefined();
  });

  it("accepts explicit modes and a positive cost cap, treating blanks as unset", () => {
    expect(
      loadWorkerEnvironment({
        DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
        LLM_STRUCTURED_OUTPUT_MODE: "json-schema",
        DEVFLOW_MAX_COST_MICROS: "4000000",
      }),
    ).toMatchObject({
      LLM_STRUCTURED_OUTPUT_MODE: "json-schema",
      DEVFLOW_MAX_COST_MICROS: 4_000_000,
    });
    expect(
      loadWorkerEnvironment({
        DATABASE_URL: "postgresql://devflow:devflow@localhost:5432/devflow",
        DEVFLOW_MAX_COST_MICROS: "  ",
      }).DEVFLOW_MAX_COST_MICROS,
    ).toBeUndefined();
  });
});
