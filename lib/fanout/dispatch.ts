/**
 * Fanout Dispatcher — Điều phối thực thi các Unit theo hợp đồng và Dependency Frontier (Oh My Hermes port).
 *
 * Tính năng chính:
 * 1. Nối DependencyFrontierScheduler với hàm thực thi subagent / tool runner.
 * 2. Kỷ luật Retry nghiêm ngặt: chỉ retry khi lỗi là transient VÀ probe replay-safe.
 * 3. Typed Unit Result 4 trạng thái: processExited / schemaValid / verificationObserved / integrationReady.
 * 4. Hỗ trợ abort/interruption trung thực (Ctrl-C / cancel) trả về trạng thái interrupted.
 */

import {
  type FanoutContract,
  type UnitContract,
  type UnitResult,
  freezeContract,
} from '@/lib/fanout/contract';
import { DependencyFrontierScheduler } from '@/lib/fanout/scheduler';
import {
  classifyFailure,
  probeReplaySafety,
  computeBackoffMs,
  type ReplayProbeState,
} from '@/lib/fanout/retry';

export type FanoutDispatchEventType =
  | 'contract_started'
  | 'unit_scheduled'
  | 'unit_running'
  | 'unit_retrying'
  | 'unit_completed'
  | 'unit_failed'
  | 'fanout_progress'
  | 'contract_completed'
  | 'contract_interrupted';

export interface FanoutDispatchEvent {
  type: FanoutDispatchEventType;
  timestamp: number;
  contractId: string;
  unitId?: string;
  result?: UnitResult;
  error?: string;
  stats?: {
    completed: number;
    failed: number;
    running: number;
    pending: number;
    admission: number;
  };
  mergeOrder?: string[];
}

export interface UnitExecutionResult {
  success: boolean;
  exitCode?: number;
  stdoutTail?: string;
  error?: unknown;
  probeState?: ReplayProbeState;
  telemetry?: {
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number | 'unknown';
    elapsedSec: number;
  };
}

export interface DispatchOptions {
  contract: FanoutContract;
  executeUnit: (unit: UnitContract, attempt: number) => Promise<UnitExecutionResult>;
  onEvent?: (event: FanoutDispatchEvent) => void;
  initialConcurrency?: number;
  maxConcurrency?: number;
  maxRetries?: number;
  maxSpawns?: number;
  fanoutDepth?: number;
  baseBackoffMs?: number;
  signal?: AbortSignal;
}

export interface DispatchSummary {
  contractId: string;
  success: boolean;
  interrupted: boolean;
  results: Record<string, UnitResult>;
  mergeOrder: string[];
  totalUnits: number;
  completedUnits: number;
  failedUnits: number;
}

/**
 * Thực thi một Fanout Contract đầy đủ.
 */
export async function dispatchFanout(options: DispatchOptions): Promise<DispatchSummary> {
  const {
    contract,
    executeUnit,
    onEvent,
    initialConcurrency = 2,
    maxConcurrency = 5,
    maxRetries = 2,
    maxSpawns = 60,
    fanoutDepth,
    baseBackoffMs,
    signal,
  } = options;

  // 0. Spawn Guard: Chặn fanout lồng nhau (OMH_FANOUT_DEPTH)
  const currentDepth = Number(fanoutDepth ?? process.env.OMH_FANOUT_DEPTH ?? 1);
  if (currentDepth > 1) {
    throw new Error('fanout_depth_exceeded: Dispatch lồng nhau bị từ chối trước khi tạo subprocess.');
  }

  // 1. Freeze & Validate contract trước khi dispatch
  const freezeRes = freezeContract(contract);
  if (!freezeRes.ok || !freezeRes.frozenContract) {
    throw new Error(`Fanout Contract không hợp lệ: ${freezeRes.errors.join('; ')}`);
  }
  const frozen = freezeRes.frozenContract;

  const scheduler = new DependencyFrontierScheduler(frozen, {
    initialConcurrency,
    maxConcurrency,
  });

  const results: Record<string, UnitResult> = {};
  for (const u of frozen.units) {
    results[u.id] = {
      unitId: u.id,
      processExited: false,
      schemaValid: true,
      verificationObserved: false,
      integrationReady: false,
      evidence: 'not_observed',
      telemetry: { elapsedSec: 0 },
    };
  }

  const emit = (event: FanoutDispatchEvent) => {
    if (onEvent) {
      try {
        onEvent(event);
      } catch (err) {
        console.error('[fanout dispatch event error]', err);
      }
    }
  };

  emit({
    type: 'contract_started',
    timestamp: Date.now(),
    contractId: frozen.id,
    mergeOrder: frozen.mergeOrder,
    stats: {
      completed: 0,
      failed: 0,
      running: 0,
      pending: frozen.units.length,
      admission: scheduler.getAdmission(),
    },
  });

  let interrupted = false;
  let totalSpawns = 0;
  const runningPromises = new Map<string, Promise<void>>();

  // Hàm thực thi một unit (có retry loop tuân thủ kỷ luật OMH)
  const runUnit = async (unit: UnitContract) => {
    let attempt = 0;
    let unitDone = false;

    emit({
      type: 'unit_running',
      timestamp: Date.now(),
      contractId: frozen.id,
      unitId: unit.id,
    });
    results[unit.id].evidence = 'running';

    while (!unitDone && !interrupted) {
      if (signal?.aborted) {
        interrupted = true;
        break;
      }

      // Kiểm tra trần spawn của toàn bộ run (Spawn Ceiling Guard)
      if (totalSpawns >= maxSpawns) {
        results[unit.id] = {
          unitId: unit.id,
          processExited: false,
          schemaValid: true,
          verificationObserved: false,
          integrationReady: false,
          evidence: 'blocked',
          telemetry: { elapsedSec: 0 },
          retry: {
            attempts: attempt,
            stoppedBecause: 'spawn_ceiling_reached',
          },
        };
        scheduler.reportFailure(unit.id);
        unitDone = true;

        emit({
          type: 'unit_failed',
          timestamp: Date.now(),
          contractId: frozen.id,
          unitId: unit.id,
          result: results[unit.id],
          error: 'spawn_ceiling_reached: Đã đạt trần tổng số lần spawn tối đa của lượt chạy.',
        });
        break;
      }

      totalSpawns++;
      attempt++;
      const startTime = Date.now();
      let execRes: UnitExecutionResult;

      try {
        execRes = await executeUnit(unit, attempt);
      } catch (err) {
        execRes = {
          success: false,
          error: err,
          telemetry: { elapsedSec: (Date.now() - startTime) / 1000 },
        };
      }

      const elapsedSec = (Date.now() - startTime) / 1000;
      const telemetry = {
        tokensIn: execRes.telemetry?.tokensIn,
        tokensOut: execRes.telemetry?.tokensOut,
        costUsd: execRes.telemetry?.costUsd ?? 'unknown',
        elapsedSec,
      };

      if (execRes.success && execRes.exitCode === 0) {
        // Thành công sạch
        results[unit.id] = {
          unitId: unit.id,
          processExited: true,
          schemaValid: true,
          verificationObserved: true,
          integrationReady: true,
          evidence: 'verified',
          telemetry,
          retry: attempt > 1 ? { attempts: attempt, stoppedBecause: 'terminal' } : undefined,
        };
        scheduler.reportSuccess(unit.id);
        unitDone = true;

        emit({
          type: 'unit_completed',
          timestamp: Date.now(),
          contractId: frozen.id,
          unitId: unit.id,
          result: results[unit.id],
        });
        break;
      }

      // Thất bại: kiểm tra phân loại lỗi
      const failureClass = classifyFailure(execRes.error, execRes.exitCode);
      if (failureClass.category === 'rate_limit') {
        scheduler.reportRateLimit(unit.id);
      }

      // Kiểm tra tính an toàn để retry (Replay Safety Probe)
      const probe = probeReplaySafety(execRes.probeState ?? { filesModified: 0, bytesWritten: 0 });
      const canRetry = failureClass.isTransient && probe.replaySafe && attempt <= maxRetries;

      if (canRetry && !signal?.aborted) {
        const backoffMs = computeBackoffMs(attempt, baseBackoffMs);
        emit({
          type: 'unit_retrying',
          timestamp: Date.now(),
          contractId: frozen.id,
          unitId: unit.id,
          error: `${failureClass.reason} Thử lại lần ${attempt + 1}/${maxRetries + 1} sau ${backoffMs}ms...`,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // Terminal failure
      results[unit.id] = {
        unitId: unit.id,
        processExited: execRes.exitCode !== undefined,
        schemaValid: true,
        verificationObserved: false,
        integrationReady: false,
        evidence: failureClass.category === 'permission' ? 'blocked' : 'reported_done',
        telemetry,
        retry: {
          attempts: attempt,
          stoppedBecause:
            attempt > maxRetries && failureClass.isTransient && probe.replaySafe
              ? 'retries_exhausted'
              : 'terminal',
        },
      };
      scheduler.reportFailure(unit.id);
      unitDone = true;

      emit({
        type: 'unit_failed',
        timestamp: Date.now(),
        contractId: frozen.id,
        unitId: unit.id,
        result: results[unit.id],
        error: failureClass.reason,
      });
      break;
    }
  };

  // Vòng lặp điều phối chính dọc theo Dependency Frontier
  while (!scheduler.isDone() && !interrupted) {
    if (signal?.aborted) {
      interrupted = true;
      break;
    }

    const readyUnits = scheduler.pullReadyUnits();
    for (const unit of readyUnits) {
      emit({
        type: 'unit_scheduled',
        timestamp: Date.now(),
        contractId: frozen.id,
        unitId: unit.id,
      });

      const p = runUnit(unit).finally(() => {
        runningPromises.delete(unit.id);
      });
      runningPromises.set(unit.id, p);
    }

    if (runningPromises.size > 0) {
      // Chờ ít nhất một unit hoàn thành trước khi kéo tiếp các frontier units tiếp theo
      await Promise.race(runningPromises.values());
    } else if (!scheduler.isDone()) {
      // Không còn ready units nào kéo được (có thể do cascade failure)
      break;
    }

    const stat = scheduler.getStatus();
    emit({
      type: 'fanout_progress',
      timestamp: Date.now(),
      contractId: frozen.id,
      stats: {
        completed: stat.completed.length,
        failed: stat.failed.length,
        running: stat.running.length,
        pending: stat.pending.length,
        admission: stat.admission,
      },
    });
  }

  // Chờ các unit đang chạy dở hoàn thành nếu chưa bị abort
  if (runningPromises.size > 0) {
    await Promise.allSettled(runningPromises.values());
  }

  if (interrupted || signal?.aborted) {
    for (const u of frozen.units) {
      if (results[u.id].evidence === 'not_observed' || results[u.id].evidence === 'running') {
        results[u.id].evidence = 'blocked';
        results[u.id].retry = { attempts: 1, stoppedBecause: 'interrupted' };
      }
    }
    emit({
      type: 'contract_interrupted',
      timestamp: Date.now(),
      contractId: frozen.id,
    });
  } else {
    emit({
      type: 'contract_completed',
      timestamp: Date.now(),
      contractId: frozen.id,
      mergeOrder: frozen.mergeOrder,
    });
  }

  const completedUnits = Object.values(results).filter((r) => r.verificationObserved).length;
  const failedUnits = Object.values(results).filter((r) => !r.verificationObserved).length;

  return {
    contractId: frozen.id,
    success: completedUnits === frozen.units.length && !interrupted,
    interrupted,
    results,
    mergeOrder: frozen.mergeOrder,
    totalUnits: frozen.units.length,
    completedUnits,
    failedUnits,
  };
}
