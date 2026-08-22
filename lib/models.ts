export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'google' | 'gateway';
export type ModelCategory = 'general' | 'coding' | 'reasoning' | 'fast';

export interface ModelConfig {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  readonly providerModel: string;
  readonly description: string;
  readonly category: ModelCategory;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly isReasoning: boolean;
  readonly supportsTemperature: boolean;
  readonly supportsImages: boolean;
  readonly supportsPdf: boolean;
}

export const AVAILABLE_MODELS: readonly ModelConfig[] = Object.freeze([
  Object.freeze({
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    providerModel: 'claude-3-5-sonnet-20241022',
    description: 'Cân bằng tốc độ & chất lượng, lập trình và viết lách xuất sắc.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'gpt-5.6-sol',
    name: 'ChatGPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5.6-sol',
    description: 'Suy luận sâu, ngữ cảnh dài, xử lý logic toán học phức tạp.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: false,
  }),
]) as readonly ModelConfig[];

export const DEFAULT_MODEL_ID = 'claude-3-5-sonnet';

const MODEL_BY_ID: ReadonlyMap<string, ModelConfig> = new Map(
  AVAILABLE_MODELS.map((m) => [m.id, m]),
);

export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_BY_ID.keys());

/** Tra cứu tường minh — trả undefined nếu không tồn tại. Không fallback im lặng. */
export function findModelConfig(modelId: string | null | undefined): ModelConfig | undefined {
  return modelId ? MODEL_BY_ID.get(modelId) : undefined;
}

/** Fallback CÓ CHỦ Ý về DEFAULT_MODEL_ID (không phụ thuộc thứ tự mảng). */
export function getModelConfig(modelId: string | null | undefined): ModelConfig {
  const found = findModelConfig(modelId);
  if (found) return found;
  const fallback = MODEL_BY_ID.get(DEFAULT_MODEL_ID);
  if (!fallback) throw new Error(`[models] DEFAULT_MODEL_ID "${DEFAULT_MODEL_ID}" không tồn tại.`);
  if (modelId) console.warn(`[models] Model không hợp lệ "${modelId}" -> dùng ${DEFAULT_MODEL_ID}.`);
  return fallback;
}

/** Dùng ở API route để chuẩn hóa tham số theo capability của model. */
export function buildGenerationParams(
  model: ModelConfig,
  requested: { temperature?: number; maxOutputTokens?: number },
): { temperature?: number; maxOutputTokens: number } {
  return {
    temperature: model.supportsTemperature ? requested.temperature : undefined,
    maxOutputTokens: Math.min(requested.maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens),
  };
}