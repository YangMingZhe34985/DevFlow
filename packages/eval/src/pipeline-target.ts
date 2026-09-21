import {
  BenchmarkExecutionRequestSchema,
  EvaluationObservationSchema,
  type BenchmarkExecutionRequest,
  type EvaluationObservation,
  type EvaluationTarget,
} from "./contracts.js";
import { immutableClone } from "./canonical.js";

/**
 * Implement this port in the Worker composition root. The implementation must
 * run the existing workflow and invoke the trusted evaluator before disposing
 * the final sandbox.
 */
export interface ExistingRunWorkerGateway {
  executeBenchmark(
    request: BenchmarkExecutionRequest,
    signal?: AbortSignal,
  ): Promise<EvaluationObservation>;
}

/** Thin adapter only; it deliberately contains no Agent execution logic. */
export class RunWorkerEvaluationTarget implements EvaluationTarget {
  constructor(private readonly gateway: ExistingRunWorkerGateway) {}

  async execute(
    requestInput: BenchmarkExecutionRequest,
    signal?: AbortSignal,
  ): Promise<EvaluationObservation> {
    const request = BenchmarkExecutionRequestSchema.parse(requestInput);
    return EvaluationObservationSchema.parse(
      await this.gateway.executeBenchmark(immutableClone(request), signal),
    );
  }
}
