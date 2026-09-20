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
import {
  DEFAULT_MODEL_ROUTING,
  normalizeModelRoutingConfig,
  type ModelRoutingConfig,
} from '@/lib/model-routing';
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
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-hairline pb-2.5">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Mixture-of-Models Routing</h3>
          <p className="text-[11px] text-[#757d89]">
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
            className="btn-secondary px-2 py-1 text-[11px] text-[#757d89] hover:text-status-error"
          >
            <RotateCcw size={12} />
          </button>
        </div>
      </div>

      {importStatus && (
        <p className="border border-accent-steel/30 bg-[#6a9fcc]/10 p-2 text-[11px] text-accent-steel">
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
              className={`rounded-none px-2.5 py-1 text-[11px] transition-colors ${
                isSelected
                  ? 'bg-[#6a9fcc] font-semibold text-[#0d1116]'
                  : 'bg-panel-bg text-text-muted hover:bg-panel-soft hover:text-text-primary'
              }`}
            >
              {desc.label}
            </button>
          );
        })}
      </div>

      {/* Active Category Description */}
      <div className="border border-border-hairline bg-surface-raised p-2.5">
        <div className="mb-0.5 font-semibold text-text-primary">
          {CATEGORY_DESCRIPTIONS[activeCat]?.label}
        </div>
        <div className="text-[11px] leading-relaxed text-[#757d89]">
          {CATEGORY_DESCRIPTIONS[activeCat]?.description}
        </div>
      </div>

      {/* Chain list for active category */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[#757d89]">
          Chuỗi ưu tiên (Fallback Chain) — vị trí 1 thử trước
        </div>

        {currentChain.map((entry, idx) => (
          <div
            key={idx}
            className="flex items-center gap-2 border border-border-hairline bg-surface-raised p-2"
          >
            <span className="w-5 text-center font-bold text-text-muted">#{idx + 1}</span>

            {/* Model select */}
            <select
              value={entry.model}
              onChange={(e) => handleModelChange(idx, e.target.value)}
              className="flex-1 rounded-none border border-border-hairline bg-bg-deep px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-[#6a9fcc]"
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
              className="w-24 rounded-none border border-border-hairline bg-bg-deep px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-[#6a9fcc]"
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
                className="p-1 text-[#757d89] hover:text-text-primary disabled:opacity-30"
                title="Di chuyển lên"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                disabled={idx === currentChain.length - 1}
                onClick={() => handleMove(idx, 'down')}
                className="p-1 text-[#757d89] hover:text-text-primary disabled:opacity-30"
                title="Di chuyển xuống"
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                disabled={currentChain.length <= 1}
                onClick={() => handleRemove(idx)}
                className="p-1 text-[#757d89] hover:text-status-error disabled:opacity-30"
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
          className="btn-secondary flex w-full items-center justify-center gap-1.5 py-1.5 text-xs text-text-primary"
        >
          <Plus size={14} />
          Thêm model dự phòng vào chuỗi
        </button>
      </div>

      <div className="border-t border-border-hairline pt-3">
        <LeadWorkerRoutingSection />
      </div>
    </div>
  );
}

/* ------------------ Lead/Worker routing (P1-5) ------------------ */

function RoutingModelSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const orphan = Boolean(value) && !options.some((o) => o.id === value);
  return (
    <div className="flex-1">
      <label htmlFor={id} className="mb-1 block text-[11px] font-semibold text-[#757d89]">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-none border border-border-hairline bg-bg-deep px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-[#6a9fcc]"
      >
        <option value="">— Theo model chính —</option>
        {orphan && <option value={value}>{value} (không còn trong danh sách)</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} ({m.id})
          </option>
        ))}
      </select>
    </div>
  );
}

function LeadWorkerRoutingSection() {
  const modelRouting = useAppStore((s) => s.settings.modelRouting) ?? DEFAULT_MODEL_ROUTING;
  const updateSettings = useAppStore((s) => s.updateSettings);
  const activeProvider = useAppStore((s) => s.activeProvider);

  const patch = (p: Partial<ModelRoutingConfig>) =>
    updateSettings({ modelRouting: normalizeModelRoutingConfig({ ...modelRouting, ...p }) });

  /* Danh sách chọn: catalog built-in + model của provider đang bật (BYOK có
     thể định nghĩa model riêng qua /v1/models). Giá trị đã chọn mà rơi khỏi
     danh sách (đổi provider) vẫn hiện thành option mồ côi — không âm thầm xoá. */
  const modelOptions = (() => {
    const base = AVAILABLE_MODELS.map((m) => ({ id: m.id, label: m.name || m.id }));
    const known = new Set(base.map((m) => m.id));
    for (const m of activeProvider?.models ?? []) {
      if (!known.has(m.id)) base.push({ id: m.id, label: m.name || m.id });
    }
    return base;
  })();

  const numberField = (
    id: string,
    label: string,
    key: 'leadTurns' | 'failureThreshold' | 'fallbackTurns',
    min: number,
    max: number,
    hint: string,
  ) => (
    <div className="flex-1">
      <label htmlFor={id} className="mb-1 block text-[11px] font-semibold text-[#757d89]">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={modelRouting[key]}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) patch({ [key]: v } as Partial<ModelRoutingConfig>);
        }}
        className="w-full rounded-none border border-border-hairline bg-bg-deep px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-[#6a9fcc]"
      />
      <p className="mt-0.5 text-[10px] leading-relaxed text-text-muted">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">Lead/Worker Routing</h3>
          <p className="text-[11px] text-[#757d89]">
            Model mạnh chạy vài lượt đầu (lập kế hoạch) rồi model rẻ thực thi; thất bại liên tiếp
            thì tự quay lại model mạnh. Lệnh <code className="text-accent-steel">/plan</code> dùng
            planner model riêng.
          </p>
        </div>
        <label className="flex flex-none cursor-pointer items-center gap-1.5 pt-1 text-[11px] text-text-primary">
          <input
            type="checkbox"
            checked={modelRouting.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
            className="h-3.5 w-3.5 rounded-none accent-[#6a9fcc]"
          />
          Bật
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <RoutingModelSelect
          id="lead-model"
          label="Lead (mạnh)"
          value={modelRouting.leadModel}
          options={modelOptions}
          onChange={(v) => patch({ leadModel: v })}
        />
        <RoutingModelSelect
          id="worker-model"
          label="Worker (rẻ)"
          value={modelRouting.workerModel}
          options={modelOptions}
          onChange={(v) => patch({ workerModel: v })}
        />
        <RoutingModelSelect
          id="planner-model"
          label="Planner (/plan)"
          value={modelRouting.plannerModel}
          options={modelOptions}
          onChange={(v) => patch({ plannerModel: v })}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {numberField('lead-turns', 'Số lượt lead', 'leadTurns', 1, 20, 'Mặc định 3')}
        {numberField(
          'failure-threshold',
          'Ngưỡng thất bại',
          'failureThreshold',
          1,
          10,
          'Số lỗi liên tiếp để quay lại lead (mặc định 2)',
        )}
        {numberField(
          'fallback-turns',
          'Số lượt fallback',
          'fallbackTurns',
          0,
          10,
          'Giữ lead bao lâu trước khi về worker (mặc định 2)',
        )}
      </div>

      <p className="text-[10.5px] leading-relaxed text-text-muted">
        &ldquo;Thất bại&rdquo; = tool trả lỗi / lệnh build-test exit ≠ 0 / bạn phàn nàn
        (&ldquo;sai rồi&rdquo;, &ldquo;làm lại&rdquo;, &ldquo;wrong&rdquo;…). Lỗi mạng 429/5xx
        của gateway KHÔNG được tính — đã có retry im lặng riêng. Việc bạn TỪ CHỐI một phê duyệt
        cũng không tính là thất bại. Vai trò của từng lượt hiện thành badge{' '}
        <code className="text-accent-steel">lead</code>/<code className="text-text-muted">worker</code>{' '}
        dưới câu trả lời.
      </p>
    </div>
  );
}
