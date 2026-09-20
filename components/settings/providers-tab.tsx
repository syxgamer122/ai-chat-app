'use client';

/**
 * Settings → tab "Model & Nhà cung cấp"
 *
 * Quản lý provider preset, định tuyến model và model đọc ảnh.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * Không nhận prop: tự đọc `useAppStore` như các section khác trong
 * components/settings/ — tránh luồn chục prop qua nhiều tầng chỉ để lấy `settings`.
 */

import dynamic from 'next/dynamic';
import { useAppStore, SERVER_PROVIDER_ID } from '@/lib/store';
import { SectionLoading } from '@/components/settings/section-loading';
import { VisionModelSection } from '@/components/settings/vision-model-section';

const ProviderManager = dynamic(() => import('@/components/provider-manager').then((m) => m.ProviderManager), { ssr: false, loading: SectionLoading });
const RoutingSettingsPanel = dynamic(() => import('@/components/routing-settings-panel').then((m) => m.RoutingSettingsPanel), { ssr: false, loading: SectionLoading });

export function ProvidersTab() {
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Model &amp; Nhà cung cấp</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Quản lý API key cá nhân (BYOK), danh sách model, vision model và chiến lược điều phối Lead/Worker.
        </p>
      </div>

      {activeProviderId === SERVER_PROVIDER_ID && (
        <div>
          <label htmlFor="server-api-key" className="mb-1.5 block text-sm font-medium text-text-primary">
            API Key OpenAI (máy chủ mặc định)
          </label>
          <input
            id="server-api-key"
            type="password"
            value={settings.apiKey || ''}
            onChange={(e) => updateSettings({ apiKey: e.target.value })}
            placeholder="sk-..."
            className="field font-mono w-full"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
            Chỉ lưu trong phiên này, không persist vào đĩa. Key này được gửi
            thẳng tới api.openai.com khi gọi model OpenAI.
          </p>
        </div>
      )}

      <div>
        <h4 className="mb-1.5 text-sm font-semibold text-text-primary">Nhà cung cấp API (BYOK)</h4>
        <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
          Lưu nhiều nhà cung cấp chuẩn OpenAI-compatible, tải danh sách model và chuyển
          nhanh mà không cần cấu hình lại server.
        </p>
        <ProviderManager />
      </div>

      <div className="border-t border-border-hairline pt-3">
        <VisionModelSection />
      </div>

      <div className="border-t border-border-hairline pt-3">
        <label htmlFor="access-code" className="mb-1.5 block text-sm font-medium text-text-primary">
          Mã truy cập (Access Code cho server gateway)
        </label>
        <input
          id="access-code"
          type="password"
          value={settings.accessCode || ''}
          onChange={(e) => updateSettings({ accessCode: e.target.value })}
          placeholder="Nhập mã truy cập..."
          className="field font-mono w-full"
        />
      </div>

      <div className="border-t border-border-hairline pt-3">
        <RoutingSettingsPanel />
      </div>
    </>
  );
}
