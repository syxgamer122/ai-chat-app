export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'google' | 'gateway';
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
 * Danh mục đồng bộ với `GET /v1/models` THẬT của crax (kiểm chứng bằng
 * request có key, không suy đoán từ tài liệu).
 *
 * QUY ƯỚC ĐẶT TÊN: crax dùng dấu GẠCH NGANG cho số phiên bản
 * (`gpt-5-6-sol`, `claude-opus-4-8`), không phải dấu chấm. Trước đây catalog
 * dùng `gpt-5.6-sol` nên mọi lượt chat đều tốn một lần thử hỏng trước khi
 * `resolveProviderModelChain` tự đổi `.` thành `-`. Nay id chính là tên thật,
 * còn bản chấm giữ trong fallback cho người dùng/preset cũ.
 *
 * contextWindowTokens lấy từ `context_length` do gateway khai báo.
 */
export const AVAILABLE_MODELS: readonly ModelConfig[] = Object.freeze([
  def({
    id: 'gpt-5-6-luna',
    name: 'ChatGPT-5.6 Luna',
    provider: 'gateway',
    providerModel: 'gpt-5-6-luna',
    providerModelFallbacks: ['gpt-5.6-luna', 'gpt-5-6-sol', 'gpt-5-5'],
    description: 'Rẻ nhất nhóm 5.6, cửa sổ ngữ cảnh 1M — hợp việc dài, tốn ít chi phí.',
    category: 'reasoning',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 32_768,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-5-6-sol',
    name: 'ChatGPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5-6-sol',
    providerModelFallbacks: ['gpt-5.6-sol', 'gpt-5-5', 'gpt-5-4'],
    description: 'Bản mạnh nhất nhóm 5.6, cân bằng suy luận và độ chính xác.',
    category: 'general',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-5-6-terra',
    name: 'ChatGPT-5.6 Terra',
    provider: 'gateway',
    providerModel: 'gpt-5-6-terra',
    providerModelFallbacks: ['gpt-5.6-terra', 'gpt-5-4-mini', 'gpt-5-5'],
    description: 'Bản tầm trung nhóm 5.6, nhanh và tiết kiệm hơn Sol.',
    category: 'fast',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 8_192,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: false,
  }),
  def({
    id: 'gpt-5-4-mini',
    name: 'ChatGPT-5.4 Mini',
    provider: 'gateway',
    providerModel: 'gpt-5-4-mini',
    providerModelFallbacks: ['gpt-5-4-nano', 'gpt-5-4'],
    description: 'Model nhỏ giá rẻ, phản hồi nhanh cho tác vụ đơn giản.',
    category: 'fast',
    contextWindowTokens: 400_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: false,
  }),
  def({
    id: 'gpt-5-5',
    name: 'ChatGPT-5.5',
    provider: 'gateway',
    providerModel: 'gpt-5-5',
    providerModelFallbacks: ['gpt-5.5', 'gpt-5-4', 'chatgpt-4o-latest'],
    description: 'Mô hình cơ sở mạnh mẽ, đa năng và ổn định.',
    category: 'general',
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gpt-5-4',
    name: 'ChatGPT-5.4',
    provider: 'gateway',
    providerModel: 'gpt-5-4',
    providerModelFallbacks: ['gpt-5-2', 'gpt-5-5'],
    description: 'Thế hệ 5.4, ngữ cảnh 1M, giá thấp hơn 5.5.',
    category: 'general',
    contextWindowTokens: 1_050_000,
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
    contextWindowTokens: 1_000_000,
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
    contextWindowTokens: 1_000_000,
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
    providerModelFallbacks: ['deepseek-v4-flash', 'deepseek-reasoner', 'deepseek-chat'],
    description: 'Mô hình chuyên sâu cho lập trình, toán học và kỹ thuật (ngữ cảnh 1M).',
    category: 'coding',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: false,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'gateway',
    providerModel: 'deepseek-v4-flash',
    providerModelFallbacks: ['deepseek-chat', 'deepseek-v4-pro'],
    description: 'Bản nhanh & rẻ của DeepSeek V4, ngữ cảnh 1M.',
    category: 'fast',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
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
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'gateway',
    providerModel: 'claude-haiku-4-5',
    providerModelFallbacks: ['claude-3-5-haiku-latest'],
    description: 'Claude nhanh và rẻ nhất, hợp tác vụ ngắn lặp nhiều.',
    category: 'fast',
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  /* ---------------- Google Gemini 3.x (crax) ---------------- */
  def({
    id: 'gemini-3-1-pro',
    name: 'Gemini 3.1 Pro',
    provider: 'gateway',
    providerModel: 'gemini-3-1-pro',
    providerModelFallbacks: ['gemini-3-flash', 'gemini-2.0-flash'],
    description: 'Bản Pro của Gemini 3, ngữ cảnh 1M, mạnh về suy luận dài.',
    category: 'reasoning',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  def({
    id: 'gemini-3-flash',
    name: 'Gemini 3 Flash',
    provider: 'gateway',
    providerModel: 'gemini-3-flash',
    providerModelFallbacks: ['gemini-3-6-flash', 'gemini-3-7-flash', 'gemini-2.0-flash'],
    description: 'Gemini 3 bản nhanh, ngữ cảnh 1M, giá thấp.',
    category: 'fast',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: true,
  }),
  /* ---------------- xAI Grok (crax) ---------------- */
  def({
    id: 'grok-4-6',
    name: 'Grok 4.6',
    provider: 'gateway',
    providerModel: 'grok-4-6',
    providerModelFallbacks: ['grok-4-5', 'grok-4-3'],
    description: 'Bản Grok mới nhất, ngữ cảnh 500k.',
    category: 'general',
    contextWindowTokens: 500_000,
    maxOutputTokens: 16_384,
    isReasoning: true,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: false,
  }),
  def({
    id: 'grok-code-fast-1',
    name: 'Grok Code Fast',
    provider: 'gateway',
    providerModel: 'grok-code-fast-1',
    providerModelFallbacks: ['grok-build-0-1', 'grok-4-6'],
    description: 'Grok tối ưu cho lập trình, phản hồi nhanh.',
    category: 'coding',
    contextWindowTokens: 256_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  /* ---------------- Qwen (crax) ---------------- */
  def({
    id: 'qwen3.8-max',
    name: 'Qwen 3.8 Max',
    provider: 'gateway',
    providerModel: 'qwen3.8-max',
    providerModelFallbacks: ['qwen3.8-max-preview', 'qwen3.7-max'],
    description: 'Qwen bản Max mới nhất, ngữ cảnh 1M.',
    category: 'general',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    provider: 'gateway',
    providerModel: 'qwen3-coder-plus',
    providerModelFallbacks: ['qwen3-coder-480b'],
    description: 'Qwen chuyên lập trình, ngữ cảnh 256k.',
    category: 'coding',
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'qwen3-vl-plus',
    name: 'Qwen3 VL Plus',
    provider: 'gateway',
    providerModel: 'qwen3-vl-plus',
    providerModelFallbacks: [],
    description: 'Qwen đa phương thức — đọc và phân tích hình ảnh.',
    category: 'general',
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: true,
    supportsPdf: false,
  }),
  /* ---------------- Moonshot Kimi (crax) ---------------- */
  def({
    id: 'kimi-k3',
    name: 'Kimi K3',
    provider: 'gateway',
    providerModel: 'kimi-k3',
    providerModelFallbacks: ['kimi-k2-6'],
    description: 'Kimi thế hệ 3, ngữ cảnh 1M.',
    category: 'general',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'kimi-k2-7-code',
    name: 'Kimi K2.7 Code',
    provider: 'gateway',
    providerModel: 'kimi-k2-7-code',
    providerModelFallbacks: ['kimi-k2-6', 'kimi-k3'],
    description: 'Kimi chuyên lập trình, ngữ cảnh 256k.',
    category: 'coding',
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    isReasoning: false,
    supportsTemperature: true,
    supportsImages: false,
    supportsPdf: false,
  }),
  /* ---------------- Model sinh media (gateway crax) ----------------
     Danh mục media của crax sau bản cập nhật tài khoản: gpt-image-2 và
     grok-imagine-2 được thêm; seedream/seedance đã bị gỡ khỏi gateway nên
     không khai báo ở đây (regex nhận diện cũng đã dọn tương ứng). */
  def({
    id: 'gpt-image-2',
    name: 'GPT Image 2',
    provider: 'gateway',
    providerModel: 'gpt-image-2',
    providerModelFallbacks: ['qwen-image-3.0-pro'],
    description: 'Model tạo ảnh mới nhất của OpenAI, bám sát mô tả và chữ trong ảnh.',
    category: 'media',
    media: 'image',
    contextWindowTokens: 4_000,
    maxOutputTokens: 1_024,
    isReasoning: false,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'grok-imagine-2',
    name: 'Grok Imagine 2',
    provider: 'gateway',
    providerModel: 'grok-imagine-2',
    providerModelFallbacks: ['grok-imagine', 'qwen-image-3.0-pro'],
    description: 'Tạo ảnh phong cách sáng tạo của xAI.',
    category: 'media',
    media: 'image',
    contextWindowTokens: 4_000,
    maxOutputTokens: 1_024,
    isReasoning: false,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'qwen-image-3.0-pro',
    name: 'Qwen Image 3.0 Pro',
    provider: 'gateway',
    providerModel: 'qwen-image-3.0-pro',
    providerModelFallbacks: ['qwen-image-2.0-pro'],
    description: 'Tạo ảnh từ mô tả văn bản, chất lượng cao nhất.',
    category: 'media',
    media: 'image',
    contextWindowTokens: 4_000,
    maxOutputTokens: 1_024,
    isReasoning: false,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'qwen-image-2.0-pro',
    name: 'Qwen Image 2.0 Pro',
    provider: 'gateway',
    providerModel: 'qwen-image-2.0-pro',
    providerModelFallbacks: ['qwen-image-3.0-pro'],
    description: 'Tạo ảnh nhanh hơn, phong cách khác bản 3.0.',
    category: 'media',
    media: 'image',
    contextWindowTokens: 4_000,
    maxOutputTokens: 1_024,
    isReasoning: false,
    supportsTemperature: false,
    supportsImages: false,
    supportsPdf: false,
  }),
  def({
    id: 'qwen-video',
    name: 'Qwen Video',
    provider: 'gateway',
    providerModel: 'qwen-video',
    description: 'Tạo video ngắn từ mô tả văn bản (mất 2-5 phút).',
    category: 'media',
    media: 'video',
    contextWindowTokens: 4_000,
    maxOutputTokens: 1_024,
    isReasoning: false,
    supportsTemperature: false,
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

export const DEFAULT_MODEL_ID = 'gpt-5-6-sol';

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

/** Model sinh ảnh/video built-in — dùng cho 2 nút media cạnh nút mic. */
export const MEDIA_MODELS: readonly ModelConfig[] = Object.freeze(
  AVAILABLE_MODELS.filter((m) => m.media !== undefined),
);

export function mediaKindOf(modelId: string | null | undefined): MediaKind | undefined {
  return findModelConfig(modelId)?.media;
}

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

  // Model media: KHÔNG chèn model chat mặc định vào chuỗi — nếu gateway không
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