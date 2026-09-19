"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { useRunEvents } from "../hooks/use-run-events";
import {
  cancelRun,
  createRepository,
  createRun,
  createTask,
  getRunDetail,
  listRepositories,
  listRuns,
  listTasks,
  resolveApproval,
} from "../lib/api";
import type {
  ApprovalRecord,
  RepositoryRecord,
  RepositorySourceKind,
  RunDetail,
  RunRecord,
  TaskRecord,
} from "../lib/types";
import { RunDetail as RunDetailView } from "./run-detail";

interface DevflowWorkbenchProps {
  initialRunId?: string;
}

export function DevflowWorkbench({ initialRunId }: DevflowWorkbenchProps) {
  const router = useRouter();
  const [repositories, setRepositories] = useState<readonly RepositoryRecord[]>([]);
  const [tasks, setTasks] = useState<readonly TaskRecord[]>([]);
  const [runs, setRuns] = useState<readonly RunRecord[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(initialRunId ?? "");
  const [detail, setDetail] = useState<RunDetail>();
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(initialRunId !== undefined);
  const [busyAction, setBusyAction] = useState<string>();
  const [error, setError] = useState<string>();

  const refreshCatalog = useCallback(async () => {
    try {
      const [repositoryRecords, taskRecords, runRecords] = await Promise.all([
        listRepositories(),
        listTasks(),
        listRuns(),
      ]);
      setRepositories(repositoryRecords);
      setTasks(taskRecords);
      setRuns(sortRuns(runRecords));
      setSelectedRepositoryId((current) => current || repositoryRecords[0]?.id || "");
      setSelectedTaskId(
        (current) =>
          current ||
          taskRecords.find((task) => task.repositoryId === repositoryRecords[0]?.id)?.id ||
          taskRecords[0]?.id ||
          "",
      );
      setError(undefined);
    } catch (catalogError) {
      setError(toMessage(catalogError));
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (runId: string, silent = false) => {
    try {
      const nextDetail = await getRunDetail(runId);
      setDetail((current) => (current?.run.id === runId || !silent ? nextDetail : current));
      setRuns((current) => upsertRun(current, nextDetail.run));
      setError(undefined);
    } catch (detailError) {
      setError(toMessage(detailError));
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([listRepositories(), listTasks(), listRuns()]).then(
      ([repositoryRecords, taskRecords, runRecords]) => {
        if (!active) return;
        setRepositories(repositoryRecords);
        setTasks(taskRecords);
        setRuns(sortRuns(runRecords));
        setSelectedRepositoryId((current) => current || repositoryRecords[0]?.id || "");
        setSelectedTaskId(
          (current) =>
            current ||
            taskRecords.find((task) => task.repositoryId === repositoryRecords[0]?.id)?.id ||
            taskRecords[0]?.id ||
            "",
        );
        setError(undefined);
        setCatalogLoading(false);
      },
      (catalogError: unknown) => {
        if (!active) return;
        setError(toMessage(catalogError));
        setCatalogLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedRunId === "") return;
    let active = true;
    void getRunDetail(selectedRunId).then(
      (nextDetail) => {
        if (!active) return;
        setDetail(nextDetail);
        setRuns((current) => upsertRun(current, nextDetail.run));
        setError(undefined);
        setDetailLoading(false);
      },
      (detailError: unknown) => {
        if (!active) return;
        setError(toMessage(detailError));
        setDetailLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [selectedRunId]);

  const eventStream = useRunEvents(
    selectedRunId === "" ? undefined : selectedRunId,
    detail?.run.id === selectedRunId ? detail.events : [],
  );
  const latestSequence =
    eventStream.events.length === 0
      ? undefined
      : eventStream.events[eventStream.events.length - 1]?.sequence;

  useEffect(() => {
    if (selectedRunId === "" || latestSequence === undefined) return;
    const refreshTimer = setTimeout(() => {
      void loadDetail(selectedRunId, true);
    }, 350);
    return () => clearTimeout(refreshTimer);
  }, [latestSequence, loadDetail, selectedRunId]);

  const openRun = useCallback(
    (runId: string) => {
      setDetailLoading(true);
      setSelectedRunId(runId);
      router.push(`/runs/${encodeURIComponent(runId)}`);
    },
    [router],
  );

  const handleCancel = useCallback(async () => {
    if (selectedRunId === "") return;
    setBusyAction("cancel-run");
    try {
      const run = await cancelRun(selectedRunId);
      setRuns((current) => upsertRun(current, run));
      await loadDetail(selectedRunId);
    } catch (cancelError) {
      setError(toMessage(cancelError));
    } finally {
      setBusyAction(undefined);
    }
  }, [loadDetail, selectedRunId]);

  const handleApproval = useCallback(
    async (approval: ApprovalRecord, status: "APPROVED" | "REJECTED", feedback?: string) => {
      setBusyAction(`approval-${approval.id}`);
      try {
        await resolveApproval(approval.id, {
          status,
          actorId: "devflow-web",
          ...(feedback === undefined
            ? {}
            : { comment: feedback, resolution: { feedback, action: "REPLAN" } }),
        });
        await loadDetail(approval.runId);
        eventStream.reconnect();
      } catch (approvalError) {
        setError(toMessage(approvalError));
      } finally {
        setBusyAction(undefined);
      }
    },
    [eventStream, loadDetail],
  );

  const repositoryTasks = useMemo(
    () =>
      selectedRepositoryId === ""
        ? tasks
        : tasks.filter((task) => task.repositoryId === selectedRepositoryId),
    [selectedRepositoryId, tasks],
  );
  const taskRuns = useMemo(
    () => (selectedTaskId === "" ? runs : runs.filter((run) => run.taskId === selectedTaskId)),
    [runs, selectedTaskId],
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => router.push("/")}>
          <span>DF</span>
          <strong>DevFlow</strong>
        </button>
        <p>Task → Plan → Approval → Execute → Test / Repair → Review → Result</p>
        <button
          className="button button--quiet"
          type="button"
          onClick={() => {
            setCatalogLoading(true);
            void refreshCatalog();
          }}
        >
          刷新列表
        </button>
      </header>

      {error !== undefined && (
        <div className="global-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)} aria-label="关闭错误提示">
            ×
          </button>
        </div>
      )}

      <div className="workspace">
        <aside className="sidebar" aria-label="创建与导航">
          <div className="sidebar-intro">
            <p className="section-kicker">Workflow setup</p>
            <h2>创建一次可验证的 Run</h2>
            <p>按顺序创建或选择 Repository、Task，再启动 Run。</p>
          </div>

          <RepositoryForm
            busy={busyAction === "create-repository"}
            onCreated={(repository) => {
              setRepositories((current) => [...current, repository]);
              setSelectedRepositoryId(repository.id);
              setSelectedTaskId("");
            }}
            onError={setError}
            onBusy={setBusyAction}
          />

          <TaskForm
            busy={busyAction === "create-task"}
            repositories={repositories}
            selectedRepositoryId={selectedRepositoryId}
            onRepositoryChange={(repositoryId) => {
              setSelectedRepositoryId(repositoryId);
              setSelectedTaskId(tasks.find((task) => task.repositoryId === repositoryId)?.id ?? "");
            }}
            onCreated={(task) => {
              setTasks((current) => [...current, task]);
              setSelectedTaskId(task.id);
            }}
            onError={setError}
            onBusy={setBusyAction}
          />

          <RunForm
            busy={busyAction === "create-run"}
            tasks={repositoryTasks}
            selectedTaskId={selectedTaskId}
            onTaskChange={setSelectedTaskId}
            onCreated={(run) => {
              setRuns((current) => upsertRun(current, run));
              openRun(run.id);
            }}
            onError={setError}
            onBusy={setBusyAction}
          />

          <nav className="run-navigation" aria-labelledby="recent-runs-heading">
            <div className="nav-heading">
              <h3 id="recent-runs-heading">Runs</h3>
              <span>{taskRuns.length}</span>
            </div>
            {catalogLoading ? (
              <p className="empty-state">载入中…</p>
            ) : (
              <div className="run-list">
                {taskRuns.map((run) => (
                  <button
                    className={`run-list-item ${run.id === selectedRunId ? "run-list-item--active" : ""}`}
                    key={run.id}
                    type="button"
                    onClick={() => openRun(run.id)}
                  >
                    <span>
                      <strong>{taskTitle(tasks, run.taskId)}</strong>
                      <small>{shortId(run.id)}</small>
                    </span>
                    <span className={`status status--${run.status.toLowerCase()}`}>
                      {run.status}
                    </span>
                  </button>
                ))}
                {taskRuns.length === 0 && <p className="empty-state">暂无 Run。</p>}
              </div>
            )}
          </nav>
        </aside>

        <div className="content">
          {detailLoading && detail?.run.id !== selectedRunId ? (
            <div className="panel loading-panel" role="status">
              正在载入 Run detail…
            </div>
          ) : detail !== undefined && detail.run.id === selectedRunId ? (
            <RunDetailView
              detail={detail}
              events={eventStream.events}
              streamState={eventStream.state}
              {...(eventStream.error === undefined ? {} : { streamError: eventStream.error })}
              {...(busyAction === undefined ? {} : { busyAction })}
              onReconnect={eventStream.reconnect}
              onRefresh={() => loadDetail(selectedRunId)}
              onCancel={handleCancel}
              onResolveApproval={handleApproval}
            />
          ) : (
            <WelcomePanel
              repositories={repositories.length}
              tasks={tasks.length}
              runs={runs.length}
            />
          )}
        </div>
      </div>
    </main>
  );
}

interface FormControlProps {
  busy: boolean;
  onError(message: string | undefined): void;
  onBusy(action: string | undefined): void;
}

function RepositoryForm({
  busy,
  onCreated,
  onError,
  onBusy,
}: FormControlProps & { onCreated(repository: RepositoryRecord): void }) {
  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<RepositorySourceKind>("LOCAL");
  const [sourceUri, setSourceUri] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onBusy("create-repository");
    try {
      const repository = await createRepository({
        name: name.trim(),
        sourceKind,
        sourceUri: sourceUri.trim(),
        ...(defaultBranch.trim() === "" ? {} : { defaultBranch: defaultBranch.trim() }),
      });
      onCreated(repository);
      setName("");
      setSourceUri("");
      onError(undefined);
    } catch (submitError) {
      onError(toMessage(submitError));
    } finally {
      onBusy(undefined);
    }
  };

  return (
    <details className="create-card" open>
      <summary>
        <span>1</span>
        Repository
      </summary>
      <form data-testid="repository-form" onSubmit={(event) => void submit(event)}>
        <label>
          名称
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          来源
          <select
            value={sourceKind}
            onChange={(event) => setSourceKind(event.target.value as RepositorySourceKind)}
          >
            <option value="LOCAL">本地目录</option>
            <option value="GIT">Git URL</option>
          </select>
        </label>
        <label>
          {sourceKind === "LOCAL" ? "绝对路径" : "Git URL"}
          <input
            required
            maxLength={4096}
            placeholder={
              sourceKind === "LOCAL" ? "C:\\work\\repo" : "https://github.com/org/repo.git"
            }
            value={sourceUri}
            onChange={(event) => setSourceUri(event.target.value)}
          />
        </label>
        <label>
          默认分支
          <input
            maxLength={255}
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
          />
        </label>
        <button className="button button--primary" disabled={busy} type="submit">
          {busy ? "创建中…" : "创建 Repository"}
        </button>
      </form>
    </details>
  );
}

function TaskForm({
  busy,
  repositories,
  selectedRepositoryId,
  onRepositoryChange,
  onCreated,
  onError,
  onBusy,
}: FormControlProps & {
  repositories: readonly RepositoryRecord[];
  selectedRepositoryId: string;
  onRepositoryChange(repositoryId: string): void;
  onCreated(task: TaskRecord): void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [baseRef, setBaseRef] = useState("main");
  const [baseCommit, setBaseCommit] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedRepositoryId === "") return;
    onBusy("create-task");
    try {
      const task = await createTask({
        repositoryId: selectedRepositoryId,
        title: title.trim(),
        description: description.trim(),
        ...(baseRef.trim() === "" ? {} : { baseRef: baseRef.trim() }),
        ...(baseCommit.trim() === "" ? {} : { baseCommit: baseCommit.trim() }),
      });
      onCreated(task);
      setTitle("");
      setDescription("");
      setBaseCommit("");
      onError(undefined);
    } catch (submitError) {
      onError(toMessage(submitError));
    } finally {
      onBusy(undefined);
    }
  };

  return (
    <details className="create-card" open>
      <summary>
        <span>2</span>
        Task
      </summary>
      <form data-testid="task-form" onSubmit={(event) => void submit(event)}>
        <label>
          Repository
          <select
            required
            value={selectedRepositoryId}
            onChange={(event) => onRepositoryChange(event.target.value)}
          >
            <option value="">请选择</option>
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input
            required
            maxLength={300}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          需求描述
          <textarea
            required
            maxLength={100000}
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Base ref
            <input
              maxLength={255}
              value={baseRef}
              onChange={(event) => setBaseRef(event.target.value)}
            />
          </label>
          <label>
            Base commit
            <input
              pattern="[0-9a-fA-F]{7,64}"
              placeholder="可选"
              value={baseCommit}
              onChange={(event) => setBaseCommit(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button button--primary"
          disabled={busy || selectedRepositoryId === ""}
          type="submit"
        >
          {busy ? "创建中…" : "创建 Task"}
        </button>
      </form>
    </details>
  );
}

function RunForm({
  busy,
  tasks,
  selectedTaskId,
  onTaskChange,
  onCreated,
  onError,
  onBusy,
}: FormControlProps & {
  tasks: readonly TaskRecord[];
  selectedTaskId: string;
  onTaskChange(taskId: string): void;
  onCreated(run: RunRecord): void;
}) {
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [modelProvider, setModelProvider] = useState("");
  const [modelName, setModelName] = useState("");
  const [maxSteps, setMaxSteps] = useState("25");
  const [maxTestRetries, setMaxTestRetries] = useState("3");
  const [maxReviewRetries, setMaxReviewRetries] = useState("1");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedTaskId === "") return;
    onBusy("create-run");
    try {
      const response = await createRun({
        taskId: selectedTaskId,
        ...(idempotencyKey.trim() === "" ? {} : { idempotencyKey: idempotencyKey.trim() }),
        ...(modelProvider.trim() === "" ? {} : { modelProvider: modelProvider.trim() }),
        ...(modelName.trim() === "" ? {} : { modelName: modelName.trim() }),
        maxSteps: Number(maxSteps),
        maxTestRetries: Number(maxTestRetries),
        maxReviewRetries: Number(maxReviewRetries),
      });
      onCreated(response.run);
      onError(undefined);
    } catch (submitError) {
      onError(toMessage(submitError));
    } finally {
      onBusy(undefined);
    }
  };

  return (
    <details className="create-card" open>
      <summary>
        <span>3</span>
        Run
      </summary>
      <form data-testid="run-form" onSubmit={(event) => void submit(event)}>
        <label>
          Task
          <select
            required
            value={selectedTaskId}
            onChange={(event) => onTaskChange(event.target.value)}
          >
            <option value="">请选择</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Idempotency key
          <input
            maxLength={255}
            placeholder="可选；重复提交返回同一 Run"
            value={idempotencyKey}
            onChange={(event) => setIdempotencyKey(event.target.value)}
          />
        </label>
        <div className="form-row">
          <label>
            Model provider
            <input
              maxLength={100}
              placeholder="使用 Worker 默认值"
              value={modelProvider}
              onChange={(event) => setModelProvider(event.target.value)}
            />
          </label>
          <label>
            Model name
            <input
              maxLength={200}
              placeholder="使用 Worker 默认值"
              value={modelName}
              onChange={(event) => setModelName(event.target.value)}
            />
          </label>
        </div>
        <div className="form-row">
          <label>
            Max steps
            <input
              required
              min={1}
              max={200}
              type="number"
              value={maxSteps}
              onChange={(event) => setMaxSteps(event.target.value)}
            />
          </label>
          <label>
            Max repair
            <input
              required
              min={0}
              max={20}
              type="number"
              value={maxTestRetries}
              onChange={(event) => setMaxTestRetries(event.target.value)}
            />
          </label>
          <label>
            Max review retry
            <input
              required
              min={0}
              max={10}
              type="number"
              value={maxReviewRetries}
              onChange={(event) => setMaxReviewRetries(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button button--primary"
          disabled={busy || selectedTaskId === ""}
          type="submit"
        >
          {busy ? "启动中…" : "创建并启动 Run"}
        </button>
      </form>
    </details>
  );
}

function WelcomePanel({
  repositories,
  tasks,
  runs,
}: {
  repositories: number;
  tasks: number;
  runs: number;
}) {
  return (
    <section className="panel welcome-panel">
      <p className="section-kicker">P6–P9 workbench</p>
      <h1>选择一个 Run，或从左侧创建。</h1>
      <p>
        Run Detail 会实时展示计划审批、执行步骤、工具调用、测试修复、独立
        review、diff、指标与最终结果。
      </p>
      <dl className="metric-grid">
        <div>
          <dt>Repositories</dt>
          <dd>{repositories}</dd>
        </div>
        <div>
          <dt>Tasks</dt>
          <dd>{tasks}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{runs}</dd>
        </div>
      </dl>
    </section>
  );
}

function upsertRun(runs: readonly RunRecord[], run: RunRecord): readonly RunRecord[] {
  return sortRuns([run, ...runs.filter((candidate) => candidate.id !== run.id)]);
}

function sortRuns(runs: readonly RunRecord[]): readonly RunRecord[] {
  return [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function taskTitle(tasks: readonly TaskRecord[], taskId: string): string {
  return tasks.find((task) => task.id === taskId)?.title ?? "Unknown task";
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 8)}…`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}
