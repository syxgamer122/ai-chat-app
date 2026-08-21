'use client';

import { useEffect, useState } from 'react';
import { Sidebar } from '@/components/sidebar';
import ChatInterface from '@/components/chat-interface';
import { db } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { AVAILABLE_MODELS } from '@/lib/models';
import { X } from 'lucide-react';

export default function Home() {
  const [isMounted, setIsMounted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const { settings, updateSettings, updatePerf, setCurrentChatId } = useAppStore();

  useEffect(() => {
    setIsMounted(true);
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Phím tắt Ctrl/Cmd + Shift + O hoặc Ctrl/Cmd + N -> Tạo chat mới
      if ((mod && e.key === 'n') || (mod && e.shiftKey && e.key.toLowerCase() === 'o')) {
        e.preventDefault();
        setCurrentChatId(null);
      }
      // Escape để đóng modal settings nếu đang mở
      if (e.key === 'Escape' && showSettings) {
        setShowSettings(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setCurrentChatId, showSettings]);

  if (!isMounted) {
    return (
      <div className="h-screen bg-zinc-950 flex items-center justify-center text-zinc-500 font-mono text-sm">
        Loading workspace...
      </div>
    );
  }

  return (
    <main className="flex h-screen overflow-hidden">
      <Sidebar onOpenSettings={() => setShowSettings(true)} />
      <ChatInterface />

      {showSettings && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSettings(false);
          }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-in fade-in duration-200"
        >
          <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-6 pb-3 border-b border-zinc-800">
              <h2 className="text-xl font-medium text-zinc-100">Cài đặt ứng dụng</h2>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="p-1 text-zinc-500 hover:text-zinc-300 rounded-lg transition"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5">
              {/* AI Model */}
              <div>
                <label className="text-sm font-medium text-zinc-300 mb-1.5 block">AI Model</label>
                <select
                  value={settings.model}
                  onChange={(e) => updateSettings({ model: e.target.value })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 transition"
                >
                  {AVAILABLE_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Temperature */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium text-zinc-300">Độ sáng tạo (Temperature)</label>
                  <span className="text-xs font-mono text-indigo-400">{settings.temperature}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.1"
                  value={settings.temperature}
                  onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>

              {/* Custom API Key */}
              <div>
                <label className="text-sm font-medium text-zinc-300 mb-1.5 block">
                  Custom API Key
                </label>
                <input
                  type="password"
                  placeholder="sk-..."
                  value={settings.apiKey || ''}
                  onChange={(e) => updateSettings({ apiKey: e.target.value })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 font-mono transition"
                />
                <p className="text-xs text-zinc-500 mt-1">
                  Để trống để dùng bể Key tự động của hệ thống.
                </p>
              </div>

              {/* System Prompt */}
              <div>
                <label className="text-sm font-medium text-zinc-300 mb-1.5 block">System Prompt</label>
                <textarea
                  rows={3}
                  value={settings.systemPrompt}
                  onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-2.5 text-sm text-zinc-200 outline-none focus:border-indigo-500 resize-none transition"
                />
              </div>

              {/* Performance & Animation */}
              <div className="pt-3 border-t border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-zinc-300">Hiệu ứng chuyển động (Animations)</div>
                    <div className="text-xs text-zinc-500">Tắt để máy yếu hoặc thiết bị cũ chạy mượt hơn</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={settings.perf?.animations ?? true}
                    onChange={(e) => updatePerf({ animations: e.target.checked })}
                    className="w-4 h-4 accent-indigo-500 cursor-pointer rounded"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-sm font-medium text-zinc-300">Cửa sổ gom render stream (Throttle)</label>
                    <span className="text-xs font-mono text-indigo-400">{settings.perf?.throttleMs ?? 150}ms</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="300"
                    step="25"
                    value={settings.perf?.throttleMs ?? 150}
                    onChange={(e) => updatePerf({ throttleMs: parseInt(e.target.value, 10) })}
                    className="w-full accent-indigo-500 cursor-pointer"
                  />
                </div>
              </div>

              {/* Danger Zone */}
              <div className="pt-4 border-t border-zinc-800 flex items-center justify-between">
                <button
                  type="button"
                  onClick={async () => {
                    if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử chat và dữ liệu cục bộ?')) {
                      await db.close();
                      await db.delete();
                      window.location.reload();
                    }
                  }}
                  className="text-red-400 text-sm hover:text-red-300 font-medium transition"
                >
                  Xóa sạch dữ liệu cục bộ
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowSettings(false)}
              className="mt-6 w-full bg-zinc-100 text-zinc-900 font-medium py-2.5 rounded-xl hover:bg-white transition-colors shadow-sm"
            >
              Hoàn tất
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
