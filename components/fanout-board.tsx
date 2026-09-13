'use client';

/**
 * Fanout Board — Bảng điều hành song song hoá có hợp đồng (Oh My Hermes port).
 *
 * Hiển thị:
 * - Hợp đồng Fanout (id, baseRevision, spawnPlan)
 * - Lưới các Unit độc lập kèm ranh giới fileScope, dependsOn
 * - Evidence Badge 4 mức theo thời gian thực
 * - Telemetry (tokens, cost, elapsedSec)
 * - Danh sách mergeOrder tất định (Topological sort)
 */

import React, { useState } from 'react';
import type { FanoutContract, UnitResult } from '@/lib/fanout/contract';
import { EvidenceBadge } from '@/components/evidence-badge';
import {
  Layers,
  GitBranch,
  ArrowRight,
  ShieldAlert,
  Play,
  CheckCircle2,
  X,
  FileCode,
  RotateCcw,
  Sparkles,
} from 'lucide-react';

export interface FanoutBoardProps {
  contract: FanoutContract;
  results?: Record<string, UnitResult>;
  onClose?: () => void;
  isDispatching?: boolean;
  onStartDispatch?: () => void;
  currentAdmission?: number;
}

export function FanoutBoard({
  contract,
  results = {},
  onClose,
  isDispatching = false,
  onStartDispatch,
  currentAdmission = 2,
}: FanoutBoardProps) {
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(
    contract.units[0]?.id || null,
  );

  const selectedUnit = contract.units.find((u) => u.id === selectedUnitId);
  const selectedResult = selectedUnitId ? results[selectedUnitId] : undefined;

  const completedCount = Object.values(results).filter(
    (r) => r.verificationObserved || r.evidence === 'verified',
  ).length;

  return (
    <div className="flex h-full max-h-[85vh] flex-col rounded-xl border border-zinc-200 bg-white text-xs shadow-xl dark:border-zinc-800 dark:bg-zinc-950">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-indigo-500" />
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            Fanout Board: {contract.id}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            base: {contract.baseRevision.slice(0, 8)}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">
            <span>Tiến độ:</span>
            <span className="font-bold text-indigo-600 dark:text-indigo-400">
              {completedCount}/{contract.units.length}
            </span>
            <span>• Slot: {currentAdmission}</span>
          </div>

          {onStartDispatch && (
            <button
              type="button"
              onClick={onStartDispatch}
              disabled={isDispatching}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 font-medium text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              {isDispatching ? 'Đang chạy…' : 'Chạy song song'}
            </button>
          )}

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-900"
              aria-label="Đóng bảng Fanout"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Main Content */}
      <div className="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-3">
        {/* Left: Units List */}
        <div className="overflow-y-auto border-r border-zinc-200 p-3 dark:border-zinc-800 md:col-span-1">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Danh sách Units ({contract.units.length})
          </div>
          <div className="space-y-1.5">
            {contract.units.map((unit) => {
              const res = results[unit.id];
              const evidence = res?.evidence ?? 'not_observed';
              const isSelected = selectedUnitId === unit.id;

              return (
                <button
                  key={unit.id}
                  type="button"
                  onClick={() => setSelectedUnitId(unit.id)}
                  className={`flex w-full flex-col gap-1 rounded-lg border p-2.5 text-left transition ${
                    isSelected
                      ? 'border-indigo-500/80 bg-indigo-50/50 dark:border-indigo-500/60 dark:bg-indigo-950/30'
                      : 'border-zinc-200/80 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                      {unit.id}
                    </span>
                    <EvidenceBadge
                      level={evidence === 'not_observed' ? 'prepared' : evidence}
                      size="sm"
                    />
                  </div>
                  <div className="text-[11px] text-zinc-600 dark:text-zinc-400 line-clamp-1">
                    {unit.title}
                  </div>
                  <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px] text-zinc-500">
                    <span className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">
                      {unit.owner}
                    </span>
                    {unit.dependsOn.length > 0 && (
                      <span className="text-zinc-400">
                        sau: {unit.dependsOn.join(', ')}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Center & Right: Unit Detail & Merge Order */}
        <div className="flex flex-col overflow-y-auto p-4 md:col-span-2">
          {selectedUnit ? (
            <div className="space-y-4">
              {/* Unit Header */}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                    {selectedUnit.id}: {selectedUnit.title}
                  </h3>
                  <EvidenceBadge
                    level={
                      selectedResult?.evidence === 'not_observed' || !selectedResult
                        ? 'prepared'
                        : selectedResult.evidence
                    }
                  />
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span>Owner: {selectedUnit.owner}</span>
                  <span>•</span>
                  <span>Phụ thuộc: {selectedUnit.dependsOn.length ? selectedUnit.dependsOn.join(', ') : 'Không có (Frontier)'}</span>
                </div>
              </div>

              {/* File Scope */}
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="flex items-center gap-1 font-semibold text-zinc-700 dark:text-zinc-300">
                  <FileCode className="h-3.5 w-3.5 text-zinc-500" />
                  <span>Ranh giới File (fileScope):</span>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {selectedUnit.fileScope.map((scope, idx) => (
                    <span
                      key={idx}
                      className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[10px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              </div>

              {/* Done Criteria */}
              <div className="rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
                <div className="font-semibold text-zinc-700 dark:text-zinc-300">
                  Tiêu chí hoàn thành (Done Criteria):
                </div>
                <ul className="mt-1.5 space-y-1">
                  {selectedUnit.doneCriteria.map((c, idx) => (
                    <li key={idx} className="flex items-start gap-1.5 text-zinc-600 dark:text-zinc-400">
                      <span className="text-indigo-500 font-bold">{idx + 1}.</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Telemetry & Retry */}
              {selectedResult && (
                <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-2.5 dark:border-zinc-800 dark:bg-zinc-900/30">
                  <div className="font-semibold text-zinc-700 dark:text-zinc-300">
                    Bằng chứng quan sát & Đo lường:
                  </div>
                  <div className="mt-1.5 grid grid-cols-2 gap-2 font-mono text-[11px] sm:grid-cols-4">
                    <div>
                      <span className="text-zinc-500">Tokens In:</span>{' '}
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {selectedResult.telemetry.tokensIn ?? '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500">Tokens Out:</span>{' '}
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {selectedResult.telemetry.tokensOut ?? '-'}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500">Chi phí:</span>{' '}
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {selectedResult.telemetry.costUsd === 'unknown' || selectedResult.telemetry.costUsd === undefined
                          ? 'unknown'
                          : `$${selectedResult.telemetry.costUsd.toFixed(4)}`}
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500">Thời gian:</span>{' '}
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {selectedResult.telemetry.elapsedSec.toFixed(1)}s
                      </span>
                    </div>
                  </div>

                  {selectedResult.retry && (
                    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                      <RotateCcw className="h-3 w-3" />
                      <span>
                        Đã thử lại {selectedResult.retry.attempts} lần — Lý do dừng:{' '}
                        {selectedResult.retry.stoppedBecause}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Merge Order List */}
              <div className="mt-auto border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <div className="flex items-center gap-1.5 font-semibold text-zinc-700 dark:text-zinc-300">
                  <GitBranch className="h-3.5 w-3.5 text-emerald-500" />
                  <span>Thứ tự tích hợp (Merge Order - tất định):</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {contract.mergeOrder.map((uId, idx) => {
                    const isVerified = results[uId]?.verificationObserved;
                    return (
                      <React.Fragment key={uId}>
                        <span
                          className={`flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] ${
                            isVerified
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                              : 'bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-400'
                          }`}
                        >
                          {isVerified && <CheckCircle2 className="h-2.5 w-2.5" />}
                          {uId}
                        </span>
                        {idx < contract.mergeOrder.length - 1 && (
                          <ArrowRight className="h-3 w-3 text-zinc-400" />
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-zinc-400">
              Chọn một unit để xem chi tiết
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
