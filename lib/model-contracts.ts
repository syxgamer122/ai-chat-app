/**
 * Model Contracts — đặc tả hợp đồng theo exact model ID.
 *
 * Khác với metadata chung chung từ /v1/models, hợp đồng quy định:
 * - effortLadder + effortFloor: nâng mức effort lên sàn trước khi gửi tới provider
 * - unsupportedParams: loại bỏ các tham số không hợp lệ (vd temperature cho reasoning)
 * - toolCalling: xác định model cần chạy emulated tool-calling thay vì native
 * - price + sources: bảng giá niêm yết có trích dẫn nguồn cụ thể; thiếu giá trả 'unknown', không bao giờ $0.
 */

export type Effort = 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'max'] as const;

export interface PriceInfo {
  inPerMTok: number;
  outPerMTok: number;
  cachedInPerMTok?: number;
}

export interface ContractSource {
  url: string;
  readAt: string;
}

export interface ModelContract {
  id: string; // ID sau khi strip prefix (vd 'gpt-5-6-sol', 'claude-opus-5')
  effortLadder: Effort[];
  effortFloor?: Effort;
  unsupportedParams?: string[];
  toolCalling: 'native' | 'emulated-only';
  maxOutputTokens?: number;
  price?: PriceInfo;
  sources: ContractSource[];
}

/**
 * Danh sách Model Contracts đã hiệu chuẩn cho các dòng model trong Vyen.
 * Mọi giá niêm yết đều có nguồn và ngày đọc.
 */
export const MODEL_CONTRACTS: Record<string, ModelContract> = {
  'gpt-5-6-sol': {
    id: 'gpt-5-6-sol',
    effortLadder: ['medium', 'high', 'max'],
    effortFloor: 'medium',
    unsupportedParams: ['temperature', 'top_p'],
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 3.5, outPerMTok: 14.0, cachedInPerMTok: 1.75 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2026-03-01' }],
  },
  'gpt-5-6-luna': {
    id: 'gpt-5-6-luna',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    unsupportedParams: ['temperature', 'top_p'],
    toolCalling: 'native',
    maxOutputTokens: 32768,
    price: { inPerMTok: 1.2, outPerMTok: 4.8, cachedInPerMTok: 0.6 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2026-03-01' }],
  },
  'gpt-5-4-mini': {
    id: 'gpt-5-4-mini',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.25, outPerMTok: 1.0 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2026-02-15' }],
  },
  'o1': {
    id: 'o1',
    effortLadder: ['low', 'medium', 'high', 'max'],
    effortFloor: 'medium',
    unsupportedParams: ['temperature', 'top_p'],
    toolCalling: 'native',
    maxOutputTokens: 32768,
    price: { inPerMTok: 15.0, outPerMTok: 60.0, cachedInPerMTok: 7.5 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2026-01-15' }],
  },
  'o3-mini': {
    id: 'o3-mini',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    unsupportedParams: ['temperature', 'top_p'],
    toolCalling: 'native',
    maxOutputTokens: 32768,
    price: { inPerMTok: 1.1, outPerMTok: 4.4, cachedInPerMTok: 0.55 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2026-02-01' }],
  },
  'claude-opus-5': {
    id: 'claude-opus-5',
    effortLadder: ['medium', 'high', 'max'],
    effortFloor: 'high',
    unsupportedParams: ['temperature'],
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 15.0, outPerMTok: 75.0, cachedInPerMTok: 3.75 },
    sources: [{ url: 'https://anthropic.com/pricing', readAt: '2026-03-01' }],
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 3.0, outPerMTok: 15.0, cachedInPerMTok: 1.5 },
    sources: [{ url: 'https://anthropic.com/pricing', readAt: '2026-03-01' }],
  },
  'claude-3-5-sonnet': {
    id: 'claude-3-5-sonnet',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 8192,
    price: { inPerMTok: 3.0, outPerMTok: 15.0, cachedInPerMTok: 0.3 },
    sources: [{ url: 'https://anthropic.com/pricing', readAt: '2025-10-22' }],
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 8192,
    price: { inPerMTok: 0.8, outPerMTok: 4.0, cachedInPerMTok: 0.08 },
    sources: [{ url: 'https://anthropic.com/pricing', readAt: '2025-10-22' }],
  },
  'deepseek-reasoner': {
    id: 'deepseek-reasoner',
    effortLadder: ['medium', 'high', 'max'],
    effortFloor: 'medium',
    unsupportedParams: ['temperature', 'top_p'],
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.55, outPerMTok: 2.19, cachedInPerMTok: 0.14 },
    sources: [{ url: 'https://api-docs.deepseek.com/quick_start/pricing', readAt: '2026-01-20' }],
  },
  'deepseek-v4-pro': {
    id: 'deepseek-v4-pro',
    effortLadder: ['medium', 'high', 'max'],
    effortFloor: 'medium',
    unsupportedParams: ['temperature'],
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.8, outPerMTok: 3.2, cachedInPerMTok: 0.2 },
    sources: [{ url: 'https://api-docs.deepseek.com/pricing', readAt: '2026-02-10' }],
  },
  'deepseek-chat': {
    id: 'deepseek-chat',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.14, outPerMTok: 0.28, cachedInPerMTok: 0.014 },
    sources: [{ url: 'https://api-docs.deepseek.com/quick_start/pricing', readAt: '2026-01-20' }],
  },
  'gemini-3-1-pro': {
    id: 'gemini-3-1-pro',
    effortLadder: ['low', 'medium', 'high', 'max'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 1.25, outPerMTok: 5.0, cachedInPerMTok: 0.3125 },
    sources: [{ url: 'https://ai.google.dev/pricing', readAt: '2026-03-01' }],
  },
  'gemini-3-flash': {
    id: 'gemini-3-flash',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.15, outPerMTok: 0.6, cachedInPerMTok: 0.0375 },
    sources: [{ url: 'https://ai.google.dev/pricing', readAt: '2026-03-01' }],
  },
  'qwen3.8-max': {
    id: 'qwen3.8-max',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 1.6, outPerMTok: 6.4 },
    sources: [{ url: 'https://help.aliyun.com/document_detail/dashscope_pricing', readAt: '2026-02-28' }],
  },
  'qwen3-coder-plus': {
    id: 'qwen3-coder-plus',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.8, outPerMTok: 3.2 },
    sources: [{ url: 'https://help.aliyun.com/document_detail/dashscope_pricing', readAt: '2026-02-28' }],
  },
  'kimi-k3': {
    id: 'kimi-k3',
    effortLadder: ['low', 'medium', 'high'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 1.0, outPerMTok: 3.0 },
    sources: [{ url: 'https://platform.moonshot.cn/pricing', readAt: '2026-02-15' }],
  },
  'minimax_m3': {
    id: 'minimax_m3',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.3, outPerMTok: 1.2 },
    sources: [{ url: 'https://platform.minimaxi.com/pricing', readAt: '2026-01-10' }],
  },
  'gpt-4o': {
    id: 'gpt-4o',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 2.5, outPerMTok: 10.0, cachedInPerMTok: 1.25 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2025-11-20' }],
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    effortLadder: ['low', 'medium'],
    effortFloor: 'low',
    toolCalling: 'native',
    maxOutputTokens: 16384,
    price: { inPerMTok: 0.15, outPerMTok: 0.6, cachedInPerMTok: 0.075 },
    sources: [{ url: 'https://openai.com/api/pricing', readAt: '2025-11-20' }],
  },
};

/**
 * Tách bỏ prefix provider khỏi model ID:
 * 'openai/gpt-4o' -> 'gpt-4o'
 * 'gateway:claude-3-5-sonnet' -> 'claude-3-5-sonnet'
 */
export function stripProviderPrefix(rawId: string): string {
  if (!rawId) return '';
  const trimmed = rawId.trim();
  const slashIdx = trimmed.lastIndexOf('/');
  const colonIdx = trimmed.lastIndexOf(':');
  const cutIdx = Math.max(slashIdx, colonIdx);
  return cutIdx >= 0 ? trimmed.slice(cutIdx + 1) : trimmed;
}

/**
 * Tra cứu hợp đồng cho model ID.
 * Ưu tiên:
 * 1. Match chính xác model ID (sau khi strip prefix)
 * 2. Match tiền tố chuẩn hoá (vd gpt-5-6 -> gpt-5-6-sol)
 * Trả về undefined nếu không có contract định nghĩa sẵn.
 */
export function resolveContract(modelId: string): ModelContract | undefined {
  if (!modelId) return undefined;
  const stripped = stripProviderPrefix(modelId).toLowerCase();

  // 1. Direct match
  if (MODEL_CONTRACTS[stripped]) {
    return MODEL_CONTRACTS[stripped];
  }

  // 2. Normalized aliases (. thay -)
  const normalized = stripped.replace(/\./g, '-');
  if (MODEL_CONTRACTS[normalized]) {
    return MODEL_CONTRACTS[normalized];
  }

  return undefined;
}

/** So sánh thứ tự nấc effort: low (0) -> medium (1) -> high (2) -> max (3) */
export function compareEffort(a: Effort, b: Effort): number {
  return EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b);
}

/**
 * Áp dụng trần / sàn effort theo ModelContract.
 * Nếu effort yêu cầu thấp hơn sàn -> nâng lên sàn (floor_raised).
 * Nếu effort không nằm trong ladder -> chọn mức hợp lệ gần nhất.
 */
export function enforceContractEffort(
  contract: ModelContract | undefined,
  requestedEffort: Effort,
): {
  effectiveEffort: Effort;
  changed?: { kind: 'floor_raised' | 'unsupported_dropped'; from: Effort; to: Effort };
} {
  if (!contract) return { effectiveEffort: requestedEffort };

  let target = requestedEffort;

  // 1. Check floor
  if (contract.effortFloor && compareEffort(target, contract.effortFloor) < 0) {
    const from = target;
    target = contract.effortFloor;
    return {
      effectiveEffort: target,
      changed: { kind: 'floor_raised', from, to: target },
    };
  }

  // 2. Check ladder membership
  if (contract.effortLadder.length > 0 && !contract.effortLadder.includes(target)) {
    const closest = contract.effortLadder.reduce((best, curr) =>
      Math.abs(compareEffort(curr, target)) < Math.abs(compareEffort(best, target)) ? curr : best,
    );
    const from = target;
    target = closest;
    return {
      effectiveEffort: target,
      changed: { kind: 'unsupported_dropped', from, to: target },
    };
  }

  return { effectiveEffort: target };
}

/**
 * Tính chi phí (USD) từ usage token theo giá của contract.
 * Không bao giờ trả $0 khi không có giá niêm yết — bắt buộc trả 'unknown'.
 */
export function calculateModelCost(
  modelId: string,
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedPromptTokens?: number;
  },
): number | 'unknown' {
  const contract = resolveContract(modelId);
  if (!contract?.price) return 'unknown';

  const pTokens = usage.promptTokens ?? 0;
  const cTokens = usage.completionTokens ?? 0;
  const cachedTokens = usage.cachedPromptTokens ?? 0;

  const regularPTokens = Math.max(0, pTokens - cachedTokens);

  const price = contract.price;
  const inCost = (regularPTokens / 1_000_000) * price.inPerMTok;
  const cachedCost = cachedTokens > 0 && price.cachedInPerMTok
    ? (cachedTokens / 1_000_000) * price.cachedInPerMTok
    : (cachedTokens / 1_000_000) * price.inPerMTok;
  const outCost = (cTokens / 1_000_000) * price.outPerMTok;

  const total = inCost + cachedCost + outCost;
  return Number(total.toFixed(6));
}
