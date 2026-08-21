import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Settings {
  model: string;
  temperature: number;
  systemPrompt: string;
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
        systemPrompt: 'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate.',
      },
      setCurrentChatId: (id) => set({ currentChatId: id }),
      updateSettings: (newSettings) => 
        set((state) => ({ settings: { ...state.settings, ...newSettings } })),
    }),
    { name: 'ai-chat-settings' }
  )
);
