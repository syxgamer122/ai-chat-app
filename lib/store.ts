import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODEL_ID, normalizeModelId } from '@/lib/models';
import { isQueueMode, type QueueMode } from '@/lib/message-queue';
import {
  sanitizeModelFavorites,
  sanitizeRecentModels,
  type ModelFavorite,
  type RecentModel,
} from '@/lib/model-meta';
import {
  DEFAULT_THINKING_LEVEL,
  isThinkingLevel,
  type ProviderModel,
  type ThinkingLevel,
} from '@/lib/provider-url';
import {
  ALL_TOOL_CATEGORIES,
  TOOL_CATEGORY_LABELS,
  TOOL_CATEGORY_MAP,
  type ToolCategory,
} from '@/lib/tool-catalog';
import {
  type CategoryId,
  type ChainEntry,
  DEFAULT_CHAINS,
} from '@/lib/routing/categories';
import type { ToolcallRule } from '@/lib/toolcall-rules';
import {
  DEFAULT_MODEL_ROUTING,
  normalizeModelRoutingConfig,
  type ModelRoutingConfig,
} from '@/lib/model-routing';

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

/* Taxonomy tool category đã dời về lib/tool-catalog.ts (nguồn sự thật duy
   nhất, bao phủ cả bg_*). Re-export giữ tên cũ để mọi importer hiện tại
   (settings-dialog, auto-pilot, tests) không phải sửa import. */
export { ALL_TOOL_CATEGORIES, TOOL_CATEGORY_LABELS, TOOL_CATEGORY_MAP };
export type { ToolCategory };

/** Per-tool and per-category permission overrides. All default to 'default'. */
export type ToolPermissions = Record<string, PermissionOverride>;

export function isPermissionOverride(v: unknown): v is PermissionOverride {
  return v === 'default' || v === 'auto' || v === 'ask' || v === 'deny';
}

/**
 * Nhãn hiển thị tiếng Việt của 4 giá trị PermissionOverride. Nguồn chung duy
 * nhất cho select trong Cài đặt và panel Công cụ & quyền: trước đây hai nơi
 * mỗi nơi một bộ nhãn tiếng Anh, đổi chỗ nào cũng drift. Chỉ đổi LABEL ở đây;
 * VALUE phải giữ nguyên vì là giá trị persist trong localStorage
 * ('ai-chat-settings' v2).
 */
export const PERMISSION_OPTIONS: ReadonlyArray<{ value: PermissionOverride; label: string }> = [
  { value: 'default', label: 'Mặc định' },
  { value: 'auto', label: 'Tự duyệt' },
  { value: 'ask', label: 'Luôn hỏi' },
  { value: 'deny', label: 'Chặn' },
];

/**
 * Tên model có gửi được lên route LLM hay không. Mọi route (chat/title/compact/
 * vision) validate field `model` bằng CÙNG ràng buộc: chữ-số cùng `. - : ~ /`,
 * tối đa 120 ký tự — vì tên đó được chuyển thẳng lên gateway.
 *
 * Client phải tự lọc TRƯỚC khi gửi: `visionModel` trong body /api/chat không có
 * `.catch(undefined)` như hai route phụ, nên một id lạ của gateway (kiểu
 * `@cf/...`) sẽ làm cả request chat trả 400 vì một field phụ của tính năng ảnh.
 */
export function isApiModelId(v: string): boolean {
  return /^[\w.\-:~/]{1,120}$/.test(v);
}

export interface Settings {
  model: string;
  /**
   * Model dùng để MÔ TẢ ẢNH thành text (fs_read ảnh trong workspace, ảnh do
   * tool MCP trả về, ảnh đính kèm khi model chat không xem được ảnh).
   * Vyen không đoán được model nào của gateway nhìn được ảnh, nên người dùng
   * tự chọn trong Cài đặt → Nhà cung cấp. Rỗng = tính năng ảnh tắt (client
   * không gọi /api/vision, ảnh bị thay bằng ghi chú/placeholder text).
   */
  visionModel: string;
  temperature: number;
  /** Mức suy luận gửi kèm request — chỉ gateway crax dịch được giá trị này. */
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  perf: PerfSettings;
  sendOnEnter: boolean;
  /** P3.1 (Pi steeringMode): Enter khi agent đang chạy — 'one-at-a-time' | 'all'. */
  steeringMode: QueueMode;
  /** P3.1 (Pi followUpMode): Alt+Enter khi agent chạy — chỉ bắn khi agent rảnh. */
  followUpMode: QueueMode;
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
   * Approval policy:
   * - 'always': ask for everything (Manual)
   * - 'smart': auto-approve reads + safe commands, ask for writes/destructive (Smart)
   * - 'never': auto-approve everything except always-blocked commands (Autonomous / YOLO)
   * - 'chat_only': completely disable all tools, chat only (Chat Only)
   */
  approvalPolicy: 'always' | 'smart' | 'never' | 'chat_only';
  /** Per-tool and per-category permission overrides. */
  toolPermissions: ToolPermissions;
  /** Model yêu thích của picker: set (id, providerId), cap 30, không cần migrate. */
  modelFavorites: ModelFavorite[];
  /** Model dùng gần đây: mới nhất đứng đầu, cap 6, scoped theo provider. */
  recentModels: RecentModel[];
  /** Disk skills (P0-3) bị tắt theo name — lọc khỏi chỉ mục gửi lên model. */
  disabledSkills: string[];
  /**
   * Lead/Worker routing (port Goose P1-5): model mạnh cho N lượt đầu + khi
   * fallback, model rẻ cho thực thi. Tắt mặc định — bật trong Settings →
   * Routing. State KHÔNG lưu: tính lại từ message history mỗi lượt
   * (lib/model-routing.ts).
   */
  modelRouting: ModelRoutingConfig;
  /**
   * Code Mode (port Goose P1-7): tool `run_code` cho phép model viết JS chạy trong
   * Node sandbox gọi MCP tools on-demand. Tắt mặc định — bật trong Cài đặt → Công cụ.
   */
  codeModeEnabled: boolean;
  apiKey?: string;
  accessCode?: string;
  /** Mixture-of-models chains theo Category (Oh My Hermes port) */
  modelChains?: Record<CategoryId, ChainEntry[]>;
  /** Quy tắc can thiệp gọi tool do người dùng tự viết */
  toolcallRules?: ToolcallRule[];
  /** Ánh xạ slash command tùy biến /<tên> -> recipeId (Goose P2-10). */
  customSlashCommands: Record<string, string>;
}

interface AppState {
  currentChatId: string | null;
  isSidebarOpen: boolean;
  /** Desktop: sidebar thu gọn thành thanh icon (rail). Mobile: bỏ qua. */
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  settingsInitialTab?: string;
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
  openSettings: (tab?: string) => void;
  setCustomSlashCommand: (name: string, recipeId: string) => void;
  removeCustomSlashCommand: (name: string) => void;
  setTheme: (theme: ThemePreference) => void;
  updateSettings: (s: Partial<Omit<Settings, 'perf'>>) => void;
  updatePerf: (p: Partial<PerfSettings>) => void;
  setActiveProvider: (id: string) => void;
  setActiveProviderSnapshot: (snapshot: ActiveProviderSnapshot | null) => void;
}

const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL_ID,
  visionModel: '',
  temperature: 0.7,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
  systemPrompt:
    'You are a helpful, brilliant AI assistant. Use Markdown and LaTeX when appropriate. ' +
    'For LaTeX math, always use $$...$$ for block math and \\(...\\) for inline math.',
  /* throttleMs 50 (trước đây 150): gom render 150ms làm token hiển thị từng
     lô trễ rõ rệt trong lúc stream. 50ms vẫn gom đủ để máy yếu không vẽ từng
     ký tự nhưng cảm giác "token chạy ngay". CHỈ là mặc định cho phiên mới —
     perf được persist, ai đã chỉnh slider (settings-dialog) thì giữ nguyên
     giá trị của họ qua merge. */
  perf: { throttleMs: 50, animations: true },
  sendOnEnter: true,
  steeringMode: 'one-at-a-time',
  followUpMode: 'one-at-a-time',
  autoCompact: true,
  webSearch: false,
  agentTools: true,
  forceEmulatedTools: false,
  agentMode: 'act',
  stagingSandbox: true,
  autoPilot: false,
  approvalPolicy: 'smart',
  toolPermissions: { fs_read: 'default', fs_write: 'default', shell: 'default', git: 'default', web: 'default', memory: 'default', plan: 'default', delegate: 'default' },
  modelFavorites: [],
  recentModels: [],
  disabledSkills: [],
  modelRouting: { ...DEFAULT_MODEL_ROUTING },
  codeModeEnabled: false,
  apiKey: '',
  accessCode: '',
  modelChains: DEFAULT_CHAINS,
  toolcallRules: [],
  customSlashCommands: {},
};

/** Validate persisted toolPermissions, falling back to current for invalid entries. */
function validateToolPermissions(
  persisted: unknown,
  fallback: ToolPermissions,
): ToolPermissions {
  if (!persisted || typeof persisted !== 'object') return { ...fallback };
  const p = persisted as Record<string, unknown>;
  const result: ToolPermissions = { ...fallback };
  for (const [k, v] of Object.entries(p)) {
    if (typeof k === 'string' && isPermissionOverride(v)) {
      result[k] = v;
    }
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
      settingsInitialTab: undefined,
      settings: DEFAULT_SETTINGS,
      theme: 'system',
      activeProviderId: SERVER_PROVIDER_ID,
      activeProvider: null,
      setCurrentChatId: (id) => set({ currentChatId: id, isSidebarOpen: false }),
      setSidebarOpen: (open) => set({ isSidebarOpen: open }),
      setSidebarCollapsed: (collapsed) => set({ isSidebarCollapsed: collapsed }),
      setSettingsOpen: (open) => set({ isSettingsOpen: open, settingsInitialTab: open ? undefined : undefined }),
      openSettings: (tab) => set({ isSettingsOpen: true, settingsInitialTab: tab }),
      setCustomSlashCommand: (name, recipeId) =>
        set((s) => {
          const cleaned = name.trim().replace(/^\//, '').toLowerCase();
          if (!cleaned) return s;
          return {
            settings: {
              ...s.settings,
              customSlashCommands: {
                ...s.settings.customSlashCommands,
                [cleaned]: recipeId,
              },
            },
          };
        }),
      removeCustomSlashCommand: (name) =>
        set((s) => {
          const cleaned = name.trim().replace(/^\//, '').toLowerCase();
          const next = { ...s.settings.customSlashCommands };
          delete next[cleaned];
          return {
            settings: {
              ...s.settings,
              customSlashCommands: next,
            },
          };
        }),
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
          /* Lựa chọn của người dùng (không suy ra được từ đâu khác) → phải
             sống qua reload, nếu không mỗi lần mở lại app là luồng ảnh tắt. */
          visionModel: s.settings.visionModel,
          temperature: s.settings.temperature,
          thinkingLevel: s.settings.thinkingLevel,
          systemPrompt: s.settings.systemPrompt,
          perf: s.settings.perf,
          sendOnEnter: s.settings.sendOnEnter,
          steeringMode: s.settings.steeringMode,
          followUpMode: s.settings.followUpMode,
          autoCompact: s.settings.autoCompact,
          webSearch: s.settings.webSearch,
          /* Hai toggle tool cũng là lựa chọn của người dùng bấm trong composer
             (gửi kèm mỗi request lên server) — thiếu khoá này là F5 mất cài
             đặt: agentTools tắt tự bật lại, forceEmulatedTools bật tự tắt. */
          agentTools: s.settings.agentTools,
          forceEmulatedTools: s.settings.forceEmulatedTools,
          agentMode: s.settings.agentMode,
          stagingSandbox: s.settings.stagingSandbox,
          autoPilot: s.settings.autoPilot,
          approvalPolicy: s.settings.approvalPolicy,
          toolPermissions: s.settings.toolPermissions,
          /* Yêu thích + Gần đây của model picker: lựa chọn của người dùng,
             thiếu khoá là F5 mất toàn bộ shortcut trong picker. */
          modelFavorites: s.settings.modelFavorites,
          recentModels: s.settings.recentModels,
          disabledSkills: s.settings.disabledSkills,
          modelRouting: s.settings.modelRouting,
          codeModeEnabled: s.settings.codeModeEnabled,
          modelChains: s.settings.modelChains,
          toolcallRules: s.settings.toolcallRules,
          customSlashCommands: s.settings.customSlashCommands,
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
            codeModeEnabled:
              typeof p.settings?.codeModeEnabled === 'boolean'
                ? p.settings.codeModeEnabled
                : current.settings.codeModeEnabled,
            model: validModel,
            /* Model vision không qua normalizeModelId: nó là id của gateway do
               người dùng khai, không thuộc catalog built-in. Chỉ chặn giá trị
               không phải string (storage bị sửa tay/rác) → về mặc định. */
            visionModel:
              typeof p.settings?.visionModel === 'string'
                ? p.settings.visionModel
                : current.settings.visionModel,
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
              p.settings?.approvalPolicy === 'always' ||
              p.settings?.approvalPolicy === 'smart' ||
              p.settings?.approvalPolicy === 'never' ||
              p.settings?.approvalPolicy === 'chat_only'
                ? p.settings.approvalPolicy
                : current.settings.approvalPolicy,
            steeringMode: isQueueMode(p.settings?.steeringMode)
              ? p.settings.steeringMode
              : current.settings.steeringMode,
            followUpMode: isQueueMode(p.settings?.followUpMode)
              ? p.settings.followUpMode
              : current.settings.followUpMode,
            toolPermissions: validateToolPermissions(p.settings?.toolPermissions, current.settings.toolPermissions),
            /* Entry rác từ storage bị vứt ở đây chứ không throw: merge chạy
               ở rehydrate, throw là trắng màn hình. */
            modelFavorites: sanitizeModelFavorites(p.settings?.modelFavorites),
            recentModels: sanitizeRecentModels(p.settings?.recentModels),
            disabledSkills: Array.isArray(p.settings?.disabledSkills)
              ? p.settings.disabledSkills.filter((n: unknown): n is string => typeof n === 'string' && n.length > 0 && n.length <= 60)
              : [],
            modelRouting: normalizeModelRoutingConfig(p.settings?.modelRouting),
            customSlashCommands:
              p.settings?.customSlashCommands && typeof p.settings.customSlashCommands === 'object'
                ? Object.fromEntries(
                    Object.entries(p.settings.customSlashCommands).filter(
                      ([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length > 0 && v.length > 0,
                    ),
                  )
                : current.settings.customSlashCommands,
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