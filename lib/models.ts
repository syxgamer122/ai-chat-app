export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'google' | 'gateway';

export interface ModelConfig {
  id: string;
  name: string;
  provider?: ProviderId;
  providerModel: string;
  description: string;
  category: 'general' | 'coding' | 'reasoning' | 'fast';
  contextWindow?: number;
  /** Giới hạn token đầu ra. Bỏ trống = để provider tự quyết định. */
  maxTokens?: number;
  isReasoning?: boolean;
  /** false = không gửi tham số temperature (model reasoning kiểu o1/o3 sẽ trả 400). */
  supportsTemperature?: boolean;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  // --- GPT-5.6 & Flagship Series ---
  {
    id: 'gpt-5.6-luna',
    name: 'ChatGPT-5.6 Luna',
    provider: 'gateway',
    providerModel: 'gpt-5.6-luna',
    description: 'Mô hình suy luận chuyên sâu, giải toán, khoa học & logic phức tạp.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'ChatGPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5.6-sol',
    description: 'Bản cân bằng toàn diện, phản hồi nhanh và chính xác.',
    category: 'general',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'ChatGPT-5.6 Terra',
    provider: 'gateway',
    providerModel: 'gpt-5.6-terra',
    description: 'Mô hình tiết kiệm tài nguyên, tốc độ phản hồi cực nhanh.',
    category: 'fast',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: 'gpt-5.5',
    name: 'ChatGPT-5.5',
    provider: 'gateway',
    providerModel: 'gpt-5.5',
    description: 'Mô hình cơ sở mạnh mẽ, đa năng và ổn định.',
    category: 'general',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },

  // --- GPT-4o & OpenAI Standard Models ---
  {
    id: 'chatgpt-4o-latest',
    name: 'ChatGPT-4o Latest',
    provider: 'openai',
    providerModel: 'chatgpt-4o-latest',
    description: 'Mô hình đa phương thức hàng đầu, xử lý xuất sắc văn bản, hình ảnh.',
    category: 'general',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    providerModel: 'gpt-4o',
    description: 'Phiên bản tiêu chuẩn của GPT-4o, tối ưu cho xử lý đa tác vụ.',
    category: 'general',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    providerModel: 'gpt-4o-mini',
    description: 'Bản thu nhỏ siêu nhanh và tiết kiệm chi phí, phù hợp tác vụ hàng ngày.',
    category: 'fast',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'openai',
    providerModel: 'o1',
    description: 'Mô hình suy luận sâu cấp độ tiến sĩ của OpenAI.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },
  {
    id: 'o1-mini',
    name: 'OpenAI o1-mini',
    provider: 'openai',
    providerModel: 'o1-mini',
    description: 'Bản tinh gọn suy luận logic và lập trình nhanh.',
    category: 'fast',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'openai',
    providerModel: 'o3-mini',
    description: 'Thế hệ mô hình suy luận tốc độ cao mới nhất từ OpenAI.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 32_768,
  },

  // --- Claude Anthropic Models ---
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'gateway',
    providerModel: 'claude-opus-5',
    description: 'Mô hình mạnh mẽ nhất của dòng Claude, suy luận và viết văn xuất sắc.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'gateway',
    providerModel: 'claude-sonnet-5',
    description: 'Bản cân bằng vượt trội giữa tốc độ và trí tuệ đỉnh cao.',
    category: 'general',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'gateway',
    providerModel: 'claude-3-5-sonnet-20241022',
    description: 'Mô hình lập trình và giải quyết vấn đề số một thế giới.',
    category: 'coding',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'gateway',
    providerModel: 'claude-3-5-haiku-20241022',
    description: 'Tốc độ phản hồi cực nhanh với chất lượng vượt trội.',
    category: 'fast',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },

  // --- DeepSeek & Others ---
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'gateway',
    providerModel: 'deepseek-v4-pro',
    description: 'Mô hình chuyên sâu cho lập trình, toán học và kỹ thuật.',
    category: 'coding',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'gateway',
    providerModel: 'deepseek-reasoner',
    description: 'Mô hình mã nguồn mở suy luận đột phá R1.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'gateway',
    providerModel: 'deepseek-chat',
    description: 'Mô hình ngôn ngữ lớn đa năng thế hệ thứ 3 của DeepSeek.',
    category: 'general',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'minimax_m3',
    name: 'MiniMax M3',
    provider: 'gateway',
    providerModel: 'minimax_m3',
    description: 'Mô hình xử lý văn bản tự nhiên mượt mà và thông minh.',
    category: 'general',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
    maxTokens: 16_384,
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gateway',
    providerModel: 'gemini-2.0-flash',
    description: 'Mô hình Google thế hệ mới với cửa sổ ngữ cảnh siêu lớn 1M tokens.',
    category: 'fast',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  },
];

export const DEFAULT_MODEL_ID = 'gpt-5.6-sol';

export const ALLOWED_MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));

const FALLBACK_MODEL: ModelConfig = {
  id: DEFAULT_MODEL_ID,
  name: 'ChatGPT-5.6 Sol',
  providerModel: 'gpt-5.6-sol',
  description: 'Mô hình mặc định.',
  category: 'general',
  isReasoning: true,
  supportsTemperature: false,
  maxTokens: 16_384,
};

export function getModelConfig(modelId?: string): ModelConfig {
  if (!modelId) return FALLBACK_MODEL;
  return AVAILABLE_MODELS.find((m) => m.id === modelId) ?? FALLBACK_MODEL;
}
