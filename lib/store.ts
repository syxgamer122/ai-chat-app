import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Settings {
  model: string;
  temperature: number;
  systemPrompt: string;
  perf?: {
    /** cửa sổ gom render markdown khi stream (ms). Máy yếu: 250–300 */
    throttleMs: number;
  };
}

interface AppState {
  currentChatId: string | null;
  settings: Settings;
  setCurrentChatId: (id: string | null) => void;
  updateSettings: (settings: Partial<Settings>) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentChatId: null,
      settings: {
        model: 'gpt-5.6-luna', // Mặc định dựa trên ảnh bạn gửi
        temperature: 0.7,
        systemPrompt: 'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. For inline math use $...$ and for block math use $$...$$. Do not use \\( or \\[. ',
        perf: {
          throttleMs: 150,
        },
      },
      setCurrentChatId: (id) => set({ currentChatId: id }),
      updateSettings: (newSettings) => 
        set((state) => ({ settings: { ...state.settings, ...newSettings } })),
    }),
    { name: 'ai-chat-settings' }
  )
);
