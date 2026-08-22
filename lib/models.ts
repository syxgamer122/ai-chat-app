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
  // --- GPT-5.6 & Flagship Series ---
  Object.freeze({
    id: 'gpt-5.6-luna',
    name: 'ChatGPT-5.6 Luna',
    provider: 'gateway',
    providerModel: 'gpt-5.6-luna',
    description: 'Mô hình suy luận chuyên sâu, giải toán, khoa học & logic phức tạp.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'gpt-5.6-sol',
    name: 'ChatGPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5.6-sol',
    description: 'Bản cân bằng toàn diện, phản hồi nhanh và chính xác.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'gpt-5.6-terra',
    name: 'ChatGPT-5.6 Terra',
    provider: 'gateway',
    providerModel: 'gpt-5.6-terra',
    description: 'Mô hình tiết kiệm tài nguyên, tốc độ phản hồi cực nhanh.',
    category: 'fast',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: false,
  }),
  Object.freeze({
    id: 'gpt-5.5',
    name: 'ChatGPT-5.5',
    provider: 'gateway',
    providerModel: 'gpt-5.5',
    description: 'Mô hình cơ sở mạnh mẽ, đa năng và ổn định.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),

  // --- GPT-4o & OpenAI Standard Models ---
  Object.freeze({
    id: 'chatgpt-4o-latest',
    name: 'ChatGPT-4o Latest',
    provider: 'openai',
    providerModel: 'chatgpt-4o-latest',
    description: 'Mô hình đa phương thức hàng đầu, xử lý xuất sắc văn bản, hình ảnh.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    providerModel: 'gpt-4o',
    description: 'Phiên bản tiêu chuẩn của GPT-4o, tối ưu cho xử lý đa tác vụ.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    providerModel: 'gpt-4o-mini',
    description: 'Bản thu nhỏ siêu nhanh và tiết kiệm chi phí, phù hợp tác vụ hàng ngày.',
    category: 'fast',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'openai',
    providerModel: 'o1',
    description: 'Mô hình suy luận sâu cấp độ tiến sĩ của OpenAI.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'o1-mini',
    name: 'OpenAI o1-mini',
    provider: 'openai',
    providerModel: 'o1-mini',
    description: 'Bản tinh gọn suy luận logic và lập trình nhanh.',
    category: 'fast',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  Object.freeze({
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'openai',
    providerModel: 'o3-mini',
    description: 'Thế hệ mô hình suy luận tốc độ cao mới nhất từ OpenAI.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),

  // --- Claude Anthropic Models ---
  Object.freeze({
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'gateway',
    providerModel: 'claude-opus-5',
    description: 'Mô hình mạnh mẽ nhất của dòng Claude, suy luận và viết văn xuất sắc.',
    category: 'reasoning',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'gateway',
    providerModel: 'claude-sonnet-5',
    description: 'Bản cân bằng vượt trội giữa tốc độ và trí tuệ đỉnh cao.',
    category: 'general',
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'gateway',
    providerModel: 'claude-3-5-sonnet-20241022',
    description: 'Mô hình lập trình và giải quyết vấn đề số một thế giới.',
    category: 'coding',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'gateway',
    providerModel: 'claude-3-5-haiku-20241022',
    description: 'Tốc độ phản hồi cực nhanh với chất lượng vượt trội.',
    category: 'fast',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),

  // --- DeepSeek & Others ---
  Object.freeze({
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'gateway',
    providerModel: 'deepseek-v4-pro',
    description: 'Mô hình chuyên sâu cho lập trình, toán học và kỹ thuật.',
    category: 'coding',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  Object.freeze({
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'gateway',
    providerModel: 'deepseek-reasoner',
    description: 'Mô hình mã nguồn mở suy luận đột phá R1.',
    category: 'reasoning',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  Object.freeze({
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'gateway',
    providerModel: 'deepseek-chat',
    description: 'Mô hình ngôn ngữ lớn đa năng thế hệ thứ 3 của DeepSeek.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  Object.freeze({
    id: 'minimax_m3',
    name: 'MiniMax M3',
    provider: 'gateway',
    providerModel: 'minimax_m3',
    description: 'Mô hình xử lý văn bản tự nhiên mượt mà và thông minh.',
    category: 'general',
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  Object.freeze({
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gateway',
    providerModel: 'gemini-2.0-flash',
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

export const ALLOWED_MODEL_IDS: ReadonlySet<string> = new Set(MODEL_BY_ID.keys());

/** Tra cứu tường minh — trả undefined nếu không tồn tại. */
export function findModelConfig(modelId: string | null | undefined): ModelConfig | undefined {
  return modelId ? MODEL_BY_ID.get(modelId) : undefined;
}

/** Fallback CÓ CHỦ Ý về DEFAULT_MODEL_ID ('gpt-5.6-sol'). */
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