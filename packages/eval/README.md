# @devflow/eval

P11 benchmark definitions, provenance, pricing, integrity checks, aggregation and durable result
storage.

`DefaultEvaluationRunner` never executes an Agent itself. It sends an immutable
`BenchmarkExecutionRequest` to an `EvaluationTarget`; production should use
`RunWorkerEvaluationTarget` with the Worker-owned `QueuedRunWorkerEvaluationGateway`. That gateway
creates a normal Run, dispatches it through BullMQ, reuses the existing DevFlow workflow, and
executes the trusted evaluator before the final sandbox is disposed.

The request deliberately separates:

- `agent`: repository, fixed base commit, task and sandbox limits;
- `evaluation`: setup/evaluation commands, protected hashes and hidden rules for the trusted
  platform only.

Do not serialize or inject the `evaluation` member into Agent prompts, tools, state or its writable
workspace.

`JsonFileEvaluationResultStore` is an append-only reference persistence adapter. It publishes each
document through an exclusive same-directory hard link, ignores incomplete `.tmp` files after a
crash, and prevents a repeated execution ID from overwriting different data.
`DatabaseEvaluationResultStore` is the production adapter for Prisma-backed suite/case lifecycle,
observations, metrics, provenance, and reports.

Run the focused acceptance suite from the repository root:

```powershell
npm run test:p11
```

Run a persisted production benchmark against the normal BullMQ/Worker pipeline with:

```powershell
npm run benchmark -- --suite .\suite.json --profile .\profile.json --pricing .\pricing.json --output .\report.json
```

PostgreSQL, Redis, the API infrastructure, and an independent normal DevFlow Worker must already
be running with the same `DATABASE_URL`, `REDIS_URL`, and `RUN_QUEUE_NAME`. The runner creates the
benchmark executions and ordinary Runs, waits for the Worker and trusted hidden evaluator, persists
case observations and reports through Prisma, then writes the optional report file. Model/provider
credentials and pricing must be supplied explicitly; the command does not enable real-model access
or GitHub writes by itself.

Execution profiles are fail-closed: `runtime.version` must be `approval-workflow-v1` and
`tools.version` must be `core-tools-v1`. Runtime configuration may pin `pipeline: "approval"`,
`worker: "bullmq"`, `maxSteps`, `maxTestRetries`, and `maxReviewRetries`; those limits are applied to
the persisted Run and checked again by the Worker. Unknown runtime/model/tool settings are rejected
instead of being copied into provenance as if they had been applied.
