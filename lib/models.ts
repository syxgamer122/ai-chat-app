export type ProviderId = 'openai' | 'anthropic' | 'deepseek' | 'google' | 'gateway';

export interface ModelOption {
  id: string;
  name: string;
  provider: ProviderId;
  providerModel: string;
  isReasoning?: boolean;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  // --- GPT & OpenAI High-Tier Models ---
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    provider: 'gateway',
    providerModel: 'gpt-5.6-luna',
    isReasoning: true,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    provider: 'gateway',
    providerModel: 'gpt-5.6-sol',
    isReasoning: true,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    provider: 'gateway',
    providerModel: 'gpt-5.6-terra',
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'gateway',
    providerModel: 'gpt-5.5',
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    providerModel: 'gpt-4o',
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini (Mặc định)',
    provider: 'openai',
    providerModel: 'gpt-4o-mini',
  },
  {
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'openai',
    providerModel: 'o1',
    isReasoning: true,
  },
  {
    id: 'o1-mini',
    name: 'OpenAI o1-mini',
    provider: 'openai',
    providerModel: 'o1-mini',
    isReasoning: true,
  },
  {
    id: 'o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'openai',
    providerModel: 'o3-mini',
    isReasoning: true,
  },

  // --- Claude Anthropic Models ---
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    provider: 'gateway',
    providerModel: 'claude-opus-5',
    isReasoning: true,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'gateway',
    providerModel: 'claude-sonnet-5',
  },
  {
    id: 'claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'gateway',
    providerModel: 'claude-3-5-sonnet-20241022',
  },
  {
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'gateway',
    providerModel: 'claude-3-5-haiku-20241022',
  },

  // --- DeepSeek & Others ---
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    provider: 'gateway',
    providerModel: 'deepseek-v4-pro',
    isReasoning: true,
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'gateway',
    providerModel: 'deepseek-reasoner',
    isReasoning: true,
  },
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'gateway',
    providerModel: 'deepseek-chat',
  },
  {
    id: 'minimax_m3',
    name: 'MiniMax M3',
    provider: 'gateway',
    providerModel: 'minimax_m3',
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'gateway',
    providerModel: 'gemini-2.0-flash',
  },
];

export const MODEL_LOOKUP = new Map<string, ModelOption>(
  AVAILABLE_MODELS.map((m) => [m.id, m]),
);

export const ALLOWED_MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));
export const DEFAULT_MODEL_ID = 'gpt-4o-mini';

export function getModelConfig(modelId?: string): ModelOption {
  if (modelId && MODEL_LOOKUP.has(modelId)) {
    return MODEL_LOOKUP.get(modelId)!;
  }
  return MODEL_LOOKUP.get(DEFAULT_MODEL_ID)!;
}
