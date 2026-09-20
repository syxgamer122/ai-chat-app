'use client';

/**
 * Settings → tab "Mở rộng"
 *
 * Máy chủ MCP, skills trên đĩa và lệnh gõ nhanh.
 *
 * (Tách ra từ components/settings-dialog.tsx.)
 *
 * Không nhận prop: tự đọc `useAppStore` như các section khác trong
 * components/settings/ — tránh luồn chục prop qua nhiều tầng chỉ để lấy `settings`.
 */

import dynamic from 'next/dynamic';
import { useAppStore } from '@/lib/store';
import { SectionLoading } from '@/components/settings/section-loading';
import { DiskSkillsSection } from '@/components/settings-skills';
import { CustomSlashCommandsSection } from '@/components/settings/slash-commands-section';

const McpSettingsPanel = dynamic(() => import('@/components/mcp/mcp-settings-panel').then((m) => m.McpSettingsPanel), { ssr: false, loading: SectionLoading });

export function ExtensionsTab() {
  const settings = useAppStore((s) => s.settings);

  return (
    <>
      <div className="border-b border-border-hairline pb-2">
        <h3 className="text-sm font-semibold text-text-primary">Mở rộng</h3>
        <p className="mt-0.5 text-[11px] text-text-muted">
          Tích hợp máy chủ MCP bên ngoài, kỹ năng SKILL.md và lệnh gõ nhanh slash commands.
        </p>
      </div>

      {/* MCP Settings */}
      <McpSettingsPanel />

      <div className="settings-card settings-card-body">
        <DiskSkillsSection />
      </div>

      <div className="settings-card settings-card-body">
        <CustomSlashCommandsSection />
      </div>
    </>
  );
}
