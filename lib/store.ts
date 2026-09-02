import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODEL_ID, normalizeModelId } from '@/lib/models';
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  type ProviderModel,
  type ThinkingLevel,
} from '@/lib/provider-url';

/** id provider "dùng cấu hình env của server" — định nghĩa ở store để tránh vòng import. */
export const SERVER_PROVIDER_ID = '__server__';

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Chế độ agent coding:
 *  - 'act' (mặc định): agent đọc + ghi file, chạy lệnh bình thường.
 *  - 'plan': agent CHỈ được explore (read/list/search) và hỏi clarifying
 *    questions. Mọi write tool (fs_write, fs_edit) bị vô hiệu hóa cả phía
 *    server lẫn client. User chuyển sang 'act' khi sẵn sàng cho agent thực thi.
 * Port từ Cline "Plan and Act" mode (Apache-2.0).
 */
export type AgentMode = 'plan' | 'act';

export function isAgentMode(v: unknown): v is AgentMode {
  return v === 'plan' || v === 'act';
}

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** Snapshot nhà cung cấp đang active — nằm trong store, không persist. */
export interface ActiveProviderSnapshot {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: Array<ProviderModel>;
}

export interface PerfSettings {
  /** Cửa sổ gom render markdown khi stream (ms). Máy yếu: 250–300 */
  throttleMs: number;
  /** Tắt animation cho máy yếu / prefers-reduced-motion */
  animations: boolean;
}

/**
 * Per-tool permission override for a category.
 * - 'default': tuân theo approvalPolicy hiện tại (smart/never/always)
 * - 'auto': luôn auto-approve (bỏ qua approvalPolicy)
 * - 'ask': luôn hỏi (kể cả khi policy = never/YOLO)
 * - 'deny': chặn hoàn toàn (tool không được gọi)
 */
export type PermissionOverride = 'default' | 'auto' | 'ask' | 'deny';

/**
 * Category groups for per-tool permission overrides.
 * Each category maps to one or more tool names.
 */
export type ToolCategory =
  | 'fs_read'
  | 'fs_write'
  | 'shell'
  | 'git'
  | 'web'
  | 'memory'
  | 'plan'
  | 'delegate';

/** Map from tool name → category for quick lookup. */
export const TOOL_CATEGORY_MAP: Record<string, ToolCategory> = {
  fs_read: 'fs_read',
  fs_list: 'fs_read',
  fs_search: 'fs_read',
  fs_edit: 'fs_write',
  fs_write: 'fs_write',
  shell_run: 'shell',
  git_status: 'git',
  git_diff: 'git',
  git_log: 'git',
  git_add: 'git',
  git_commit: 'git',
  web_search: 'web',
  web_fetch: 'web',
  memory_search: 'memory',
  memory_save: 'memory',
  plan_create: 'plan',
  plan_update: 'plan',
  delegate: 'delegate',
};

/** Human-readable labels for each category (UI). */
export const TOOL_CATEGORY_LABELS: Record<ToolCategory, { label: string; icon: string; tools: string }> = {
  fs_read: { label: 'File Reading', icon: '📂', tools: 'fs_read, fs_list, fs_search' },
  fs_write: { label: 'File Editing', icon: '✏️', tools: 'fs_edit, fs_write' },
  shell: { label: 'Shell Commands', icon: '💻', tools: 'shell_run' },
  git: { label: 'Git Operations', icon: '🔀', tools: 'git_status, git_diff, git_log, git_add, git_commit' },
  web: { label: 'Web Tools', icon: '🌐', tools: 'web_search, web_fetch' },
  memory: { label: 'Memory', icon: '🧠', tools: 'memory_search, memory_save' },
  plan: { label: 'Plans', icon: '📋', tools: 'plan_create, plan_update' },
  delegate: { label: 'Subagent', icon: '🤖', tools: 'delegate' },
};

export const ALL_TOOL_CATEGORIES: ToolCategory[] = [
  'fs_read', 'fs_write', 'shell', 'git', 'web', 'memory', 'plan', 'delegate',
];

/** Per-category permission overrides. All default to 'default'. */
export type ToolPermissions = Record<ToolCategory, PermissionOverride>;

export function isPermissionOverride(v: unknown): v is PermissionOverride {
  return v === 'default' || v === 'auto' || v === 'ask' || v === 'deny';
}

export interface Settings {
  model: string;
  temperature: number;
  /** Mức suy luận gửi kèm request — chỉ gateway crax dịch được giá trị này. */
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  perf: PerfSettings;
  sendOnEnter: boolean;
  /** Tự động nén hội thoại khi ước lượng token gần trần context của model. */
  autoCompact: boolean;
  /** Bật tra cứu web cho tin nhắn tiếp theo (nút Globe trong composer). */
  webSearch: boolean;
  /**
   * Cho phép model tự gọi công cụ (web_search, fs_* của agent coding...).
   * TẮT khi người dùng chỉ muốn chat thuần: model yếu đôi khi cố gọi tool
   * thay vì trả lời, hoặc gọi công cụ đọc file mà không cần thiết.
   */
  agentTools: boolean;
  /**
   * Ép gọi tool qua đường GIẢ LẬP (protocol text) thay vì function calling
   * gốc của API. Dành cho gateway nhận tham số `tools` (200 OK) rồi âm thầm
   * bỏ qua — model chỉ thấy tên tool trong prompt, cố gọi thì JSON args leaked
   * ra text thuần và không bao giờ được thực thi.
   */
  forceEmulatedTools: boolean;
  /** Chế độ agent coding: 'plan' (chỉ explore) hoặc 'act' (đọc + ghi). */
  agentMode: AgentMode;
  /**
   * Staging sandbox (port Plandex, MIT): fs_edit/fs_write ghi vào bộ đệm
   * thay vì đĩa; user review cả batch trong staging panel rồi Apply/Reject.
   * Tắt → hành vi cũ: diff modal phê duyệt từng edit, ghi đĩa ngay.
   */
  stagingSandbox: boolean;
  /**
   * Auto-pilot mode: skip confirmation modals for tool calls based on
   * approvalPolicy. Port from Goose GooseMode + Codex approval modes.
   */
  autoPilot: boolean;
  /**
   * Approval policy when autoPilot is ON:
   * - 'always': ask for everything (same as autoPilot OFF)
   * - 'smart': auto-approve reads + safe commands, ask for writes/destructive
   * - 'never': auto-approve everything except always-blocked commands (YOLO)
   */
  approvalPolicy: 'always' | 'smart' | 'never';
  /** Per-tool permission overrides by category. */
  toolPermissions: ToolPermissions;
  apiKey?: string;
  accessCode?: string;
}

interface AppState {
  currentChatId: string | null;
  isSidebarOpen: boolean;
  /** Desktop: sidebar thu gọn thành thanh icon (rail). Mobile: bỏ qua. */
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  settings: Settings;
  /** Giao diện sáng/tối — 'system' theo prefers-color-scheme của OS. */
  theme: ThemePreference;
  /** Provider đang dùng — SERVER_PROVIDER_ID = cấu hình env của server. */
  activeProviderId: string;
  /** Snapshot provider active (baseUrl/key/models) — không persist. */
  activeProvider: ActiveProviderSnapshot | null;
  setCurrentChatId: (id: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setTheme: (theme: ThemePreference) => void;
  updateSettings: (s: Partial<Omit<Settings, 'perf'>>) => void;
  updatePerf: (p: Partial<PerfSettings>) => void;
  setActiveProvider: (id: string) => void;
  setActiveProviderSnapshot: (snapshot: ActiveProviderSnapshot | null) => void;
}

const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL_ID,
  temperature: 0.7,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  systemPrompt:
    'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. ' +
    'For LaTeX math, always use $$...$$ for block math and \\(...\\) for inline math.',
  perf: { throttleMs: 150, animations: true },
  sendOnEnter: true,
  autoCompact: true,
  webSearch: false,
  agentTools: true,
  forceEmulatedTools: false,
  agentMode: 'act',
  stagingSandbox: true,
  autoPilot: false,
  approvalPolicy: 'smart',
  toolPermissions: { fs_read: 'default', fs_write: 'default', shell: 'default', git: 'default', web: 'default', memory: 'default', plan: 'default', delegate: 'default' },
  apiKey: '',
  accessCode: '',
};

/** Validate persisted toolPermissions, falling back to current for invalid entries. */
function validateToolPermissions(
  persisted: unknown,
  fallback: ToolPermissions,
): ToolPermissions {
  if (!persisted || typeof persisted !== 'object') return { ...fallback };
  const p = persisted as Record<string, unknown>;
  const result = { ...fallback };
  for (const cat of ALL_TOOL_CATEGORIES) {
    if (isPermissionOverride(p[cat])) result[cat] = p[cat];
  }
  return result;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      currentChatId: null,
      isSidebarOpen: false,
      isSidebarCollapsed: false,
      isSettingsOpen: false,
      settings: DEFAULT_SETTINGS,
      theme: 'system',
      activeProviderId: SERVER_PROVIDER_ID,
      activeProvider: null,
      setCurrentChatId: (id) => set({ currentChatId: id, isSidebarOpen: false }),
      setSidebarOpen: (open) => set({ isSidebarOpen: open }),
      setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
      setSettingsOpen: (open) => set({ isSettingsOpen: open }),
      setTheme: (theme) => set({ theme }),
      updateSettings: (partial) =>
        set((s) => ({ settings: { ...s.settings, ...partial } })),
      updatePerf: (partial) =>
        set((s) => ({ settings: { ...s.settings, perf: { ...s.settings.perf, ...partial } } })),
      setActiveProvider: (id) => set({ activeProviderId: id, activeProvider: null }),
      setActiveProviderSnapshot: (snapshot) => set({ activeProvider: snapshot }),
    }),
    {
      name: 'ai-chat-settings',
      version: 2,
      partialize: (s) => ({
        activeProviderId: s.activeProviderId,
        isSidebarCollapsed: s.isSidebarCollapsed,
        theme: s.theme,
        settings: {
          model: s.settings.model,
          temperature: s.settings.temperature,
          thinkingLevel: s.settings.thinkingLevel,
          systemPrompt: s.settings.systemPrompt,
          perf: s.settings.perf,
          sendOnEnter: s.settings.sendOnEnter,
          autoCompact: s.settings.autoCompact,
          webSearch: s.settings.webSearch,
          agentMode: s.settings.agentMode,
          stagingSandbox: s.settings.stagingSandbox,
          autoPilot: s.settings.autoPilot,
          approvalPolicy: s.settings.approvalPolicy,
          toolPermissions: s.settings.toolPermissions,
        },
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        const rawModel = p.settings?.model;
        const usingCustomProvider =
          !!p.activeProviderId && p.activeProviderId !== SERVER_PROVIDER_ID;
        // Model của provider ngoài built-in không qua normalizeModelId.
        const validModel = usingCustomProvider
          ? typeof rawModel === 'string' && rawModel
            ? rawModel
            : DEFAULT_MODEL_ID
          : normalizeModelId(rawModel);

        return {
          ...current,
          ...p,
          theme: isThemePreference(p.theme) ? p.theme : current.theme,
          settings: {
            ...current.settings,
            ...(p.settings ?? {}),
            model: validModel,
            thinkingLevel: isThinkingLevel(p.settings?.thinkingLevel)
              ? p.settings.thinkingLevel
              : DEFAULT_THINKING_LEVEL,
            perf: { ...current.settings.perf, ...(p.settings?.perf ?? {}) },
            agentMode: isAgentMode(p.settings?.agentMode) ? p.settings.agentMode : current.settings.agentMode,
            /* Boolean khôi phục an toàn: giá trị lạ/rác → giữ mặc định hiện tại. */
            stagingSandbox:
              typeof p.settings?.stagingSandbox === 'boolean'
                ? p.settings.stagingSandbox
                : current.settings.stagingSandbox,
            autoPilot:
              typeof p.settings?.autoPilot === 'boolean'
                ? p.settings.autoPilot
                : current.settings.autoPilot,
            approvalPolicy:
              p.settings?.approvalPolicy === 'always' || p.settings?.approvalPolicy === 'smart' || p.settings?.approvalPolicy === 'never'
                ? p.settings.approvalPolicy
                : current.settings.approvalPolicy,
            toolPermissions: validateToolPermissions(p.settings?.toolPermissions, current.settings.toolPermissions),
            apiKey: '',
            accessCode: '',
          },
          activeProvider: null,
        };
      },
      migrate: (state: any) => ({
        ...state,
        settings: {
          ...state?.settings,
          model: normalizeModelId(state?.settings?.model),
        },
      }),
    },
  ),
);