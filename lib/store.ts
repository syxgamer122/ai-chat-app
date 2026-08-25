import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODEL_ID, normalizeModelId } from '@/lib/models';
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  type ProviderModel,
  type ThinkingLevel,
} from '@/lib/provider-url';

/** id provider "dùng cấu hình env của server" — định nghĩa ở store để tránh vòng import. */
export const SERVER_PROVIDER_ID = '__server__';

export type ThemePreference = 'light' | 'dark' | 'system';

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** Snapshot nhà cung cấp đang active — nằm trong store, không persist. */
export interface ActiveProviderSnapshot {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Array<ProviderModel>;
}

export interface PerfSettings {
  /** Cửa sổ gom render markdown khi stream (ms). Máy yếu: 250–300 */
  throttleMs: number;
  /** Tắt animation cho máy yếu / prefers-reduced-motion */
  animations: boolean;
}

export interface Settings {
  model: string;
  temperature: number;
  /** Mức suy luận gửi kèm request — chỉ gateway crax dịch được giá trị này. */
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  perf: PerfSettings;
  sendOnEnter: boolean;
  /** Tự động nén hội thoại khi ước lượng token gần trần context của model. */
  autoCompact: boolean;
  /** Bật tra cứu web cho tin nhắn tiếp theo (nút Globe trong composer). */
  webSearch: boolean;
  apiKey?: string;
  accessCode?: string;
}

interface AppState {
  currentChatId: string | null;
  isSidebarOpen: boolean;
  /** Desktop: sidebar thu gọn thành thanh icon (rail). Mobile: bỏ qua. */
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  settings: Settings;
  /** Giao diện sáng/tối — 'system' theo prefers-color-scheme của OS. */
  theme: ThemePreference;
  /** Provider đang dùng — SERVER_PROVIDER_ID = cấu hình env của server. */
  activeProviderId: string;
  /** Snapshot provider active (baseUrl/key/models) — không persist. */
  activeProvider: ActiveProviderSnapshot | null;
  setCurrentChatId: (id: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  updateSettings: (s: Partial<Omit<Settings, 'perf'>>) => void;
  updatePerf: (p: Partial<PerfSettings>) => void;
  setActiveProvider: (id: string) => void;
  setActiveProviderSnapshot: (snapshot: ActiveProviderSnapshot | null) => void;
}

const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL_ID,
  temperature: 0.7,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  systemPrompt:
    'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. ' +
    'For LaTeX math, always use $$...$$ for block math and \\(...\\) for inline math.',
  perf: { throttleMs: 150, animations: true },
  sendOnEnter: true,
  autoCompact: true,
  webSearch: false,
  apiKey: '',
  accessCode: '',
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentChatId: null,
      isSidebarOpen: false,
      isSidebarCollapsed: false,
      isSettingsOpen: false,
      settings: DEFAULT_SETTINGS,
      theme: 'system',
      activeProviderId: SERVER_PROVIDER_ID,
      activeProvider: null,
      setCurrentChatId: (id) => set({ currentChatId: id, isSidebarOpen: false }),
      setSidebarOpen: (open) => set({ isSidebarOpen: open }),
      setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
      setSettingsOpen: (open) => set({ isSettingsOpen: open }),
      setTheme: (theme) => set({ theme }),
      updateSettings: (partial) =>
        set((s) => ({ settings: { ...s.settings, ...partial } })),
      updatePerf: (partial) =>
        set((s) => ({ settings: { ...s.settings, perf: { ...s.settings.perf, ...partial } } })),
      setActiveProvider: (id) => set({ activeProviderId: id, activeProvider: null }),
      setActiveProviderSnapshot: (snapshot) => set({ activeProvider: snapshot }),
    }),
    {
      name: 'ai-chat-settings',
      version: 2,
      partialize: (s) => ({
        activeProviderId: s.activeProviderId,
        isSidebarCollapsed: s.isSidebarCollapsed,
        theme: s.theme,
        settings: {
          model: s.settings.model,
          temperature: s.settings.temperature,
          thinkingLevel: s.settings.thinkingLevel,
          systemPrompt: s.settings.systemPrompt,
          perf: s.settings.perf,
          sendOnEnter: s.settings.sendOnEnter,
          autoCompact: s.settings.autoCompact,
          webSearch: s.settings.webSearch,
        },
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        const rawModel = p.settings?.model;
        const usingCustomProvider =
          !!p.activeProviderId && p.activeProviderId !== SERVER_PROVIDER_ID;
        // Model của provider ngoài built-in không qua normalizeModelId.
        const validModel = usingCustomProvider
          ? typeof rawModel === 'string' && rawModel
            ? rawModel
            : DEFAULT_MODEL_ID
          : normalizeModelId(rawModel);

        return {
          ...current,
          ...p,
          theme: isThemePreference(p.theme) ? p.theme : current.theme,
          settings: {
            ...current.settings,
            ...(p.settings ?? {}),
            model: validModel,
            thinkingLevel: isThinkingLevel(p.settings?.thinkingLevel)
              ? p.settings.thinkingLevel
              : DEFAULT_THINKING_LEVEL,
            perf: { ...current.settings.perf, ...(p.settings?.perf ?? {}) },
            apiKey: '',
            accessCode: '',
          },
          activeProvider: null,
        };
      },
      migrate: (state: any) => ({
        ...state,
        settings: {
          ...state?.settings,
          model: normalizeModelId(state?.settings?.model),
        },
      }),
    },
  ),
);