/**
 * Store trạng thái Recipe phía client (không persist): panel đang mở,
 * recipe đang chọn, và lần chạy recipe active mà chat-interface dùng để
 * gắn body.recipe + điều phối retry checks.
 */

import { create } from 'zustand';
import type { Recipe, RecipeParamValues } from './schema';

export type RecipeRunStatus =
  | 'running' // agent đang thực hiện attempt hiện tại
  | 'checking' // agent xong, đang chạy shell checks
  | 'retrying' // check fail, chuẩn bị gửi lại attempt kế
  | 'passed'
  | 'failed'
  | 'stopped'
  | 'error';

export interface ActiveRecipeRun {
  runId: string;
  recipe: Recipe;
  /** Body recipe gửi kèm mỗi lượt của run (đã render tham số). */
  body: {
    title: string;
    instructions: string;
    jsonSchema?: Record<string, unknown>;
    toolDeny?: string[];
    toolAllow?: string[];
    /** Sub-recipes đã resolve (inline parse / path đọc ở máy user). */
    subRecipes?: Array<{
      name: string;
      mode: 'sequential' | 'parallel';
      returnMode: 'full' | 'summary';
      fixedValues: Record<string, string>;
      recipe: Recipe;
    }>;
  };
  /** User message mở đầu (attempt 1). */
  firstUserMessage: string;
  /** Giá trị tham số đã resolve — dùng render lại lệnh check. */
  values: RecipeParamValues;
  attempt: number;
  maxAttempts: number;
  status: RecipeRunStatus;
  /** Log một dòng cho UI (kết quả check, chuyển attempt...). */
  log: string[];
}

export interface RecipeSelection {
  recipe: Recipe;
  origin: 'db' | 'workspace' | 'link';
  recordId?: string;
  workspacePath?: string;
}

interface RecipeUiState {
  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  selected: RecipeSelection | null;
  select: (sel: RecipeSelection | null) => void;
  activeRun: ActiveRecipeRun | null;
  setActiveRun: (run: ActiveRecipeRun | null) => void;
  patchActiveRun: (patch: Partial<Omit<ActiveRecipeRun, 'runId' | 'recipe' | 'body' | 'firstUserMessage'>>) => void;
  appendLog: (line: string) => void;
}

export const useRecipeUiStore = create<RecipeUiState>()((set) => ({
  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  selected: null,
  select: (sel) => set({ selected: sel }),
  activeRun: null,
  setActiveRun: (run) =>
    set((s) => ({
      activeRun: run,
      // Run mới đóng panel để người dùng theo dõi hội thoại.
      ...(run ? { panelOpen: false } : {}),
      ...(run ? s : {}),
    })),
  patchActiveRun: (patch) =>
    set((s) => (s.activeRun ? { activeRun: { ...s.activeRun, ...patch } } : {})),
  appendLog: (line) =>
    set((s) =>
      s.activeRun
        ? { activeRun: { ...s.activeRun, log: [...s.activeRun.log.slice(-19), line] } }
        : {},
    ),
}));
