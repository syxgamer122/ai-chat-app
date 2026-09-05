"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Loader2 } from "lucide-react";

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
    ? "text-[#6a9fcc]"
    : isDone
      ? "text-[#5db87a]"
      : "text-[#e8704f]";

  // Một icon duy nhất mang trạng thái thật (spin = đang chạy), thay vì
  // icon trang trí + icon trạng thái trùng lặp
  const StatusIcon = isRunning ? Loader2 : isDone ? CheckCircle2 : XCircle;

  return (
    <div className="my-2 rounded-none border border-[#495059] bg-[#212730] font-mono text-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[#161d27] rounded-none transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[#9fa4ab]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[#9fa4ab]" />
        )}
        <StatusIcon
          className={`h-3.5 w-3.5 flex-shrink-0 ${statusColor} ${
            isRunning ? "animate-spin" : ""
          }`}
        />
        <span className={`font-semibold ${statusColor}`}>
          Subagent
        </span>
        <span className="ml-auto text-[11px] text-[#9fa4ab]">
          {turn != null && maxTurns != null && `${turn}/${maxTurns} turns`}
          {toolCalls != null && ` · ${toolCalls} tools`}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[#495059] bg-[#161d27] px-3 py-2 space-y-1">
          {task && (
            <p className="text-[11.5px] text-[#ebe7e4]">
              <span className="font-semibold text-[#6a9fcc]">Task:</span> {task}
            </p>
          )}
          {result && (
            <p className="text-[11.5px] text-[#9fa4ab] whitespace-pre-wrap">
              <span className="font-semibold text-[#5db87a]">Result:</span> {result}
            </p>
          )}
          {error && (
            <p className="text-[11.5px] text-[#e8704f]">
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
