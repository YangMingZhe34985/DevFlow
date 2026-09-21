"use client";

import { useMemo, useState } from "react";

import type { StreamState } from "../hooks/use-run-events";
import {
  approvalPlan,
  diffText,
  eventActivity,
  eventSummary,
  extractPlan,
  formatDate,
  formatDuration,
  formatJson,
  mergeSteps,
  mergeToolCalls,
  metricGroups,
  reviewView,
  testEvents,
  toolActivities,
  workflowItems,
  type ActivityStatus,
  type ReviewView,
  type WorkflowItem,
} from "../lib/run-view";
import type {
  AgentEvent,
  ApprovalRecord,
  RunDetail as RunDetailRecord,
  StepRecord,
  ToolCallRecord,
} from "../lib/types";

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);

interface RunDetailProps {
  detail: RunDetailRecord;
  events: readonly AgentEvent[];
  streamState: StreamState;
  streamError?: string;
  busyAction?: string;
  onReconnect(): void;
  onRefresh(): Promise<void>;
  onCancel(): Promise<void>;
  onResolveApproval(
    approval: ApprovalRecord,
    status: "APPROVED" | "REJECTED",
    feedback?: string,
  ): Promise<void>;
}

export function RunDetail({
  detail,
  events,
  streamState,
  streamError,
  busyAction,
  onReconnect,
  onRefresh,
  onCancel,
  onResolveApproval,
}: RunDetailProps) {
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const plan = useMemo(() => extractPlan(detail, events), [detail, events]);
  const steps = useMemo(() => mergeSteps(detail.steps, events), [detail.steps, events]);
  const mergedTools = useMemo(
    () => mergeToolCalls(detail.toolCalls, events),
    [detail.toolCalls, events],
  );
  const tools = useMemo(() => toolActivities(mergedTools, steps), [mergedTools, steps]);
  const workflow = useMemo(() => workflowItems(detail, events), [detail, events]);
  const metrics = useMemo(() => metricGroups(detail, events), [detail, events]);
  const tests = useMemo(() => testEvents(events), [events]);
  const diff = useMemo(() => diffText(detail, events), [detail, events]);
  const review = useMemo(() => reviewView(detail, events), [detail, events]);
  const eventRows = useMemo(() => events.map(eventActivity), [events]);
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === "PENDING");
  const currentNode = workflow.find((item) => item.state === "running" || item.state === "failed");
  const displayStage =
    currentNode?.label ??
    [...workflow].reverse().find((item) => item.state === "completed")?.label ??
    "Plan";
  const durationMs =
    detail.run.result?.metrics.durationMs ??
    elapsed(detail.run.startedAt, detail.run.finishedAt ?? detail.run.updatedAt);

  return (
    <article className="run-detail" data-testid="run-detail">
      <header className="run-header panel">
        <div className="run-header-main">
          <div>
            <div className="section-kicker">Run detail</div>
            <h1>{detail.task.title}</h1>
          </div>
          <div className="run-header-context">
            <span>
              Repository <strong>{detail.repository.name}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span className="run-header-stage" data-testid="run-header-stage">
              {detail.run.status === "FAILED" ? `Failed at ${displayStage}` : displayStage}
            </span>
          </div>
          <div className="run-header-meta">
            <span data-testid="run-duration">Duration {formatDuration(durationMs)}</span>
            <span>Base ref {detail.task.baseRef ?? "HEAD"}</span>
            <span title={detail.task.baseCommitSha}>
              Base commit {shortSha(detail.task.baseCommitSha)}
            </span>
            <span className="run-id" title={detail.run.id}>
              Run {shortId(detail.run.id)}
            </span>
          </div>
        </div>
        <div className="run-header-actions">
          <StatusBadge value={detail.run.status} />
          <button className="button button--quiet" type="button" onClick={() => void onRefresh()}>
            刷新快照
          </button>
          {!TERMINAL_STATUSES.has(detail.run.status) && (
            <button
              className="button button--danger"
              type="button"
              disabled={busyAction === "cancel-run"}
              onClick={() => void onCancel()}
            >
              {busyAction === "cancel-run" ? "取消中…" : "取消 Run"}
            </button>
          )}
        </div>
      </header>

      <section className="panel run-overview" aria-labelledby="workflow-heading">
        <SectionHeading
          id="workflow-heading"
          title="Workflow progress"
          subtitle="当前阶段、已完成阶段与失败位置一目了然。"
        />
        <Workflow items={workflow} />
        <details className="run-config">
          <summary>运行配置与时间</summary>
          <dl className="definition-grid">
            <Definition label="Task status" value={detail.task.status} />
            <Definition label="Created" value={formatDate(detail.run.createdAt)} />
            <Definition label="Started" value={formatDate(detail.run.startedAt)} />
            <Definition label="Finished" value={formatDate(detail.run.finishedAt)} />
            <Definition label="Max steps" value={String(detail.run.maxSteps)} />
            <Definition
              label="Repair attempts"
              value={`${detail.run.retryCount} / ${detail.run.maxTestRetries}`}
            />
            <Definition label="Review retries" value={String(detail.run.maxReviewRetries)} />
            <Definition label="Dispatch revision" value={String(detail.run.dispatchRevision)} />
          </dl>
        </details>
      </section>

      <ResultPanel detail={detail} />

      <section className="panel" aria-labelledby="approval-heading" data-testid="approval-panel">
        <SectionHeading
          id="approval-heading"
          title="计划与审批"
          subtitle={
            pendingApprovals.length > 0
              ? `${pendingApprovals.length} 个请求等待处理；未批准不会进入代码执行。`
              : "计划、审批决定和拒绝反馈会保留在 Run 中。"
          }
        />
        {plan === undefined ? (
          <EmptyState>尚未生成可展示的计划。</EmptyState>
        ) : (
          <div className="plan" data-testid="run-plan">
            {plan.summary !== undefined && <p className="plan-summary">{plan.summary}</p>}
            <ol className="plan-steps">
              {plan.steps.map((step) => (
                <li key={step.id}>
                  <strong>{step.title}</strong>
                  {step.description !== undefined && <span>{step.description}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="approval-list">
          {detail.approvals.map((approval) => {
            const approvalSpecificPlan = approvalPlan(approval);
            const rejectFeedback = feedback[approval.id] ?? "";
            return (
              <article className="approval-card" key={approval.id}>
                <div className="approval-title">
                  <div>
                    <strong>{approvalLabel(approval.kind)}</strong>
                    <small>{formatDate(approval.requestedAt)}</small>
                  </div>
                  <StatusBadge value={approval.status} />
                </div>
                {approvalSpecificPlan === undefined ? (
                  <JsonDetails label="审批请求" value={approval.request} />
                ) : (
                  approvalSpecificPlan.summary !== undefined && (
                    <p className="approval-note">{approvalSpecificPlan.summary}</p>
                  )
                )}
                {approval.comment !== undefined && (
                  <p className="approval-feedback">
                    <strong>反馈：</strong>
                    {approval.comment}
                  </p>
                )}
                {approval.status === "PENDING" && (
                  <div className="approval-actions">
                    <label>
                      拒绝反馈
                      <textarea
                        data-testid={`approval-feedback-${approval.id}`}
                        placeholder="说明需要修改的计划或工具调用；拒绝时必填。"
                        value={rejectFeedback}
                        onChange={(event) =>
                          setFeedback((current) => ({
                            ...current,
                            [approval.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="button button--primary"
                        data-testid={`approval-approve-${approval.id}`}
                        type="button"
                        disabled={busyAction === `approval-${approval.id}`}
                        onClick={() => void onResolveApproval(approval, "APPROVED")}
                      >
                        批准并继续
                      </button>
                      <button
                        className="button button--danger"
                        data-testid={`approval-reject-${approval.id}`}
                        type="button"
                        disabled={
                          busyAction === `approval-${approval.id}` ||
                          rejectFeedback.trim().length === 0
                        }
                        onClick={() =>
                          void onResolveApproval(approval, "REJECTED", rejectFeedback.trim())
                        }
                      >
                        {approval.kind === "PLAN" ? "拒绝并重新规划" : "拒绝发布"}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
          {detail.approvals.length === 0 && <EmptyState>当前没有审批记录。</EmptyState>}
        </div>
      </section>

      <section className="panel" aria-labelledby="metrics-heading" data-testid="run-metrics">
        <SectionHeading
          id="metrics-heading"
          title="Metrics"
          subtitle="重点指标优先，调用与延迟分组展示。"
        />
        <div className="metric-groups">
          {metrics.map((group) => (
            <section className="metric-group" key={group.id}>
              <h3>{group.label}</h3>
              <dl className={`metric-grid metric-grid--${group.id}`}>
                {group.items.map((metric) => (
                  <div
                    key={metric.key}
                    data-testid={metric.key === "budget" ? "metric-budget" : undefined}
                  >
                    <dt>{metric.label}</dt>
                    <dd>{metric.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>

      <section className="panel" aria-labelledby="tests-heading">
        <SectionHeading
          id="tests-heading"
          title="Test / Repair"
          subtitle={`最多 ${detail.run.maxTestRetries} 次修复，当前记录 ${detail.run.retryCount} 次`}
        />
        <div className="compact-timeline">
          {tests.map((event) => (
            <div className="compact-event" key={event.eventId}>
              <span className="sequence">#{event.sequence}</span>
              <strong>{event.type}</strong>
              <span>{eventSummary(event) || formatDate(event.occurredAt)}</span>
            </div>
          ))}
          {tests.length === 0 && <EmptyState>尚无测试或修复记录。</EmptyState>}
        </div>
      </section>

      <div className="two-column">
        <section className="panel" aria-labelledby="steps-heading" data-testid="run-steps">
          <SectionHeading id="steps-heading" title="Steps" subtitle={`${steps.length} steps`} />
          <div className="activity-list">
            {steps.map((step) => (
              <StepActivity key={step.id} step={step} />
            ))}
            {steps.length === 0 && <EmptyState>尚未开始执行步骤。</EmptyState>}
          </div>
        </section>

        <section className="panel" aria-labelledby="tools-heading" data-testid="run-tool-calls">
          <SectionHeading id="tools-heading" title="Tools" subtitle={`${tools.length} calls`} />
          <div className="activity-list">
            {tools.map((activity) => (
              <ToolActivity key={activity.id} toolCall={activity.toolCall} stage={activity.stage} />
            ))}
            {tools.length === 0 && <EmptyState>尚无工具调用。</EmptyState>}
          </div>
        </section>
      </div>

      <section className="panel" aria-labelledby="review-heading" data-testid="run-review">
        <SectionHeading
          id="review-heading"
          title="Independent review"
          subtitle="结构化审查结论与 findings"
        />
        {review === undefined ? (
          <EmptyState>尚未生成 review artifact。</EmptyState>
        ) : (
          <ReviewCard review={review} />
        )}
      </section>

      <section className="panel diff-panel" aria-labelledby="diff-heading" data-testid="run-diff">
        <SectionHeading id="diff-heading" title="Diff" subtitle="最终代码变更，按文件折叠展示。" />
        {diff === undefined ? (
          <EmptyState>尚未生成 diff artifact。</EmptyState>
        ) : (
          <DiffView diff={diff} />
        )}
      </section>

      {detail.githubPublication !== undefined && (
        <section
          className="panel"
          aria-labelledby="github-heading"
          data-testid="github-publication"
        >
          <SectionHeading
            id="github-heading"
            title="GitHub publication"
            subtitle="平台受控的 branch、commit 与 pull request metadata"
          />
          <dl className="definition-grid">
            <Definition
              label="Repository"
              value={`${detail.githubPublication.repository.owner}/${detail.githubPublication.repository.name}`}
            />
            <Definition label="Base ref" value={detail.githubPublication.baseBranch} />
            <Definition label="Base commit" value={detail.githubPublication.baseCommit} />
            <Definition label="Branch" value={detail.githubPublication.branchName} />
            <Definition
              label="Commit"
              value={detail.githubPublication.commitSha ?? "等待 Push 审批"}
            />
            <Definition
              label="Pull request"
              value={
                detail.githubPublication.pullRequestNumber === undefined
                  ? "等待 PR 审批"
                  : `#${String(detail.githubPublication.pullRequestNumber)} (${detail.githubPublication.pullRequestState ?? "open"})`
              }
            />
          </dl>
          {detail.githubPublication.branchUrl !== undefined && (
            <p>
              <a href={detail.githubPublication.branchUrl} rel="noreferrer" target="_blank">
                查看远端分支
              </a>
            </p>
          )}
          {detail.githubPublication.pullRequestUrl !== undefined && (
            <p>
              <a href={detail.githubPublication.pullRequestUrl} rel="noreferrer" target="_blank">
                查看 Pull Request
              </a>
            </p>
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="events-heading" data-testid="event-timeline">
        <div className="section-heading section-heading--actions">
          <div>
            <h2 id="events-heading">Events</h2>
            <p>历史 replay 与 SSE 增量按 sequence 合并。</p>
          </div>
          <div className="stream-control">
            <span
              className={`stream-state stream-state--${streamState}`}
              data-testid="connection-state"
            >
              {streamLabel(streamState)}
            </span>
            <button className="button button--quiet" type="button" onClick={onReconnect}>
              重新连接
            </button>
          </div>
        </div>
        {streamError !== undefined && <p className="inline-alert">{streamError}</p>}
        <div className="activity-list event-list">
          {eventRows.map((activity) => (
            <details
              className={`activity-row activity-row--${activity.status.toLowerCase()}`}
              key={activity.id}
            >
              <summary>
                <strong className="activity-title">{activity.title}</strong>
                <span className="activity-meta">
                  {activity.summary || formatDate(activity.event.occurredAt)}
                </span>
                <StatusBadge value={activity.status} />
              </summary>
              <div className="activity-body">
                <JsonBlock value={activity.event.payload} />
              </div>
            </details>
          ))}
          {eventRows.length === 0 && <EmptyState>等待第一个事件。</EmptyState>}
        </div>
      </section>
    </article>
  );
}

function Workflow({ items }: { items: readonly WorkflowItem[] }) {
  return (
    <ol className="workflow" aria-label="Run workflow">
      {items.map((item, index) => (
        <li
          className={`workflow-step workflow-step--${item.state}`}
          data-state={item.state}
          data-testid={`workflow-stage-${item.id.toLowerCase()}`}
          key={item.id}
          {...(item.state === "running" || item.state === "failed"
            ? { "aria-current": "step" as const }
            : {})}
        >
          <span>{index + 1}</span>
          <strong>{item.label}</strong>
          <small>{workflowStateLabel(item.state)}</small>
        </li>
      ))}
    </ol>
  );
}

function ResultPanel({ detail }: { detail: RunDetailRecord }) {
  return (
    <section
      className="panel result-panel"
      aria-labelledby="result-heading"
      data-testid="run-result"
    >
      <SectionHeading id="result-heading" title="Result" subtitle={detail.run.status} />
      {detail.run.result === undefined ? (
        <EmptyState>Run 尚未结束。</EmptyState>
      ) : (
        <div>
          {detail.run.result.summary !== undefined && (
            <p className="result-summary">{detail.run.result.summary}</p>
          )}
          {detail.run.result.error !== undefined && (
            <div className="result-error">
              <strong>{detail.run.result.error.code}</strong>
              <p>{detail.run.result.error.message}</p>
              {detail.run.result.error.details !== undefined && (
                <JsonDetails label="错误详情" value={detail.run.result.error.details} />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function StepActivity({ step }: { step: StepRecord }) {
  return (
    <details className={`activity-row activity-row--${step.status.toLowerCase()}`}>
      <summary>
        <strong className="activity-title">
          #{step.sequence} {step.title ?? step.stage}
        </strong>
        <span className="activity-meta">
          {step.stage} · {formatDuration(step.durationMs)}
        </span>
        <StatusBadge value={step.status} />
      </summary>
      <div className="activity-body">
        {step.input !== undefined && <JsonDetails label="输入" value={step.input} />}
        {step.output !== undefined && <JsonDetails label="输出" value={step.output} />}
        {step.error !== undefined && <JsonDetails label="错误" value={step.error} />}
      </div>
    </details>
  );
}

function ToolActivity({
  toolCall,
  stage,
}: {
  toolCall: ToolCallRecord;
  stage: StepRecord["stage"] | undefined;
}) {
  return (
    <details className={`activity-row activity-row--${toolCall.status.toLowerCase()}`}>
      <summary>
        <strong className="activity-title">{toolCall.name}</strong>
        <span className="activity-meta">
          {stage ?? "—"} · {formatDuration(toolCall.durationMs)}
        </span>
        <StatusBadge value={toolCall.status} />
      </summary>
      <div className="activity-body">
        <JsonDetails label="输入" value={toolCall.input} />
        {toolCall.output !== undefined && <JsonDetails label="输出" value={toolCall.output} />}
        {toolCall.error !== undefined && <JsonDetails label="错误" value={toolCall.error} />}
      </div>
    </details>
  );
}

function ReviewCard({ review }: { review: ReviewView }) {
  const verdictClass = review.verdict === "PASSED" ? "passed" : "changes-requested";
  return (
    <div className="review-card">
      <div className={`review-verdict review-verdict--${verdictClass}`}>
        <strong data-testid="review-verdict">Review: {review.verdict.replace("_", " ")}</strong>
        <StatusBadge value={review.verdict} />
      </div>
      {review.summary !== undefined && (
        <div className="review-summary">
          <h3>Summary</h3>
          <p>{review.summary}</p>
        </div>
      )}
      <div className="review-findings" data-testid="review-findings">
        <h3>Findings</h3>
        {review.findings.length === 0 ? (
          <p className="empty-state">No findings.</p>
        ) : (
          <ul className="finding-list">
            {review.findings.map((finding, index) => (
              <li key={`${finding.severity}-${String(index)}`}>
                <StatusBadge value={finding.severity} />
                <span>{finding.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="json-details">
        <summary>Raw review data</summary>
        <pre className="code-block">{review.raw}</pre>
      </details>
    </div>
  );
}

function DiffView({ diff }: { diff: string }) {
  const sections = splitDiff(diff);
  const additions = diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const deletions = diff
    .split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return (
    <div>
      <div className="diff-summary">
        <span>{sections.length} files</span>
        <span>+{additions}</span>
        <span>-{deletions}</span>
      </div>
      <div className="activity-list">
        {sections.map((section, index) => (
          <details
            className="activity-row"
            key={`${section.title}-${String(index)}`}
            open={sections.length === 1}
          >
            <summary>
              <strong className="activity-title">{section.title}</strong>
              <span className="activity-meta">{section.lines} lines</span>
            </summary>
            <div className="activity-body">
              <pre className="code-block diff-block">{section.content}</pre>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function splitDiff(diff: string): readonly { title: string; content: string; lines: number }[] {
  const starts = [...diff.matchAll(/^diff --git .*$/gmu)];
  if (starts.length === 0) {
    return [{ title: "Patch", content: diff, lines: diff.split("\n").length }];
  }
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? diff.length;
    const content = diff.slice(start, end).trimEnd();
    const title =
      /^diff --git a\/(.+?) b\/(.+)$/mu.exec(content)?.[2] ?? `File ${String(index + 1)}`;
    return { title, content, lines: content.split("\n").length };
  });
}

function approvalLabel(kind: ApprovalRecord["kind"]): string {
  if (kind === "PLAN") return "Plan approval";
  if (kind === "GITHUB_PUSH") return "GitHub push approval";
  if (kind === "GITHUB_PULL_REQUEST") return "Pull request approval";
  return "Tool approval";
}

function SectionHeading({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  return (
    <div className="section-heading">
      <h2 id={id}>{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}

function Definition({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StatusBadge({ value }: { value: string | ActivityStatus }) {
  return (
    <span className={`status status--${value.toLowerCase().replace(/\s+/gu, "_")}`}>{value}</span>
  );
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <JsonBlock value={value} />
    </details>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre className="code-block">{formatJson(value)}</pre>;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

function elapsed(start: string | undefined, end: string | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function shortSha(value: string | undefined): string {
  return value === undefined ? "unresolved" : value.slice(0, 12);
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function workflowStateLabel(state: WorkflowItem["state"]): string {
  if (state === "completed") return "Completed";
  if (state === "running") return "Running";
  if (state === "failed") return "Failed";
  if (state === "skipped") return "Skipped";
  return "Pending";
}

function streamLabel(state: StreamState): string {
  const labels: Record<StreamState, string> = {
    idle: "未连接",
    "loading-history": "回放历史",
    connecting: "连接中",
    live: "实时",
    retrying: "重连中",
    closed: "已结束",
  };
  return labels[state];
}
