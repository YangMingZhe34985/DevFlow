# DevFlow

[English](README.md) | [中文](README_CN.md)

DevFlow is an AI software engineering agent platform for observable, verifiable repository analysis, code changes, testing, repair, review, approval, and GitHub delivery workflows.

> Repository + Task → Observable and Verifiable Agent Run

DevFlow separates interactive APIs from untrusted code execution. The API persists intent and enqueues work; a BullMQ worker drives the workflow; agents can interact with a repository only through policy-controlled tools inside an isolated Docker sandbox.

## Overview

DevFlow turns a software engineering task into a durable Run with explicit stages, persisted events, bounded agent execution, deterministic tests, human approval gates, and reviewable Git output. It supports local repositories and GitHub repositories while pinning every Task to an immutable base commit for reproducibility.

The project is currently intended for local development and evaluation. Before exposing it to an untrusted network, add an authentication and authorization layer appropriate to your deployment.

## Features

- Local and GitHub repository registration with immutable base-commit resolution
- Structured planning with complexity estimation and adaptive Run-wide step budgets
- Tool-calling agent runtime with bounded context, retries, token limits, and progress detection
- Docker sandbox isolation for repository files, Git operations, and test commands
- Deterministic test and targeted repair loop with retry limits
- Independent structured review and diff generation
- Human-in-the-loop approvals for plans and GitHub publication
- BullMQ/Redis asynchronous execution with leases, cancellation, retry, and recovery
- PostgreSQL/Prisma persistence for Runs, events, steps, artifacts, approvals, and metrics
- Persisted SSE event replay for live Run status in the Web application
- Idempotent GitHub branch push and pull request creation
- Reproducible benchmark fixtures, provenance checks, and efficiency reports
- OpenAI and OpenAI-compatible LLM endpoints through a provider abstraction

## Architecture

```text
                        +-------------------+
User ----------------->| Web (Next.js)     |
  |                     +---------+---------+
  |                               |
  +-------------------->| CLI     | REST / SSE
                        +----+----+         |
                             |              v
                             |      +-------+--------+
                             |      | API (NestJS)   |
                             |      +---+---------+--+
                             |          |         |
                             |          |         +------> PostgreSQL
                             |          v
                             |      Redis / BullMQ
                             |          |
                             |          v
                             |      +---+----------+
                             +----->| Worker       |
                                    +---+----------+
                                        |
                           +------------+-------------+
                           | Workflow / Agent Runtime |
                           +------+--------------+----+
                                  |              |
                                  v              v
                         Tool Executor       LLM Provider
                                  |
                                  v
                         Docker Sandbox
                         (files, Git, tests)
                                  |
                                  +----------> GitHub API
```

The API never executes the agent. The Worker owns execution, and the agent never receives direct host filesystem, Docker, database, or platform-credential access. See [docs/architecture.md](docs/architecture.md) for the detailed boundaries and lifecycle.

## Tech Stack

| Area                 | Technology                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| Web                  | Next.js 16, React 19, TypeScript                                          |
| API                  | NestJS 12, Zod                                                            |
| Worker and queue     | Node.js, BullMQ, Redis                                                    |
| Persistence          | PostgreSQL, Prisma 7                                                      |
| Agent and LLM        | Vercel AI SDK, OpenAI/OpenAI-compatible adapters                          |
| Isolation            | Docker sandbox with CPU, memory, PID, network, timeout, and output limits |
| Validation and tests | Vitest, Playwright, Docker-backed integration suites                      |
| Monorepo             | npm workspaces, TypeScript project references, ESM                        |

## Project Structure

```text
apps/
  api/          REST API, approvals, queue dispatch, and SSE
  cli/          Local command-line composition root
  web/          Dashboard, Run creation, and Run detail UI
  worker/       Queue consumer and production workflow orchestration
packages/
  agent/        Model port, agent loop, state, and context control
  database/     Prisma schema and persistence adapters
  eval/         Benchmark definitions, scoring, provenance, and reports
  git/          Sandbox-only Git service
  github/       GitHub REST adapter and publication coordinator
  sandbox/      Docker sandbox and immutable local snapshots
  shared/       Browser/server-safe domain contracts and events
  tools/        Tool registry, policy, built-ins, and executor
  workflow/     Pure workflow state and transition contracts
docker/         Development infrastructure and sandbox image
docs/           Architecture, decisions, and archived development material
scripts/        Cross-workspace integration and acceptance runners
tests/          Integration, end-to-end, and benchmark fixtures
```

## Quick Start

### Prerequisites

- Node.js 22.12 or newer (Node.js 24 is used in CI)
- npm 10 or newer
- Docker Engine or Docker Desktop with Compose

### Install and run

```bash
git clone git@github.com:YangMingZhe34985/DevFlow.git
cd Devflow
cp .env.example .env
npm ci
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

`npm ci` generates Prisma Client automatically. `npm run dev` also regenerates it before
compiling the workspaces, so no separate `prisma generate` command is required.

Edit `.env` and configure at least `LLM_PROVIDER`, `LLM_MODEL`, and `LLM_API_KEY`. For an OpenAI-compatible provider, also set `LLM_BASE_URL`.

```bash
npm run infra:up
npm run db:migrate:deploy
npm run sandbox:build
npm run dev
```

The default endpoints are:

- Web: `http://localhost:3000`
- API: `http://localhost:3001/api/v1`
- Worker health: `http://localhost:3002/health/ready`
- PostgreSQL: `localhost:5432`
- Redis: `localhost:6379`

To stop the development infrastructure:

```bash
npm run infra:down
```

## Configuration

Start from [.env.example](.env.example). The most important settings are:

| Variable                        | Purpose                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                  | PostgreSQL connection used by Prisma, API, and Worker      |
| `REDIS_URL`                     | Redis connection used by BullMQ                            |
| `LLM_PROVIDER`                  | `openai` or `openai-compatible`                            |
| `LLM_MODEL`                     | Provider model identifier                                  |
| `LLM_API_KEY`                   | Platform-side model credential                             |
| `LLM_BASE_URL`                  | Required for OpenAI-compatible endpoints                   |
| `DEVFLOW_LOCAL_REPOSITORY_ROOT` | Optional allowlisted root for local repositories           |
| `DEVFLOW_MAX_STEPS`             | Run-wide hard limit for agent decisions                    |
| `DEVFLOW_MAX_TOTAL_TOKENS`      | Run-wide token budget                                      |
| `DEVFLOW_TIMEOUT_MS`            | Absolute active-execution deadline                         |
| `DEVFLOW_SANDBOX_IMAGE`         | Docker image used for isolated Runs                        |
| `DEVFLOW_GITHUB_WRITE_ENABLED`  | Enables approved GitHub writes; disabled by default        |
| `GITHUB_TOKEN`                  | Platform-only GitHub credential; never passed to the agent |

Do not commit `.env` or real credentials. GitHub credentials must remain at the API/Worker provider boundary and must not be included in task descriptions, model prompts, sandbox environments, or event payloads.

## Development

```bash
npm run check          # lint, typecheck, and unit tests
npm run build          # TypeScript workspaces and production Web build
npm run test           # Vitest suite
npm run test:e2e       # Playwright Web end-to-end tests
npm run format:check   # verify formatting
npm run db:validate    # validate the Prisma schema
```

Docker-backed integration runners are also available in `package.json`. They create isolated databases and sandboxes and therefore require Docker, PostgreSQL, and Redis access.

## Workflow

```text
Create Repository
        |
        v
Create Task and pin base commit
        |
        v
Create Run -> enqueue -> Worker claim/lease
        |
        v
PLAN -> Plan Approval
        |
        v
EXECUTE -> TEST -> REPAIR (bounded loop)
        |
        v
REVIEW -> optional targeted repair and retest
        |
        v
DIFF
        |
        +---- LOCAL ----------------------> DONE
        |
        +---- GitHub -> Push Approval -> Push
                         -> PR Approval -> Pull Request -> DONE
```

Every important transition and model/tool result is persisted. A reconnecting Web client replays events by sequence before continuing with SSE updates.

## Roadmap

- Deployment-grade authentication, authorization, and tenant isolation
- Object storage and retention policies for large artifacts and logs
- Stronger operational telemetry and distributed tracing
- Additional repository hosts and provider-specific LLM adapters
- Benchmark dashboards and long-running regression history
- More granular, persisted approval policies for sensitive tools

## Documentation

- [Architecture](docs/architecture.md)
- [Architecture decision records](docs/decisions/)
- [Test layout](tests/README.md)
- [Script conventions](scripts/README.md)
- [Historical development and acceptance material](docs/development/)

## License

DevFlow is available under the [MIT License](LICENSE).
