'use client';

/**
 * Settings → Lệnh gõ nhanh (Slash commands)
 *
 * Ánh xạ /<tên> tuỳ biến sang recipe.
 *
 * (Tách ra từ components/settings-dialog.tsx — file đó từng dài 1.668 dòng.)
 */

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Trash2 } from 'lucide-react';
import { db, type RecipeRecord } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { BUILTIN_SLASH_COMMANDS } from '@/lib/slash-commands';

export function CustomSlashCommandsSection() {
  const customSlashCommands = useAppStore((s) => s.settings.customSlashCommands ?? {});
  const setCustomSlashCommand = useAppStore((s) => s.setCustomSlashCommand);
  const removeCustomSlashCommand = useAppStore((s) => s.removeCustomSlashCommand);

  const recipes = useLiveQuery(
    () => db.recipes.orderBy('updatedAt').reverse().toArray(),
    [],
    [] as RecipeRecord[],
  );

  const [cmdName, setCmdName] = useState('');
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const cleaned = cmdName.trim().replace(/^\//, '').toLowerCase();
    if (!cleaned) {
      setError('Vui lòng nhập tên lệnh slash (ví dụ: lint hoặc fix).');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
      setError('Tên lệnh chỉ được chứa chữ cái, số, gạch dưới (_) hoặc gạch ngang (-).');
      return;
    }
    if (BUILTIN_SLASH_COMMANDS.some((b) => b.name === cleaned || b.aliases?.includes(cleaned))) {
      setError(`Tên lệnh "/${cleaned}" đã trùng với lệnh mặc định của hệ thống.`);
      return;
    }
    if (!selectedRecipeId) {
      setError('Vui lòng chọn một recipe để liên kết.');
      return;
    }
    setCustomSlashCommand(cleaned, selectedRecipeId);
    setCmdName('');
    setSelectedRecipeId('');
    setError(null);
  };

  const commandEntries = Object.entries(customSlashCommands);

  return (
    <div className="space-y-4 pt-2">
      <div>
        <h4 className="field-label text-[15px]">
          Lệnh gõ nhanh (Slash Commands)
        </h4>
        <p className="mt-0.5 text-xs leading-relaxed text-text-muted">
          Gõ <code className="claude-inline-code">/</code> trong khung chat để điều khiển nhanh hoặc kích hoạt workflow.
        </p>
      </div>

      {/* Danh sách lệnh built-in */}
      <div className="border border-border-hairline bg-surface-raised p-3">
        <h5 className="mb-2 text-xs font-semibold text-text-primary">
          Lệnh hệ thống mặc định
        </h5>
        <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
          {BUILTIN_SLASH_COMMANDS.map((cmd) => (
            <div
              key={cmd.name}
              className="flex flex-col gap-0.5 border border-border-hairline bg-panel-bg p-2"
            >
              <div className="flex items-center gap-1.5 font-mono font-medium text-accent-steel">
                <span>/{cmd.name}</span>
                {cmd.aliases && cmd.aliases.length > 0 && (
                  <span className="text-[10px] font-normal text-[#757d89]">
                    ({cmd.aliases.map((a) => `/${a}`).join(', ')})
                  </span>
                )}
              </div>
              <p className="text-[11px] text-text-muted">
                {cmd.description}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Danh sách custom slash commands */}
      <div className="space-y-2">
        <h5 className="text-xs font-semibold text-text-primary">
          Lệnh tùy biến liên kết Recipe (Custom /&lt;tên&gt; → Recipe)
        </h5>

        {commandEntries.length === 0 ? (
          <p className="text-xs italic text-[#757d89]">
            Chưa có lệnh tùy biến nào. Thêm lệnh bên dưới để mở nhanh workflow yêu thích bằng phím tắt <code className="claude-inline-code">/</code>.
          </p>
        ) : (
          <div className="space-y-1.5">
            {commandEntries.map(([name, recipeId]) => {
              const rec = (recipes ?? []).find((r) => r.id === recipeId);
              return (
                <div
                  key={name}
                  className="flex items-center justify-between border border-border-hairline bg-surface-raised px-3 py-2 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-accent-steel">/{name}</span>
                    <span className="text-[#757d89]">→</span>
                    <span className="font-medium text-text-primary">
                      {rec?.title ?? recipeId}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCustomSlashCommand(name)}
                    className="p-1 text-text-muted transition hover:bg-[#e8704f]/10 hover:text-status-error"
                    title={`Xóa lệnh /${name}`}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Form thêm custom command */}
        <div className="space-y-2 border border-dashed border-border-hairline p-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <input
                value={cmdName}
                onChange={(e) => {
                  setCmdName(e.target.value);
                  if (error) setError(null);
                }}
                className="field-sm w-full"
                placeholder="Tên lệnh (vd: lint hoặc test)"
                aria-label="Tên lệnh slash"
              />
            </div>
            <div>
              <select
                value={selectedRecipeId}
                onChange={(e) => {
                  setSelectedRecipeId(e.target.value);
                  if (error) setError(null);
                }}
                className="field-sm w-full"
                aria-label="Chọn Recipe"
              >
                <option value="">-- Chọn Recipe liên kết --</option>
                {(recipes ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="button"
            onClick={handleAdd}
            className="btn-secondary w-full py-1.5 text-xs font-medium"
          >
            + Gán lệnh slash vào Recipe
          </button>
          {error && <p className="notice-error text-xs">{error}</p>}
        </div>
      </div>
    </div>
  );
}

