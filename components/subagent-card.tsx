"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { EvidenceBadge } from "@/components/evidence-badge";

export interface SubagentAnnotation {
  subagent: {
    phase: "start" | "progress" | "done" | "error";
    task?: string;
    turn?: number;
    maxTurns?: number;
    toolCalls?: number;
    result?: string;
    error?: string;
    /** Metadata mới từ executeDelegate — batch song song gắn nhãn lane. */
    runId?: string;
    mode?: "scout" | "worker";
    taskIndex?: number;
    taskTotal?: number;
    evidenceLevel?: "prepared" | "running" | "reported_done" | "verified" | "blocked" | "failed";
  };
}

interface SubagentCardProps {
  annotation: SubagentAnnotation;
}

export function SubagentCard({ annotation }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { phase, task, turn, maxTurns, toolCalls, result, error, runId, mode, taskIndex, taskTotal, evidenceLevel } =
    annotation.subagent;

  const isRunning = phase === "start" || phase === "progress";
  const isDone = phase === "done";
  const isError = phase === "error";

  const subagentEvidence = evidenceLevel ?? (
    isRunning
      ? "running"
      : isDone
        ? (result?.toLowerCase().includes("verified") || result?.toLowerCase().includes("test pass") ? "verified" : "reported_done")
        : "failed"
  );

  const statusColor = isRunning
    ? "text-accent-steel"
    : isDone
      ? "text-status-success"
      : "text-status-error";

  // Một icon duy nhất mang trạng thái thật (spin = đang chạy)
  const StatusIcon = isRunning ? Loader2 : isDone ? CheckCircle2 : XCircle;

  return (
    <div className="my-2 rounded-none border border-border-hairline bg-panel-bg font-mono text-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised rounded-none transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
        )}
        <StatusIcon
          className={`h-3.5 w-3.5 flex-shrink-0 ${statusColor} ${
            isRunning ? "animate-spin" : ""
          }`}
        />
        <span className={`font-semibold ${statusColor}`}>
          Subagent
        </span>
        <EvidenceBadge level={subagentEvidence} className="ml-1" />
        {mode === "scout" && (
          <span className="text-[11px] text-text-muted">· scout</span>
        )}
        {taskIndex != null && taskTotal != null && (
          <span className="text-[11px] text-text-muted">
            {taskIndex + 1}/{taskTotal}
          </span>
        )}
        {runId && (
          <span className="text-[11px] text-text-muted">#{runId.slice(0, 6)}</span>
        )}
        <span className="ml-auto text-[11px] text-text-muted">
          {turn != null && maxTurns != null && `${turn}/${maxTurns} turns`}
          {toolCalls != null && ` · ${toolCalls} tools`}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border-hairline bg-surface-raised px-3 py-2 space-y-1">
          {task && (
            <p className="text-[11.5px] text-text-primary">
              <span className="font-semibold text-accent-steel">Task:</span> {task}
            </p>
          )}
          {result && (
            <p className="text-[11.5px] text-text-muted whitespace-pre-wrap">
              <span className="font-semibold text-status-success">Result:</span> {result}
            </p>
          )}
          {error && (
            <p className="text-[11.5px] text-status-error">
              <span className="font-semibold">Error:</span> {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Extract subagent annotations from a message's annotations array.
 */
export function getSubagentAnnotations(
  annotations: unknown[] | undefined,
): SubagentAnnotation[] {
  if (!annotations) return [];
  return annotations.filter(
    (ann): ann is SubagentAnnotation =>
      typeof ann === "object" &&
      ann !== null &&
      "subagent" in ann &&
      typeof (ann as Record<string, unknown>).subagent === "object",
  );
}
