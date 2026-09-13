'use client';

import React, { useState } from 'react';
import { useAppStore } from '@/lib/store';
import {
  ALL_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  DEFAULT_CHAINS,
  validateModelChains,
  type CategoryId,
  type ChainEntry,
} from '@/lib/routing/categories';
import { EFFORT_LEVELS, type Effort } from '@/lib/model-contracts';
import { AVAILABLE_MODELS } from '@/lib/models';
import { Download, Upload, RotateCcw, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';

export function RoutingSettingsPanel() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const chains = settings.modelChains ?? DEFAULT_CHAINS;
  const [activeCat, setActiveCat] = useState<CategoryId>('architect');
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const currentChain = chains[activeCat] ?? DEFAULT_CHAINS[activeCat] ?? [];

  const updateCurrentChain = (newChain: ChainEntry[]) => {
    const updated = {
      ...chains,
      [activeCat]: newChain,
    };
    updateSettings({ modelChains: updated });
  };

  const handleModelChange = (index: number, model: string) => {
    const next = [...currentChain];
    next[index] = { ...next[index], model };
    updateCurrentChain(next);
  };

  const handleEffortChange = (index: number, effort: Effort) => {
    const next = [...currentChain];
    next[index] = { ...next[index], effort };
    updateCurrentChain(next);
  };

  const handleMove = (index: number, direction: 'up' | 'down') => {
    const next = [...currentChain];
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= next.length) return;
    const temp = next[index];
    next[index] = next[targetIdx];
    next[targetIdx] = temp;
    updateCurrentChain(next);
  };

  const handleRemove = (index: number) => {
    if (currentChain.length <= 1) return; // Giữ ít nhất 1 entry
    const next = currentChain.filter((_, i) => i !== index);
    updateCurrentChain(next);
  };

  const handleAdd = () => {
    const next = [...currentChain, { model: 'gpt-5-6-sol', effort: 'medium' as Effort }];
    updateCurrentChain(next);
  };

  const handleResetDefaults = () => {
    if (window.confirm('Khôi phục toàn bộ cấu hình chuỗi model về mặc định ban đầu?')) {
      updateSettings({ modelChains: DEFAULT_CHAINS });
    }
  };

  const handleExportJson = () => {
    const data = JSON.stringify(chains, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'model-chains.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const rawJson = JSON.parse(String(event.target?.result ?? '{}'));
        const validatedChains = validateModelChains(rawJson);
        updateSettings({ modelChains: validatedChains });
        setImportStatus('Nạp cấu hình JSON thành công!');
        setTimeout(() => setImportStatus(null), 3000);
      } catch (err: any) {
        setImportStatus(`Lỗi: ${err?.message ?? 'Không đọc được file'}`);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-4 text-xs font-mono">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-700/50 pb-2.5">
        <div>
          <h3 className="text-sm font-semibold text-zinc-200">Mixture-of-Models Routing</h3>
          <p className="text-[11px] text-zinc-400">
            Cấu hình chuỗi dự phòng model:effort theo từng hạng mục công việc.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleExportJson}
            title="Xuất cấu hình JSON"
            className="btn-secondary px-2 py-1 text-[11px] flex items-center gap-1"
          >
            <Download size={12} />
            Export
          </button>
          <label className="btn-secondary px-2 py-1 text-[11px] flex items-center gap-1 cursor-pointer">
            <Upload size={12} />
            Import
            <input type="file" accept=".json" onChange={handleImportJson} className="hidden" />
          </label>
          <button
            type="button"
            onClick={handleResetDefaults}
            title="Khôi phục mặc định"
            className="btn-secondary px-2 py-1 text-[11px] text-zinc-400 hover:text-red-400"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {importStatus && (
        <p className="rounded bg-primary/10 border border-primary/30 p-2 text-primary text-[11px]">
          {importStatus}
        </p>
      )}

      {/* Category selector buttons */}
      <div className="flex flex-wrap gap-1">
        {ALL_CATEGORIES.map((cat) => {
          const desc = CATEGORY_DESCRIPTIONS[cat];
          const isSelected = activeCat === cat;
          return (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCat(cat)}
              className={`rounded px-2.5 py-1 text-[11px] transition-colors ${
                isSelected
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
            >
              {desc.label}
            </button>
          );
        })}
      </div>

      {/* Active Category Description */}
      <div className="rounded border border-zinc-700/60 bg-zinc-900/50 p-2.5">
        <div className="font-semibold text-zinc-300 mb-0.5">
          {CATEGORY_DESCRIPTIONS[activeCat]?.label}
        </div>
        <div className="text-[11px] text-zinc-400 leading-relaxed">
          {CATEGORY_DESCRIPTIONS[activeCat]?.description}
        </div>
      </div>

      {/* Chain list for active category */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
          Chuỗi ưu tiên (Fallback Chain) — vị trí 1 thử trước
        </div>

        {currentChain.map((entry, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 rounded border border-zinc-700 bg-zinc-800/80 p-2"
          >
            <span className="w-5 text-center font-bold text-zinc-500">#{idx + 1}</span>

            {/* Model select */}
            <select
              value={entry.model}
              onChange={(e) => handleModelChange(idx, e.target.value)}
              className="flex-1 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {AVAILABLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.id})
                </option>
              ))}
            </select>

            {/* Effort select */}
            <select
              value={entry.effort}
              onChange={(e) => handleEffortChange(idx, e.target.value as Effort)}
              className="w-24 rounded border border-zinc-600 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-primary"
            >
              {EFFORT_LEVELS.map((eff) => (
                <option key={eff} value={eff}>
                  {eff}
                </option>
              ))}
            </select>

            {/* Reorder & Remove buttons */}
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                disabled={idx === 0}
                onClick={() => handleMove(idx, 'up')}
                className="p-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                title="Di chuyển lên"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                disabled={idx === currentChain.length - 1}
                onClick={() => handleMove(idx, 'down')}
                className="p-1 text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                title="Di chuyển xuống"
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                disabled={currentChain.length <= 1}
                onClick={() => handleRemove(idx)}
                className="p-1 text-zinc-400 hover:text-red-400 disabled:opacity-30"
                title="Xóa model khỏi chuỗi"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={handleAdd}
          className="btn-secondary w-full py-1.5 text-xs flex items-center justify-center gap-1.5 text-zinc-300"
        >
          <Plus size={14} />
          Thêm model dự phòng vào chuỗi
        </button>
      </div>
    </div>
  );
}
