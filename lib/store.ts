import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODEL_ID, ALLOWED_MODEL_IDS } from '@/lib/models';

export interface PerfSettings {
  /** Cửa sổ gom render markdown khi stream (ms). Máy yếu: 250–300 */
  throttleMs: number;
  /** Tắt animation cho máy yếu / prefers-reduced-motion */
  animations: boolean;
}

export interface Settings {
  model: string;
  temperature: number;
  systemPrompt: string;
  perf: PerfSettings;
  sendOnEnter: boolean;
  apiKey?: string;
  accessCode?: string;
}

interface AppState {
  currentChatId: string | null;
  isSidebarOpen: boolean;
  settings: Settings;
  setCurrentChatId: (id: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  updateSettings: (s: Partial<Omit<Settings, 'perf'>>) => void;
  updatePerf: (p: Partial<PerfSettings>) => void;
}

const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL_ID,
  temperature: 0.7,
  systemPrompt:
    'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. ' +
    'For LaTeX math, always use $$...$$ for block math and \\(...\\) for inline math.',
  perf: { throttleMs: 150, animations: true },
  sendOnEnter: true,
  apiKey: '',
  accessCode: '',
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentChatId: null,
      isSidebarOpen: false,
      settings: DEFAULT_SETTINGS,
      setCurrentChatId: (id) => set({ currentChatId: id, isSidebarOpen: false }),
      setSidebarOpen: (open) => set({ isSidebarOpen: open }),
      updateSettings: (partial) =>
        set((s) => ({ settings: { ...s.settings, ...partial } })),
      updatePerf: (partial) =>
        set((s) => ({ settings: { ...s.settings, perf: { ...s.settings.perf, ...partial } } })),
    }),
    {
      name: 'ai-chat-settings',
      version: 2,
      partialize: (s) => ({
        settings: {
          model: s.settings.model,
          temperature: s.settings.temperature,
          systemPrompt: s.settings.systemPrompt,
          perf: s.settings.perf,
          sendOnEnter: s.settings.sendOnEnter,
        },
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        const rawModel = p.settings?.model;
        const validModel = rawModel && ALLOWED_MODEL_IDS.has(rawModel) ? rawModel : DEFAULT_MODEL_ID;

        return {
          ...current,
          ...p,
          settings: {
            ...current.settings,
            ...(p.settings ?? {}),
            model: validModel,
            perf: { ...current.settings.perf, ...(p.settings?.perf ?? {}) },
            // Tuyệt đối không phục hồi apiKey hay accessCode từ localStorage
            apiKey: '',
            accessCode: '',
          },
        };
      },
      migrate: (state: any) => state,
    },
  ),
);
