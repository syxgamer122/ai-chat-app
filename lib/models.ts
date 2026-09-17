export type ProviderId = 'openai';
export type ModelCategory = 'general' | 'coding' | 'reasoning' | 'fast' | 'media';

/** Model sinh media: route /api/chat đi đường riêng (images API / SSE type:video). */
export type MediaKind = 'image' | 'video';

export interface ModelConfig {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderId;
  /** Tên gửi lên upstream (thử đầu tiên). */
  readonly providerModel: string;
  /** Các tên thay thế khi upstream trả 404 / model_not_found. */
  readonly providerModelFallbacks: readonly string[];
  readonly description: string;
  readonly category: ModelCategory;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly isReasoning: boolean;
  readonly supportsTemperature: boolean;
  readonly supportsImages: boolean;
  readonly supportsPdf: boolean;
  /** Có mặt = model sinh ảnh/video, không phải model chat. */
  readonly media?: MediaKind;
}

type ModelInput = Omit<ModelConfig, 'providerModelFallbacks'> & {
  providerModelFallbacks?: readonly string[];
};

const def = (m: ModelInput): ModelConfig =>
  Object.freeze({ providerModelFallbacks: [], ...m }) as ModelConfig;

/**
 * Danh mục model OpenAI chính thức (gọi qua provider BYOK của người dùng).
 *
 * Tầng gateway miễn phí dùng chung  đã bị gỡ hẳn: mọi lượt
 * LLM giờ đi qua provider active của người dùng (header x-api-key/x-api-base)
 * hoặc key dán trong Cài đặt cho model OpenAI chính gốc.
 */
export const AVAILABLE_MODELS: readonly ModelConfig[] = Object.freeze([
  def({
    id: 'chatgpt-4o-latest',
    name: 'ChatGPT-4o Latest',
    provider: 'openai',
    providerModel: 'chatgpt-4o-latest',
    providerModelFallbacks: ['gpt-4o'],
    description: 'Mô hình đa phương thức hàng đầu, xử lý xuất sắc văn bản, hình ảnh.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    providerModel: 'gpt-4o',
    providerModelFallbacks: ['gpt-4o-2024-11-20', 'chatgpt-4o-latest'],
    description: 'Phiên bản tiêu chuẩn của GPT-4o, tối ưu cho xử lý đa tác vụ.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    providerModel: 'gpt-4o-mini',
    providerModelFallbacks: ['gpt-4o-mini-2024-07-18'],
    description: 'Bản thu nhỏ siêu nhanh và tiết kiệm chi phí, phù hợp tác vụ hàng ngày.',
    category: 'fast',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'openai',
    providerModel: 'o1',
    providerModelFallbacks: ['o1-preview', 'o3-mini'],
    description: 'Mô hình suy luận sâu cấp độ tiến sĩ của OpenAI.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'o1-mini',
    name: 'OpenAI o1-mini',
    provider: 'openai',
    providerModel: 'o1-mini',
    providerModelFallbacks: ['o3-mini'],
    description: 'Bản tinh gọn suy luận logic và lập trình nhanh.',
    category: 'fast',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'openai',
    providerModel: 'o3-mini',
    providerModelFallbacks: ['o1-mini'],
    description: 'Thế hệ mô hình suy luận tốc độ cao mới nhất từ OpenAI.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
]) as readonly ModelConfig[];

export const DEFAULT_MODEL_ID = 'gpt-4o';

const MODEL_BY_ID: ReadonlyMap<string, ModelConfig> = new Map(
  AVAILABLE_MODELS.map((m) => [m.id, m]),
);

/** Cho phép client cũ gửi providerModel thay vì id mà vẫn resolve đúng. */
const MODEL_BY_PROVIDER_NAME: ReadonlyMap<string, ModelConfig> = (() => {
  const map = new Map<string, ModelConfig>();
  for (const m of AVAILABLE_MODELS) {
    for (const name of [m.providerModel, ...m.providerModelFallbacks]) {
      if (!map.has(name.toLowerCase())) map.set(name.toLowerCase(), m);
    }
  }
  return map;
})();

export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_BY_ID.keys());

export function mediaKindOf(modelId: string | null | undefined): MediaKind | undefined {
  return findModelConfig(modelId)?.media;
}

/**
 * Override mapping không cần redeploy code.
 * ENV: MODEL_ALIAS_MAP='{"claude-sonnet-5":"claude-sonnet-4-5","gpt-4o":"gpt-4.1"}'
 * Key = modelId nội bộ, value = tên model thật trên upstream proxy.
 */
let aliasCache: Record<string, string> | null = null;
function aliasOverrides(): Record<string, string> {
  if (aliasCache) return aliasCache;
  try {
    const raw = process.env.MODEL_ALIAS_MAP;
    const parsed = raw ? JSON.parse(raw) : {};
    aliasCache =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
  } catch {
    console.warn('[models] MODEL_ALIAS_MAP không phải JSON hợp lệ, bỏ qua.');
    aliasCache = {};
  }
  return aliasCache;
}

export function findModelConfig(modelId: string | null | undefined): ModelConfig | undefined {
  if (!modelId) return undefined;
  return MODEL_BY_ID.get(modelId) ?? MODEL_BY_PROVIDER_NAME.get(modelId.toLowerCase());
}

export function getModelConfig(modelId: string | null | undefined): ModelConfig {
  const found = findModelConfig(modelId);
  if (found) return found;
  const fallback = MODEL_BY_ID.get(DEFAULT_MODEL_ID);
  if (!fallback) throw new Error(`[models] DEFAULT_MODEL_ID "${DEFAULT_MODEL_ID}" không tồn tại.`);
  if (modelId) console.warn(`[models] Model không hợp lệ "${modelId}" -> dùng ${DEFAULT_MODEL_ID}.`);
  return fallback;
}

/** Dùng khi rehydrate localStorage: id chết -> id mặc định. */
export function normalizeModelId(modelId: string | null | undefined): string {
  return getModelConfig(modelId).id;
}

/**
 * Chuỗi tên model để thử lần lượt trên upstream.
 * Thứ tự: ENV override -> providerModel -> fallbacks -> default model.
 */
export function resolveProviderModelChain(model: ModelConfig): readonly string[] {
  const chain: string[] = [];
  const push = (v?: string) => {
    const t = v?.trim();
    if (!t || chain.includes(t)) return;
    chain.push(t);
    // Một số upstream đặt tên model bằng gạch thay vì dấu chấm — thử biến thể
    // `.` -> `-` ngay sau id gốc để tự fallback khi nhà cung cấp đổi kiểu tên.
    const dashed = t.replace(/\./g, '-');
    if (dashed !== t && !chain.includes(dashed)) chain.push(dashed);
  };

  push(aliasOverrides()[model.id]);
  push(model.providerModel);
  for (const f of model.providerModelFallbacks) push(f);

  // Model media: KHÔNG chèn model chat mặc định vào chuỗi — nếu provider không
  // có model ảnh/video thì phải báo lỗi, chứ không âm thầm trả về text.
  if (model.media === undefined && model.id !== DEFAULT_MODEL_ID) {
    const d = MODEL_BY_ID.get(DEFAULT_MODEL_ID);
    if (d) {
      push(aliasOverrides()[d.id]);
      push(d.providerModel);
    }
  }
  return Object.freeze(chain);
}

export function buildGenerationParams(
  model: ModelConfig,
  requested: { temperature?: number; maxOutputTokens?: number },
): { temperature?: number; maxOutputTokens: number } {
  return {
    temperature: model.supportsTemperature ? requested.temperature : undefined,
    maxOutputTokens: Math.min(
      requested.maxOutputTokens ?? model.maxOutputTokens,
      model.maxOutputTokens,
    ),
  };
}
