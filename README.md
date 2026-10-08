# DevFlow 2.3

Current development version: **v2.3 (2.3.0)**. Editing and failure repair share one persistent Coding Session. The frozen implementation strictly passed E07, meeting this version's acceptance criterion; E10 still stopped before replanning on host tool-budget reservations. See [the results, regression validation and remaining P0 blockers](docs/unified-coding-loop-20261008.md). The published GitHub release remains v2.2; this local version update does not publish a release.

[中文](README_CN.md) | [English](README.md)

DevFlow turns repository tasks and GitHub Issues into observable, approval-based AI engineering runs: localization, approved planning, an iterative Coding Loop, deterministic final validation and independent review.

The API persists intent and queues work. The Worker owns execution; agents access repository code through policy-controlled tools in Docker sandboxes. Tasks pin an immutable base commit, and runs retain events, source references, diff artifacts and budgets.

## Current capabilities

- A concise proposal Planner: repair direction, intended source files, verification and uncertainty. Human approval defines write scope.
- Separate model bindings for Localization, Planner, Coding and Review. All Coding iterations use the `EXECUTE` binding; legacy `REPAIR` configuration remains readable. The example configuration uses Bailian.
- Versioned TS/JS dependency/export evidence and bounded Python/Java/C++ static navigation, shared across stages. Partial or ambiguous relationships stay explicit.
- Full-file SHA checks, precise text replacement and protected-file policies before code writes.
- Tool-free Review with bounded host evidence and public reproductions; confirmed defects return to the same Coding Session with diagnostic tasks, SHA-linked evidence and checked answers.
- Public build/typecheck/lint/test profiles, source-aware diagnostic handoff and one bounded scope replan requiring a new approval.
- One Coding Session retains history, checkpoints, tool policy and resource consumption across edits and public test/review failures. Repeated observations cannot earn new progress; edit-format and output correction share one bounded credit.
- A stable patch remains editable within approval. `finishPhase` yields to Workflow-owned final validation; failures or explicit unfinished work can return to the same session within the remaining limits. Final Review remains independent. See [the current Coding lifecycle](docs/unified-coding-loop-20261008.md).
- Shared request/recovery budgets, complete-output checks and protected write scope throughout the workflow.

The final nine-case cohort passed strict end-to-end acceptance in 5/9 cases. A separate financial continuation passed one spending-interrupted case, bringing validated nine-case coverage to six strict successes. This small dataset demonstrates capability within the tested repositories; broader evaluation is needed to estimate general repair success. See [validation and known limits](docs/validation-v2.md).

The v2.2 dataset experiments separately validated E09 and E01 in one frozen batch and E08 in a subsequent single-case batch. These records use different versions and are not a combined cohort success rate. See [the current experiment records](docs/new-dataset-validation-20261007.md).

## Quick start

Requires Node.js >=22.12 (CI uses 24), npm >=10, and Docker with Compose.

```bash
git clone https://github.com/YangMingZhe34985/DevFlow.git
cd DevFlow
cp .env.example .env
npm ci
```

On PowerShell use `Copy-Item .env.example .env`. Set `LLM_API_KEY` in your local .env and confirm the provider/model settings. Never commit credentials. Prisma Client is generated during installation.

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

Web: http://localhost:3000; API: http://localhost:3001/api/v1; Worker readiness: http://localhost:3002/health/ready. Stop infrastructure with `npm run infra:down`. The current deployment targets local development; add suitable authentication and authorization before exposing it to untrusted networks.

## Model configuration

[.env.example](.env.example) defaults to Bailian's compatible endpoint. Planner/Review use `deepseek-v4-pro-0813`, the entire Coding Loop uses `glm-5.3`, and Localization inherits `LLM_MODEL`. Coding uses `LLM_EXECUTE_*`: thinking enabled, low effort, 8,192 output tokens and 32,000 context tokens. Independent Review uses high effort, 16,384 output tokens and 64,000 context tokens. `LLM_REPAIR_*` remains a legacy configuration interface; it does not create another Coding agent or change the unified session's limits. Read [stage bindings, inheritance and budgets](docs/stage-models.md), then restart the Worker after changes.

## Workflow

```text
Repository + pinned Task -> Localization -> Planner -> Plan Approval
  -> Unified Coding Loop: Observe -> Edit -> Test -> Analyze -> Revise
  -> Workflow Final Validation -> Independent Review
       -> failed validation / confirmed defect -> same Coding Session
       -> new write scope -> Planner -> new Plan Approval -> same Coding Session
  -> Diff -> Local completion or approved GitHub Push / Pull Request
```

A valid proposal, a passing test suite and a verified Issue repair are separate results. Empty/all-inspection plans do not authorize writes. New scope requires approval. Review is independent and remains tool-free with host-provided current evidence. See [stage responsibilities and guardrails](docs/v2-workflow.md).

## Repository

- `apps/api`, `apps/web`, `apps/cli`, `apps/worker`: REST/SSE, dashboard, CLI and orchestration.
- `packages/agent`, `tools`, `sandbox`: model runtime, tool policy and isolated execution.
- `packages/shared`, `workflow`, `database`, `git`, `github`, `eval`: contracts, persistence, delivery and evaluation.
- `tests`, `docker`, `scripts`, `docs`: public fixtures, infrastructure, verification and documentation.

Historical experiment implementations, raw requests, billing records, hidden evaluation data and private migration notes are excluded from Git. The production Planner has one proposal protocol; compatibility for persisted approvals remains.

## Development

```bash
npm run check
npm run build
npm run format:check
npm run db:validate
npm run test:e2e
node scripts/check-release-files.mjs
```

Docker integration runners require explicit opt-in and local infrastructure. The standard unit suite has no paid-model requirement. GitHub publication is disabled by default and requires approval plus platform credentials kept outside the sandbox.

[Architecture](docs/architecture.md) · [Test layout](tests/README.md) · [Scripts](scripts/README.md) · [MIT License](LICENSE)
