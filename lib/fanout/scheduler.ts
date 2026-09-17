/**
 * Fanout Scheduler — Bộ lập lịch Frontier dựa trên DAG phụ thuộc và điều phối lưu lượng thích ứng.
 *
 * Tính năng chính:
 * 1. Dependency-Frontier: Một unit được kích hoạt NGAY KHI mọi unit phụ thuộc (dependsOn) hoàn thành,
 *    không bắt buộc phải chờ toàn bộ "đợt" (wave barrier).
 * 2. Adaptive Admission Concurrency:
 *    - Bắt đầu ở cửa sổ 2 slot.
 *    - Mỗi lần hoàn thành sạch: admission = min(admission + 1, maxConcurrency).
 *    - Khi gặp áp lực rate-limit: admission = max(1, floor(admission / 2)).
 *    - Việc thu hẹp cửa sổ KHÔNG hủy các unit đang chạy.
 */

import type { FanoutContract, UnitContract } from '@/lib/fanout/contract';

export interface SchedulerOptions {
  initialConcurrency?: number;
  maxConcurrency?: number;
}

export interface UnitExecutionEvent {
  type: 'unit_started' | 'unit_completed' | 'unit_rate_limited' | 'unit_failed';
  unitId: string;
  timestamp: number;
}

export class DependencyFrontierScheduler {
  private contract: FanoutContract;
  private maxConcurrency: number;
  private currentAdmission: number;

  private completedUnits = new Set<string>();
  private failedUnits = new Set<string>();
  private runningUnits = new Set<string>();
  private pendingUnits: Map<string, UnitContract>;

  private eventLog: UnitExecutionEvent[] = [];

  constructor(contract: FanoutContract, options?: SchedulerOptions) {
    this.contract = contract;
    this.maxConcurrency = Math.min(8, options?.maxConcurrency ?? 5);
    this.currentAdmission = Math.min(
      this.maxConcurrency,
      Math.max(1, options?.initialConcurrency ?? 2),
    );

    this.pendingUnits = new Map();
    for (const u of contract.units) {
      this.pendingUnits.set(u.id, u);
    }
  }

  public getAdmission(): number {
    return this.currentAdmission;
  }

  public getRunningCount(): number {
    return this.runningUnits.size;
  }

  public isDone(): boolean {
    return this.pendingUnits.size === 0 && this.runningUnits.size === 0;
  }

  /**
   * Lấy các unit sẵn sàng chạy (tất cả dependsOn đã completed và còn slot admission).
   */
  public pullReadyUnits(): UnitContract[] {
    const readyToDispatch: UnitContract[] = [];

    for (const [id, unit] of this.pendingUnits.entries()) {
      if (this.runningUnits.size + readyToDispatch.length >= this.currentAdmission) {
        break;
      }

      // Kiểm tra xem tất cả phụ thuộc đã pass chưa
      const allDepsMet = unit.dependsOn.every((dep) => this.completedUnits.has(dep));
      const hasFailedDep = unit.dependsOn.some((dep) => this.failedUnits.has(dep));

      if (hasFailedDep) {
        // Một phụ thuộc bị hỏng -> unit này bị cascade fail
        this.pendingUnits.delete(id);
        this.failedUnits.add(id);
        this.eventLog.push({
          type: 'unit_failed',
          unitId: id,
          timestamp: Date.now(),
        });
        continue;
      }

      if (allDepsMet) {
        readyToDispatch.push(unit);
      }
    }

    // Đánh dấu running
    for (const u of readyToDispatch) {
      this.pendingUnits.delete(u.id);
      this.runningUnits.add(u.id);
      this.eventLog.push({
        type: 'unit_started',
        unitId: u.id,
        timestamp: Date.now(),
      });
    }

    return readyToDispatch;
  }

  /**
   * Báo cáo hoàn thành một unit sạch sẽ -> mở rộng cửa sổ admission.
   */
  public reportSuccess(unitId: string): void {
    this.runningUnits.delete(unitId);
    this.completedUnits.add(unitId);

    // Tăng dần cửa sổ admission sau mỗi completion sạch (+1)
    this.currentAdmission = Math.min(this.currentAdmission + 1, this.maxConcurrency);

    this.eventLog.push({
      type: 'unit_completed',
      unitId,
      timestamp: Date.now(),
    });
  }

  /**
   * Báo cáo gặp áp lực rate-limit -> thu hẹp cửa sổ admission xuống một nửa.
   */
  public reportRateLimit(unitId: string): void {
    // Chia đôi cửa sổ admission, sàn là 1
    this.currentAdmission = Math.max(1, Math.floor(this.currentAdmission / 2));

    this.eventLog.push({
      type: 'unit_rate_limited',
      unitId,
      timestamp: Date.now(),
    });
  }

  /**
   * Báo cáo thất bại terminal của unit.
   */
  public reportFailure(unitId: string): void {
    this.runningUnits.delete(unitId);
    this.failedUnits.add(unitId);

    this.eventLog.push({
      type: 'unit_failed',
      unitId,
      timestamp: Date.now(),
    });
  }

  public getStatus(): {
    completed: string[];
    failed: string[];
    running: string[];
    pending: string[];
    admission: number;
  } {
    return {
      completed: [...this.completedUnits],
      failed: [...this.failedUnits],
      running: [...this.runningUnits],
      pending: [...this.pendingUnits.keys()],
      admission: this.currentAdmission,
    };
  }
}
