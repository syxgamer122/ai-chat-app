"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Zap, CheckCircle2, XCircle, Loader2 } from "lucide-react";

export interface SubagentAnnotation {
  subagent: {
    phase: "start" | "progress" | "done" | "error";
    task?: string;
    turn?: number;
    maxTurns?: number;
    toolCalls?: number;
    result?: string;
    error?: string;
  };
}

interface SubagentCardProps {
  annotation: SubagentAnnotation;
}

export function SubagentCard({ annotation }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { phase, task, turn, maxTurns, toolCalls, result, error } = annotation.subagent;

  const isRunning = phase === "start" || phase === "progress";
  const isDone = phase === "done";
  const isError = phase === "error";

  const statusColor = isRunning
    ? "text-blue-600 dark:text-blue-400"
    : isDone
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-red-600 dark:text-red-400";

  const StatusIcon = isRunning ? Loader2 : isDone ? CheckCircle2 : XCircle;

  return (
    <div className="my-2 rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900/50 text-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/50 rounded-lg transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
        )}
        <Zap className={`h-3.5 w-3.5 ${statusColor}`} />
        <span className={`font-medium ${statusColor}`}>
          Subagent
        </span>
        {isRunning && (
          <StatusIcon className="h-3.5 w-3.5 animate-spin text-blue-500" />
        )}
        {!isRunning && (
          <StatusIcon className={`h-3.5 w-3.5 ${statusColor}`} />
        )}
        <span className="ml-auto text-xs text-zinc-500">
          {turn != null && maxTurns != null && `${turn}/${maxTurns} turns`}
          {toolCalls != null && ` · ${toolCalls} tools`}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-700 space-y-1">
          {task && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium">Task:</span> {task}
            </p>
          )}
          {result && (
            <p className="text-xs text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap">
              <span className="font-medium">Result:</span> {result}
            </p>
          )}
          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">
              <span className="font-medium">Error:</span> {error}
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
