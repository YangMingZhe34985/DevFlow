# DevFlow 4.0.0

[中文](README_CN.md) | [English](README.md)

DevFlow hands repository tasks and GitHub issues to an autonomous agent, keeping every run observable and auditable. The agent explores, edits, runs tests and submits on its own inside an isolated Docker sandbox. The host re-runs the public checks independently, and an independent reviewer then examines the candidate in tiers. GitHub pushes and pull requests always require human approval.

## What's new in v4.0.0

v4.0.0 replaces the multi-stage workflow with a single autonomous agent. See the [autonomous mode design](docs/v4/autonomous-mode.md) and the [v4 progress log](docs/v4/PROGRESS.md).

- One agent with four general tools (`bash`, `read_file`, `edit_file`, `submit`) replaces the Localization → Planner → plan approval → Coding → Review pipeline.
- The host independently re-runs discovered public checks. Tiered independent review starts with tool-free triage and adds bounded tool checks only for concrete concerns. Verification failures and review FAILs go back to the same session, and unresolved candidates get a fresh-sandbox attempt.
- Every Run has hard cost, turn and deadline limits, unconfirmed calls are charged at their worst case, and Runs resume from checkpoints.
- GitHub push and PR go through a dedicated delivery executor, still behind two human approvals.
- Retired: the workflow / team / single modes, PRG localization, the resource budget scheduler, team persistence, the database benchmark pipeline, and the `@devflow/workflow`, `@devflow/git` and `@devflow/eval` packages. This cut about 72% of the source. Historical Runs stay readable but no longer execute, and there was no destructive database migration. The pre-retirement code is kept under the Git tag `v4-pre-retirement`.
- The CLI runs the same agent kernel directly.
- New external held-out set (SWE-bench Verified + Multilingual) with a budget-gated evaluation entry.

## Results

| Suite                                                          | Result                            | Avg. cost per case |
| -------------------------------------------------------------- | --------------------------------- | ------------------ |
| Synthetic regression set E01–E10                               | 10/10 strict patch pass (Phase 2) | ~¥1.6–2.2          |
| External held-out set (SWE-bench Verified 15 + Multilingual 5) | 13/20 officially resolved (65%)   | ¥1.32              |

The retired workflow path's best result on the same synthetic set was 5/10. External results are single runs on a small set, so the confidence interval is wide. The solver is GLM-5.3; the reviewer is DeepSeek-v4-pro. Per-case results and failure analysis are in the [progress log](docs/v4/PROGRESS.md); known strategy gaps are in the [backlog](docs/v4/BACKLOG.md).

## How it works

```text
Repository + Task pinned to a base commit
  -> autonomous agent (bash / read_file / edit_file / submit)
  -> host re-runs public checks (discovered build / typecheck / lint / test)
       -> failure: feedback returns to the same session for revision
  -> tiered independent review: tool-free triage; bounded tool checks only for concrete concerns
       -> FAIL: back to the same session for revision
       -> unresolved: a fresh-sandbox attempt sharing one cost / turn / time budget
  -> diff -> LOCAL repositories finish; GIT repositories go to push approval -> PR approval
```

Every Run has hard cost, turn and deadline limits; unconfirmed model calls are charged at their worst case. The agent cannot modify `.git/` or `.github/workflows/`. GitHub credentials stay on the platform side and never reach the sandbox or prompts. GitHub writes are disabled by default and require explicit approval.

## Quick start

Requires Node.js >=22.12 (CI uses 24), npm >=10, Docker and Compose.

```bash
git clone https://github.com/YangMingZhe34985/DevFlow.git
cd DevFlow
cp .env.example .env
npm ci
```

On PowerShell use `Copy-Item .env.example .env`. Set `LLM_API_KEY` in your local `.env` and review the model configuration; never commit credentials.

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

The Web UI runs at http://localhost:3000, the API at http://localhost:3001/api/v1, and the Worker readiness check at http://localhost:3002/health/ready. Stop the infrastructure with `npm run infra:down`. DevFlow currently targets local development; add authentication and authorization suited to your deployment before exposing it to untrusted networks.

The same agent kernel also runs from the command line against a local repository: `npm run dev:cli -- --repo <path> "<task>"`.

## Models

[.env.example](.env.example) uses Bailian's OpenAI-compatible endpoint with two bindings. `LLM_EXECUTE_*` configures the solver (`glm-5.3`, low reasoning, 8,192 output tokens). `LLM_REVIEW_*` configures the independent reviewer (`deepseek-v4-pro-0813`, high reasoning, 16,384 output tokens). Tiered review settings are overridden by `DEVFLOW_AUTONOMOUS_REVIEW_*`; see [model configuration](docs/stage-models.md). Restart the Worker after changing them.

## Repository layout

- `apps/api` (REST/SSE), `apps/web` (UI), `apps/cli` (command line), `apps/worker` (execution and delivery).
- `packages/agent` (model adapters and the agent kernel), `packages/tools` (ACI tools), `packages/sandbox` (Docker sandbox and repository snapshots), `packages/database` (persistence), `packages/github` (GitHub delivery), `packages/shared` (contracts).
- `scripts/v4` (evaluation entry points for E01–E10 and the external held-out set), `tests`, `docker`, `docs`.

Raw model requests, cost ledgers, hidden grading data and local experiment material are kept out of Git.

## Development checks

```bash
npm run check
npm run build
npm run format:check
npm run db:validate
npm run test:e2e
node scripts/check-release-files.mjs
```

Integration tests need Docker or PostgreSQL: `npm run test:p1`, `test:p3`, `test:p5`, `test:p9`, `test:p10` and `test:postgres` start and clean up what they need. Unit and integration tests use fake models and never call paid models.

[Docs](docs/README.md) · [Tests](tests/README.md) · [Scripts](scripts/README.md) · [MIT License](LICENSE)
