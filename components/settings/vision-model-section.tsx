'use client';

/**
 * Settings → Model đọc ảnh (Vision)
 *
 * Chọn model mô tả ảnh cho workspace và kết quả MCP.
 *
 * (Tách ra từ components/settings-dialog.tsx — file đó từng dài 1.668 dòng.)
 */

import { useAppStore, SERVER_PROVIDER_ID, isApiModelId } from '@/lib/store';

export function VisionModelSection() {
  const visionModel = useAppStore((s) => s.settings.visionModel ?? '');
  const updateSettings = useAppStore((s) => s.updateSettings);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const activeProvider = useAppStore((s) => s.activeProvider);

  const models = activeProvider?.models ?? [];
  const noModels = activeProviderId === SERVER_PROVIDER_ID || models.length === 0;
  const orphanModel = Boolean(visionModel) && !models.some((m) => m.id === visionModel);
  const unusableModel = Boolean(visionModel) && !isApiModelId(visionModel);

  return (
    <div className="space-y-1.5">
      <label htmlFor="vision-model" className="block text-sm font-medium text-text-primary">
        Model đọc ảnh (vision)
      </label>
      <select
        id="vision-model"
        value={visionModel}
        disabled={noModels}
        onChange={(e) => updateSettings({ visionModel: e.target.value })}
        className="field w-full disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">— Không dùng —</option>
        {orphanModel && <option value={visionModel}>{visionModel} (không còn trong danh sách)</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name || m.id}
          </option>
        ))}
      </select>
      {noModels ? (
        <p className="text-[11px] leading-relaxed text-text-muted">
          Hãy chọn một Nhà cung cấp ở trên và bấm kiểm tra kết nối để tải danh sách model, rồi
          quay lại đây chọn model đọc ảnh.
          {visionModel ? ` Lựa chọn cũ (${visionModel}) vẫn được giữ.` : ''}
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-text-muted">
          Dùng để mô tả ảnh thành chữ: ảnh trong thư mục làm việc khi agent gọi{' '}
          <code className="claude-inline-code">fs_read</code>, ảnh do công cụ MCP trả về, và ảnh
          bạn đính kèm cho model không xem được ảnh.
        </p>
      )}
      {unusableModel && (
        <p className="notice-warn text-[11px] leading-relaxed" role="status">
          Tên model &ldquo;{visionModel}&rdquo; chứa ký tự mà máy chủ không nhận nên Vyen chưa dùng được để
          đọc ảnh. Hãy chọn model khác.
        </p>
      )}
    </div>
  );
}

