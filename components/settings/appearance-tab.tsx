'use client';

/**
 * Settings → tab "Giao diện & trải nghiệm"
 *
 * Tham số model mặc định, thao tác nhập liệu, hàng đợi và hiệu năng hiển thị.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * Không nhận prop: tự đọc `useAppStore` như các section khác trong
 * components/settings/ — tránh luồn chục prop qua nhiều tầng chỉ để lấy `settings`.
 */

import { useAppStore } from '@/lib/store';
import { isQueueMode } from '@/lib/message-queue';

export function AppearanceTab() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePerf = useAppStore((s) => s.updatePerf);

  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Giao diện &amp; trải nghiệm</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Cấu hình tham số mô hình mặc định, thao tác nhập liệu và hiệu năng hiển thị.
        </p>
      </div>

      <div className="settings-card settings-card-body">
        <h4 className="field-label text-[15px]">Tham số mô hình</h4>

        <div>
          <label htmlFor="temperature" className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium text-text-primary">Temperature (Độ sáng tạo)</span>
            <span className="font-mono text-xs tabular-nums text-accent-steel">
              {settings.temperature.toFixed(2)}
            </span>
          </label>
          <input
            id="temperature"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.temperature}
            onChange={(e) => updateSettings({ temperature: parseFloat(e.target.value) })}
            className="w-full accent-[#6a9fcc]"
          />
          <p className="field-hint mt-1">
            Thấp = trả lời ổn định, sát dữ kiện. Cao = sáng tạo, biến thiên nhiều hơn.
          </p>
        </div>

        <div>
          <label htmlFor="system-prompt" className="field-label mb-1.5 block">
            System Prompt cốt lõi
          </label>
          <textarea
            id="system-prompt"
            value={settings.systemPrompt}
            onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
            rows={4}
            className="field resize-y w-full"
          />
        </div>
      </div>

      <div className="settings-card settings-card-body">
        <h4 className="field-label text-[15px]">Nhập liệu &amp; Hàng đợi</h4>

        <label htmlFor="send-on-enter" className="flex items-start justify-between gap-3 cursor-pointer">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Enter để gửi tin nhắn
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Tắt thì Enter xuống dòng, gửi bằng Ctrl/⌘ + Enter.
            </span>
          </span>
          <input
            id="send-on-enter"
            type="checkbox"
            checked={settings.sendOnEnter}
            onChange={(e) => updateSettings({ sendOnEnter: e.target.checked })}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-none accent-[#6a9fcc]"
          />
        </label>

        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Tin xếp hàng khi AI đang chạy
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Enter khi AI đang trả lời = steering (gửi ngay khi lượt xong), Alt+Enter =
              follow-up (gửi khi AI rảnh). Chọn cách bắn hàng đợi khi đến lượt.
            </span>
          </span>
          <span className="flex flex-shrink-0 flex-col gap-1">
            <select
              aria-label="Chế độ steering"
              value={settings.steeringMode}
              onChange={(e) => {
                const v: unknown = e.target.value;
                updateSettings({ steeringMode: isQueueMode(v) ? v : 'one-at-a-time' });
              }}
              className="field"
            >
              <option value="one-at-a-time">Steering: từng tin</option>
              <option value="all">Steering: tất cả</option>
            </select>
            <select
              aria-label="Chế độ follow-up"
              value={settings.followUpMode}
              onChange={(e) => {
                const v: unknown = e.target.value;
                updateSettings({ followUpMode: isQueueMode(v) ? v : 'one-at-a-time' });
              }}
              className="field"
            >
              <option value="one-at-a-time">Follow-up: từng tin</option>
              <option value="all">Follow-up: tất cả</option>
            </select>
          </span>
        </div>
      </div>

      <div className="settings-card settings-card-body">
        <h4 className="field-label text-[15px]">Hiệu năng &amp; Hiển thị</h4>

        <label htmlFor="auto-compact-toggle" className="flex items-start justify-between gap-3 cursor-pointer">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Nén hội thoại tự động (Compaction)
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Khi hội thoại gần trần ngữ cảnh của model, tự tóm tắt phần cũ và chỉ gửi
              tóm tắt + tin mới lên AI.
            </span>
          </span>
          <input
            id="auto-compact-toggle"
            type="checkbox"
            checked={settings.autoCompact}
            onChange={(e) => updateSettings({ autoCompact: e.target.checked })}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-none accent-[#6a9fcc]"
          />
        </label>

        <label htmlFor="anim-toggle" className="flex items-start justify-between gap-3 cursor-pointer">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-primary">
              Hiệu ứng chuyển động (Animations)
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-text-muted">
              Tắt để giảm tải GPU/CPU trên máy yếu. Tự động tuân theo prefers-reduced-motion của OS.
            </span>
          </span>
          <input
            id="anim-toggle"
            type="checkbox"
            checked={settings.perf?.animations ?? true}
            onChange={(e) => updatePerf({ animations: e.target.checked })}
            className="mt-0.5 h-4 w-4 flex-shrink-0 rounded-none accent-[#6a9fcc]"
          />
        </label>

        <div>
          <label htmlFor="throttle-ms" className="mb-1.5 block text-sm font-medium text-text-primary">
            Tần suất vẽ lại khi streaming token
          </label>
          <select
            id="throttle-ms"
            value={settings.perf?.throttleMs ?? 150}
            onChange={(e) => updatePerf({ throttleMs: Number(e.target.value) })}
            className="field w-full"
          >
            <option value={80}>Mượt nhất — 80ms (máy khỏe)</option>
            <option value={150}>Cân bằng — 150ms (mặc định)</option>
            <option value={250}>Tiết kiệm — 250ms</option>
            <option value={400}>Nhẹ nhất — 400ms (máy yếu)</option>
          </select>
        </div>
      </div>
    </>
  );
}
