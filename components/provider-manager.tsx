'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react';
import { db } from '@/lib/db';
import {
  deleteProvider,
  ensureProviderSeed,
  listProviders,
  newProviderId,
  syncActiveProviderSnapshot,
  upsertProvider,
  type ProviderConfig,
} from '@/lib/providers';
import { useAppStore, SERVER_PROVIDER_ID } from '@/lib/store';

/** Quản lý nhà cung cấp API (provider presets) trong Settings. */
export function ProviderManager() {
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const setActiveProvider = useAppStore((s) => s.setActiveProvider);
  const accessCode = useAppStore((s) => s.settings.accessCode);

  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await ensureProviderSeed();
    setProviders(await listProviders());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = async (id: string) => {
    setActiveProvider(id);
    await syncActiveProviderSnapshot(id);
    setStatus(id === SERVER_PROVIDER_ID ? 'Đang dùng máy chủ mặc định.' : 'Đã chuyển nhà cung cấp.');
  };

  const save = async () => {
    if (!editing) return;
    const name = editing.name.trim() || 'Provider';
    if (!editing.baseUrl.trim()) {
      setStatus('Thiếu địa chỉ baseURL.');
      return;
    }
    const record = { ...editing, name, updatedAt: Date.now() };
    await upsertProvider(record);
    await refresh();
    setEditing(null);
    setStatus(`Đã lưu "${name}".`);
    // Đang active provider này → refresh snapshot (baseUrl/key có thể đổi).
    if (useAppStore.getState().activeProviderId === record.id) {
      await syncActiveProviderSnapshot(record.id);
    }
  };

  /** Test kết nối + tải danh sách model về provider record. */
  const testAndLoadModels = async (p: ProviderConfig) => {
    setBusyId(p.id);
    setStatus(`Đang kết nối ${p.name}…`);
    try {
      const res = await fetch('/api/providers/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessCode ? { Authorization: `Bearer ${accessCode}` } : {}),
        },
        body: JSON.stringify({ baseUrl: p.baseUrl, apiKey: p.apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`${p.name}: ${data?.error ?? 'lỗi kết nối'}`);
        return;
      }
      const models = (data.models ?? []) as ProviderConfig['models'];
      await upsertProvider({ ...p, models, modelsFetchedAt: data.fetchedAt });
      await refresh();
      if (useAppStore.getState().activeProviderId === p.id) {
        await syncActiveProviderSnapshot(p.id);
      }
      setStatus(`${p.name}: kết nối OK — ${models?.length ?? 0} model.`);
    } catch {
      setStatus(`${p.name}: không gọi được /api/providers/models.`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (p: ProviderConfig) => {
    await deleteProvider(p.id);
    await refresh();
    setStatus(`Đã xoá "${p.name}".`);
  };

  const startNew = () =>
    setEditing({
      id: newProviderId(),
      name: '',
      baseUrl: '',
      apiKey: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

  const inputCls =
    'w-full rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm text-zinc-800 outline-none focus:border-[#0A7E8C]';

  return (
    <div className="space-y-3">
      {/* Máy chủ mặc định */}
      <label
        className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border px-3 py-2.5 ${
          activeProviderId === SERVER_PROVIDER_ID
            ? 'border-[#0A7E8C]/50 bg-[#0A7E8C]/5'
            : 'border-zinc-200 bg-white'
        }`}
      >
        <span className="flex items-center gap-2 text-sm text-zinc-800">
          <Server size={15} className="text-zinc-500" />
          <span>
            Máy chủ mặc định
            <span className="block text-[11px] text-zinc-500">
              Dùng OPENAI_BASE_URL + key pool cấu hình trên server
            </span>
          </span>
        </span>
        <input
          type="radio"
          name="provider"
          className="accent-[#0A7E8C]"
          checked={activeProviderId === SERVER_PROVIDER_ID}
          onChange={() => void choose(SERVER_PROVIDER_ID)}
        />
      </label>

      {providers.map((p) => {
        const active = activeProviderId === p.id;
        return (
          <div
            key={p.id}
            className={`rounded-xl border px-3 py-2.5 ${
              active ? 'border-[#0A7E8C]/50 bg-[#0A7E8C]/5' : 'border-zinc-200 bg-white'
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="provider"
                  className="accent-[#0A7E8C]"
                  checked={active}
                  onChange={() => void choose(p.id)}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-zinc-800">{p.name}</span>
                  <span className="block truncate text-[11px] text-zinc-500">
                    {p.baseUrl} · {p.models?.length ?? 0} model
                  </span>
                </span>
              </label>
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  title="Kiểm tra kết nối + tải danh sách model"
                  onClick={() => void testAndLoadModels(p)}
                  disabled={busyId === p.id}
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-[#0A7E8C] disabled:opacity-40"
                >
                  {busyId === p.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                </button>
                <button
                  type="button"
                  title="Sửa"
                  onClick={() => setEditing(p)}
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  title="Xoá"
                  onClick={() => void remove(p)}
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 size={14} />
                </button>
              </span>
            </div>
          </div>
        );
      })}

      {editing ? (
        <div className="space-y-2 rounded-xl border border-[#0A7E8C]/40 bg-[#0A7E8C]/[0.03] p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-700">
              {providers.some((x) => x.id === editing.id) ? 'Sửa nhà cung cấp' : 'Thêm nhà cung cấp'}
            </span>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-100"
            >
              <X size={14} />
            </button>
          </div>
          <input
            className={inputCls}
            placeholder="Tên (vd: crax-gpt)"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="Base URL (vd: https://gpt.crax.lol/v1)"
            value={editing.baseUrl}
            onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
          />
          <input
            className={inputCls}
            placeholder="API key (có thể bỏ trống)"
            value={editing.apiKey}
            onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              className="flex items-center gap-1.5 rounded-lg bg-[#0A7E8C] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#086E7A]"
            >
              <Check size={13} /> Lưu
            </button>
            <button
              type="button"
              onClick={() =>
                void testAndLoadModels({
                  ...editing,
                  name: editing.name.trim() || 'Provider',
                })
              }
              disabled={busyId === editing.id}
              className="flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-40"
            >
              {busyId === editing.id ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Kiểm tra kết nối &amp; lưu model
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startNew}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-300 py-2 text-xs font-medium text-zinc-600 hover:border-[#0A7E8C]/50 hover:text-[#0A7E8C]"
        >
          <Plus size={14} /> Thêm nhà cung cấp
        </button>
      )}

      {status && <p className="text-[11px] text-zinc-500">{status}</p>}
    </div>
  );
}
