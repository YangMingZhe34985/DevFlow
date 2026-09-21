import { describe, expect, it } from "vitest";

import {
  BenchmarkSuiteSchema,
  PricingConfigurationSchema,
  benchmarkDefinitionDigest,
  canonicalJson,
  estimateCostUsd,
} from "../src/index.js";
import { benchmarkCase, benchmarkSuite, pricingConfiguration } from "./test-helpers.js";

describe("benchmark definitions", () => {
  it("requires fixed full commit SHAs", () => {
    expect(() =>
      BenchmarkSuiteSchema.parse({
        id: "bad",
        version: "1",
        cases: [
          {
            id: "case",
            version: "1",
            repository: { sourceUri: "fixture://case", baseCommit: "main" },
            task: { title: "Fix", description: "Fix it" },
            evaluationCommand: { program: "node", args: [] },
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects duplicate case identities within a versioned suite", () => {
    const testCase = benchmarkCase();
    expect(() =>
      BenchmarkSuiteSchema.parse({ ...benchmarkSuite([testCase]), cases: [testCase, testCase] }),
    ).toThrow("Duplicate benchmark case id");
  });

  it("rejects embedded repository credentials and LOCAL network access", () => {
    const testCase = benchmarkCase();
    expect(() =>
      BenchmarkSuiteSchema.parse({
        ...benchmarkSuite([testCase]),
        cases: [
          {
            ...testCase,
            repository: {
              ...testCase.repository,
              sourceUri: "https://secret-token@github.com/example/private.git",
            },
          },
        ],
      }),
    ).toThrow("must not contain credentials");
    expect(() =>
      BenchmarkSuiteSchema.parse({
        ...benchmarkSuite([testCase]),
        cases: [{ ...testCase, limits: { ...testCase.limits, networkEnabled: true } }],
      }),
    ).toThrow("LOCAL benchmark repositories cannot enable sandbox networking");
  });

  it("produces stable definition digests independent of object key order", () => {
    const testCase = benchmarkCase();
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(canonicalJson({ "\u{10000}": 1, "\uE000": 2 })).toBe('{"\uE000":2,"\ud800\udc00":1}');
    expect(benchmarkDefinitionDigest(testCase)).toBe(
      benchmarkDefinitionDigest(structuredClone(testCase)),
    );
  });
});

describe("pricing configuration", () => {
  it("calculates cost only from the explicit pricing version", () => {
    expect(
      estimateCostUsd(pricingConfiguration(), "fake", "deterministic-model", {
        inputTokens: 2_000,
        outputTokens: 1_000,
      }),
    ).toBe("0.01200000");
  });

  it("fails closed for missing or duplicate pricing entries", () => {
    expect(() =>
      estimateCostUsd(pricingConfiguration(), "fake", "unpriced", {
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow("has no entry");
    const entry = pricingConfiguration().entries[0];
    expect(() =>
      PricingConfigurationSchema.parse({
        version: "duplicate",
        entries: [entry, entry],
      }),
    ).toThrow("Duplicate pricing entry");
  });
});
