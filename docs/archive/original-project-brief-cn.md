# DevFlow — AI Software Engineering Agent Platform

## Development Specification for Codex / Claude Code

## 1. Project Goal

DevFlow is an **AI software engineering agent execution, observability, and evaluation platform**.

Given a source repository and a natural-language development task, DevFlow should allow an agent to:

```
Understand Task
→ Analyze Repository
→ Generate Plan
→ Call Tools
→ Modify Code
→ Run Tests
→ Fix Failures
→ Review Changes
→ Produce Git Diff / Result
```

The project is **not intended to be a Cursor/Claude Code clone**. The primary focus is:

- reliable agent execution;
- sandboxed code execution;
- test-feedback loops;
- execution tracing;
- human approval;
- reproducible evaluation.

---

## 2. Core Requirements

### 2.1 Repository and Task Management

The system should support:

- importing/localizing Git repositories;
- creating software engineering tasks;
- associating multiple execution runs with one task;
- storing task and run history.

Core relationship:

```
Repository
  └─ Task
      └─ Run
          ├─ Step
          ├─ ToolCall
          ├─ Event
          ├─ Artifact
          └─ Approval
```

`Task` represents the problem to solve.

`Run` represents one agent attempt to solve the task.

---

### 2.2 Agent Runtime

Implement an agent runtime capable of:

- invoking LLMs;
- processing tool calls;
- maintaining conversation/run state;
- limiting maximum steps;
- handling timeout and cancellation;
- retrying recoverable failures;
- collecting token, latency, and error information.

Initial execution model:

```
LLM
 ↓
Tool Call
 ↓
Tool Executor
 ↓
Tool Result
 ↓
LLM
```

Do not introduce unnecessary multi-agent complexity in the first version.

---

### 2.3 Tool System

Provide a unified tool abstraction.

Initial tools:

```
listFiles
readFile
searchCode
writeFile
applyPatch
runCommand
gitStatus
gitDiff
```

Each tool should support:

- typed input/output;
- schema validation;
- permission checks where required;
- timeout handling;
- structured errors;
- execution event logging.

Recommended schema validation library:

```
Zod
```

---

### 2.4 Agent Workflow

Use a hybrid model:

> deterministic workflow + agent-based decisions.

Target workflow:

```
START
 ↓
Analyze Repository
 ↓
Analyze Task
 ↓
Generate Plan
 ↓
Human Approval
 ↓
Execute Agent
 ↓
Run Tests
 ├─ Failed → Agent Fix → Run Tests
 ↓
Review
 ├─ Failed → Agent Fix
 ↓
Generate Diff
 ↓
DONE
```

The application controls workflow transitions.

The LLM handles reasoning and task-specific decisions.

---

### 2.5 Sandbox

Agent-generated commands must **not execute directly on the host machine**.

Each run should execute inside an isolated Docker workspace.

Typical lifecycle:

```
Create Sandbox
→ Clone/Copy Repository
→ Agent Operations
→ Install Dependencies
→ Run Tests / Build
→ Generate Diff
→ Destroy Sandbox
```

Sandbox should eventually support:

- CPU limits;
- memory limits;
- execution timeout;
- working-directory isolation;
- environment-variable control;
- optional network restrictions.

---

### 2.6 Observability

Every agent run should produce a structured execution trace.

Record events such as:

```
RUN_STARTED
STEP_STARTED
LLM_REQUEST
LLM_RESPONSE
TOOL_CALL
TOOL_RESULT
TEST_STARTED
TEST_RESULT
APPROVAL_REQUIRED
RUN_FAILED
RUN_COMPLETED
```

Track where possible:

```
timestamp
duration
model
tokens
cost
tool
input
output
error
```

The web UI should display these events in real time.

---

### 2.7 Human-in-the-loop

Support approval checkpoints.

Initial approval point:

```
Generated Plan
→ User Approves
→ Agent Executes
```

Later support tool-level policies such as:

```
read_file     → auto
search_code   → auto
write_file    → configurable
run_command   → configurable
git_push      → approval required
```

---

### 2.8 Test Feedback Loop

Code modification must be verified by actual repository commands.

Example:

```
Agent modifies code
 ↓
npm test
 ↓
Failed
 ↓
Agent reads failure
 ↓
Agent modifies code
 ↓
npm test
 ↓
Passed
```

Use a maximum retry count to prevent infinite loops.

---

## 3. Recommended Architecture

Use a TypeScript monorepo.

```
devflow/
├─ apps/
│  ├─ web/          # Next.js frontend
│  ├─ api/          # NestJS API
│  └─ worker/       # Agent execution worker
│
├─ packages/
│  ├─ agent/        # Agent runtime
│  ├─ tools/        # Tool implementations
│  ├─ workflow/     # Workflow logic
│  ├─ sandbox/      # Docker execution
│  ├─ git/          # Git operations
│  ├─ database/     # Prisma schema/client
│  ├─ shared/       # Shared types/schemas
│  └─ eval/         # Agent evaluation
│
├─ examples/
├─ tests/
├─ docker/
└─ scripts/
```

---

## 4. Technology Stack

### Frontend

```
Next.js
React
TypeScript
Tailwind CSS
shadcn/ui
Zustand
Monaco Editor
```

React Flow may be introduced later for workflow visualization.

---

### Backend

```
NestJS
TypeScript
Prisma
PostgreSQL
```

---

### Async Execution

```
Redis
BullMQ
```

Agent runs should execute in workers instead of blocking API processes.

---

### Agent Layer

Initial:

```
Custom Agent Runtime
Vercel AI SDK
Zod
```

Later, if workflow complexity requires checkpointing, pause/resume, or conditional state transitions:

```
LangGraph.js
```

Do not introduce LangGraph before the basic agent runtime is understood and working.

---

### Infrastructure

```
Docker
Docker Compose
Git
```

---

### Communication

```
REST
SSE
```

Use REST for commands/resources and SSE for real-time run events.

---

### Testing

```
Vitest
Playwright
```

---

## 5. Development Phases

### Phase 1 — Agent Prototype

Build a standalone Node.js + TypeScript prototype.

No frontend, NestJS, database, or queue.

Goal:

```
Task
→ Agent
→ Read/Search/Edit Repository
→ Run Tests
→ Produce Git Diff
```

The agent must successfully repair simple local test repositories.

---

### Phase 2 — Runtime and Tool Abstraction

Refactor the prototype into reusable packages.

Implement:

```
AgentRuntime
ToolRegistry
ToolExecutor
RunContext
AgentState
AgentEvent
```

Add:

```
maxSteps
timeout
retry
cancel
structured errors
token usage
logging
```

---

### Phase 3 — Docker Sandbox

Move repository operations and command execution into Docker containers.

All shell/test/build execution must go through the sandbox layer.

---

### Phase 4 — API and Persistence

Create the NestJS API and PostgreSQL data model.

Implement:

```
Repository
Task
Run
Step
ToolCall
Event
Artifact
Approval
```

---

### Phase 5 — Queue and Worker

Introduce Redis + BullMQ.

Flow:

```
API
→ Queue
→ Agent Worker
→ Sandbox
```

Support:

```
queueing
retry
cancel
timeout
concurrency
```

---

### Phase 6 — Web UI

Create:

```
Dashboard
Repositories
Tasks
Runs
Run Detail
```

`Run Detail` is the primary interface.

Display:

```
workflow status
execution timeline
tool calls
logs
test results
changed files
git diff
token/latency statistics
```

---

### Phase 7 — SSE and Trace

Stream run events from backend to frontend using SSE.

Persist important events for later replay and evaluation.

---

### Phase 8 — Workflow and Human Approval

Implement:

```
Analyze
→ Plan
→ Approve
→ Execute
→ Test
→ Review
→ Finish
```

Support rejection/replanning.

---

### Phase 9 — Test Feedback and Review

Implement automatic repair loops based on test failures.

Add an independent review stage based on:

```
Task
Git Diff
Test Result
```

---

### Phase 10 — GitHub Integration

Support:

```
Repository Import
Issue Import
Issue → DevFlow Task
Patch Generation
Optional PR Creation
```

GitHub credentials must be handled by the platform, not directly exposed to the agent.

---

### Phase 11 — Evaluation

Build a small reproducible benchmark.

Each case should define:

```
repository
base commit
task description
evaluation command
hidden/expected tests
```

Track:

```
task success rate
test pass rate
steps
tool calls
tokens
cost
latency
retry count
```

---

## 6. Implementation Priorities

Prioritize in this order:

```
Agent correctness
→ Tool reliability
→ Test verification
→ Sandbox safety
→ Runtime observability
→ Backend persistence
→ Web UI
→ Advanced integrations
```

Do **not** prioritize:

```
authentication complexity
landing pages
visual polish
multi-agent systems
MCP
RAG
advanced workflow editors
```

until the core agent execution path works reliably.

---

## 7. Coding Principles

When implementing DevFlow:

- prefer explicit types over implicit `any`;
- keep domain logic independent from frameworks where possible;
- use Zod at external/tool boundaries;
- keep tool implementations small and isolated;
- do not allow the LLM to bypass the tool layer;
- do not execute arbitrary agent commands directly on the host;
- emit structured events for important runtime actions;
- avoid premature abstraction;
- add tests for runtime, tools, sandbox, and workflow logic;
- prefer small incremental commits and runnable milestones.

---

## 8. Definition of Done for V1

DevFlow V1 is considered complete when a user can:

```
Import/select a repository
→ Create a software engineering task
→ Start an Agent Run
→ Review/approve the plan
→ Observe execution in real time
→ Agent modifies code in Docker Sandbox
→ Tests are executed
→ Agent reacts to failed tests
→ Final tests pass or failure is reported
→ User sees Git Diff and execution trace
```

The same task must be reproducible enough to support evaluation and comparison across multiple runs.

---

## 9. Project Scope Constraint

The main product abstraction is:

> **Repository + Task → Observable and Verifiable Agent Run**

Any feature that does not directly improve this execution path should be treated as secondary until the V1 core is stable.
