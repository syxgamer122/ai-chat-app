'use client';

/**
 * Settings → Skills (P0-3): liệt kê SKILL.md tìm thấy (workspace + toàn cục),
 * bật/tắt từng cái (lọc khỏi chỉ mục gửi lên model), tạo skill mới bằng cách
 * scaffold .vyen/skills/<name>/SKILL.md ngay trong workspace.
 */

import { useCallback, useEffect, useState } from 'react';
import { FolderPlus, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import {
  scanDiskSkills,
  scaffoldSkillFile,
  type DiskSkillEntry,
} from '@/lib/skills/disk';
import { buildDiskSkillAdapters } from '@/lib/skills/client-adapters';
import { desktopFsWrite } from '@/lib/desktop-fs';
import { requireWorkspace, fsWrite } from '@/lib/fs-access';
import { isVyenDesktop } from '@/lib/desktop-bridge';

export function DiskSkillsSection() {
  const disabledSkills = useAppStore((s) => s.settings.disabledSkills);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [entries, setEntries] = useState<DiskSkillEntry[]>([]);
  const [errors, setErrors] = useState<Array<{ source: string; error: string }>>([]);
  const [scanning, setScanning] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const rescan = useCallback(async () => {
    setScanning(true);
    try {
      const scan = await scanDiskSkills(buildDiskSkillAdapters());
      setEntries(scan.entries);
      setErrors(scan.errors);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void rescan();
  }, [rescan]);

  const toggle = (name: string) => {
    const next = disabledSkills.includes(name)
      ? disabledSkills.filter((n) => n !== name)
      : [...disabledSkills, name];
    updateSettings({ disabledSkills: next });
  };

  const createSkill = useCallback(async () => {
    const name = newName.trim();
    if (!/^[a-zA-Z0-9][\w.-]*$/.test(name)) {
      setNotice('Tên skill chỉ gồm chữ-số-._- , không bắt đầu bằng dấu.');
      return;
    }
    if (!newDesc.trim()) {
      setNotice('Cần mô tả ngắn để agent biết khi nào dùng skill này.');
      return;
    }
    const content = scaffoldSkillFile(name, newDesc.trim());
    try {
      if (isVyenDesktop()) {
        await desktopFsWrite(`.vyen/skills/${name}/SKILL.md`, content);
      } else {
        const ws = await requireWorkspace();
        if (!ws.ok) throw new Error(ws.error);
        await fsWrite(ws.deps, `.vyen/skills/${name}/SKILL.md`, content);
      }
      setNewName('');
      setNewDesc('');
      setNotice(`Đã tạo .vyen/skills/${name}/SKILL.md — mở file để viết nội dung.`);
      await rescan();
    } catch (err) {
      setNotice(`Tạo skill thất bại: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [newName, newDesc, rescan]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-800">Kỹ năng (SKILL.md)</h3>
        <button
          type="button"
          onClick={() => void rescan()}
          className="flex items-center gap-1.5 border border-zinc-300 px-2 py-1 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          <RefreshCw size={11} className={scanning ? 'animate-spin' : undefined} aria-hidden="true" />
          Quét lại
        </button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-600">
        Kỹ năng dạng file <code className="claude-inline-code">SKILL.md</code> trong{' '}
        <code className="claude-inline-code">.vyen/skills/</code> của workspace và{' '}
        <code className="claude-inline-code">~/.vyen/skills/</code> (desktop). Agent chỉ thấy{' '}
        <em>tên + mô tả</em>; nội dung được nạp khi agent gọi <code className="claude-inline-code">skill_load</code>.
      </p>

      <ul className="space-y-1.5">
        {entries.map((e) => {
          const disabled = disabledSkills.includes(e.name);
          return (
            <li key={`${e.source}:${e.name}`} className="flex items-start gap-2">
              <input
                id={`skill-toggle-${e.source}-${e.name}`}
                type="checkbox"
                checked={!disabled}
                onChange={() => toggle(e.name)}
                className="mt-0.5 h-4 w-4 accent-sky-600"
              />
              <label htmlFor={`skill-toggle-${e.source}-${e.name}`} className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-xs font-medium text-zinc-800">
                  {e.name}
                  <span className="ml-1.5 font-normal text-zinc-400">{e.source === 'workspace' ? 'workspace' : 'toàn cục'}</span>
                  {e.version && <span className="ml-1.5 font-mono text-[10px] text-zinc-400">v{e.version}</span>}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">{e.description}</span>
              </label>
            </li>
          );
        })}
        {!scanning && entries.length === 0 && (
          <li className="text-xs text-zinc-500">
            Chưa tìm thấy skill nào. Kết nối workspace rồi bấm Quét lại, hoặc tạo skill mới bên dưới.
          </li>
        )}
        {scanning && <li className="text-xs text-zinc-500">Đang quét…</li>}
      </ul>

      {errors.length > 0 && (
        <div role="status" className="border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          {errors.slice(0, 3).map((e) => (
            <div key={e.source} className="truncate">
              {e.source}: {e.error}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800">
          <FolderPlus size={13} aria-hidden="true" />
          Tạo skill mới
        </div>
        <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="tên-khong-dau"
            aria-label="Tên skill mới"
            className="claude-input font-mono text-xs"
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Mô tả ngắn: dùng khi nào"
            aria-label="Mô tả skill mới"
            className="claude-input text-xs"
          />
        </div>
        <button
          type="button"
          onClick={() => void createSkill()}
          className="border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-800 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Scaffold .vyen/skills/…/SKILL.md
        </button>
        {notice && <p role="status" className="text-[11px] text-sky-700 dark:text-sky-300">{notice}</p>}
      </div>
    </div>
  );
}
