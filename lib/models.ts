export interface ModelOption {
  id: string;
  name: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini (Mặc định)' },
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'minimax_m3', name: 'MiniMax M3' },
];

export const ALLOWED_MODEL_IDS = new Set(AVAILABLE_MODELS.map((m) => m.id));
export const DEFAULT_MODEL_ID = 'gpt-4o-mini';
