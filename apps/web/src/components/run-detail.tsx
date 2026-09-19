"use client";

import { useMemo, useState } from "react";

import type { StreamState } from "../hooks/use-run-events";
import {
  approvalPlan,
  diffText,
  eventSummary,
  extractPlan,
  formatDate,
  formatDuration,
  formatJson,
  mergeSteps,
  mergeToolCalls,
  metricItems,
  reviewText,
  testEvents,
} from "../lib/run-view";
import type { AgentEvent, ApprovalRecord, RunDetail as RunDetailRecord } from "../lib/types";

const WORKFLOW = [
  ["GENERATE_PLAN", "Plan"],
  ["WAITING_APPROVAL", "Approval"],
  ["EXECUTE", "Execute"],
  ["TEST", "Test"],
  ["FIX", "Repair"],
  ["REVIEW", "Review"],
  ["GENERATE_DIFF", "Diff"],
  ["DONE", "Result"],
] as const;

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
  const toolCalls = useMemo(
    () => mergeToolCalls(detail.toolCalls, events),
    [detail.toolCalls, events],
  );
  const metrics = useMemo(() => metricItems(detail, events), [detail, events]);
  const tests = useMemo(() => testEvents(events), [events]);
  const diff = useMemo(() => diffText(detail, events), [detail, events]);
  const review = useMemo(() => reviewText(detail, events), [detail, events]);
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === "PENDING");

  return (
    <article className="run-detail" data-testid="run-detail">
      <header className="run-header panel">
        <div>
          <div className="section-kicker">Run detail</div>
          <h1>{detail.task.title}</h1>
          <p className="run-id">{detail.run.id}</p>
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

      <section className="panel" aria-labelledby="overview-heading">
        <SectionHeading id="overview-heading" title="概览" subtitle="执行身份与当前进度" />
        <dl className="definition-grid">
          <Definition label="Repository" value={detail.repository.name} />
          <Definition label="Task status" value={detail.task.status} />
          <Definition label="Current stage" value={detail.run.currentStage} />
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
        <Workflow currentStage={detail.run.currentStage} status={detail.run.status} />
      </section>

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
                    <strong>{approval.kind === "PLAN" ? "Plan approval" : "Tool approval"}</strong>
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
                        拒绝并重新规划
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

      <div className="two-column">
        <section className="panel" aria-labelledby="steps-heading" data-testid="run-steps">
          <SectionHeading id="steps-heading" title="步骤" subtitle={`${steps.length} steps`} />
          <div className="record-list">
            {steps.map((step) => (
              <article className="record" key={step.id}>
                <div className="record-heading">
                  <span className="sequence">#{step.sequence}</span>
                  <strong>{step.title ?? step.stage}</strong>
                  <StatusBadge value={step.status} />
                </div>
                <div className="record-meta">
                  <span>{step.stage}</span>
                  <span>{formatDuration(step.durationMs)}</span>
                </div>
                {step.output !== undefined && <JsonDetails label="输出" value={step.output} />}
                {step.error !== undefined && <JsonDetails label="错误" value={step.error} />}
              </article>
            ))}
            {steps.length === 0 && <EmptyState>尚未开始执行步骤。</EmptyState>}
          </div>
        </section>

        <section className="panel" aria-labelledby="tools-heading" data-testid="run-tool-calls">
          <SectionHeading
            id="tools-heading"
            title="工具调用"
            subtitle={`${toolCalls.length} calls`}
          />
          <div className="record-list">
            {toolCalls.map((toolCall) => (
              <article className="record" key={toolCall.id}>
                <div className="record-heading">
                  <strong>{toolCall.name}</strong>
                  <StatusBadge value={toolCall.status} />
                </div>
                <div className="record-meta">
                  <span>{formatDuration(toolCall.durationMs)}</span>
                  <span>{toolCall.id}</span>
                </div>
                <JsonDetails label="输入" value={toolCall.input} />
                {toolCall.output !== undefined && (
                  <JsonDetails label="输出" value={toolCall.output} />
                )}
                {toolCall.error !== undefined && (
                  <JsonDetails label="错误" value={toolCall.error} />
                )}
              </article>
            ))}
            {toolCalls.length === 0 && <EmptyState>尚无工具调用。</EmptyState>}
          </div>
        </section>
      </div>

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

      <section className="panel" aria-labelledby="metrics-heading" data-testid="run-metrics">
        <SectionHeading id="metrics-heading" title="指标" subtitle="持久化 Run metrics" />
        <dl className="metric-grid">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <dt>{metric.label}</dt>
              <dd>{metric.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="two-column">
        <section className="panel" aria-labelledby="diff-heading" data-testid="run-diff">
          <SectionHeading id="diff-heading" title="Diff" subtitle="最终代码变更" />
          {diff === undefined ? (
            <EmptyState>尚未生成 diff artifact。</EmptyState>
          ) : (
            <pre className="code-block diff-block">{diff}</pre>
          )}
        </section>
        <section className="panel" aria-labelledby="review-heading" data-testid="run-review">
          <SectionHeading id="review-heading" title="Independent review" subtitle="独立审查结果" />
          {review === undefined ? (
            <EmptyState>尚未生成 review artifact。</EmptyState>
          ) : (
            <pre className="code-block prose-block">{review}</pre>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="events-heading" data-testid="event-timeline">
        <div className="section-heading section-heading--actions">
          <div>
            <h2 id="events-heading">事件</h2>
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
        <div className="event-list">
          {events.map((event) => (
            <article className={`event event--${event.level.toLowerCase()}`} key={event.sequence}>
              <span className="sequence">#{event.sequence}</span>
              <time dateTime={event.occurredAt}>{formatDate(event.occurredAt)}</time>
              <strong>{event.type}</strong>
              <span className="event-summary">{eventSummary(event)}</span>
              <details>
                <summary>payload</summary>
                <pre className="code-block">{formatJson(event.payload)}</pre>
              </details>
            </article>
          ))}
          {events.length === 0 && <EmptyState>等待第一个事件。</EmptyState>}
        </div>
      </section>

      <section
        className="panel result-panel"
        aria-labelledby="result-heading"
        data-testid="run-result"
      >
        <SectionHeading id="result-heading" title="最终结果" subtitle={detail.run.status} />
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
    </article>
  );
}

function Workflow({ currentStage, status }: { currentStage: string; status: string }) {
  const currentIndex = WORKFLOW.findIndex(([stage]) => stage === currentStage);
  return (
    <ol className="workflow" aria-label="Run workflow">
      {WORKFLOW.map(([stage, label], index) => {
        const state =
          status === "FAILED" || status === "CANCELLED" || status === "TIMED_OUT"
            ? stage === currentStage
              ? "current"
              : index < currentIndex
                ? "done"
                : "future"
            : index < currentIndex
              ? "done"
              : index === currentIndex
                ? "current"
                : "future";
        return (
          <li className={`workflow-step workflow-step--${state}`} key={stage}>
            <span>{index + 1}</span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );
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

function StatusBadge({ value }: { value: string }) {
  return <span className={`status status--${value.toLowerCase()}`}>{value}</span>;
}

function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <pre className="code-block">{formatJson(value)}</pre>
    </details>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

function streamLabel(state: StreamState): string {
  const labels: Record<StreamState, string> = {
    idle: "未连接",
    "loading-history": "载入历史",
    connecting: "连接中",
    live: "SSE 实时",
    retrying: "断线重连",
    closed: "已结束",
  };
  return labels[state];
}
