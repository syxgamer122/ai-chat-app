/**
 * Fanout Contract & Frozen Validation — Hợp đồng song song hoá (Oh My Hermes port).
 *
 * Nguyên tắc:
 * 1. Propose -> LLM đề xuất chia nhỏ bài toán thành các unit.
 * 2. Freeze -> Kiểm tra tất định nghiêm ngặt:
 *    - Chồng lấn file_scope mà không có depends_on là LỖI CỨNG (Hard Error).
 *    - Chu trình phụ thuộc (Cycle dependency) là LỖI CỨNG.
 *    - Chia > 4 units mà thiếu spawn_plan hợp lệ (<= 280 ký tự/mục) là LỖI CỨNG.
 * 3. Typed Unit Result 4 trạng thái: processExited / schemaValid / verificationObserved / integrationReady.
 * 4. Dispatch không bao giờ tự tiện merge; chỉ cung cấp mergeOrder tất định.
 */

export interface UnitContract {
  id: string;
  title: string;
  owner: 'subagent' | 'maestro-cli';
  fileScope: string[]; // glob pattern hoặc đường dẫn file
  dependsOn: string[]; // danh sách id các unit phải hoàn thành trước
  doneCriteria: string[]; // tiêu chí số hóa
  verification?: {
    command: string;
  };
}

export interface SpawnPlan {
  why_parallel: string;
  why_not_single_unit: string;
  independence: string;
  expected_evidence_shape: string;
}

export interface FanoutContract {
  id: string;
  goalDigest: string;
  baseRevision: string;
  units: UnitContract[];
  mergeOrder: string[];
  spawnPlan?: SpawnPlan;
  safetyProfileRevision: string;
}

export interface UnitResult {
  unitId: string;
  processExited: boolean;
  schemaValid: boolean;
  verificationObserved: boolean;
  integrationReady: boolean;
  evidence: 'not_observed' | 'running' | 'reported_done' | 'verified' | 'blocked';
  telemetry: {
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number | 'unknown';
    elapsedSec: number;
  };
  retry?: {
    attempts: number;
    stoppedBecause:
      | 'terminal'
      | 'retries_exhausted'
      | 'surfaced_for_continuation'
      | 'spawn_ceiling_reached'
      | 'interrupted';
  };
}

/**
 * Kiểm tra xem 2 glob / file pattern có nguy cơ chồng lấn hay không.
 */
function scopesOverlap(scopeA: string[], scopeB: string[]): boolean {
  for (const a of scopeA) {
    for (const b of scopeB) {
      const cleanA = a.trim().toLowerCase();
      const cleanB = b.trim().toLowerCase();
      if (cleanA === b || cleanA === '*' || cleanB === '*') return true;
      // Trùng file chính xác
      if (cleanA === cleanB) return true;
      // Trùng thư mục cha-con
      if (cleanA.startsWith(cleanB.replace('/*', '')) || cleanB.startsWith(cleanA.replace('/*', ''))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Phát hiện chu trình phụ thuộc và tính toán thứ tự merge hợp lệ (Topological Sort).
 */
export function computeTopologicalOrder(units: UnitContract[]): {
  order: string[];
  hasCycle: boolean;
} {
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  for (const u of units) {
    inDegree.set(u.id, 0);
    graph.set(u.id, []);
  }

  for (const u of units) {
    for (const dep of u.dependsOn) {
      if (graph.has(dep)) {
        graph.get(dep)!.push(u.id);
        inDegree.set(u.id, (inDegree.get(u.id) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of graph.get(current) ?? []) {
      const nextDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, nextDeg);
      if (nextDeg === 0) queue.push(neighbor);
    }
  }

  const hasCycle = order.length !== units.length;
  return { order, hasCycle };
}

/**
 * Đóng băng và kiểm tra tính hợp lệ của Fanout Contract.
 */
export function freezeContract(contract: FanoutContract): {
  ok: boolean;
  errors: string[];
  frozenContract?: FanoutContract;
} {
  const errors: string[] = [];

  // 1. Kiểm tra chu trình phụ thuộc (Cycle check)
  const { order, hasCycle } = computeTopologicalOrder(contract.units);
  if (hasCycle) {
    errors.push('Phát hiện chu trình phụ thuộc vòng (dependency cycle) giữa các unit.');
  }

  // 2. Kiểm tra chồng lấn fileScope mà không có quan hệ dependsOn
  for (let i = 0; i < contract.units.length; i++) {
    for (let j = i + 1; j < contract.units.length; j++) {
      const u1 = contract.units[i];
      const u2 = contract.units[j];

      if (scopesOverlap(u1.fileScope, u2.fileScope)) {
        const u1DependsOnU2 = u1.dependsOn.includes(u2.id);
        const u2DependsOnU1 = u2.dependsOn.includes(u1.id);

        if (!u1DependsOnU2 && !u2DependsOnU1) {
          errors.push(
            `Xung đột phạm vi file: Unit "${u1.id}" và "${u2.id}" cùng chạm vào file nhưng không khai báo quan hệ dependsOn.`,
          );
        }
      }
    }
  }

  // 3. Kiểm tra Spawn Plan khi chia > 4 units
  if (contract.units.length > 4) {
    const plan = contract.spawnPlan;
    if (!plan) {
      errors.push('Bắt buộc phải có SpawnPlan khi chia việc trên 4 units.');
    } else {
      const fields: Array<keyof SpawnPlan> = [
        'why_parallel',
        'why_not_single_unit',
        'independence',
        'expected_evidence_shape',
      ];
      for (const f of fields) {
        const val = plan[f]?.trim();
        if (!val) {
          errors.push(`SpawnPlan thiếu trường bắt buộc: "${f}".`);
        } else if (val.includes('\n') || val.includes('\r')) {
          errors.push(`Trường "${f}" trong SpawnPlan phải là đúng 1 dòng (không chứa ký tự xuống dòng).`);
        } else if (val.length > 280) {
          errors.push(`Trường "${f}" trong SpawnPlan vượt quá giới hạn 280 ký tự (${val.length}).`);
        } else if (val.length < 3 || /^(todo|tbd|n\/?a|none|abc|test|chua co|\.+|\?+)$/i.test(val)) {
          errors.push(`Trường "${f}" trong SpawnPlan không được trả lời nửa vời hoặc mang tính chiếu lệ.`);
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    frozenContract: {
      ...contract,
      mergeOrder: order,
    },
  };
}
