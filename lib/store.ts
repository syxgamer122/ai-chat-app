import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface PerfSettings {
  /** cửa sổ gom render markdown khi stream (ms). Máy yếu: 250–300 */
  throttleMs: number;
  /** tắt animation cho máy yếu / prefers-reduced-motion */
  animations: boolean;
}

export interface Settings {
  model: string;
  temperature: number;
  systemPrompt: string;
  perf: PerfSettings;
  sendOnEnter: boolean;
}

interface AppState {
  currentChatId: string | null;
  settings: Settings;
  hydrated: boolean;
  setCurrentChatId: (id: string | null) => void;
  updateSettings: (s: Partial<Omit<Settings, 'perf'>>) => void;
  updatePerf: (p: Partial<PerfSettings>) => void;
}

const DEFAULT_SETTINGS: Settings = {
  model: 'gpt-5.6-luna',
  temperature: 0.7,
  systemPrompt:
    'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. ' +
    'For inline math use $...$ and for block math use $$...$$. Do not use \\( or \\[.',
  perf: { throttleMs: 150, animations: true },
  sendOnEnter: true,
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentChatId: null,
      settings: DEFAULT_SETTINGS,
      hydrated: false,
      setCurrentChatId: (id) => set({ currentChatId: id }),
      updateSettings: (partial) =>
        set((s) => ({ settings: { ...s.settings, ...partial } })),
      updatePerf: (partial) =>
        set((s) => ({ settings: { ...s.settings, perf: { ...s.settings.perf, ...partial } } })),
    }),
    {
      name: 'ai-chat-settings',
      version: 2,
      // Không persist currentChatId: mở tab mới trỏ vào chat cũ dễ gây race.
      partialize: (s) => ({ settings: s.settings }),
      // Deep-merge để field mới luôn có mặc định.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          settings: {
            ...current.settings,
            ...(p.settings ?? {}),
            perf: { ...current.settings.perf, ...(p.settings?.perf ?? {}) },
          },
        };
      },
      migrate: (state: any) => state,
      onRehydrateStorage: () => (state) => state && (state.hydrated = true),
    },
  ),
);
