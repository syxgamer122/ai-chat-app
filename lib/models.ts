export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'google' | 'gateway';
export type ModelCategory = 'general' | 'coding' | 'reasoning' | 'fast';

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
}

type ModelInput = Omit<ModelConfig, 'providerModelFallbacks'> & {
  providerModelFallbacks?: readonly string[];
};

const def = (m: ModelInput): ModelConfig =>
  Object.freeze({ providerModelFallbacks: [], ...m }) as ModelConfig;

export const AVAILABLE_MODELS: readonly ModelConfig[] = Object.freeze([
  def({
    id: 'gpt-5.6-luna',
    name: 'ChatGPT-5.6 Luna',
    provider: 'gateway',
    providerModel: 'gpt-5.6-luna',
    providerModelFallbacks: ['gpt-5.6-sol', 'gpt-5.5', 'gpt-4o'],
    description: 'Mô hình suy luận chuyên sâu, giải toán, khoa học & logic phức tạp.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-5.6-sol',
    name: 'ChatGPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5.6-sol',
    providerModelFallbacks: ['gpt-5.5', 'chatgpt-4o-latest', 'gpt-4o'],
    description: 'Bản cân bằng toàn diện, phản hồi nhanh và chính xác.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-5.6-terra',
    name: 'ChatGPT-5.6 Terra',
    provider: 'gateway',
    providerModel: 'gpt-5.6-terra',
    providerModelFallbacks: ['gpt-4o-mini', 'gpt-5.5'],
    description: 'Mô hình tiết kiệm tài nguyên, tốc độ phản hồi cực nhanh.',
    category: 'fast',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: false,
  }),
  def({
    id: 'gpt-5.5',
    name: 'ChatGPT-5.5',
    provider: 'gateway',
    providerModel: 'gpt-5.5',
    providerModelFallbacks: ['chatgpt-4o-latest', 'gpt-4o'],
    description: 'Mô hình cơ sở mạnh mẽ, đa năng và ổn định.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
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
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'gateway',
    providerModel: 'claude-opus-5',
    providerModelFallbacks: ['claude-opus-4-1', 'claude-3-opus-latest', 'claude-sonnet-5'],
    description: 'Mô hình mạnh mẽ nhất của dòng Claude, suy luận và viết văn xuất sắc.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'gateway',
    providerModel: 'claude-sonnet-5',
    providerModelFallbacks: [
      'claude-sonnet-4-5',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-sonnet-20241022',
    ],
    description: 'Bản cân bằng vượt trội giữa tốc độ và trí tuệ đỉnh cao.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'gateway',
    providerModel: 'claude-3-5-sonnet-latest',
    providerModelFallbacks: [
      'claude-3-5-sonnet',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-sonnet-20240620',
      'claude-sonnet-5',
    ],
    description: 'Mô hình lập trình và giải quyết vấn đề số một thế giới.',
    category: 'coding',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'gateway',
    providerModel: 'claude-3-5-haiku-latest',
    providerModelFallbacks: ['claude-3-5-haiku', 'claude-3-5-haiku-20241022'],
    description: 'Tốc độ phản hồi cực nhanh với chất lượng vượt trội.',
    category: 'fast',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'gateway',
    providerModel: 'deepseek-v4-pro',
    providerModelFallbacks: ['deepseek-reasoner', 'deepseek-chat'],
    description: 'Mô hình chuyên sâu cho lập trình, toán học và kỹ thuật.',
    category: 'coding',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'gateway',
    providerModel: 'deepseek-reasoner',
    providerModelFallbacks: ['deepseek-r1', 'deepseek-chat'],
    description: 'Mô hình mã nguồn mở suy luận đột phá R1.',
    category: 'reasoning',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'gateway',
    providerModel: 'deepseek-chat',
    providerModelFallbacks: ['deepseek-v3'],
    description: 'Mô hình ngôn ngữ lớn đa năng thế hệ thứ 3 của DeepSeek.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'minimax_m3',
    name: 'MiniMax M3',
    provider: 'gateway',
    providerModel: 'minimax_m3',
    providerModelFallbacks: ['minimax-m3', 'MiniMax-M3'],
    description: 'Mô hình xử lý văn bản tự nhiên mượt mà và thông minh.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gateway',
    providerModel: 'gemini-2.0-flash',
    providerModelFallbacks: ['gemini-2.0-flash-001', 'gemini-2.0-flash-exp', 'gemini-1.5-flash'],
    description: 'Mô hình Google thế hệ mới với cửa sổ ngữ cảnh siêu lớn 1M tokens.',
    category: 'fast',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
]) as readonly ModelConfig[];

export const DEFAULT_MODEL_ID = 'gpt-5.6-sol';

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

/**
 * Override mapping không cần redeploy code.
 * ENV: MODEL_ALIAS_MAP='{"claude-sonnet-5":"claude-sonnet-4-5","gpt-5.6-sol":"gpt-4o"}'
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
    // Gateway crax đặt tên model bằng gạch (`gpt-5-6-sol`) — thử biến thể
    // thay `.` bằng `-` ngay sau id gốc để tự fallback khi gateway đổi kiểu.
    const dashed = t.replace(/\./g, '-');
    if (dashed !== t && !chain.includes(dashed)) chain.push(dashed);
  };

  push(aliasOverrides()[model.id]);
  push(model.providerModel);
  for (const f of model.providerModelFallbacks) push(f);

  if (model.id !== DEFAULT_MODEL_ID) {
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