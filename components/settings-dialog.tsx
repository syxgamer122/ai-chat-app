'use client';

import { Z_CLASS } from '@/lib/ui-z';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { Search, X } from 'lucide-react';
import { useFocusTrap } from '@/lib/hooks/use-focus-trap';
import { AppearanceTab } from '@/components/settings/appearance-tab';
import { ProvidersTab } from '@/components/settings/providers-tab';
import { SafetyTab } from '@/components/settings/safety-tab';
import { ExtensionsTab } from '@/components/settings/extensions-tab';
import { MemoryTab } from '@/components/settings/memory-tab';
import { DataTab } from '@/components/settings/data-tab';
import {
  SETTINGS_TABS,
  SETTINGS_SEARCH_ITEMS,
  resolveSettingsTab,
  type SettingsTab,
} from '@/components/settings/settings-tabs';

/*
 * Re-export để importer cũ không phải đổi đường dẫn — `tests/a11y-contract.test.ts`
 * đọc `SETTINGS_TABS` từ chính file này để kiểm chứng liên kết ARIA tab ↔ panel.
 */
export { SETTINGS_TABS };
export type { SettingsTab };

type Status = { kind: 'idle' | 'busy' | 'ok' | 'error'; message?: string };

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';


export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updatePerf = useAppStore((s) => s.updatePerf);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const settingsInitialTab = useAppStore((s) => s.settingsInitialTab);

  const initialTab = resolveSettingsTab(settingsInitialTab);
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [visited, setVisited] = useState<Set<SettingsTab>>(() => new Set<SettingsTab>([initialTab]));
  const [searchQuery, setSearchQuery] = useState('');

  
  const panelRef = useRef<HTMLDivElement>(null);

  const switchTab = useCallback((t: SettingsTab) => {
    setTab(t);
    setVisited((prev) => {
      if (prev.has(t)) return prev;
      const next = new Set(prev);
      next.add(t);
      return next;
    });
  }, []);

  useEffect(() => {
    if (settingsInitialTab) {
      const target = resolveSettingsTab(settingsInitialTab);
      switchTab(target);
    }
  }, [settingsInitialTab, switchTab]);

  useFocusTrap(panelRef, {
    active: true,
    onEscape: onClose,
  });

  

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = SETTINGS_TABS.findIndex((t) => t.id === tab);
    const next =
      e.key === 'ArrowRight'
        ? (i + 1) % SETTINGS_TABS.length
        : (i - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    switchTab(SETTINGS_TABS[next].id);
    (e.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
  };

  /* Tìm kiếm trong cài đặt */
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return SETTINGS_SEARCH_ITEMS.filter((item) => {
      const haystack = `${item.title} ${item.description} ${item.keywords}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [searchQuery]);

  const handleSelectSearchResult = (targetTab: SettingsTab) => {
    switchTab(targetTab);
    setSearchQuery('');
  };

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className={`fixed inset-0 ${Z_CLASS.system} flex animate-fade-in items-center justify-center bg-black/60 p-4`}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="pi-frame relative flex max-h-[90dvh] w-full max-w-xl animate-pop-in flex-col overflow-hidden rounded-none border border-border-hairline bg-panel-bg focus:outline-none font-mono"
      >
        <span className="pi-corner-tl" />
        <span className="pi-corner-tr" />
        <span className="pi-corner-bl" />
        <span className="pi-corner-br" />

        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-border-hairline bg-surface-raised px-5 py-3">
          <h2
            id="settings-dialog-title"
            className="flex items-center gap-1.5 font-pixel text-[16px] font-semibold tracking-[0.05em] text-text-primary [image-rendering:pixelated]"
          >
            <span className="font-bold text-accent-steel">$</span>
            <span>settings</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng cài đặt"
            className="icon-btn-sm"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search Bar */}
        <div className="relative flex-shrink-0 border-b border-border-hairline/60 bg-surface-raised/70 px-5 py-2">
          <div className="relative">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#757d89]"
            />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm cài đặt (vd: hiệu ứng, temperature, mcp, sao lưu, quyền, routing...)"
              className="field-sm w-full pl-8 text-xs"
              aria-label="Tìm kiếm trong cài đặt"
            />
          </div>

          {searchResults.length > 0 && (
            <div className="absolute left-5 right-5 top-full z-20 mt-1 max-h-56 overflow-y-auto border border-border-hairline bg-surface-raised shadow-xl">
              {searchResults.map((item) => {
                const tabMeta = SETTINGS_TABS.find((t) => t.id === item.tab);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleSelectSearchResult(item.tab)}
                    className="flex w-full items-start justify-between gap-2 border-b border-border-hairline/30 p-2.5 text-left text-xs hover:bg-panel-bg"
                  >
                    <div>
                      <div className="font-semibold text-text-primary">{item.title}</div>
                      <div className="text-[11px] text-text-muted">{item.description}</div>
                    </div>
                    <span className="flex-shrink-0 border border-border-hairline bg-panel-bg px-1.5 py-0.5 text-[10px] text-accent-steel">
                      {tabMeta?.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Tab List */}
        <div className="flex-shrink-0 px-5 pt-3">
          <div
            className="no-scrollbar flex gap-1 overflow-x-auto rounded-none border border-border-hairline bg-bg-deep p-1"
            role="tablist"
            aria-label="Nhóm cài đặt"
          >
            {SETTINGS_TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls={`settings-panel-${t.id}`}
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => switchTab(t.id)}
                  onKeyDown={onTabKeyDown}
                  className={`flex flex-shrink-0 items-center gap-1.5 rounded-none px-2.5 py-1 text-xs font-mono transition-colors duration-100 ${
                    tab === t.id
                      ? 'bg-[#6a9fcc] font-semibold text-[#0d1116]'
                      : 'text-text-muted hover:bg-surface-raised hover:text-text-primary'
                  }`}
                >
                  <Icon size={12} />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Panels Container */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* TAB 1: GIAO DIỆN & TRẢI NGHIỆM */}
          <div
            role="tabpanel"
            id="settings-panel-appearance"
            aria-labelledby="settings-tab-appearance"
            hidden={tab !== 'appearance'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'appearance' ? 'block' : 'hidden'}`}
          >
            {visited.has('appearance') && <AppearanceTab />}
          </div>

          {/* TAB 2: MODEL & NHÀ CUNG CẤP */}
          <div
            role="tabpanel"
            id="settings-panel-providers"
            aria-labelledby="settings-tab-providers"
            hidden={tab !== 'providers'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'providers' ? 'block' : 'hidden'}`}
          >
            {visited.has('providers') && <ProvidersTab />}
          </div>

          {/* TAB 3: QUYỀN & AN TOÀN */}
          <div
            role="tabpanel"
            id="settings-panel-safety"
            aria-labelledby="settings-tab-safety"
            hidden={tab !== 'safety'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'safety' ? 'block' : 'hidden'}`}
          >
            {visited.has('safety') && <SafetyTab />}
          </div>

          {/* TAB 4: MỞ RỘNG */}
          <div
            role="tabpanel"
            id="settings-panel-extensions"
            aria-labelledby="settings-tab-extensions"
            hidden={tab !== 'extensions'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'extensions' ? 'block' : 'hidden'}`}
          >
            {visited.has('extensions') && <ExtensionsTab />}
          </div>

          {/* TAB 5: BỘ NHỚ */}
          <div
            role="tabpanel"
            id="settings-panel-memory"
            aria-labelledby="settings-tab-memory"
            hidden={tab !== 'memory'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'memory' ? 'block' : 'hidden'}`}
          >
            {visited.has('memory') && <MemoryTab />}
          </div>

          {/* TAB 6: DỮ LIỆU & TỰ ĐỘNG HOÁ */}
          <div
            role="tabpanel"
            id="settings-panel-data"
            aria-labelledby="settings-tab-data"
            hidden={tab !== 'data'}
            className={`settings-panel px-5 py-5 sm:px-6 space-y-4 ${tab === 'data' ? 'block' : 'hidden'}`}
          >
            {visited.has('data') && <DataTab />}
          </div>
        </div>
      </div>
    </div>
  );
}
