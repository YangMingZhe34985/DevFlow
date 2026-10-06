# DevFlow 2.0

[中文](README_CN.md) | [English](README.md)

DevFlow turns repository tasks and GitHub Issues into observable, approval-based AI engineering runs: localization, repair planning, code edits, deterministic tests, targeted repair and independent review.

The API persists intent and queues work. The Worker owns execution; agents access repository code through policy-controlled tools in Docker sandboxes. Tasks pin an immutable base commit, and runs retain events, source references, diff artifacts and budgets.

## What changed in 2.0

- A concise proposal Planner: repair direction, intended source files, verification and uncertainty. Human approval defines write scope.
- Separate model bindings for Localization, Planner, Execute, Repair and Review. The example configuration uses Bailian.
- Versioned TS/JS dependency/export evidence, available to Execute and Repair through bounded `queryRelations` calls.
- Full-file SHA checks, precise text replacement and protected-file policies before code writes.
- Tool-free Review with two bounded host evidence rounds and isolated public reproductions; Repair retains diagnostic tasks and checked per-finding answers for independent re-review.
- Execute reserves editing correction and completion budgets; repeated source/graph queries cannot earn new progress, while malformed edits receive one bounded correction.
- Shared request/recovery budgets, complete-output checks and protected write scope throughout the workflow.

The final nine-case cohort passed strict end-to-end acceptance in 5/9 cases. A separate financial continuation passed one spending-interrupted case, bringing validated nine-case coverage to six strict successes. This small dataset demonstrates capability within the tested repositories; broader evaluation is needed to estimate general repair success. See [validation and known limits](docs/validation-v2.md).

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

[.env.example](.env.example) defaults to Bailian's compatible endpoint. Planner/Review use `deepseek-v4-pro-0813`, Execute/Repair use `glm-5.3`, and Localization inherits `LLM_MODEL`. Review uses high reasoning effort; Review/Repair allow 16,384 output tokens and 64,000 context tokens. Each stage has its own `LLM_<STAGE>_*` settings. Users choose models suited to their provider and workload. Read [stage bindings, inheritance and budgets](docs/stage-models.md), then restart the Worker after changes.

## Workflow

```text
Repository + pinned Task -> Localization -> Planner -> Plan Approval
  -> Execute -> Test -> bounded Repair / retest
  -> Review -> targeted repair or evidence response -> Test -> Review
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
