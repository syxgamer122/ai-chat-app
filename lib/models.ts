export interface ModelConfig {
  id: string;
  name: string;
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
  {
    id: 'gpt-5.6-sol',
    name: 'ChatGPT-5.6 Sol',
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
    providerModel: 'gpt-5.6-terra',
    description: 'Mô hình tiết kiệm tài nguyên, tốc độ phản hồi cực nhanh.',
    category: 'fast',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'ChatGPT-5.6 Luna',
    providerModel: 'gpt-5.6-luna',
    description: 'Mô hình suy luận chuyên sâu, giải toán, khoa học & logic phức tạp.',
    category: 'reasoning',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    // Reasoning tokens tính vào output => cần hạn mức lớn, tránh cắt giữa bài giải.
    maxTokens: 32_768,
  },
  {
    id: 'gpt-5.5',
    name: 'ChatGPT-5.5',
    providerModel: 'gpt-5.5',
    description: 'Mô hình cơ sở mạnh mẽ, đa năng và ổn định.',
    category: 'general',
    isReasoning: true,
    supportsTemperature: false,
    contextWindow: 200_000,
    maxTokens: 16_384,
  },
  {
    id: 'chatgpt-4o-latest',
    name: 'ChatGPT-4o Latest',
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
    providerModel: 'gpt-4o-mini',
    description: 'Bản thu nhỏ siêu nhanh và tiết kiệm chi phí, phù hợp tác vụ hàng ngày.',
    category: 'fast',
    isReasoning: false,
    supportsTemperature: true,
    contextWindow: 128_000,
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

export function getModelConfig(modelId: string): ModelConfig {
  return AVAILABLE_MODELS.find((m) => m.id === modelId) ?? FALLBACK_MODEL;
}
