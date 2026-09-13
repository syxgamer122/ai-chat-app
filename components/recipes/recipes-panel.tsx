'use client';

/**
 * Panel Recipes — danh sách recipe (Dexie + workspace .vyen/recipes), form
 * tham số, Run / Export / Import. Recipe từ liên kết share luôn mở ở chế độ
 * XEM TRƯỚC: không có gì chạy cho tới khi người dùng bấm Run (chống
 * prompt-injection qua link).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ChefHat, FileDown, FileUp, Link2, Play, Trash2, X } from 'lucide-react';
import { db, type RecipeRecord } from '@/lib/db';
import {
  coerceParamValue,
  discoverWorkspaceRecipes,
  importRecipeText,
  readRecipeRecord,
  deleteRecipe as deleteRecipeRecord,
  serializeRecipe,
  buildRecipeShareLink,
  resolveParameters,
  prepareRecipeRun,
  type Recipe,
  type RecipeParamValues,
} from '@/lib/recipes';
import { useRecipeUiStore, type ActiveRecipeRun } from '@/lib/recipes/run-store';
import { desktopFsList, desktopFsRead } from '@/lib/desktop-fs';
import { requireWorkspace } from '@/lib/fs-access';
import { isVyenDesktop } from '@/lib/desktop-bridge';

/* ---------------- pure helpers (test được) ---------------- */

/** Ghép danh sách hiển thị: DB trước (mới nhất trước), workspace sau. */
export interface RecipeListItem {
  key: string;
  recipe: Recipe;
  origin: 'db' | 'workspace' | 'link';
  recordId?: string;
  workspacePath?: string;
  updatedAt?: number;
}

export function mergeRecipeLists(
  dbRecords: readonly RecipeRecord[],
  workspace: readonly { path: string; recipe: Recipe }[],
): RecipeListItem[] {
  const items: RecipeListItem[] = [];
  for (const r of dbRecords) {
    const recipe = readRecipeRecord(r);
    if (recipe) {
      items.push({ key: `db:${r.id}`, recipe, origin: 'db', recordId: r.id, updatedAt: r.updatedAt });
    }
  }
  for (const w of workspace) {
    items.push({ key: `ws:${w.path}`, recipe: w.recipe, origin: 'workspace', workspacePath: w.path });
  }
  return items;
}

/** Giá trị mặc định cho form theo khai báo tham số. */
export function defaultFormValues(recipe: Recipe): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of recipe.parameters ?? []) {
    out[p.key] = p.default !== undefined ? String(p.default) : p.input_type === 'boolean' ? 'false' : '';
  }
  return out;
}

/* ---------------- UI ---------------- */

function ParamField({
  def,
  value,
  onChange,
}: {
  def: NonNullable<Recipe['parameters']>[number];
  value: string;
  onChange: (v: string) => void;
}) {
  const label = (
    <label htmlFor={`recipe-param-${def.key}`} className="block text-[11px] text-[#9fa4ab]">
      {def.key}
      <span className="ml-1 text-[#5c6470]">
        {def.requirement === 'required' ? '(bắt buộc)' : def.requirement === 'user_prompt' ? '(hỏi khi chạy)' : '(tuỳ chọn)'}
      </span>
    </label>
  );
  const base = 'field-sm mt-1 w-full';
  if (def.input_type === 'select') {
    return (
      <div>
        {label}
        <select id={`recipe-param-${def.key}`} value={value} onChange={(e) => onChange(e.target.value)} className={base}>
          <option value="">— chọn —</option>
          {(def.options ?? []).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  }
  if (def.input_type === 'boolean') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <input
          id={`recipe-param-${def.key}`}
          type="checkbox"
          checked={value === 'true'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="h-4 w-4 accent-[#6a9fcc]"
        />
        <span className="text-[11px] text-[#9fa4ab]">
          {def.key}
          {def.description ? ` — ${def.description}` : ''}
        </span>
      </div>
    );
  }
  return (
    <div>
      {label}
      <input
        id={`recipe-param-${def.key}`}
        type={def.input_type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={def.description ? def.description.slice(0, 80) : `giá trị ${def.input_type}`}
        className={base}
      />
    </div>
  );
}

export function RecipesPanel({
  open,
  onClose,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  /** Chat-interface đăng ký: bấm Run → bắt đầu run thật. */
  onRun?: (run: ActiveRecipeRun) => void;
}) {
  const selected = useRecipeUiStore((s) => s.selected);
  const select = useRecipeUiStore((s) => s.select);

  const dbRecords = useLiveQuery(() => db.recipes.orderBy('updatedAt').reverse().toArray(), [], [] as RecipeRecord[]);
  const [workspaceRecipes, setWorkspaceRecipes] = useState<Array<{ path: string; recipe: Recipe }>>([]);
  const [wsError, setWsError] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const items = useMemo(() => mergeRecipeLists(dbRecords ?? [], workspaceRecipes), [dbRecords, workspaceRecipes]);

  /* Quét .vyen/recipes mỗi khi mở panel (desktop bridge hoặc web FSA). */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeBtnRef.current?.focus();
    (async () => {
      try {
        const adapter = isVyenDesktop()
          ? {
              listRecipeFiles: async () =>
                (await desktopFsList('.vyen/recipes'))
                  .filter((e) => e.type === 'file')
                  .map((e) => e.name),
              readText: async (p: string) =>
                String((await desktopFsRead(`.vyen/recipes/${p}`) as unknown as { content?: string }).content ?? ''),
            }
          : await (async () => {
              const ws = await requireWorkspace();
              if (!ws.ok) throw new Error(ws.error);
              const dirHandle = await ws.deps.root
                .getDirectoryHandle('.vyen', { create: false })
                .then((h) => h.getDirectoryHandle('recipes', { create: false }));
              return {
                listRecipeFiles: async () => {
                  const names: string[] = [];
                  for await (const entry of dirHandle.values()) {
                    if (entry.kind === 'file') names.push(entry.name);
                  }
                  return names;
                },
                readText: async (p: string) => {
                  const fh = await dirHandle.getFileHandle(p);
                  return (await fh.getFile()).text();
                },
              };
            })();
        const found = await discoverWorkspaceRecipes(adapter);
        if (!cancelled) {
          setWorkspaceRecipes(found.recipes);
          setWsError(found.errors.length ? `${found.errors.length} file hỏng: ${found.errors[0]!.error.slice(0, 80)}` : null);
        }
      } catch {
        if (!cancelled) setWorkspaceRecipes([]);
      }
    })();
    return () => {
      cancelled = true;
      restoreFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /* Đổi selection → reset form theo default của recipe mới. */
  useEffect(() => {
    setFormValues(selected ? defaultFormValues(selected.recipe) : {});
    setFormError(null);
  }, [selected]);

  const handleRun = useCallback(() => {
    if (!selected) return;
    const recipe = selected.recipe;
    const values: RecipeParamValues = {};
    for (const p of recipe.parameters ?? []) {
      const raw = formValues[p.key] ?? '';
      if (raw === '') continue;
      const coerced = coerceParamValue(raw, p.input_type);
      if (coerced === null) {
        setFormError(`Tham số "${p.key}" cần giá trị ${p.input_type} hợp lệ.`);
        return;
      }
      values[p.key] = coerced;
    }
    const resolved = resolveParameters(recipe, values);
    if (resolved.missing.length) {
      setFormError(`Thiếu tham số bắt buộc: ${resolved.missing.join(', ')}.`);
      return;
    }
    const prepared = prepareRecipeRun(recipe, resolved.values, {
      includeStructuredDirective: true,
      ...(selected.origin === 'workspace' && selected.workspacePath
        ? { recipeDir: '.vyen/recipes' }
        : {}),
    });
    const run: ActiveRecipeRun = {
      runId: `rrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recipe,
      body: {
        title: recipe.title,
        instructions: prepared.systemAppend,
        ...(recipe.response?.json_schema ? { jsonSchema: recipe.response.json_schema } : {}),
        ...(prepared.toolPolicy.deny.length ? { toolDeny: prepared.toolPolicy.deny } : {}),
        ...(prepared.toolPolicy.allow.length ? { toolAllow: prepared.toolPolicy.allow } : {}),
      },
      firstUserMessage: prepared.firstUserMessage,
      values: resolved.values,
      attempt: 1,
      maxAttempts: 1 + (recipe.retry?.max_retries ?? 0),
      status: 'running',
      log: [`bắt đầu: ${recipe.title}`],
    };
    onRun?.(run);
  }, [selected, formValues, onRun]);

  const handleImportFile = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const text = await files[0]!.text();
    const res = await importRecipeText(text);
    setNotice(res.ok ? `Đã nhập "${res.record.title}".` : `Nhập thất bại: ${res.error}`);
  }, []);

  const handleImportLink = useCallback(async () => {
    const { decodeRecipeParam } = await import('@/lib/recipes/share');
    const param = /(?:\?|&)recipe=([^&]+)/.exec(linkInput.trim());
    const decoded = param ? decodeRecipeParam(decodeURIComponent(param[1]!)) : null;
    if (!decoded?.ok || !decoded.recipe) {
      setNotice('Liên kết không đọc được recipe (hỏng hoặc sai định dạng).');
      return;
    }
    const res = await importRecipeText(serializeRecipe(decoded.recipe, 'yaml'));
    setNotice(res.ok ? `Đã nhập "${res.record.title}" từ liên kết.` : `Lưu thất bại: ${res.error}`);
    setLinkInput('');
  }, [linkInput]);

  const handleExport = useCallback(async () => {
    if (!selected) return;
    const yaml = serializeRecipe(selected.recipe, 'yaml');
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.recipe.title.toLowerCase().replace(/[^\w\d-]+/g, '-')}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [selected]);

  const handleCopyLink = useCallback(async () => {
    if (!selected) return;
    const link = buildRecipeShareLink(selected.recipe);
    try {
      await navigator.clipboard.writeText(link);
      setNotice('Đã copy liên kết share vào clipboard.');
    } catch {
      setNotice('Không copy được clipboard — thử lại hoặc export file .yaml.');
    }
  }, [selected]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Recipes"
      className="fixed inset-0 z-[100] flex justify-end bg-black/60"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-[min(30rem,100vw)] flex-col overflow-hidden rounded-none border border-[#495059] bg-[#212730] font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2 border-b border-[#495059] bg-[#161d27] px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[#ebe7e4]">
              <span className="font-bold text-[#6a9fcc]">$</span>
              <span className="text-[#6a9fcc]">recipes</span>
              <span>· {items.length} workflow</span>
            </div>
            <div className="text-[11px] text-[#9fa4ab]">
              Workflow đóng gói: tham số, tool, kiểm chứng và retry.
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Đóng panel recipes"
            className="icon-btn icon-btn-md relative rounded-none after:absolute after:-inset-[6px] after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc]"
          >
            <X size={14} />
          </button>
        </div>

        {!selected && (
          <>
            <div className="flex items-center gap-1.5 border-b border-[#495059] px-3 py-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 border border-[#495059] px-2 py-1.5 text-[11px] text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#161d27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
              >
                <FileUp size={12} aria-hidden="true" /> Nhập file
              </button>
              <div className="flex min-w-0 flex-1 items-center gap-1">
                <Link2 size={12} aria-hidden="true" className="flex-none text-[#6a9fcc]" />
                <input
                  type="text"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  placeholder="dán liên kết ?recipe=…"
                  aria-label="Liên kết recipe"
                  className="field-sm min-w-0 flex-1"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleImportLink()}
                disabled={!linkInput.trim()}
                className="border border-[#495059] px-2 py-1.5 text-[11px] text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#161d27] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
              >
                Nhập
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".yaml,.yml,.json"
                hidden
                onChange={(e) => {
                  void handleImportFile(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => select({ recipe: item.recipe, origin: item.origin, ...(item.recordId ? { recordId: item.recordId } : {}), ...(item.workspacePath ? { workspacePath: item.workspacePath } : {}) })}
                  className="block w-full border-b border-[#495059] px-3 py-2.5 text-left transition-colors hover:bg-[#161d27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
                >
                  <div className="flex items-baseline gap-2">
                    <ChefHat size={13} aria-hidden="true" className="flex-none text-[#6a9fcc]" />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#ebe7e4]">{item.recipe.title}</span>
                    <span className="flex-none text-[10.5px] text-[#9fa4ab]">
                      {item.origin === 'db' ? 'đã lưu' : item.workspacePath}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[#9fa4ab]">
                    {item.recipe.description}
                  </p>
                  {(item.recipe.parameters?.length ?? 0) > 0 && (
                    <p className="mt-0.5 text-[10.5px] text-[#5c6470]">
                      tham số: {item.recipe.parameters!.map((p) => p.key).join(', ')}
                    </p>
                  )}
                </button>
              ))}
              {items.length === 0 && (
                <div role="status" className="px-4 py-8 text-center text-[11.5px] leading-relaxed text-[#9fa4ab]">
                  Chưa có recipe nào. Nhập file .yaml, dán liên kết share, hoặc tạo
                  thư mục <code>.vyen/recipes/</code> trong workspace rồi đặt file
                  recipe vào đó.
                </div>
              )}
              {wsError && (
                <div role="status" className="border-t border-[#495059] px-3 py-2 text-[10.5px] text-[#e8993a]">
                  {wsError}
                </div>
              )}
            </div>
          </>
        )}

        {selected && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-[#495059] bg-[#161d27] px-4 py-3">
              <div className="flex items-baseline gap-2">
                <ChefHat size={14} aria-hidden="true" className="flex-none text-[#6a9fcc]" />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[#ebe7e4]">{selected.recipe.title}</span>
                <button
                  type="button"
                  onClick={() => select(null)}
                  aria-label="Quay lại danh sách"
                  className="flex-none text-[11px] text-[#6a9fcc] hover:text-[#ebe7e4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6a9fcc]"
                >
                  danh sách
                </button>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[#9fa4ab]">{selected.recipe.description}</p>
              {selected.origin === 'link' && (
                <p className="mt-1 text-[10.5px] text-[#e8993a]">
                  Recipe từ liên kết — xem trước nội dung, không gì chạy cho tới khi bạn bấm Run.
                </p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {(selected.recipe.parameters?.length ?? 0) > 0 ? (
                <div className="space-y-3">
                  {selected.recipe.parameters!.map((p) => (
                    <ParamField
                      key={p.key}
                      def={p}
                      value={formValues[p.key] ?? ''}
                      onChange={(v) => setFormValues((f) => ({ ...f, [p.key]: v }))}
                    />
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-[#9fa4ab]">Recipe không cần tham số.</p>
              )}

              {(selected.recipe.retry?.checks?.length ?? 0) > 0 && (
                <div className="mt-4 border-t border-[#495059] pt-3">
                  <p className="text-[11px] font-semibold text-[#ebe7e4]">Kiểm chứng sau khi agent xong</p>
                  <ul className="mt-1 space-y-0.5">
                    {selected.recipe.retry!.checks.map((c, i) => (
                      <li key={i} className="text-[11px] text-[#9fa4ab]">
                        <code className="text-[#8fb8d8]">{c.command}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-[10.5px] text-[#5c6470]">
                    Tối đa {selected.recipe.retry!.max_retries} lần chạy lại; lệnh vẫn qua phê duyệt như thường.
                  </p>
                </div>
              )}

              {formError && <p role="alert" className="mt-3 text-[11px] text-[#e8704f]">{formError}</p>}
              {notice && <p role="status" className="mt-3 text-[11px] text-[#5db87a]">{notice}</p>}
            </div>

            <div className="flex flex-wrap items-center gap-1.5 border-t border-[#495059] bg-[#161d27] px-3 py-2.5">
              <button
                type="button"
                onClick={handleRun}
                className="flex items-center gap-1.5 bg-[#6a9fcc] px-3 py-2 text-[12px] font-semibold text-[#0d1116] transition-colors hover:bg-[#6a9fcc]/85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0d1116]"
              >
                <Play size={12} aria-hidden="true" /> Run
              </button>
              <button
                type="button"
                onClick={() => void handleExport()}
                className="flex items-center gap-1.5 border border-[#495059] px-2 py-1.5 text-[11px] text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#212730] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
              >
                <FileDown size={12} aria-hidden="true" /> Export .yaml
              </button>
              <button
                type="button"
                onClick={() => void handleCopyLink()}
                className="flex items-center gap-1.5 border border-[#495059] px-2 py-1.5 text-[11px] text-[#ebe7e4] transition-colors hover:border-[#757d89] hover:bg-[#212730] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
              >
                <Link2 size={12} aria-hidden="true" /> Copy link
              </button>
              {selected.recordId && (
                <button
                  type="button"
                  onClick={() => {
                    void deleteRecipeRecord(selected.recordId!);
                    select(null);
                  }}
                  aria-label={`Xoá recipe ${selected.recipe.title}`}
                  className="ml-auto flex items-center gap-1 border border-[#495059] px-2 py-1.5 text-[11px] text-[#e8704f] transition-colors hover:border-[#e8704f] hover:bg-[#212730] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#e8704f]"
                >
                  <Trash2 size={12} aria-hidden="true" /> Xoá
                </button>
              )}
            </div>
          </div>
        )}

        {!selected && notice && (
          <div className="border-t border-[#495059] bg-[#161d27] px-4 py-2 text-[11px] text-[#5db87a]" role="status">
            {notice}
          </div>
        )}
      </aside>
    </div>
  );
}
