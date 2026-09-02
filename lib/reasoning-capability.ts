/**
 * Reasoning capability — đọc metadata suy luận của model từ /v1/models theo
 * chuẩn OpenRouter (port từ prime-agent `openrouter-reasoning.ts`, MIT,
 * lược về bộ 4 mức của Vyen).
 *
 * Vấn đề: thinking slider trước giờ chỉ có tác dụng trên crax
 * (`supportsThinkingLevel` là regex hostname) — với OrcaRouter/Tokenin tham
 * số bị route bỏ qua. Metadata kiểu OpenRouter khai báo per-model:
 * `supported_parameters` chứa "reasoning" và object `reasoning` gồm
 * `mandatory` + `supported_efforts` → biết chính xác model nào nhận mức nào.
 *
 * File này THUẦN, không import runtime gì ngoài type — dùng được cả client
 * lẫn edge route.
 */

import type { ThinkingLevel } from '@/lib/provider-url';

export interface ReasoningCapability {
  /**
   * Các mức của Vyen (low/medium/high/max) mà model khai báo hỗ trợ.
   * Mảng rỗng = model chỉ bật/tắt suy luận (không chọn được mức) — gửi mức
   * nào cũng được, gateway tự dịch.
   */
  efforts: ThinkingLevel[];
  /** Model BẮT BUỘC suy luận — không có chế độ tắt. */
  mandatory: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VYEN_LEVELS: readonly ThinkingLevel[] = ['low', 'medium', 'high', 'max'];

/**
 * Phân tích một entry model từ response /v1/models.
 * Trả null khi không khai báo hỗ trợ reasoning (hoặc dữ liệu không đọc được)
 * — caller giữ hành vi cũ cho model đó.
 */
export function parseModelReasoning(item: unknown): ReasoningCapability | null {
  if (!isRecord(item)) return null;

  const supportedParameters = Array.isArray(item.supported_parameters)
    ? item.supported_parameters
    : [];
  if (!supportedParameters.includes('reasoning')) return null;
  if (!isRecord(item.reasoning)) return null;

  const mandatory = item.reasoning.mandatory === true;
  const rawEfforts = item.reasoning.supported_efforts;

  // supported_efforts === null: hỗ trợ MỌI mức chuẩn → map đủ 4 mức Vyen.
  if (rawEfforts === null) {
    return { efforts: [...VYEN_LEVELS], mandatory };
  }

  if (Array.isArray(rawEfforts)) {
    const lowered = new Set(
      rawEfforts.filter((e): e is string => typeof e === 'string').map((e) => e.toLowerCase()),
    );
    const efforts = VYEN_LEVELS.filter((level) => lowered.has(level));
    // Khai báo có reasoning nhưng không khớp mức nào của Vyen (vd chỉ
    // "minimal"/"xhigh") → coi như toggle-only: gửi mức nào cũng dịch được.
    return { efforts, mandatory };
  }

  // Có object reasoning nhưng KHÔNG khai báo efforts (undefined/kiểu lạ):
  // semantics prime-agent — chỉ bật/tắt, không chọn được mức.
  return { efforts: [], mandatory };
}

/** true nếu `candidate` là mức gần `requested` nhất trong danh sách hỗ trợ. */
function distance(a: ThinkingLevel, b: ThinkingLevel): number {
  return Math.abs(VYEN_LEVELS.indexOf(a) - VYEN_LEVELS.indexOf(b));
}

/**
 * Chọn mức sẽ gửi upstream: đúng mức yêu cầu nếu được hỗ trợ, ngược lại mức
 * GẦN NHẤT theo thang low→max. Toggle-only (efforts rỗng) hoặc danh sách trống
 * → gửi nguyên mức yêu cầu.
 */
export function resolveNearestEffort(
  requested: ThinkingLevel,
  cap: ReasoningCapability | null | undefined,
): ThinkingLevel {
  if (!cap || cap.efforts.length === 0) return requested;
  if (cap.efforts.includes(requested)) return requested;
  // Mức gần requested hơn thì thắng; hòa nhau giữ mức đứng TRƯỚC trong danh sách.
  return cap.efforts.reduce((best, level) =>
    distance(level, requested) < distance(best, requested) ? level : best,
  );
}
