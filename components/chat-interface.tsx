import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppStore, isApiModelId, SERVER_PROVIDER_ID } from '@/lib/store';
import {
  computeRoutingSnapshot,
  normalizeModelRoutingConfig,
  DEFAULT_MODEL_ROUTING,
  type RoutingMessageLike,
  type RoutingRole,
} from '@/lib/model-routing';
import { syncActiveProviderSnapshot } from '@/lib/providers';
import {
  db,
  appendMessage,
  fromParentKey,
  toParentKey,
  type StoredMessage,
  type RecipeRecord,
} from '@/lib/db';
import { AVAILABLE_MODELS, MEDIA_MODELS } from '@/lib/models';
import { deriveModelOption, toggleFavorite, upsertRecent } from '@/lib/model-meta';
import {
  reconstructActiveThread,
  reconstructActiveThreadSafe,
  getSiblings,
  findDeepestLeafId,
} from '@/lib/tree-utils';
import { useBranchKeyboardShortcuts } from '@/lib/use-branch-keyboard-shortcuts';
import { useSwipeBranch } from '@/lib/use-swipe-branch';
import { repairSessionIfNeeded, repairAndBroadcastSession } from '@/lib/tree-repair';
import { useCrossTabChatSync } from '@/lib/use-cross-tab-chat-sync';
import { chatBroadcast } from '@/lib/chat-broadcast';
import { createMutationId } from '@/lib/client-identity';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { useRunLifecycle } from '@/lib/hooks/use-run-lifecycle';
import {
  RUN_LIFECYCLE_KV_KEY,
  isTerminal,
  parseRunState,
  reconcileOnBoot,
  serializeRunState,
} from '@/lib/run-lifecycle';
import { Composer, type MediaAction, type MediaActions, type SlashPrompt } from '@/components/composer';
import { ToastHost } from '@/components/toast';
import type { ModelOption } from '@/components/model-selector';
import { useTitleGenerator } from '@/lib/use-title-generator';
import { ensurePromptSeed, savePrompt } from '@/lib/prompt-library';
import { ensureProviderSeed } from '@/lib/providers';
import { isSameFamilyAsMedia, pickMediaModels } from '@/lib/media-models';
import { MediaGenerationError, generateMedia } from '@/lib/media-generate';
import {
  supportsMediaGeneration,
  supportsThinkingLevel,
  type ThinkingLevel,
} from '@/lib/provider-url';
import { estimatePromptTokens, shouldCompact, evaluateUsageTrigger, splitForCompaction } from '@/lib/context-budget';
import { drainQueue, enqueueMessage, isQueueMode, type QueueMode } from '@/lib/message-queue';
import { CLIENT_MAX_STEPS } from '@/lib/tool-limits';
import {
  resolveContextWindow,
  serializeForCompaction,
  buildEmergencySummary,
  extractFileOps,
  extractUserRequests,
  mergeCompactionState,
  formatCompactContextBlock,
  findActiveCompaction,
  type CompactionMarker,
} from '@/lib/context-compaction';
import {
  buildGoalKickoff,
  describeGoalStop,
  evaluateGoalTurn,
  getGoalLoop,
  startGoalLoop,
  stopGoalLoop,
  stripGoalCompleteTag,
  type GoalLoopState,
} from '@/lib/goal-loop';
import { useHudStore } from '@/lib/hud-store';
import {
  CONTINUE_PROMPT,
  sanitizeContent,
  getFinishInfo,
  revokeObjectUrls,
  toChatMessage,
  getNextBranchOrder,
  getNextSequence,
  reconstructParentPath,
  getFinalStoredStatus,
  reconcileActiveMessages,
  type PendingAssistantFork,
} from '@/lib/chat-tree-persistence';
import { gatherWebContext } from '@/lib/use-web-search';
import { stripEmulatedToolMarkup } from '@/lib/text-tool-guard';
import {
  fsDelete,
  fsList,
  fsRead,
  fsReadFull,
  fsReadImage,
  fsSearch,
  fsWrite,
  disconnectWorkspace,
  getWorkspaceInfo,
  pickWorkspaceRoot,
  requireWorkspace,
  restoreWorkspaceRoot,
  type FsDeps,
} from '@/lib/fs-access';
import { isVyenDesktop } from '@/lib/desktop-bridge';
import { useRecipeUiStore, type ActiveRecipeRun } from '@/lib/recipes/run-store';
import {
  nextRetryAction,
  renderTemplate,
  processStructuredOutput,
  formatStructuredLine,
  readRecipeRecord,
} from '@/lib/recipes';
import { BUILTIN_SLASH_COMMANDS, parseSlashCommand } from '@/lib/slash-commands';
import type { RetryCheckOutcome } from '@/lib/recipes/retry';
import {
  scanDiskSkills,
  buildHintsBlock,
} from '@/lib/skills/disk';
import {
  buildDiskSkillAdapters,
  readHintsFromWorkspace,
  loadSkillContent,
} from '@/lib/skills/client-adapters';
import { useDiskSkillsStore } from '@/lib/skills/disk-store';
import { foldText } from '@/lib/search-utils';
import {
  rememberAgentMemory,
  resolveWorkspaceKey,
  listAgentMemories,
  removeMemoryCategory,
  removeSpecificMemory,
} from '@/lib/memory/goose-client';
import {
  retrieveMatchingMemories,
  memoriesForWorkspace,
  buildMemoryIndexBlock,
  agentMemoriesAsLessons,
} from '@/lib/memory/goose';
import {
  desktopFsList,
  desktopFsRead,
  desktopFsReadImage,
  desktopFsSearch,
  desktopFsWrite,
  desktopFsDelete,
  desktopFsReadFull,
  desktopGetWorkspaceInfo,
  desktopPickWorkspaceRoot,
  desktopDisconnectWorkspace,
  desktopRequireWorkspace,
} from '@/lib/desktop-fs';
import {
  describeWorkspaceImage,
  describeMcpImage,
  isImagePath,
  type WorkspaceImageToolResult,
} from '@/lib/fs-vision';
import { hasMcpImages, describeMcpImageBlocks } from '@/lib/mcp/image-content';
import {
  captureFile,
  newTurnCapture,
  saveTurnCapture,
  type CaptureInput,
  type TurnCapture,
} from '@/lib/workspace-checkpoints';
import { CLIENT_TOOL_NAMES, CLIENT_TOOL_DEFS } from '@/lib/agent-tools';
import { shouldAutoApprove } from '@/lib/auto-pilot';
import { loadToolPermissionsFromDb } from '@/lib/tool-permissions';
import {
  isToolDenied,
  TOOL_CATEGORY_LABELS,
  TOOL_CATEGORY_MAP,
} from '@/lib/tool-catalog';
import {
  acquirePostEditSlot,
  attachPostEditCheck,
  detectPostEditCommands,
  emptyPostEditThrottle,
  POST_EDIT_CHECK_TIMEOUT_MS,
  type PostEditCheckOutcome,
  type PostEditThrottleState,
} from '@/lib/post-edit-check';
import {
  callMcpTool,
  isMcpAvailable,
  listMcpServers,
  listMcpTools,
  onMcpServerStatus,
} from '@/lib/mcp/bridge';
import {
  formatMcpResultForModel,
  isMcpToolKey,
  mapMcpTools,
  mcpToolKey,
  MCP_PROXY_TOOL_KEY,
  normalizeMcpProxyArgs,
  resolveMcpProxyTool,
  searchMcpProxyTools,
  type McpToolInfo,
} from '@/lib/mcp/tool-mapper';
import {
  buildToolIndex,
  searchTools,
  type ToolIndexEntry,
} from '@/lib/mcp/tool-router';
import {
  stageFile,
  unstageFile,
  clearStaging,
  stagingCount,
  stagingStats,
  serializeStaging,
  parseStaging,
  STAGING_KV_KEY,
  type StagingStore,
} from '@/lib/staging';
import {
  recordDebugAttempt,
  clearDebugSession,
  isSafeDebugCommand,
  buildRetryGuidance,
  emptyDebugStore,
  AUTO_DEBUG_MAX_ATTEMPTS_DEFAULT,
  normalizeDebugCommand,
  type DebugStore,
} from '@/lib/debug-loop';
import {
  emptyPlan,
  addSubtask,
  updateSubtaskStatus,
  planProgress,
  formatPlanSummary,
  parsePlan,
  type Plan,
  type SubtaskStatus,
} from '@/lib/subtask-plan';
import {
  serializeLesson,
  validateLessonText,
  suggestLessonFromDebug,
  type LessonCategory,
} from '@/lib/lessons';
import { normalizePathKey } from '@/lib/path-utils';
import { showNotice } from '@/lib/notice-store';
import { DiffConfirm, type DiffConfirmState } from '@/components/diff-confirm';
import { ShellConfirm } from '@/components/shell-confirm';
import type { StagingPanelState } from '@/components/staging-panel';
import { McpToolApprovalDialog } from '@/components/mcp/tool-approval-dialog';
import { useOrchestrator } from '@/lib/use-orchestrator';
import { toSkills } from '@/lib/prompt-library';
import { matchActiveSkills } from '@/lib/skills';
import { gatherPdfContexts } from '@/lib/use-pdf-context';
import { gatherLiveContext } from '@/lib/live-tools';
import { addMemory, listMemories } from '@/lib/db';
import { proposeCandidate, queryRecallPack } from '@/lib/memory/store';
import type { RecallPack, MemoryKind } from '@/lib/memory/types';
import { X } from 'lucide-react';
import { compressImageFiles } from '@/lib/image-compress';
import { StatusLine } from './chat/status-line';
import { MessageList } from './chat/message-list';
import { WorkspaceCheckpointBar } from '@/components/workspace-checkpoints';
import type { BranchInfo } from './chat/message-item';
import type { ComposerApi } from '@/components/composer';

/* Ba panel overlay lớn (staging/orchestrator/plan) chỉ mở theo yêu cầu —
   import tĩnh kéo cả ba (kèm heatmap, diff view, subtask UI) vào chunk
   trang chính dù 99% phiên không mở chúng. dynamic() tách chunk riêng,
   tải lúc lần đầu mở. ssr:false vì đây đã là client tree (hooks). */
import dynamic from 'next/dynamic';

const StagingPanel = dynamic(
  () => import('@/components/staging-panel').then((m) => m.StagingPanel),
  { ssr: false },
);
const OrchestratorPanel = dynamic(
  () => import('@/components/orchestrator/orchestrator-panel').then((m) => m.OrchestratorPanel),
  { ssr: false },
);
const PlanPanel = dynamic(
  () => import('@/components/plan-panel').then((m) => m.PlanPanel),
  { ssr: false },
);
const ToolsPanel = dynamic(
  () => import('@/components/tools-panel').then((m) => m.ToolsPanel),
  { ssr: false },
);
const RecipesPanel = dynamic(
  () => import('@/components/recipes/recipes-panel').then((m) => m.RecipesPanel),
  { ssr: false },
);
const AgentHud = dynamic(
  () => import('@/components/hud/agent-hud').then((m) => m.AgentHud),
  { ssr: false },
);

/* Trần đính kèm. Đặt ở MODULE scope: trước đây khai báo trong thân component
   nên tạo lại mỗi render và làm eslint cảnh báo thiếu dependency ở
   useCallback bên dưới (hằng số thì không thể là dependency hợp lệ). */
const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const MAX_FILES = 4;

/* ------------------------------------------------------------------ */
/* Main ChatInterface Orchestrator                                     */
/* ------------------------------------------------------------------ */
export default function ChatInterface() {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const updateSettings = useAppStore((s) => s.updateSettings);

  const model = useAppStore((s) => s.settings.model);
  /** Yêu thích + Gần đây của model picker: scoped theo activeProviderId. */
  const modelFavorites = useAppStore((s) => s.settings.modelFavorites);
  const recentModels = useAppStore((s) => s.settings.recentModels);
  /**
   * Model MÔ TẢ ẢNH (người dùng chọn trong Cài đặt → Nhà cung cấp). Rỗng =
   * luồng ảnh tắt: /api/vision đòi model bắt buộc nên gọi mà không có chỉ
   * nhận 400, thà không gọi và nói rõ cho model/người dùng.
   *
   * Lọc qua isApiModelId ngay tại đây: field `visionModel` của /api/chat KHÔNG
   * có `.catch(undefined)` như model của title/compact, nên một id gateway lạ
   * (ký tự ngoài `\w . - : ~ /`) sẽ làm CẢ lượt chat trả BAD_SCHEMA 400 vì một
   * field phụ. Id không gửi được coi như chưa chọn.
   */
  const visionModel = useAppStore((s) => {
    const v = s.settings.visionModel ?? '';
    return isApiModelId(v) ? v : '';
  });
  const temperature = useAppStore((s) => s.settings.temperature);
  const thinkingLevel = useAppStore((s) => s.settings.thinkingLevel);
  const systemPrompt = useAppStore((s) => s.settings.systemPrompt);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const accessCode = useAppStore((s) => s.settings.accessCode);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const activeProvider = useAppStore((s) => s.activeProvider);
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  /** P3.1 — Steering (Enter khi đang chạy) vs Follow-up (Alt+Enter). */
  const steeringMode = useAppStore((s) =>
    isQueueMode(s.settings.steeringMode) ? s.settings.steeringMode : 'one-at-a-time',
  ) as QueueMode;
  const followUpMode = useAppStore((s) =>
    isQueueMode(s.settings.followUpMode) ? s.settings.followUpMode : 'one-at-a-time',
  ) as QueueMode;
  const autoCompactEnabled = useAppStore((s) => s.settings.autoCompact);
  const webSearchEnabled = useAppStore((s) => s.settings.webSearch);
  /** Tắt = model không nhận tool nào (chat thuần, không agent coding). */
  const agentToolsEnabled = useAppStore((s) => s.settings.agentTools ?? true);
  /** Ép đường tool giả lập — gateway strip `tools` im lặng (vd crax). */
  const forceEmulatedTools = useAppStore((s) => s.settings.forceEmulatedTools ?? false);
  /** Chế độ agent: 'plan' = chỉ explore, 'act' = đọc + ghi. */
  const agentMode = useAppStore((s) => s.settings.agentMode ?? 'act');
  const autoPilot = useAppStore((s) => s.settings.autoPilot ?? false);
  const approvalPolicy = useAppStore((s) => s.settings.approvalPolicy ?? 'smart');
  const toolPermissions = useAppStore((s) => s.settings.toolPermissions);
  /** Staging sandbox: fs_edit/fs_write ghi vào bộ đệm thay vì đĩa. */
  const stagingEnabled = useAppStore((s) => s.settings.stagingSandbox ?? true);
  /** Lead/Worker routing (P1-5): override model mỗi lượt theo state machine. */
  const modelRouting = useAppStore((s) => s.settings.modelRouting ?? DEFAULT_MODEL_ROUTING);
  /** Code Mode (P1-7): chạy JS sandbox gọi MCP on-demand */
  const codeModeEnabled = useAppStore((s) => s.settings.codeModeEnabled ?? false);
  /** Capability suy luận của model đang chọn (metadata kiểu OpenRouter). */
  const modelReasoningCap = activeProvider?.models?.find((m) => m.id === model)?.reasoning ?? null;
  const throttleMs = useAppStore((s) => s.settings.perf.throttleMs);
  const customSlashCommands = useAppStore((s) => s.settings.customSlashCommands ?? {});

  /** Nạp snapshot provider đang active từ IndexedDB vào store. */
  useEffect(() => {
    void syncActiveProviderSnapshot(activeProviderId);
  }, [activeProviderId]);

  /** Provider mặc định của server (env) hỗ trợ những tính năng nào. */
  const [serverCaps, setServerCaps] = useState<{ thinkingLevel: boolean; media: boolean }>({
    thinkingLevel: false,
    media: false,
  });
  useEffect(() => {
    let cancelled = false;
    fetch('/api/server-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { thinkingLevel?: boolean; media?: boolean } | null) => {
        if (cancelled || !j) return;
        setServerCaps({
          thinkingLevel: Boolean(j.thinkingLevel),
          media: Boolean(j.media),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const currentChat = useLiveQuery(
    () => (currentChatId ? db.chats.get(currentChatId) : undefined),
    [currentChatId],
  );

  /** Thư viện prompt cho slash menu "/" trong composer.
   *  Seed mặc định chạy ngoài liveQuery (liveQuery cấm giao dịch ghi). */
  useEffect(() => {
    void ensurePromptSeed();
    void ensureProviderSeed();
    void loadToolPermissionsFromDb().then((dbPerms) => {
      if (dbPerms && Object.keys(dbPerms).length > 0) {
        const cur = useAppStore.getState().settings.toolPermissions ?? {};
        useAppStore.getState().updateSettings({
          toolPermissions: { ...cur, ...dbPerms },
        });
      }
    });
  }, []);
  const promptTemplates = useLiveQuery(
    () => db.prompts.orderBy('updatedAt').reverse().toArray(),
    [],
    [],
  );
  /** Slash menu chỉ hiển thị prompt CHÈN — skill (mode='skill') tự kích hoạt
      theo ngữ cảnh, không chọn tay qua "/". Recipe gộp vào menu "/" với nhãn
      riêng (kind='recipe'): chọn recipe sẽ MỞ panel thay vì chèn text. */
  const recipeRecords = useLiveQuery(
    () => db.recipes.orderBy('updatedAt').reverse().toArray(),
    [],
    [] as RecipeRecord[],
  );
  const insertPrompts = useMemo(() => {
    const prompts: SlashPrompt[] = (promptTemplates ?? []).filter((p) => p.mode !== 'skill');
    /* Lệnh built-in chuẩn hóa theo Goose (P2-10): /plan, /mode, /summarize, /recipe, /skills, /memory, /tools, /cost */
    const builtinCommands: SlashPrompt[] = BUILTIN_SLASH_COMMANDS.map((cmd) => ({
      id: `cmd:${cmd.name}`,
      title: cmd.name,
      content: `/${cmd.name} `,
      kind: 'command',
    }));

    /* Lệnh tùy biến người dùng cấu hình: /<tên> -> recipe */
    const customCommands: SlashPrompt[] = Object.entries(customSlashCommands).map(([name]) => ({
      id: `cmd:custom:${name}`,
      title: name,
      content: `/${name} `,
      kind: 'command',
    }));

    for (const r of recipeRecords ?? []) {
      const parsed = readRecipeRecord(r);
      prompts.push({
        id: `recipe:${r.id}`,
        title: r.title,
        content: parsed?.description ?? 'workflow recipe',
        kind: 'recipe',
      });
    }
    return [...builtinCommands, ...customCommands, ...prompts];
  }, [promptTemplates, recipeRecords, customSlashCommands]);

  /**
   * Model media khả dụng cho nhà cung cấp đang chọn.
   * crax liệt kê `qwen-image-*` trong /v1/models nhưng KHÔNG liệt kê
   * `qwen-video` (alias chỉ dùng được qua chat SSE) — nên với gateway crax ta
   * bổ sung thêm model media built-in vào danh sách.
   */
  const mediaCatalog = useMemo(() => {
    const craxLike = activeProvider
      ? supportsMediaGeneration(activeProvider.baseUrl)
      : serverCaps.media;

    const fromProvider = (activeProvider?.models ?? []).map((m) => ({
      id: m.id,
      label: m.name || m.id,
    }));
    if (!craxLike) return fromProvider;

    const known = new Set(fromProvider.map((m) => m.id));
    return [
      ...fromProvider,
      ...MEDIA_MODELS.filter((m) => !known.has(m.id)).map((m) => ({ id: m.id, label: m.name })),
    ];
  }, [activeProvider, serverCaps.media]);

  const MODELS: ModelOption[] = useMemo(() => {
    if (activeProvider?.models?.length) {
      const base = activeProvider.models.map((m) => deriveModelOption(m));
      // Bổ sung model media built-in mà /v1/models của gateway không khai báo.
      const known = new Set(base.map((m) => m.id));
      const extra = mediaCatalog
        .filter((m) => !known.has(m.id))
        .map((m) => {
          const cfg = MEDIA_MODELS.find((c) => c.id === m.id);
          return cfg ? deriveModelOption(cfg) : { id: m.id, label: m.label };
        });
      return [...base, ...extra];
    }
    // Provider của server: bỏ model media nếu gateway env không hỗ trợ.
    return AVAILABLE_MODELS.filter((m) => serverCaps.media || m.media === undefined).map((m) =>
      deriveModelOption(m),
    );
  }, [activeProvider, mediaCatalog, serverCaps.media]);

  /**
   * Nút "Tạo ảnh" / "Tạo video" cạnh nút mic. Chỉ hiện khi model đang chọn
   * cùng họ với model media của gateway — ví dụ crax: chọn qwen3.8-max /
   * qwen3.7-max thì hiện 2 nút dùng qwen-image-3.0-pro và qwen-video.
   *
   * `direct`: có key ở phía trình duyệt → gọi thẳng gateway, không qua
   * /api/chat, nên không bị giới hạn thời gian chạy của serverless function
   * (video mất 2-5 phút, vượt xa hạn mức của Vercel Hobby).
   */
  const mediaActions: MediaActions | undefined = useMemo(() => {
    if (!mediaCatalog.length) return undefined;
    const picked = pickMediaModels(mediaCatalog);
    if (!picked.image && !picked.video) return undefined;
    if (!isSameFamilyAsMedia(model, picked)) return undefined;
    // `direct` chỉ đúng khi CHÍNH provider đó có key trong IndexedDB. Điều kiện
    // cũ `activeProvider.apiKey || apiKey` bật direct dựa trên key của máy chủ
    // mặc định, dẫn tới handleGenerateMedia gửi key đó tới baseUrl của provider.
    const direct = Boolean(activeProvider?.baseUrl && activeProvider.apiKey);
    return {
      ...(picked.image
        ? { image: { modelId: picked.image.id, label: picked.image.label, direct } }
        : {}),
      ...(picked.video
        ? { video: { modelId: picked.video.id, label: picked.video.label, direct } }
        : {}),
    };
  }, [activeProvider, mediaCatalog, model]);

  /** Đổi provider → model hiện tại không còn trong danh sách thì lấy cái đầu. */
  useEffect(() => {
    if (!MODELS.length) return;
    if (!MODELS.some((m) => m.id === model)) {
      updateSettings({ model: MODELS[0].id });
    }
  }, [MODELS, model, updateSettings]);

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const chatKey = currentChatId ?? draftId;
  const requestEpoch = useRef(0);
  const previousChatId = useRef<string | null>(currentChatId);

  /**
   * Thông báo cho các tab khác rằng cây hội thoại vừa thay đổi.
   * Dùng chung một kênh chatBroadcast (Lamport revision + localStorage fallback)
   * — không còn kênh ad-hoc riêng nào nữa.
   */
  const notifyChatUpdated = useCallback((chatId: string) => {
    try {
      chatBroadcast.publish({
        type: 'chat-updated',
        sessionId: chatId,
        mutationId: createMutationId(),
      });
    } catch {}
  }, []);

  const [attachments, setAttachments] = useState<File[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * Đang sinh ảnh/video trực tiếp từ trình duyệt (không đi qua /api/chat).
   * Tách khỏi isLoading của useChat vì đây không phải stream của SDK.
   */
  const [mediaBusy, setMediaBusy] = useState(false);
  const mediaAbortRef = useRef<AbortController | null>(null);

  /** API mệnh lệnh của composer (draft-local): adopt/voice/suggestion ghi draft. */
  const composerApiRef = useRef<ComposerApi | null>(null);
  /** Mục tiêu seed cho orchestrator lúc mở panel (đọc draft 1 lần, không sync). */
  const [orchestratorSeed, setOrchestratorSeed] = useState('');

  const [allStoredMessages, setAllStoredMessages] = useState<StoredMessage[]>([]);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);

  const allStoredMessagesRef = useRef<StoredMessage[]>([]);
  const activeLeafIdRef = useRef<string | null>(null);
  const pendingAssistantForkRef = useRef<PendingAssistantFork | null>(null);
  const treePersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const latestPersistSnapshotRef = useRef<{
    chatId: string;
    messages: Message[];
    epoch: number;
  } | null>(null);
  const treePersistEpochRef = useRef(0);
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    allStoredMessagesRef.current = allStoredMessages;
  }, [allStoredMessages]);

  useEffect(() => {
    activeLeafIdRef.current = activeLeafId;
  }, [activeLeafId]);

  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const createdObjectUrls = useRef<Set<string>>(new Set());

  /**
   * Read-before-edit guard: tập hợp file đã được fs_read thành công trong
   * phiên này. fs_edit/fs_write từ chối nếu path chưa nằm trong set.
   * Sống theo component mount (không reset khi gửi tin mới) — agent không
   * phải đọc lại file chỉ vì user hỏi tiếp. Port từ Wove (Apache-2.0).
   */
  const readFilesRef = useRef<Set<string>>(new Set());

  /**
   * Staging sandbox state: overlay thay đổi của agent TRƯỚC KHI chạm đĩa.
   * stagingVersion tăng mỗi lần store thay đổi để trigger UI re-render
   * (ref không trigger render). Persist vào Dexie kv khi thay đổi.
   */
  const stagingRef = useRef<StagingStore>({});
  const [stagingVersion, setStagingVersion] = useState(0);
  const [stagingPanelOpen, setStagingPanelOpen] = useState(false);

  /**
   * Orchestrator (port agent-orchestrator + vectorbt): chạy N agent theo lưới
   * tham số, chấm điểm, tổng hợp.
   *
   * CỐ TÌNH là một mặt phẳng RIÊNG, không cắm vào luồng gửi tin nhắn: kết quả
   * chỉ vào hội thoại khi người dùng chủ động bấm nút — "Thêm vào hội thoại"
   * ghi message assistant xuống đúng nhánh đang xem (qua lớp persist sẵn có),
   * "Đưa vào ô nhập" chỉ đặt text vào composer để người dùng sửa rồi tự gửi.
   */
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [activeRecallPack, setActiveRecallPack] = useState<RecallPack | null>(null);
  const [showRecalledDetail, setShowRecalledDetail] = useState(false);
  const orchestrator = useOrchestrator();
  /** Chặn ghép 2 lần cùng một kết quả (double-click trước khi panel kịp đóng). */
  const orchestratorAdoptLockRef = useRef(false);

  /** Panel "Công cụ & quyền": toàn bộ catalog tool + quyền auto-pilot theo nhóm. */
  const [toolsPanelOpen, setToolsPanelOpen] = useState(false);
  const [recipesPanelOpen, setRecipesPanelOpen] = useState(false);

  /** Auto-debug loop state: track retry attempts per command. */
  const debugLoopRef = useRef<DebugStore>(emptyDebugStore());

  /** Post-edit verification: throttle 60s/conversation — slot chiếm trước async. */
  const postEditThrottleRef = useRef<PostEditThrottleState>(emptyPostEditThrottle());

  /* Plan checklist (plan_create/plan_update): nạp từ kv theo chat, cập nhật
     trực tiếp từ handler của tool để UI phản ánh ngay trong lúc stream. */
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planHidden, setPlanHidden] = useState(false);
  useEffect(() => {
    setPlan(null);
    setPlanHidden(false);
    if (!currentChatId) return;
    void db.kv
      .get(`plan:${currentChatId}`)
      .then((row) => {
        if (!row?.value) return;
        const parsed = parsePlan(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
        if (parsed) setPlan(parsed);
      })
      .catch(() => {});
  }, [currentChatId]);

  /* Gắn session với workspace path (P2-8) */
  const [sessionWorkspacePath, setSessionWorkspacePath] = useState<string | null>(null);
  const [dismissedReconnect, setDismissedReconnect] = useState(false);

  useEffect(() => {
    setSessionWorkspacePath(null);
    setDismissedReconnect(false);
    if (!currentChatId) return;
    void db.chats
      .get(currentChatId)
      .then((chat) => {
        if (chat?.workspacePath) {
          setSessionWorkspacePath(chat.workspacePath);
        }
      })
      .catch(() => {});
  }, [currentChatId]);

  /** Ghi overlay + persist + bump version. Gọi sau mọi stage/unstage/clear. */
  const updateStaging = useCallback((next: StagingStore) => {
    stagingRef.current = next;
    setStagingVersion((v) => v + 1);
    db.kv.put({ key: STAGING_KV_KEY, value: serializeStaging(next) }).catch(() => {});
  }, []);

  /** Khôi phục staging từ kv khi mount hoặc đổi chat. */
  useEffect(() => {
    db.kv.get(STAGING_KV_KEY).then((row) => {
      if (!row?.value) return;
      const restored = parseStaging(row.value);
      if (stagingCount(restored) > 0) {
        stagingRef.current = restored;
        setStagingVersion((v) => v + 1);
      }
    }).catch(() => {});
  }, []);

  // Đếm thế hệ attachment: mỗi lần clear (gửi/xóa) tăng 1 — đợt nén ảnh chạy
  // nền khởi động trước đó sẽ tự hủy kết quả nếu giữa chừng list đã bị clear
  // (chống file "ma" dính nhầm vào tin nhắn kế tiếp).
  const attachGenRef = useRef(0);
  /** Mirror để addFiles đọc tổng size MỚI NHẤT qua gap async nén ảnh —
      closure `attachments` stale làm 2 đợt add <1s bypass trần 3MB (B-att). */
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  /* Workspace checkpoint (undo agent coding): 1 lượt agent = 1 snapshot.
     Ref mở từ tool-call ghi đầu tiên tới khi stream kết thúc — useChat giữ
     isLoading=true xuyên các resubmit của maxSteps nên mọi fs_write/fs_edit
     trong cùng response gom về đúng một bản ghi (first-wins per path). */
  const turnCaptureRef = useRef<TurnCapture | null>(null);
  const closeTurnCapture = useCallback(() => {
    turnCaptureRef.current = null;
  }, []);
  /** Đọc "trước khi ghi" cho snapshot — nội dung ĐẦY ĐỦ (fsRead thường trần
      24k ký tự để đớn context; restore bản truncated là hỏng file user). */
  const readCaptureForPath = useCallback(
    async (deps: FsDeps | null, rawPath: string): Promise<CaptureInput> => {
      const r = isVyenDesktop() ? await desktopFsReadFull(rawPath) : await fsReadFull(deps!, rawPath);
      switch (r.status) {
        case 'ok':
          return { status: 'ok', path: r.path, content: r.content };
        case 'missing':
          return { status: 'missing', path: r.path };
        case 'too-large':
          return { status: 'too-large', path: r.path };
        default:
          return { status: 'error', path: rawPath };
      }
    },
    [],
  );

  /**
   * Apply tất cả staged changes: checkpoint disk state → ghi đĩa → clear overlay.
   * Checkpoint dùng workspace-checkpoints (first-wins per path, incomplete blocks rollback).
   */
  const applyAllStaged = useCallback(async () => {
    const store = stagingRef.current;
    const files = Object.values(store);
    if (!files.length) return;

    const isDesktop = typeof window !== 'undefined' && (window as any).vyen?.desktop === true;
    const wsForFs = !isDesktop ? await requireWorkspace().then((r) => (r.ok ? r.deps : null)) : null;
    const capChatId = useAppStore.getState().currentChatId;

    /* Capture disk state TRƯỚC KHI ghi — một capture cho cả batch. */
    const capture = capChatId ? newTurnCapture(capChatId) : null;
    for (const file of files) {
      if (capture) {
        try {
          captureFile(capture, await readCaptureForPath(isDesktop ? null : wsForFs!, file.path));
        } catch {
          /* File không đọc được để capture — đánh dấu incomplete. */
        }
      }
    }

    /* Ghi từng file vào đĩa. */
    for (const file of files) {
      try {
        if (isDesktop) {
          await desktopFsWrite(file.path, file.content);
        } else if (wsForFs) {
          await fsWrite(wsForFs, file.path, file.content);
        }
      } catch (e) {
        showNotice(`Lỗi ghi file ${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    /* Lưu checkpoint (cho undo sau này). */
    if (capture) void saveTurnCapture(capture);

    /* Clear overlay + persist. */
    updateStaging(clearStaging(store));
    setStagingPanelOpen(false);
    showNotice(`Đã apply ${files.length} file vào đĩa.`);
  }, [readCaptureForPath, updateStaging]);

  /** Reject từng file — chỉ xóa khỏi overlay, đĩa không bị đụng. */
  const rejectStagedFile = useCallback((path: string) => {
    updateStaging(unstageFile(stagingRef.current, path));
  }, [updateStaging]);

  /** Reject all — clear overlay, đĩa không bị đụng. */
  const rejectAllStaged = useCallback(() => {
    updateStaging(clearStaging(stagingRef.current));
    setStagingPanelOpen(false);
    showNotice('Đã hủy tất cả thay đổi staged (đĩa không bị ảnh hưởng).');
  }, [updateStaging]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files);
    const gen = attachGenRef.current;

    // Nén ảnh trước khi xét trần: ảnh chụp điện thoại 3-5MB về vài trăm KB
    // (canvas resize + WebP) nên trên 3MB không cần chặn oan người dùng.
    void compressImageFiles(fileArr)
      .catch(() => fileArr) // nén lỗi thì dùng file gốc như cũ
      .then((processed) => {
        if (attachGenRef.current !== gen) return; // đã clear trong lúc nén
        let totalSize = attachmentsRef.current.reduce((sum, f) => sum + f.size, 0);
        const ok: File[] = [];
        const rejected: string[] = [];

        for (const f of processed) {
          if (totalSize + f.size > MAX_TOTAL_ATTACHMENT_BYTES) {
            rejected.push(f.name);
          } else {
            totalSize += f.size;
            ok.push(f);
          }
        }

        if (rejected.length) {
          showNotice(`Bỏ qua file vượt quá giới hạn 3MB: ${rejected.join(', ')}`);
        }
        setAttachments((prev) => [...prev, ...ok].slice(0, MAX_FILES));
      });
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);
  const finishRef = useRef<'stop' | 'abort' | 'error'>('stop');
  /** Auto-retry emulated khi gateway strip tools im lặng (xem onFinish). */
  const emulatedRetryCountRef = useRef(0);
  const switchLockRef = useRef(false);

  /* ------------------------------------------------------------------ */
  /* Lead/Worker routing (port Goose P1-5)                               */
  /* ------------------------------------------------------------------ */
  /** Role của lượt ĐANG chạy — onFinish gắn vào usage annotation làm badge. */
  const routingRoleRef = useRef<RoutingRole | null>(null);
  /** Planner model dùng đúng MỘT lượt kế tiếp sau lệnh /plan. */
  const plannerKickoffRef = useRef<string | null>(null);

  /** Model do routing chọn có gửi được lên route không: provider tự khai
   *  nhận mọi id gateway trả về; Máy chủ mặc định chỉ nhận model built-in
   *  (route 400 MODEL_NOT_ALLOWED với id lạ) — cùng điều kiện recipe dùng. */
  const isRoutableModel = useCallback(
    (id: string): boolean => {
      if (!isApiModelId(id)) return false;
      if (activeProviderId === SERVER_PROVIDER_ID) return MODELS.some((m) => m.id === id);
      return true;
    },
    [activeProviderId, MODELS],
  );

  /**
   * Body override cho MỘT lượt gửi: fold lại toàn bộ history → role → model.
   * Trả {} khi routing tắt hoặc model của role chưa cấu hình — lượt chạy bằng
   * model người dùng chọn như thường. `msgs` truyền tường minh từ closure của
   * từng call site (đúng history tại thời điểm đó) thay vì ref — onFinish
   * drain steering cần fold KỂ CẢ lượt vừa kết thúc.
   */
  const routingBodyFor = useCallback(
    (msgs: readonly Message[], text: string): Record<string, unknown> => {
      const snap = computeRoutingSnapshot(
        msgs as unknown as readonly RoutingMessageLike[],
        modelRouting,
        text,
      );
      if (snap.modelId && isRoutableModel(snap.modelId)) {
        routingRoleRef.current = snap.role;
        return { model: snap.modelId };
      }
      routingRoleRef.current = null;
      return {};
    },
    [modelRouting, isRoutableModel],
  );

  const [isSwitchingBranch, setIsSwitchingBranch] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setIsTouchDevice(media.matches);
    update();

    media.addEventListener?.('change', update);
    return () => {
      media.removeEventListener?.('change', update);
    };
  }, []);

  /* Compaction: marker đưa vào request qua useChat `body` (được đọc từ ref
     cập nhật mỗi render). State khai báo TRƯỚC useChat để tránh TDZ; giá trị
     được đồng bộ từ activeCompaction bằng effect ngay sau hook. */
  const [requestCompaction, setRequestCompaction] = useState<CompactionMarker | undefined>(
    undefined,
  );
  const [compactBusy, setCompactBusy] = useState(false);
  /** Tra cứu web đang chạy trước khi gửi (toggle Globe trong composer). */
  const [webBusy, setWebBusy] = useState(false);
  /** Ref đồng bộ để submitTurn gate đồng bộ (state có thể stale 1 render). */
  const webBusyRef = useRef(false);
  /**
   * P3.1 — Hàng đợi steering/follow-up (ref đồng bộ + state render chip).
   * Ref là nguồn sự thật cho onFinish drain; state chỉ để render + đếm.
   */
  const steeringRef = useRef<string[]>([]);
  const followUpRef = useRef<string[]>([]);
  const [steeringCount, setSteeringCount] = useState(0);
  const [followUpCount, setFollowUpCount] = useState(0);
  const steeringModeRef = useRef<QueueMode>('one-at-a-time');
  const followUpModeRef = useRef<QueueMode>('one-at-a-time');
  useEffect(() => {
    steeringModeRef.current = steeringMode;
    followUpModeRef.current = followUpMode;
  }, [steeringMode, followUpMode]);

  /* ---------------- Agent coding: workspace + client tools ---------------- */
  const [workspace, setWorkspace] = useState(getWorkspaceInfo());
  const currentWsNameOrPath =
    (workspace as unknown as { path?: string })?.path || workspace?.name || '';
  const isWorkspaceMatched = Boolean(
    workspace?.connected &&
      sessionWorkspacePath &&
      (currentWsNameOrPath === sessionWorkspacePath ||
        currentWsNameOrPath.endsWith(sessionWorkspacePath) ||
        sessionWorkspacePath.endsWith(currentWsNameOrPath)),
  );

  /* Nhánh git cho status line (mượn ý @rokiy/pi-ui): đọc 1 LẦN khi workspace
     bật kết nối qua desktop bridge; web thuần không có bridge thì thôi, không
     hiện, không báo lỗi. Đổi nhánh giữa phiên hiếm khi quan trọng tới mức
     phải theo dõi liên tục. */
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!workspace?.connected) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop();
        if (!bridge || cancelled) return;
        const result = await bridge.git.status();
        if (cancelled) return;
        const branch =
          typeof result === 'object' && result !== null && 'branch' in result
            ? String((result as { branch?: unknown }).branch ?? '') || null
            : null;
        setGitBranch(branch);
      } catch {
        // Repo chưa init hoặc bridge lỗi: segment nhánh thôi không hiện.
        setGitBranch(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.connected, workspace?.name]);

  /* B6: hàng đợi diff — model gọi 2 fs_write/fs_edit trong cùng step thì
     promise thứ nhất không bao giờ resolve nếu ghi đè slot. Queue + ref
     mở/đóng: xong cái hiện tại mới shift cái kế. */
  const [diffState, setDiffState] = useState<DiffConfirmState | null>(null);
  const diffOpenRef = useRef(false);
  const diffQueueRef = useRef<DiffConfirmState[]>([]);
  /* Run lifecycle nằm ở phía DƯỚI file (phụ thuộc useChat), nên modal — vốn
     được định nghĩa trước — đi qua ref. */
  const awaitUserRef = useRef<() => void>(() => {});
  const resumeRef = useRef<() => void>(() => {});

  const showDiffModal = useCallback(
    (s: Omit<DiffConfirmState, 'open' | 'resolve'>): Promise<boolean> =>
      new Promise((resolve) => {
        const item: DiffConfirmState = { ...s, open: true, resolve };
        /* Run đậu lại chờ người dùng: KHÔNG được tính là stalled, nếu không
           modal mở 2 phút là bị reconciler kết luận "stream đứt" và giết run. */
        awaitUserRef.current();
        if (diffOpenRef.current) {
          diffQueueRef.current.push(item);
          return;
        }
        diffOpenRef.current = true;
        setDiffState(item);
      }),
    [],
  );
  const closeDiffModal = useCallback(() => {
    const next = diffQueueRef.current.shift();
    if (next) {
      setDiffState(next);
      return;
    }
    diffOpenRef.current = false;
    setDiffState(null);
    resumeRef.current();
  }, []);
  // Shell approval — tương tự diff queue để không ghi đè khi model gọi
  // liên tiếp 2 shell_run trong cùng step.
  type ShellConfirmState = { command: string; cwd?: string; open: true; resolve: (v: boolean) => void };
  const [shellState, setShellState] = useState<ShellConfirmState | null>(null);
  const shellOpenRef = useRef(false);
  const shellQueueRef = useRef<ShellConfirmState[]>([]);
  const showShellModal = useCallback(
    (s: Omit<ShellConfirmState, 'open' | 'resolve'>): Promise<boolean> =>
      new Promise((resolve) => {
        const item: ShellConfirmState = { ...s, open: true, resolve };
        awaitUserRef.current();
        if (shellOpenRef.current) {
          shellQueueRef.current.push(item);
          return;
        }
        shellOpenRef.current = true;
        setShellState(item);
      }),
    [],
  );
  const closeShellModal = useCallback(() => {
    const next = shellQueueRef.current.shift();
    if (next) {
      setShellState(next);
      return;
    }
    shellOpenRef.current = false;
    setShellState(null);
    resumeRef.current();
  }, []);

  /* ------------------------------------------------------------------ */
  /* MCP tools — danh sách tool từ các server người dùng đã kết nối       */
  /* ------------------------------------------------------------------ */

  /**
   * Danh sách tool gửi kèm mỗi request (route chỉ khai báo, không thực thi
   * được). Index nằm trong REF: `handleClientToolCall` cần tra cứu mà không
   * bị phụ thuộc vào closure — thêm vào deps của callback sẽ làm nó đổi
   * danh tính mỗi lần danh sách MCP đổi.
   */
  const mcpIndexRef = useRef<Map<string, { serverId: string; toolName: string }>>(new Map());
  const [mcpTools, setMcpTools] = useState<McpToolInfo[]>([]);
  /**
   * Server đang ở chế độ proxy — tool của chúng KHÔNG gửi vào payload
   * mcpTools (tiết kiệm ngữ cảnh), chỉ dùng làm metadata cho mcp__search.
   * REF như mcpIndexRef: handleClientToolCall tra cứu không qua closure.
   */
  const mcpProxyServerIdsRef = useRef<Set<string>>(new Set());
  /** Metadata tool proxy cho handler mcp__search — ref để closure không stale. */
  const mcpProxyToolsRef = useRef<McpToolInfo[]>([]);
  /** Tool Router Index (P1-7): chỉ mục toàn bộ native + MCP tools phục vụ tools_search. */
  const toolRouterIndexRef = useRef<ToolIndexEntry[]>(buildToolIndex(CLIENT_TOOL_DEFS, []));
  /** Danh sách các tool đã nạp qua tools_load trong phiên hiện tại. */
  const loadedToolNamesRef = useRef<Set<string>>(new Set());

  const refreshMcpTools = useCallback(async () => {
    if (!isMcpAvailable()) return;
    try {
      const tools = await listMcpTools();
      mcpIndexRef.current = mapMcpTools(tools).index;
      toolRouterIndexRef.current = buildToolIndex(CLIENT_TOOL_DEFS, tools);
      setMcpTools(tools);
      try {
        const servers = await listMcpServers();
        mcpProxyServerIdsRef.current = new Set(
          servers.filter((s) => s.exposeMode === 'proxy').map((s) => s.id),
        );
      } catch {
        // Đọc trạng thái server lỗi: giữ nguyên mode cũ, tool vẫn chạy.
      }
      mcpProxyToolsRef.current = tools.filter((t) => mcpProxyServerIdsRef.current.has(t.serverId));
    } catch {
      // Lỗi đọc danh sách (shell Electron bận) — giữ nguyên danh sách cũ,
      // lần refresh sau (khi server đổi trạng thái) sẽ thử lại.
    }
  }, []);

  useEffect(() => {
    if (!isMcpAvailable()) return;
    void refreshMcpTools();
    /* Server đổi trạng thái (vừa thêm, vừa kết nối lại, vừa mất kết nối) là
       lúc danh sách tool thay đổi — nạp lại thay vì đoán. */
    return onMcpServerStatus(() => {
      void refreshMcpTools();
    });
  }, [refreshMcpTools]);

  /* Tách tool full/proxy cho payload. Ref không kích hoạt re-render, nhưng
     refreshMcpTools luôn setMcpTools(new array) cùng lúc với khi ref đổi →
     memo này tính lại đúng lúc danh sách (hoặc mode server) thực sự đổi. */
  const mcpFullTools = useMemo(
    () => mcpTools.filter((t) => !mcpProxyServerIdsRef.current.has(t.serverId)),
    [mcpTools],
  );
  const mcpProxyTools = useMemo(
    () => mcpTools.filter((t) => mcpProxyServerIdsRef.current.has(t.serverId)),
    [mcpTools],
  );

  /* ------------------------------------------------------------------ */
  /* Auto-pilot wrappers: skip modal when policy allows auto-approval    */
  /* ------------------------------------------------------------------ */

  const autoApproveShell = useCallback(
    async (s: { command: string; cwd?: string }): Promise<boolean> => {
      if (
        shouldAutoApprove({
          toolName: 'shell_run',
          args: { command: s.command, cwd: s.cwd },
          policy: approvalPolicy,
          autoPilotEnabled: autoPilot,
          toolPermissions,
        })
      ) {
        return true;
      }
      return showShellModal(s);
    },
    [autoPilot, approvalPolicy, toolPermissions, showShellModal],
  );

  const autoApproveCode = useCallback(
    async (s: { code: string }): Promise<boolean> => {
      if (
        shouldAutoApprove({
          toolName: 'run_code',
          args: { code: s.code },
          policy: approvalPolicy,
          autoPilotEnabled: autoPilot,
          toolPermissions,
        })
      ) {
        return true;
      }
      return showShellModal({ command: `[run_code]:\n${s.code}` });
    },
    [autoPilot, approvalPolicy, toolPermissions, showShellModal],
  );

  const autoApproveDiff = useCallback(
    async (s: { path: string; oldText: string; newText: string }): Promise<boolean> => {
      if (
        shouldAutoApprove({
          toolName: 'fs_edit',
          args: { path: s.path },
          policy: approvalPolicy,
          autoPilotEnabled: autoPilot,
          toolPermissions,
        })
      ) {
        return true;
      }
      return showDiffModal(s);
    },
    [autoPilot, approvalPolicy, toolPermissions, showDiffModal],
  );

  useEffect(() => {
    /* Khôi phục handle phiên trước. PHẢI đồng bộ lại state sau khi xong:
       restoreWorkspaceRoot() chỉ nạp handle vào biến module của fs-access,
       còn `workspace` được khởi tạo bằng getWorkspaceInfo() ở lần render ĐẦU
       — lúc đó handle chưa nạp nên luôn là {connected:false}. Thiếu bước này,
       nút 📁 mãi hiện "chưa kết nối" dù thư mục đã sẵn sàng, và người dùng
       tưởng tính năng hỏng. */
    let alive = true;
    if (isVyenDesktop()) {
      void desktopGetWorkspaceInfo().then((info) => {
        if (alive) setWorkspace(info);
      });
    } else {
      void restoreWorkspaceRoot().then(() => {
        if (alive) setWorkspace(getWorkspaceInfo());
      });
    }
    return () => {
      alive = false;
    };
  }, []);
  const pickFolder = useCallback(async () => {
    if (isVyenDesktop()) {
      const r = await desktopPickWorkspaceRoot();
      if (!r.ok) {
        showNotice(r.error);
      } else {
        showNotice(`Đã kết nối thư mục: ${r.name}`, 3000);
      }
      const info = isVyenDesktop() ? await desktopGetWorkspaceInfo() : getWorkspaceInfo();
      setWorkspace(info);
      const activeChatId = useAppStore.getState().currentChatId;
      const pathOrName = (info as unknown as { path?: string }).path || info.name;
      if (activeChatId && pathOrName) {
        setSessionWorkspacePath(pathOrName);
        void db.chats.update(activeChatId, { workspacePath: pathOrName });
      }
      return;
    }
    const r = await pickWorkspaceRoot();
    if (!r.ok) {
      showNotice(r.error);
    } else {
      showNotice(`Đã kết nối thư mục: ${r.name}`, 3000);
    }
    const info = getWorkspaceInfo();
    setWorkspace(info);
    const activeChatId = useAppStore.getState().currentChatId;
    const pathOrName = (info as unknown as { path?: string }).path || info.name;
    if (activeChatId && pathOrName) {
      setSessionWorkspacePath(pathOrName);
      void db.chats.update(activeChatId, { workspacePath: pathOrName });
    }
  }, []);

  /**
   * Ngắt kết nối workspace: xoá handle khỏi bộ nhớ + IndexedDB (web) hoặc
   * gọi IPC clear (desktop). Sync lại state ngay để nút 📁/FolderX phản ánh
   * đúng trạng thái — thiếu bước này UI vẫn tưởng còn kết nối.
   */
  const disconnectFolder = useCallback(async () => {
    if (isVyenDesktop()) {
      try {
        await desktopDisconnectWorkspace();
      } catch (e) {
        showNotice(e instanceof Error ? e.message : 'Không ngắt được kết nối workspace.');
        return;
      }
      setWorkspace(await desktopGetWorkspaceInfo());
    } else {
      await disconnectWorkspace();
      setWorkspace(getWorkspaceInfo());
    }
    showNotice('Đã ngắt kết nối thư mục làm việc.', 3000);
  }, []);

  /** Build API headers cho fetch calls — gộp logic trùng lặp từ useChat + performCompaction.
   *  Khai báo TRƯỚC handleClientToolCall: luồng mô tả ảnh (fs_read ảnh, ảnh MCP)
   *  gọi /api/vision ngay trong tool handler và cần đúng headers provider này. */
  const buildApiHeaders = useCallback((): Record<string, string> => ({
    ...(accessCode ? { 'x-access-code': accessCode } : {}),
    ...(activeProvider?.baseUrl
      ? {
          'x-api-base': activeProvider.baseUrl,
          ...(activeProvider.apiKey ? { 'x-api-key': activeProvider.apiKey } : {}),
        }
      : apiKey
        ? { 'x-api-key': apiKey }
        : {}),
  }), [accessCode, activeProvider, apiKey]);

  /**
   * fs_*, shell, git tools chạy NGAY TRÊN MÁY USER — server không thể chạm file.
   * onToolCall trả kết quả (JSON string) → useChat đặt state 'result' → sau stream,
   * maxSteps phía client tự resubmit cho model đọc kết quả tiếp.
   * fs_write/shell_run PHẢI qua confirm: người dùng duyệt mới ghi/chạy.
   */
  const handleClientToolCall = useCallback(
    async ({ toolCall }: { toolCall: { toolName: string; args?: unknown } }) => {
      /* Thân thực thi MCP dùng chung: tool thường (qua index) lẫn action "call"
         của tool proxy (resolve từ metadata) phải đi ĐÚNG đường này để không
         né approval/autoApprove/vision/format. */
      const runMcpExecution = async (
        serverId: string,
        toolName: string,
        modelFacingKey: string,
        args: Record<string, unknown>,
      ): Promise<string> => {
        try {
          const result = await callMcpTool(serverId, toolName, args);
          /* Ảnh do MCP trả về → mô tả text qua pipeline vision TRƯỚC khi nén
             thành string cho model (đường sync chỉ để placeholder). Bỏ qua
             khi denied/isError — kết quả khi đó bị nén thành JSON lỗi, mô tả
             ảnh chỉ tốn lệnh vision (~35s + ngân sách rate limit của route).
             Tầng này phục vụ cả tool MCP của subagent (relay đi qua handler
             này). Lambda bọc vì describeMcpImage nhận fetchImpl ở tham số 2,
             không khớp McpImageDescriber (mimeType) — nên fetchImpl để
             undefined (mặc định) và opts đi ở tham số 3.
             CHƯA chọn model vision → bỏ hẳn bước describe: /api/vision đòi
             model nên mọi khối ảnh chỉ nhận về "mô tả thất bại", tệ hơn ghi
             chú placeholder mặc định của mcpContentToText. */
          let content = result.content;
          if (visionModel && !result.denied && !result.isError && hasMcpImages(content)) {
            content = await describeMcpImageBlocks(content, (url) =>
              describeMcpImage(url, undefined, { headers: buildApiHeaders(), model: visionModel }),
            );
          }
          return formatMcpResultForModel({ ...result, content }, modelFacingKey);
        } catch (err) {
          /* Lỗi GIAO THỨC (mất kết nối, timeout, người dùng từ chối ở tầng
             IPC) — khác với lỗi nghiệp vụ đã được format ở trên. */
          return JSON.stringify({
            error: `Gọi công cụ MCP "${modelFacingKey}" thất bại: ${String(
              err instanceof Error ? err.message : err,
            )}`,
          });
        }
      };

      /* Mode chat_only (P1-6): vô hiệu hoàn toàn toàn bộ tool (kể cả fs_read) */
      if (approvalPolicy === 'chat_only') {
        return JSON.stringify({
          error: `Tool "${toolCall.toolName}" is denied by policy (chat_only mode).`,
          denied: true,
        });
      }

      /* Tool MCP đi TRƯỚC mọi kiểm tra khác: chúng không cần workspace
         (không đụng file của người dùng qua fs_*), và tên không nằm trong
         CLIENT_TOOL_NAMES nên sẽ bị chặn ở ngay dòng dưới nếu để lọt xuống. */
      if (isMcpToolKey(toolCall.toolName)) {
        if (isToolDenied(toolCall.toolName, toolPermissions)) {
          return JSON.stringify({
            error: `Tool "${toolCall.toolName}" is denied by policy.`,
            denied: true,
          });
        }
        /* Tool proxy: key mcp__search không có entry trong index — xử lý
           riêng, resolve key action call từ metadata server proxy. */
        if (toolCall.toolName === MCP_PROXY_TOOL_KEY) {
          const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
          const action = typeof rawArgs.action === 'string' ? rawArgs.action : '';
          const proxyList = mcpProxyToolsRef.current;
          if (action === 'search') {
            const matches = searchMcpProxyTools(
              proxyList,
              typeof rawArgs.query === 'string' ? rawArgs.query : '',
            );
            return JSON.stringify({
              tools: matches,
              hint: matches.length
                ? 'Gọi action "call" với key + args; "describe" để xem schema đầy đủ trước nếu cần.'
                : 'Không có tool nào khớp — thử từ khoá khác hoặc query rỗng để liệt kê.',
            });
          }
          if (action === 'describe') {
            const t =
              typeof rawArgs.key === 'string' ? resolveMcpProxyTool(proxyList, rawArgs.key) : null;
            if (!t) {
              return JSON.stringify({
                error: `Key "${String(rawArgs.key ?? '')}" không thuộc server proxy hiện hành — hãy search lại.`,
              });
            }
            return JSON.stringify({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            });
          }
          if (action === 'call') {
            const t =
              typeof rawArgs.key === 'string' ? resolveMcpProxyTool(proxyList, rawArgs.key) : null;
            if (!t) {
              return JSON.stringify({
                error: `Key "${String(rawArgs.key ?? '')}" không thuộc server proxy hiện hành — hãy search lại.`,
              });
            }
            const args = normalizeMcpProxyArgs(rawArgs.args);
            if (!args) {
              return JSON.stringify({
                error:
                  'args không parse được thành object — gửi lại dạng object JSON hoặc chuỗi JSON của object.',
              });
            }
            return await runMcpExecution(t.serverId, t.name, mcpToolKey(t.serverId, t.name), args);
          }
          return JSON.stringify({
            error: `Action không hợp lệ: ${action || '(thiếu)'} — chỉ dùng search/describe/call.`,
          });
        }
        const target = mcpIndexRef.current.get(toolCall.toolName);
        if (!target) {
          return JSON.stringify({
            error:
              `Tool MCP "${toolCall.toolName}" không còn tồn tại — server có thể đã bị gỡ ` +
              'hoặc mất kết nối. Kiểm tra lại trong Cài đặt → MCP.',
          });
        }
        return await runMcpExecution(
          target.serverId,
          target.toolName,
          toolCall.toolName,
          (toolCall.args ?? {}) as Record<string, unknown>,
        );
      }
      /* skill_load (P0-3): khai báo ĐỘNG ở route nên không thuộc
         CLIENT_TOOL_NAMES. Đọc SKILL.md ở máy user — skill workspace cần
         workspace, skill toàn cục (~/.vyen) thì không. Xử lý trước cổng
         "tool lạ"/workspace để không chặn oan; vẫn tôn trọng nhóm quyền
         (skill_load xếp nhóm fs_read). */
      if (toolCall.toolName === 'skill_load') {
        if (isToolDenied('skill_load', toolPermissions)) {
          return JSON.stringify({
            error: 'Tool "skill_load" is denied by policy.',
            denied: true,
          });
        }
        const wantName = String(((toolCall.args ?? {}) as Record<string, unknown>).name ?? '').trim();
        const entry = useDiskSkillsStore.getState().entries.find((e) => e.name === wantName);
        if (!entry) {
          const available = useDiskSkillsStore.getState().entries.map((e) => e.name).join(', ');
          return JSON.stringify({
            error: `Không có skill "${wantName}" trong chỉ mục. Có: ${available || '(chưa quét được skill nào)'}`,
          });
        }
        try {
          return JSON.stringify(await loadSkillContent(entry));
        } catch (err) {
          return JSON.stringify({
            error: `Đọc skill "${wantName}" thất bại: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      /* tools_search (P1-7 Tool Router): tìm kiếm tool trong chỉ mục */
      if (toolCall.toolName === 'tools_search') {
        if (isToolDenied('tools_search', toolPermissions)) {
          return JSON.stringify({ error: 'Tool "tools_search" is denied by policy.', denied: true });
        }
        const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
        const query = String(rawArgs.query ?? '');
        const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : 10;
        const matches = searchTools(toolRouterIndexRef.current, query, limit, loadedToolNamesRef.current);
        return JSON.stringify({
          matches,
          totalMatches: matches.length,
          hint: matches.length
            ? 'Gọi tools_load([name]) để nạp công cụ vào phiên nếu bạn muốn dùng ở bước tiếp theo.'
            : 'Không tìm thấy công cụ nào khớp từ khoá — hãy thử từ khoá khác tổng quát hơn.',
        });
      }

      /* tools_load (P1-7 Tool Router): nạp động tool vào phiên */
      if (toolCall.toolName === 'tools_load') {
        if (isToolDenied('tools_load', toolPermissions)) {
          return JSON.stringify({ error: 'Tool "tools_load" is denied by policy.', denied: true });
        }
        const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
        const names = Array.isArray(rawArgs.names) ? rawArgs.names.map(String) : [];
        const loaded: string[] = [];
        const notFound: string[] = [];
        for (const name of names) {
          if (toolRouterIndexRef.current.some((t) => t.name === name)) {
            loadedToolNamesRef.current.add(name);
            loaded.push(name);
          } else {
            notFound.push(name);
          }
        }
        return JSON.stringify({
          loaded,
          notFound,
          totalActiveLoaded: loadedToolNamesRef.current.size,
          note: loaded.length
            ? `Đã nạp ${loaded.length} công cụ vào phiên. Bạn có thể gọi trực tiếp công cụ này trong lượt tiếp theo.`
            : 'Không tìm thấy tên công cụ nào khớp trong chỉ mục để nạp.',
        });
      }

      /* run_code (P1-7 Code Mode): thực thi JavaScript sandbox gọi MCP tools */
      if (toolCall.toolName === 'run_code') {
        if (isToolDenied('run_code', toolPermissions)) {
          return JSON.stringify({ error: 'Tool "run_code" is denied by policy.', denied: true });
        }
        const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
        const code = String(rawArgs.code ?? '');
        const approved = await autoApproveCode({ code });
        if (!approved) {
          return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI thực thi đoạn mã này.' });
        }
        const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop();
        if (!bridge?.code?.run) {
          return JSON.stringify({ error: 'Code Mode đòi hỏi kết nối với Vyen desktop bridge.' });
        }
        const res = await bridge.code.run({ code });
        return JSON.stringify(res);
      }

      /* chat_recall (Goose P2-8): tra cứu full-text toàn bộ lịch sử trò chuyện */
      if (toolCall.toolName === 'chat_recall') {
        if (isToolDenied('chat_recall', toolPermissions)) {
          return JSON.stringify({ error: 'Tool "chat_recall" is denied by policy.', denied: true });
        }
        const rawArgs = (toolCall.args ?? {}) as Record<string, unknown>;
        const query = String(rawArgs.query ?? '').trim();
        const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : 5;
        try {
          const { recallChatSessions } = await import('@/lib/chat-recall');
          const results = await recallChatSessions(query, limit);
          return JSON.stringify({
            query,
            total: results.length,
            results,
            hint: results.length
              ? 'Đã tìm thấy các phiên trò chuyện liên quan trong lịch sử. Bạn có thể sử dụng thông tin và ngữ cảnh này để trả lời người dùng.'
              : 'Không tìm thấy phiên trò chuyện nào trong lịch sử phù hợp với từ khoá.',
          });
        } catch (err) {
          return JSON.stringify({
            error: `Lỗi tra cứu lịch sử: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (!CLIENT_TOOL_NAMES.has(toolCall.toolName)) {
        /* Tool lạ PHẢI trả result string thay vì undefined: ai@4 giữ invocation
           kẹt ở state `call` mãi mãi khi onToolCall không trả gì → stream treo
           vĩnh viễn. Nhánh default cuối switch đã làm đúng — đồng bộ hoá. */
        return JSON.stringify({ error: `Tool không tồn tại: ${toolCall.toolName}` });
      }
      /* Quyền "Chặn" per-tool & category: kiểm tra TRƯỚC mọi nhánh thực thi
         để không modal nào hiện lên khi bị deny. Trả về đúng "denied by policy" */
      if (isToolDenied(toolCall.toolName, toolPermissions)) {
        const category = TOOL_CATEGORY_MAP[toolCall.toolName];
        return JSON.stringify({
          error:
            `Tool "${toolCall.toolName}" is denied by policy: nhóm ` +
            `"${category ? TOOL_CATEGORY_LABELS[category]?.label ?? String(category) : 'MCP'}" đang bị đặt quyền ` +
            'Chặn. Hãy báo người dùng và chờ họ đổi quyền nếu cần dùng lại.',
          denied: true,
        });
      }
      const isDesktop = isVyenDesktop();
      const desktopOnly = new Set(['shell_run', 'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'bg_run', 'bg_status', 'bg_stop']);
      if (desktopOnly.has(toolCall.toolName) && !isDesktop) {
        return JSON.stringify({ error: 'Tool này chỉ khả dụng trong Vyen desktop (Electron). Hãy chạy app bằng npm run app:dev / app:prod.' });
      }
      // Workspace check — rẽ nhánh desktop/web
      if (isDesktop) {
        const wsD = await desktopRequireWorkspace();
        if (!wsD.ok) {
          showNotice(wsD.error);
          return JSON.stringify({ error: wsD.error });
        }
      } else {
        const ws = await requireWorkspace();
        if (!ws.ok) {
          showNotice(ws.error);
          return JSON.stringify({ error: ws.error });
        }
      }
      // Lấy deps cho web path (desktop không cần)
      const wsForFs = !isDesktop ? await requireWorkspace().then((r) => (r.ok ? r.deps : null)) : null;
      const args = (toolCall.args ?? {}) as Record<string, unknown>;
      /* Post-edit verification (ý tưởng pi-lens, thu gọn): sau khi ghi file
         THÀNH CÔNG ở đường legacy, chạy lint/typecheck khai báo trong
         package.json (allow-list tên script, tối đa 2 lệnh) và gắn kết quả
         vào tool result để model thấy lỗi NGAY trong lượt. Throttle 60s theo
         hội thoại, và VẪN đi qua autoApproveShell — chính sách duyệt của
         user không bị bypass; bị từ chối thì bỏ qua check im lặng. */
      const runPostEditChecks = async (): Promise<PostEditCheckOutcome[] | null> => {
        if (!isDesktop) return null; // web không có shell — bỏ qua im lặng
        // Key throttle đọc tại chỗ từ store (như capChatId) — không đưa vào deps.
        const throttleKey = useAppStore.getState().currentChatId ?? '';
        if (!acquirePostEditSlot(postEditThrottleRef.current, throttleKey, Date.now())) return null;
        let pkgRaw = '';
        try {
          const probe = await desktopFsRead('package.json');
          pkgRaw = String((probe as unknown as Record<string, unknown>)?.content ?? '');
        } catch {
          return null; // không đọc được package.json — không có gì để check
        }
        let pkg: unknown;
        try {
          pkg = JSON.parse(pkgRaw);
        } catch {
          return null;
        }
        const commands = detectPostEditCommands(pkg);
        const outcomes: PostEditCheckOutcome[] = [];
        for (const c of commands) {
          let approved = false;
          try {
            approved = await autoApproveShell({ command: c.command, cwd: undefined });
          } catch {
            approved = false;
          }
          if (!approved) break; // policy từ chối → dừng cả vòng, result giữ nguyên
          try {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const r = await bridge.shell.run({ command: c.command, timeoutMs: POST_EDIT_CHECK_TIMEOUT_MS });
            const output = r.stderr?.trim() ? `${r.stdout ?? ''}\n${r.stderr}` : (r.stdout ?? '');
            outcomes.push({
              command: c.command,
              exitCode: r.code ?? null,
              ok: r.code === 0,
              output,
            });
          } catch {
            outcomes.push({
              command: c.command,
              exitCode: null,
              ok: false,
              output: '(lệnh check thất bại — không ảnh hưởng kết quả của edit)',
            });
          }
        }
        return outcomes;
      };
      try {
        switch (toolCall.toolName) {
          case 'fs_list': {
            const rel = String(args.path ?? '');
            const data = isDesktop ? await desktopFsList(rel) : await fsList(wsForFs!, rel);
            return JSON.stringify(data);
          }
          case 'fs_read': {
            const rel = String(args.path ?? '');
            /* Staging overlay: nếu file đang staged, trả nội dung staged thay
               vì đĩa. Agent tự thấy kết quả sửa của mình → tránh doom-loop
               "sửa rồi đọc lại vẫn cũ". Port từ Plandex sandbox model. */
            const normRel = normalizePathKey(rel);
            const stagedEntry = stagingRef.current[normRel];
            if (stagedEntry && !isImagePath(rel)) {
              readFilesRef.current.add(normRel);
              const content = stagedEntry.content;
              const lines = content.split('\n');
              const startLine = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
              const lineCount = typeof args.line_count === 'number' ? args.line_count : undefined;
              const sliced = lineCount !== undefined
                ? lines.slice(startLine - 1, startLine - 1 + lineCount)
                : lines.slice(startLine - 1);
              /* Trần 24k ký tự MIRROR fsRead trên đĩa: overlay tích luỹ nhiều
                 fs_edit có thể dài hơn trần — không cắt thì một fs_read nhồi
                 cả file khổng lồ vào context trong khi đường đĩa vẫn cắt.
                 truncated phản ánh cả cắt-dòng (có line_count) lẫn cắt-ký tự
                 để model biết gọi tiếp start_line thay vì tưởng hết file. */
              const STAGED_READ_MAX_CHARS = 24_000;
              const joined = sliced.join('\n');
              const truncated =
                (lineCount !== undefined ? startLine - 1 + lineCount < lines.length : false) ||
                joined.length > STAGED_READ_MAX_CHARS;
              return JSON.stringify({
                content: joined.slice(0, STAGED_READ_MAX_CHARS),
                size: content.length,
                truncated,
                staged: true,
              });
            }
            /* Ảnh trong workspace: đọc bytes → /api/vision mô tả → model nhận
               bản mô tả text thay vì bị từ chối (lỗi "image input" người dùng
               từng gặp khi bytes nhị phân đi thẳng vào context). */
            if (isImagePath(rel)) {
              /* Chưa chọn model đọc ảnh: KHÔNG gọi /api/vision (route đòi
                 model, chắc chắn 400) — trả thẳng lý do theo shape
                 WorkspaceImageToolResult để model đọc được và nói lại cho
                 người dùng cách bật, thay vì báo "lỗi hệ thống tệp". */
              if (!visionModel) {
                const result: WorkspaceImageToolResult = {
                  path: rel,
                  kind: 'image',
                  error:
                    'Chưa chọn model đọc ảnh (vision) trong Cài đặt → Nhà cung cấp, nên không mô ' +
                    'tả được ảnh này. Hãy nói người dùng chọn một model xem được ảnh của Nhà cung ' +
                    'cấp đang bật rồi đọc lại.',
                };
                return JSON.stringify(result);
              }
              const result = await describeWorkspaceImage(
                rel,
                isDesktop ? desktopFsReadImage : (p) => fsReadImage(wsForFs!, p),
                /* fetchImpl mặc định (chỗ tiêm này chỉ dành cho test) — headers
                   provider + model vision đi ở tham số thứ 4. */
                undefined,
                { headers: buildApiHeaders(), model: visionModel },
              );
              return JSON.stringify(result);
            }
            const opts = {
              ...(typeof args.start_line === 'number' ? { startLine: args.start_line } : {}),
              ...(typeof args.line_count === 'number' ? { lineCount: args.line_count } : {}),
            };
            const data = isDesktop ? await desktopFsRead(rel, opts) : await fsRead(wsForFs!, rel, opts);
            /* Read-before-edit: ghi nhận file đã đọc để fs_edit/fs_write cho phép. */
            if (!(data as unknown as Record<string, unknown>)?.error) {
              readFilesRef.current.add(normalizePathKey(rel));
            }
            return JSON.stringify(data);
          }
          case 'fs_search': {
            const query = String(args.query ?? '');
            const isRegex = args.is_regex === true;
            const data = isDesktop ? await desktopFsSearch(query, { isRegex }) : await fsSearch(wsForFs!, query, { isRegex });
            return JSON.stringify(data);
          }
          case 'fs_edit': {
            const path = String(args.path ?? '');
            /* Read-before-edit guard: từ chối sửa file chưa đọc. Guard cứng ở
               tầng tool — model PHẢI fs_read trước khi fs_edit. Port từ Wove. */
            const normPath = normalizePathKey(path);
            if (normPath && !readFilesRef.current.has(normPath)) {
              return JSON.stringify({
                applied: false,
                error:
                  `File "${path}" chưa được đọc. Bạn PHẢI gọi fs_read để đọc nội dung file này ` +
                  'trước khi sửa. Điều này đảm bảo bạn hiểu rõ nội dung hiện tại và tránh ghi đè ' +
                  'nội dung quan trọng mà bạn chưa xem.',
              });
            }
            /* Plan mode guard: chặn write ở client dù server đã lọc. Lớp bảo vệ
               kép — model yếu đôi khi vẫn hallucinate tool call dù không thấy
               tool trong schema. */
            if (agentMode === 'plan') {
              return JSON.stringify({
                applied: false,
                error:
                  'PLAN MODE đang bật — không được phép sửa file. Hãy trình bày kế hoạch ' +
                  'và chờ người dùng chuyển sang ACT mode trước khi thực thi.',
              });
            }
            const blocksText = String(args.blocks ?? '');
            const { parseEditBlocks, replaceMostSimilarChunk } = await import('@/lib/edit-blocks');
            const parsed = parseEditBlocks(blocksText);
            if (parsed.error || parsed.blocks.length === 0) {
              return JSON.stringify({ applied: false, error: parsed.error ?? 'Không parse được khối edit.' });
            }
            /* Staging path: base content từ overlay nếu có, nếu không thì từ đĩa. */
            const existingStaged = stagingRef.current[normPath];
            let beforeText: string;
            if (existingStaged) {
              beforeText = existingStaged.content;
            } else {
              /* Đọc NGUYÊN VĂN toàn file qua fsReadFull/desktopFsReadFull —
                 KHÔNG dùng fsRead thường: bản đó cắt 24k ký tự để đớn context,
                 mà SEARCH/REPLACE dưới đây áp lên beforeText rồi fsWrite/staging
                 ghi ĐÈ TOÀN FILE → file >24k mất sạch phần đuôi (mất dữ liệu).
                 File vượt trần đọc full → trả tool error, bắt model chia nhỏ. */
              const full = isDesktop ? await desktopFsReadFull(path) : await fsReadFull(wsForFs!, path);
              if (full.status !== 'ok') {
                return JSON.stringify({
                  applied: false,
                  error:
                    full.status === 'too-large'
                      ? `File "${path}" quá lớn để fs_edit (trần đọc toàn bộ 512KB). Hãy đọc từng đoạn bằng fs_read rồi áp nhiều lần fs_edit nhỏ.`
                      : full.status === 'missing'
                        ? `File "${path}" không tồn tại. Dùng fs_write để tạo file mới.`
                        : `Không đọc được "${path}": ${'message' in full ? full.message : 'lỗi không rõ'}`,
                });
              }
              beforeText = full.content;
            }
            let current = beforeText;
            const applied = [];
            for (const block of parsed.blocks) {
              const r = replaceMostSimilarChunk(current, block.search, block.replace);
              if (!r.ok) {
                return JSON.stringify({
                  applied: false,
                  failedBlock: { file: block.filename, search: block.search.slice(0, 200) },
                  hint: r.hint,
                  note: 'Khối SEARCH không khớp. Đọc lại file (fs_read) rồi copy NGUYÊN VĂN đoạn cần đổi.',
                });
              }
              current = r.text!;
              applied.push(r.strategy);
            }
            /* Staging path: ghi vào overlay thay vì đĩa. Agent tiếp tục làm
               việc bình thường; user review batch trong staging panel. */
            if (stagingEnabled) {
              const diskOriginal = existingStaged ? existingStaged.original : beforeText;
              updateStaging(stageFile(stagingRef.current, path, diskOriginal, current));
              readFilesRef.current.add(normPath);
              return JSON.stringify({ applied: true, staged: true, blocks: applied.length, strategies: applied });
            }
            /* Legacy path: diff modal + ghi đĩa ngay + checkpoint. */
            const approved = await autoApproveDiff({ path, oldText: beforeText, newText: current });
            if (!approved) {
              return JSON.stringify({
                applied: false,
                approved: false,
                note: 'Người dùng TỪ CHỐI bản sửa này. Hỏi họ muốn điều chỉnh gì trước khi thử lại.',
              });
            }
            const capChatId = useAppStore.getState().currentChatId;
            if (capChatId) {
              if (!turnCaptureRef.current) {
                turnCaptureRef.current = newTurnCapture(capChatId);
              }
              captureFile(turnCaptureRef.current, await readCaptureForPath(isDesktop ? null : wsForFs!, path));
            }
            const res = isDesktop ? await desktopFsWrite(path, current) : await fsWrite(wsForFs!, path, current);
            if (turnCaptureRef.current) void saveTurnCapture(turnCaptureRef.current);
            const editChecks = await runPostEditChecks();
            const editResult = JSON.stringify({ applied: true, blocks: applied.length, strategies: applied, ...res });
            return editChecks ? attachPostEditCheck(editResult, editChecks) : editResult;
          }
          case 'fs_write': {
            const path = String(args.path ?? '');
            /* Read-before-edit guard cho FILE ĐÃ TỒN TẠI: tạo file mới thì OK,
               nhưng ghi đè file cũ mà chưa đọc → từ chối. Kiểm tra bằng cách
               thử đọc: nếu file tồn tại mà chưa nằm trong readFilesRef → chặn. */
             const normPath = normalizePathKey(path);
            if (normPath && !readFilesRef.current.has(normPath)) {
              let fileExists = false;
              try {
                const probe = isDesktop
                  ? await desktopFsRead(path)
                  : await fsRead(wsForFs!, path);
                fileExists = !(probe as unknown as Record<string, unknown>)?.error;
              } catch {
                fileExists = false;
              }
              if (fileExists) {
                return JSON.stringify({
                  applied: false,
                  error:
                    `File "${path}" đã tồn tại nhưng chưa được đọc. Bạn PHẢI gọi fs_read trước ` +
                    'khi ghi đè để đảm bảo không mất nội dung quan trọng. Nếu muốn tạo file MỚI, ' +
                    'đảm bảo đường dẫn chưa tồn tại.',
                });
              }
              /* File chưa tồn tại → tạo mới, cho phép. Tự động mark là đã "đọc"
                 (biết rõ nội dung vì chính agent viết). */
              readFilesRef.current.add(normPath);
            }
            if (agentMode === 'plan') {
              return JSON.stringify({
                applied: false,
                error:
                  'PLAN MODE đang bật — không được phép ghi file. Hãy trình bày kế hoạch ' +
                  'và chờ người dùng chuyển sang ACT mode trước khi thực thi.',
              });
            }
            const content = String(args.content ?? '');
            let oldText = '';
            {
              /* Đọc full như fs_edit: oldText là cơ sở của diff duyệt + original
                 của staging + đếm dòng cho trần 200 dòng — bản cắt 24k làm user
                 duyệt diff KHÔNG thấy phần đuôi bị xoá, và file nhiều ký tự dài
                 lách qua trần dòng. File >512KB → chặn, buộc dùng fs_edit. */
              const full = isDesktop ? await desktopFsReadFull(path) : await fsReadFull(wsForFs!, path);
              if (full.status === 'too-large') {
                return JSON.stringify({
                  written: false,
                  error:
                    `File "${path}" quá lớn để ghi đè toàn bộ (trần đọc 512KB). ` +
                    'Dùng fs_edit để sửa cục bộ thay vì ghi lại cả file.',
                });
              }
              if (full.status === 'ok') oldText = full.content;
              /* missing/error → coi như file mới — diff toàn bộ là add (giữ hành vi cũ). */
            }
            /* Large file protection (port Wove, Apache-2.0): chặn full rewrite
               file >200 dòng. Ghi đè file lớn dễ mất nội dung agent chưa đọc
               tới; buộc dùng fs_edit để sửa cục bộ. Tạo file mới (oldText='')
               không bị chặn. */
            const LARGE_FILE_LINE_LIMIT = 200;
            if (oldText) {
              const lineCount = oldText.split('\n').length;
              if (lineCount > LARGE_FILE_LINE_LIMIT) {
                return JSON.stringify({
                  written: false,
                  error:
                    `File "${path}" có ${lineCount} dòng — quá lớn để ghi đè toàn bộ (trần ${LARGE_FILE_LINE_LIMIT} dòng). ` +
                    'Dùng fs_edit để sửa CỤC BỘ thay vì ghi đè cả file. Điều này tránh mất nội dung ' +
                    'bạn chưa đọc tới và giảm rủi ro lỗi. Nếu thực sự cần viết lại toàn bộ, hãy chia ' +
                    'nhỏ thành nhiều lần fs_edit.',
                });
              }
            }
            /* Staging path: ghi vào overlay thay vì đĩa. */
            if (stagingEnabled) {
              const existing = stagingRef.current[normPath];
              const diskOriginal = existing ? existing.original : (oldText || null);
              updateStaging(stageFile(stagingRef.current, path, diskOriginal, content));
              readFilesRef.current.add(normPath);
              return JSON.stringify({ written: true, staged: true, size: content.length });
            }
            /* Legacy path: diff modal + ghi đĩa ngay + checkpoint. */
            const approved = await autoApproveDiff({ path, oldText, newText: content });
            if (!approved) {
              return JSON.stringify({
                written: false,
                approved: false,
                note: 'Người dùng TỪ CHỐI ghi file này. Đừng ghi lại y nguyên — hỏi họ muốn điều chỉnh gì.',
              });
            }
            const capChatId = useAppStore.getState().currentChatId;
            if (capChatId) {
              if (!turnCaptureRef.current) {
                turnCaptureRef.current = newTurnCapture(capChatId);
              }
              captureFile(turnCaptureRef.current, await readCaptureForPath(isDesktop ? null : wsForFs!, path));
            }
            const writeRes = isDesktop ? await desktopFsWrite(path, content) : await fsWrite(wsForFs!, path, content);
            if (turnCaptureRef.current) void saveTurnCapture(turnCaptureRef.current);
            const writeChecks = await runPostEditChecks();
            const writeResult = JSON.stringify({ written: true, ...writeRes });
            return writeChecks ? attachPostEditCheck(writeResult, writeChecks) : writeResult;
          }
          case 'shell_run': {
            const command = String(args.command ?? '');
            const cwd = args.cwd ? String(args.cwd) : undefined;
            const timeoutSecs = typeof args.timeout_secs === 'number' ? Math.min(Math.max(args.timeout_secs, 1), 600) : undefined;
            const timeoutMs = timeoutSecs ? timeoutSecs * 1000 : undefined;
            const approved = await autoApproveShell({ command, cwd });
            if (!approved) {
              return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI chạy lệnh này.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const result = await bridge.shell.run({ command, cwd, timeoutMs });

            /* Auto-debug loop: khi lệnh fail + safe command → track attempts và
               chèn retry guidance vào result để model tự sửa và retry. Port từ
               Plandex `plandex debug` (MIT). */
            const exitCode = result.code;
            const failed = exitCode !== null && exitCode !== 0;
            if (failed && isSafeDebugCommand(command)) {
              const maxAttempts = AUTO_DEBUG_MAX_ATTEMPTS_DEFAULT;
              const { store: nextStore, result: debugResult } = recordDebugAttempt(
                debugLoopRef.current,
                command,
                exitCode,
                result.stderr?.slice(0, 500) ?? '',
                maxAttempts,
              );
              debugLoopRef.current = nextStore;

              if (debugResult.shouldStop) {
                // Dừng retry — clear session
                debugLoopRef.current = clearDebugSession(debugLoopRef.current, command);
              }

              const guidance = buildRetryGuidance(
                command,
                exitCode,
                debugResult.session.attempts,
                maxAttempts,
                debugResult.stopReason,
              );
              return JSON.stringify({ ...result, retryGuidance: guidance });
            }
            // Lệnh thành công → clear debug session nếu có + gợi ý lưu bài học
            if (!failed) {
              const session = debugLoopRef.current[normalizeDebugCommand(command)];
              debugLoopRef.current = clearDebugSession(debugLoopRef.current, command);
              // Nếu đã retry nhiều lần rồi mới thành công → gợi ý model lưu lesson
              if (session && session.attempts > 1) {
                const suggestion = suggestLessonFromDebug(command, session.attempts);
                if (suggestion) {
                  return JSON.stringify({ ...result, lessonSuggestion: suggestion });
                }
              }
            }
            return JSON.stringify(result);
          }
          case 'bg_run': {
            const command = String(args.command ?? '');
            const timeoutSecs =
              typeof args.timeout_secs === 'number' ? Math.min(Math.max(args.timeout_secs, 1), 3600) : undefined;
            // Cùng cổng duyệt với shell_run — lệnh nền không được bypass approval.
            const approved = await autoApproveShell({ command, cwd: undefined });
            if (!approved) {
              return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI chạy lệnh nền này.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const r = await bridge.shell.runBg({ command, timeoutSecs });
            return JSON.stringify(r);
          }
          case 'bg_status': {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const r = await bridge.shell.bgStatus(
              typeof args.job_id === 'string' && args.job_id ? args.job_id : undefined,
            );
            return JSON.stringify(r);
          }
          case 'bg_stop': {
            const jobId = String(args.job_id ?? '');
            if (!jobId) {
              return JSON.stringify({ error: 'Thiếu job_id — lấy từ kết quả của bg_run.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            return JSON.stringify(await bridge.shell.bgStop(jobId));
          }
          case 'git_status': {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const result = await bridge.git.status();
            return JSON.stringify(result);
          }
          case 'git_diff': {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const result = await bridge.git.diff({ relPath: args.path ? String(args.path) : undefined, staged: args.staged === true });
            return JSON.stringify({ diff: result });
          }
          case 'git_log': {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const limit = typeof args.limit === 'number' ? args.limit : 20;
            const result = await bridge.git.log({ limit });
            return JSON.stringify({ log: result });
          }
          case 'git_add': {
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
            const result = await bridge.git.add(paths);
            return JSON.stringify(result);
          }
          case 'git_commit': {
            const message = String(args.message ?? '');
            /* Lệnh THẬT chạy bridge.git.commit(message) bằng argv an toàn chứ
               không qua shell — hiển thị "git commit -m \"...cắt 80...\"" là ghép
               chuỗi shell GIẢ: message chứa dấu " đọc lệch, phần cắt 80 ký tự
               thì user duyệt khác những gì chạy. Chỉ giữ tiền tố "git commit"
               (auto-pilot đối chiếu pattern lệnh trên chuỗi này), phần sau là
               thông điệp NGUYÊN VĂN dạng dữ liệu. */
            const approved = await autoApproveShell({
              command: `git commit — thông điệp commit:\n${message}`,
              cwd: undefined,
            });
            if (!approved) {
              return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI commit này.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop()!;
            const result = await bridge.git.commit(message);
            return JSON.stringify(result);
          }

          /* ------------------------------------------------------------------ */
          /* Sub-task Plan                                                       */
          /* ------------------------------------------------------------------ */

          /* Không có case 'delegate': route KHÔNG khai báo tool này ở đường
             native (NATIVE_EXCLUDED_CLIENT_TOOLS) vì runSubagent chỉ chạy
             inline trong runEmulatedLoop. Đường emulated xử lý delegate phía
             server qua onDelegateCall, nên renderer không bao giờ nhận nó. */

          case 'plan_create': {
            const title = String(args.title ?? 'Untitled plan');
            const rawSubtasks = Array.isArray(args.subtasks) ? args.subtasks : [];
            let plan = emptyPlan(title);
            for (const st of rawSubtasks) {
              if (!st || typeof st.title !== 'string') continue;
              plan = addSubtask(plan, st.title, {
                description: typeof st.description === 'string' ? st.description : undefined,
                files: Array.isArray(st.files) ? st.files.filter((f: unknown): f is string => typeof f === 'string') : undefined,
              });
            }
            /* Plan là tài nguyên CỦA CHAT. currentChatId null (draft) mà ghi
               `plan:null` thì vừa tạo khoá mồ côi không chat nào đọc được, vừa
               bắt MỌI draft sau này dùng chung một khoá → plan phiên này đè
               lên phiên khác. Materialize draft thành chat thật theo đúng
               pattern submitTurn/handleGenerateMedia rồi mới ghi. */
            let chatId = useAppStore.getState().currentChatId;
            if (!chatId) {
              chatId = draftId;
              hydratedFor.current = chatId;
              await db.chats.put({
                id: chatId,
                title: 'New Chat',
                pinned: 0,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              setCurrentChatId(chatId);
            }
            await db.kv.put({ key: `plan:${chatId}`, value: JSON.stringify(plan) }).catch(() => {});
            setPlan(plan);
            setPlanHidden(false);
            showNotice(`Đã tạo plan "${title}" với ${plan.subtasks.length} subtask.`);
            return JSON.stringify({ ok: true, plan: formatPlanSummary(plan), subtaskCount: plan.subtasks.length });
          }

          case 'plan_update': {
            const subtaskId = String(args.subtaskId ?? '');
            const status = String(args.status ?? '') as SubtaskStatus;
            /* Load plan từ kv. Đọc chatId TƯƠI từ store: plan_create trong
               cùng stream có thể vừa materialize draft thành chat — biến
               `currentChatId` bắt trong closure lúc đó vẫn là null. */
            const chatId = useAppStore.getState().currentChatId;
            const row = chatId ? await db.kv.get(`plan:${chatId}`).catch(() => null) : null;
            const plan = row?.value ? parsePlan(typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
            if (!chatId || !plan) {
              return JSON.stringify({ ok: false, error: 'Không tìm thấy plan hiện tại. Gọi plan_create trước.' });
            }
            const updated = updateSubtaskStatus(plan, subtaskId, status);
            if (!updated) {
              return JSON.stringify({ ok: false, error: `Subtask "${subtaskId}" không tồn tại trong plan.` });
            }
            await db.kv.put({ key: `plan:${chatId}`, value: JSON.stringify(updated) }).catch(() => {});
            setPlan(updated);
            const prog = planProgress(updated);
            return JSON.stringify({
              ok: true,
              plan: formatPlanSummary(updated),
              progress: `${prog.done}/${prog.total} (${prog.percentComplete}%)`,
            });
          }

          /* ------------------------------------------------------------------ */
          /* Self-Improvement Lessons                                            */
          /* ------------------------------------------------------------------ */

          case 'lesson_save': {
            const category = String(args.category ?? '') as LessonCategory;
            const text = String(args.text ?? '');
            const validated = validateLessonText(text);
            if (!validated) {
              return JSON.stringify({ ok: false, error: 'Bài học quá ngắn hoặc rỗng (tối thiểu 5 ký tự).' });
            }
            if (!['rule', 'pattern', 'gotcha'].includes(category)) {
              return JSON.stringify({ ok: false, error: 'Category phải là rule, pattern, hoặc gotcha.' });
            }
            try {
              const cand = await proposeCandidate({
                text: validated,
                kind: category,
                scope: { kind: 'project', ref: currentChat?.id || 'default' },
                provenance: { threadId: currentChat?.id || 'main' },
              });
              showNotice(`Đã đề xuất bài học [${category}]: ${validated.slice(0, 50)}… (Chờ duyệt)`);
              return JSON.stringify({ ok: true, id: cand.id, category, text: validated, status: 'pending' });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi đề xuất bài học: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          /* ------------------------------------------------------------------ */
          /* Structured memory (Goose port P1-4) — CRUD thẳng Dexie + mirror.    */
          /* ------------------------------------------------------------------ */

          case 'remember_memory': {
            try {
              const res = await rememberAgentMemory({
                category: args.category,
                data: args.data,
                tags: args.tags,
                is_global: args.is_global,
              });
              if (!res.ok || !res.record) {
                return JSON.stringify({ ok: false, error: res.error });
              }
              return JSON.stringify({
                ok: true,
                id: res.record.id,
                category: res.record.category,
                scope: res.record.scope,
                mirrored: res.mirrored === true,
              });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi ghi memory: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          case 'retrieve_memories': {
            try {
              const workspaceKey = await resolveWorkspaceKey();
              const all = await listAgentMemories();
              const matches = retrieveMatchingMemories(
                all,
                {
                  query: typeof args.query === 'string' ? args.query : undefined,
                  category: typeof args.category === 'string' ? args.category : undefined,
                  tags: Array.isArray(args.tags) ? (args.tags.filter((t) => typeof t === 'string') as string[]) : undefined,
                  workspaceKey,
                },
                foldText,
              );
              return JSON.stringify({
                matches: matches.map((r) => ({
                  id: r.id,
                  category: r.category,
                  data: r.data,
                  tags: r.tags,
                  scope: r.scope,
                  createdAt: r.createdAt,
                })),
                total: memoriesForWorkspace(all, workspaceKey).length,
                note: matches.length ? undefined : 'Không có memory nào khớp — thử từ khoá/category khác.',
              });
            } catch (e) {
              return JSON.stringify({ error: `Lỗi tra memory: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          case 'remove_memory_category': {
            try {
              const removed = await removeMemoryCategory(String(args.category ?? ''));
              return JSON.stringify({ ok: true, removed });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi xoá category: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          case 'remove_specific_memory': {
            try {
              const removed = await removeSpecificMemory(String(args.id ?? ''));
              if (!removed) return JSON.stringify({ ok: false, error: `Không tìm thấy memory id "${String(args.id ?? '')}".` });
              return JSON.stringify({ ok: true, removed: { id: removed.id, category: removed.category } });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi xoá memory: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          case 'memory_propose': {
            const text = String(args.text ?? '').trim();
            if (text.length < 5) {
              return JSON.stringify({ ok: false, error: 'Ghi nhớ quá ngắn (tối thiểu 5 ký tự).' });
            }
            const kind = (args.kind as MemoryKind) || 'pattern';
            try {
              const cand = await proposeCandidate({
                text,
                kind,
                scope: { kind: 'project', ref: currentChat?.id || 'default' },
                provenance: { threadId: currentChat?.id || 'main' },
              });
              showNotice(`Đã đề xuất ghi nhớ [${kind}]: ${text.slice(0, 50)}… (Chờ duyệt)`);
              return JSON.stringify({ ok: true, id: cand.id, kind, text, status: 'pending' });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi đề xuất ghi nhớ: ${e instanceof Error ? e.message : String(e)}` });
            }
          }

          default:
            return JSON.stringify({ error: 'Tool không hỗ trợ phía client.' });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 300) : 'Lỗi hệ thống tệp.';
        return JSON.stringify({ error: msg });
      }
    },
    [
      approvalPolicy,
      /* showDiffModal/showShellModal KHÔNG có ở đây: thân callback chỉ còn gọi
         autoApproveShell/autoApproveDiff (chúng tự phụ thuộc hai hàm đó). Khai
         báo thừa làm callback đổi danh tính vô cớ. */
      autoApproveShell,
      autoApproveCode,
      autoApproveDiff,
      readCaptureForPath,
      /* Cổng deny ở đầu funnel đọc toolPermissions trực tiếp: người dùng chặn
         nhóm giữa phiên mà handler giữ closure cũ là tool vẫn chạy. */
      toolPermissions,
      /* Các giá trị này ĐỌC TRỰC TIẾP trong thân callback (guard plan-mode
         của fs_edit/fs_write, nhánh staging, materialize draft chat). Thiếu
         chúng thì callback giữ nguyên giá trị CŨ mãi mãi: người dùng bật PLAN
         mode giữa phiên mà lớp chặn phía client vẫn dùng 'act' — server có lọc
         tool rồi,
         nhưng đây là lớp bảo vệ thứ hai nên không được phép đóng băng. */
      agentMode,
      stagingEnabled,
      updateStaging,
      /* plan_create/plan_update đọc chat MỚI NHẤT qua useAppStore.getState()
         thay vì closure (plan_create có thể materialize draft chat giữa
         stream), nên ở đây chỉ cần draftId + setCurrentChatId cho nhánh đó. */
      draftId,
      setCurrentChatId,
      /* Luồng mô tả ảnh (fs_read ảnh workspace + ảnh MCP) đọc hai giá trị này
         trực tiếp. Thiếu chúng: người dùng chọn model vision hoặc đổi Nhà cung
         cấp giữa phiên mà tool handler vẫn gửi model/headers cũ → /api/vision
         trả 400/401 dù Cài đặt đã đúng. */
      visionModel,
      buildApiHeaders,
    ],
  );

  /* ------------------------------------------------------------------ */
  /* Vòng đời run — desired/observed reconciler                          */
  /* ------------------------------------------------------------------ */
  /**
   * `isLoading` của useChat là MỘT boolean: không phân biệt được "đang chạy
   * khoẻ", "stream đứt" và "đã dừng có chủ đích", và không bao giờ tự kết
   * luận. Reconciler này đặt trần thời gian lên từng giai đoạn và tự chốt
   * trạng thái terminal khi run thực sự chết.
   *
   * `stop`/`reload`/`messages` do useChat cấp ở phía DƯỚI, nên đi qua ref —
   * callback của hook không được phụ thuộc vào chúng (nếu không mỗi lần
   * messages đổi là lịch reconcile bị giật lại).
   */
  const chatStopRef = useRef<() => void>(() => {});
  const chatReloadRef = useRef<() => void>(() => {});
  const messagesForRepairRef = useRef<Message[]>([]);

  /**
   * Object do hook trả về là MỚI mỗi render, nhưng từng hàm bên trong được
   * useCallback nên ổn định. Tách ra để đưa vào dep array mà không làm
   * submitTurn bị tạo lại mỗi lần re-render.
   */
  const {
    snapshot: runSnapshot,
    begin: beginRun,
    touch: touchRun,
    stop: stopRun,
    succeed: succeedRun,
    fail: failRun,
    setRepairable,
    awaitUser: awaitUserRun,
    resume: resumeRun,
    hydrate: hydrateRun,
    current: currentRun,
  } = useRunLifecycle({
    onRepair: (attempt) => {
      /**
       * Tiếp tục một run đang kẹt bằng cách gửi lại. CHỈ làm khi bong bóng
       * assistant chưa có nội dung — reload() vứt toàn bộ phần đã stream, nên
       * nếu người dùng đang nhìn thấy văn bản thì "sửa" là huỷ kết quả, tệ hơn
       * là để họ tự bấm Tiếp tục.
       */
      const last = messagesForRepairRef.current[messagesForRepairRef.current.length - 1];
      const hasPartial =
        last?.role === 'assistant' && String(last.content ?? '').trim().length > 0;
      if (hasPartial) {
        stopRun();
        return;
      }
      showNotice(`Không nhận được phản hồi — thử lại lần ${attempt}…`, 4000);
      void chatReloadRef.current();
    },
    onTerminate: (reason) => {
      chatStopRef.current();
      if (reason === 'user_stop') return;
      const text =
        reason === 'deadline'
          ? 'Run vượt quá thời gian cho phép và đã bị dừng.'
          : 'Không nhận được phản hồi từ nhà cung cấp — run đã bị gián đoạn. Bấm "Tạo lại" để thử lại.';
      showNotice(text, 6000);
    },
  });

  /* Recipe checks (port Goose): onFinish ủy quyền sang callback được gán sau
     (runRecipeChecks định nghĩa ở dưới submitTurn) qua ref để giữ thứ tự hook
     ổn định. Trả true nghĩa là run recipe đã xử lý lượt này — queue drains
     phía dưới bỏ qua. */
  const runRecipeChecksRef = useRef<
    ((finalText: string) => Promise<boolean>) | null
  >(null);

  /* Disk skills + hints (P0-3): entries quét theo workspace nằm ở
     useDiskSkillsStore (đọc qua getState trong callback — không stale
     closure); hintsChip/showHints là state UI cho chip "hints loaded". */
  const [hintsChip, setHintsChip] = useState<{ file: string; content: string } | null>(null);
  const [showHints, setShowHints] = useState(false);
  useEffect(() => {
    if (!workspace?.connected || !workspace.name) {
      useDiskSkillsStore.getState().setEntries([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const scan = await scanDiskSkills(buildDiskSkillAdapters());
        if (!cancelled) useDiskSkillsStore.getState().setEntries(scan.entries);
      } catch {
        /* quét lỗi — giữ danh sách cũ */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspace?.connected, workspace?.name]);

  const {
    messages, setMessages,
    stop, reload, append, isLoading, error, data,
  } = useChat({
    id: chatKey,
    /**
     * Key của "Máy chủ mặc định" (settings.apiKey) CHỈ đi tới baseUrl của
     * server env. Khi có provider preset active, chỉ gửi key của chính provider
     * đó — không fallback sang settings.apiKey, vì như vậy là gửi credential
     * của gateway A tới gateway B do người dùng tự khai.
     */
    headers: buildApiHeaders(),
    body: {
      model,
      temperature,
      thinkingLevel,
      system: systemPrompt,
      /* Vision-bridge: model chat không xem được ảnh thì server mô tả ảnh đính
         kèm bằng model này (cùng provider active) rồi thay vào tin nhắn. Không
         gửi khi rỗng — server hiểu là tính năng tắt và dùng placeholder text. */
      ...(visionModel ? { visionModel } : {}),
      /* Cho phép tắt hẳn tool-calling. Khi approvalPolicy === 'chat_only', tắt hẳn tool. */
      agentTools: approvalPolicy === 'chat_only' ? false : agentToolsEnabled,
      /* Plan/Act mode: server lọc write tools + chèn chỉ thị vào system prompt. */
      ...(agentMode !== 'act' ? { agentMode } : {}),
      /* Staging sandbox: server chèn ghi chú vào system prompt. */
      ...(stagingEnabled ? { staging: true } : {}),
      /* Trạng thái workspace: server chèn khối [Workspace] vào system prompt
         để model biết fs_* có thư mục làm việc — không gửi thì model tưởng
         không truy cập được máy user và không bao giờ gọi fs_list (lỗi thật
         "agent coding không nhận diện được workspace"). */
      workspace: {
        connected: Boolean(workspace?.connected),
        name: workspace?.name ?? null,
      },
      /* Compaction: chỉ gửi khi marker còn hợp lệ trên nhánh hiện tại. */
      ...(requestCompaction
        ? {
            contextSummary: requestCompaction.summary,
            compactBoundaryId: requestCompaction.upToId,
          }
        : {}),
      /* Tool MCP hiện có (chỉ trong Electron desktop): route khai báo cho
         model, renderer thực thi rồi resubmit kết quả. Không gửi khi rỗng để
         không phình payload của mọi request web. */
      ...(mcpFullTools.length > 0 ? { mcpTools: mcpFullTools } : {}),
      /* Tool của server proxy: chỉ là metadata cho mcp__search — KHÔNG được
         khai báo schema lên model, đây là mục đích của cả chế độ. */
      ...(mcpProxyTools.length > 0 ? { mcpProxyTools } : {}),
      /* Tool Router (P1-7): các tool đã nạp động qua tools_load */
      ...(loadedToolNamesRef.current.size > 0
        ? { loadedTools: Array.from(loadedToolNamesRef.current) }
        : {}),
      /* Code Mode (P1-7): bật tool run_code */
      ...(codeModeEnabled ? { codeModeEnabled: true } : {}),
    },
    experimental_throttle: throttleMs,
    /* Client-executed tools (fs_*): onToolCall chạy trên máy user, trả kết quả
       tại chỗ; sau stream, maxSteps phía useChat tự resubmit để model đọc
       kết quả — vòng lặp agent coding chạy xuyên nhiều request. */
    maxSteps: CLIENT_MAX_STEPS,
    onToolCall: handleClientToolCall,
    onFinish: (message, { finishReason, usage }) => {
      /**
       * Mỗi lần kết thúc một bước là một tiến triển — đẩy heartbeat để stall
       * detector không kết luận oan trong lúc client đang thực thi tool rồi
       * resubmit (khoảng lặng giữa hai request có thể dài).
       */
      touchRun();

      // Cập nhật Agent HUD telemetry từ annotations và usage lượt này
      if (usage) {
        const annotations = (message as any).annotations as Array<Record<string, unknown>> | undefined;
        const receiptAnn = annotations?.find((a) => a && typeof a === 'object' && 'routeReceipt' in a) as
          | { routeReceipt?: { category?: any; selected?: { model?: string; effort?: any } } }
          | undefined;
        if (receiptAnn?.routeReceipt) {
          const rr = receiptAnn.routeReceipt;
          useHudStore.getState().upsertLane({
            laneId: 'main',
            kind: 'main',
            category: rr.category ?? 'capable',
            model: rr.selected?.model ?? 'gpt-5-6-sol',
            effort: rr.selected?.effort ?? 'medium',
            tokensIn: usage.promptTokens ?? 0,
            tokensOut: usage.completionTokens ?? 0,
            evidence: 'reported_done',
          });
        }
      }

      // Đóng checkpoint turn — các snapshot của response này đã được lưu
      // (fire-and-forget); lượt agent kế tiếp mở capture mới.
      closeTurnCapture();
      // Guard markup tool-call model tự nhả vào kênh text — strip TRƯỚC khi
      // sanitize/lưu để nội dung trong DB cũng sạch (tokens + search index).
      const clean = sanitizeContent(stripGoalCompleteTag(stripEmulatedToolMarkup(message.content).text));

      /**
       * Gateway nhận request có `tools` nhưng BỎ QUA IM LẶNG: model không bao
       * giờ nhận schema tool, chỉ thấy tên tool qua khối [Tools]/[Workspace] —
       * các model từng được train tool-calling (GLM, Qwen...) sẽ nhả khối
       * <tool_call> dạng TEXT thường. Đường native không parse khối này,
       * client strip markup → bubble rỗng/không tool nào chạy, người dùng
       * thấy "agent không đọc/sửa được file".
       *
       * Phát hiện: raw content chứa khối tool-call + KHÔNG có toolInvocation
       * nào được populates + finish không phải 'tool-calls' → tự thử lại MỘT
       * lần bằng đường giả lập (forceEmulatedTools); server nhận cờ này rồi
       * ghim cache tool-unsupported cho các lượt sau của cùng upstream.
       */
      const invocations = ((message as { toolInvocations?: unknown[] }).toolInvocations ?? []) as unknown[];
      const textToolCalls =
        /<\s*(?:tool_call|tool-call|toolcall|function_call|function-call|tool_use|tooluse|invoke)\b/i.test(
          message.content,
        );
      if (
        textToolCalls &&
        invocations.length === 0 &&
        finishReason !== 'tool-calls' &&
        emulatedRetryCountRef.current < 1
      ) {
        emulatedRetryCountRef.current += 1;
        showNotice('Model gọi tool dạng văn bản (gateway không hỗ trợ function calling) — thử lại bằng đường giả lập…', 6000);
        void reload({ body: { forceEmulatedTools: true } });
        return;
      }

      /**
       * Gateway đôi khi trả stream rỗng (502 ngầm, quá tải, model reasoning
       * bị nuốt token). Kết thúc im lặng để lại bong bóng trống vô nghĩa —
       * đánh dấu error, ghi câu gợi ý vào bong bóng và báo toast.
       */
      if (!clean.trim() && finishReason !== 'tool-calls') {
        finishRef.current = 'error';
        failRun();
        showNotice('Nhà cung cấp trả về phản hồi rỗng. Bấm "Tạo lại" hoặc đổi model khác thử lại.', 6000);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  content:
                    '_Phản hồi trống từ nhà cung cấp (lỗi gateway tạm thời). Bấm "Tạo lại" để thử lại, hoặc đổi model khác._',
                  annotations: [
                    ...((message.annotations ?? []) as Array<Record<string, unknown>>),
                    { error: 'EMPTY_RESPONSE' },
                  ] as typeof m.annotations,
                }
              : m,
          ),
        );
        return;
      }

      const promptTokens = Number(usage?.promptTokens ?? 0) || 0;
      // Gateway không báo usage ra → ước lượng từ độ dài câu trả lời.
      const completionTokens =
        Number(usage?.completionTokens ?? 0) || Math.ceil(clean.length / 4);

      /* Lưu usage thật cho auto-compact trigger — chỉ ghi khi có số liệu thật
         từ upstream (promptTokens > 0). Ước lượng fallback KHÔNG được dùng ở
         đây vì nó sẽ khiến evaluateUsageTrigger đọc sai silent overflow. */
      if (promptTokens > 0) {
        lastUsageRef.current = { promptTokens, completionTokens, finishReason };
      }
      if (promptTokens > 0 || completionTokens > 0) {
        // Ghi usage vào annotation để thống kê token có dữ liệu trong DB.
        const anns = (message.annotations ?? []) as Array<Record<string, unknown>>;
        const lastModel = [...anns].reverse().find((a) => typeof a?.model === 'string')?.model;
        /* durationMs + est cho dòng thống kê dưới câu trả lời (mượn ý
           @rokiy/pi-ui): est = true khi completion là ước lượng chars/4 chứ
           không phải số gateway báo, để UI khỏi hiện chi phí bịa. onFinish
           chỉ chạy sau khi stream kết thúc, không phải trong render —
           Date.now() tại đây là điểm đo endedAt chính đáng. */
        const durationMs =
          turnStartedAtRef.current !== null
            ? // eslint-disable-next-line react-hooks/purity
              Date.now() - turnStartedAtRef.current
            : undefined;
        const estimated = !Number(usage?.completionTokens ?? 0);
        const usageAnn = [
          ...anns,
          {
            usage: { promptTokens, completionTokens },
            model: lastModel ?? model,
            /* Badge lead/worker của lượt này (P1-5) — client là nơi quyết định
               routing nên không chờ server phát annotation. */
            ...(routingRoleRef.current ? { routingRole: routingRoleRef.current } : {}),
            ...(durationMs ? { durationMs } : {}),
            ...(estimated ? { est: true } : {}),
          },
        ];
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  ...(clean !== message.content ? { content: clean } : {}),
                  annotations: usageAnn as typeof m.annotations,
                }
              : m,
          ),
        );
      } else if (clean !== message.content) {
        setMessages((prev) =>
          prev.map((m) => (m.id === message.id ? { ...m, content: clean } : m)),
        );
      }
      if (finishReason === 'length') {
        console.warn('[chat] câu trả lời bị cắt do giới hạn token');
      }

      /**
       * Kết thúc thật sự: chỉ khi bước cuối KHÔNG phải 'tool-calls'. Trường hợp
       * còn lại là useChat đang resubmit để model đọc kết quả tool — run vẫn
       * sống, tuyệt đối không chốt succeeded ở đây.
       */
      if (finishReason !== 'tool-calls' && finishRef.current !== 'error') {
        succeedRun();

        /* Recipe active (port Goose): agent vừa xong một attempt → chạy shell
           checks, quyết pass/retry/stop. Chiếu quyền flow (queue drains bỏ
           qua) để vòng retry không đua với steering queued. */
        {
          const rr = useRecipeUiStore.getState().activeRun;
          if (rr && (rr.status === 'running' || rr.status === 'retrying') && runRecipeChecksRef.current) {
            void runRecipeChecksRef.current(clean);
            return;
          }
        }

        /* P3.1 — Drain queue đúng thứ tự Pi: steering trước, rồi goal-continue,
           rồi follow-up. Mỗi drain chỉ append MỘT lượt (one-at-a-time mặc
           định); useChat resubmit xong onFinish kế tiếp drain tiếp. Steering
           đi thẳng (không qua goal-stop như tin thủ công). */
        const steerDrained = drainQueue(steeringRef.current, steeringModeRef.current);
        if (steerDrained.taken.length > 0) {
          steeringRef.current = steerDrained.rest;
          setSteeringCount(steerDrained.rest.length);
          const steerText = steerDrained.taken.join('\n\n');
          void append({ role: 'user', content: steerText }, { body: routingBodyFor(messages, steerText) });
          return;
        }

        /* Goal Loop gate — lượt assistant vừa THẬT SỰ kết thúc (không phải
           resubmit tool-calls, không phải error). Verdict đọc/ghi trực tiếp
           lib store (conversation-scoped) qua evaluateGoalTurn; decision
           'continue' → append steering để useChat resubmit tự động, còn lại
           → dừng vòng lặp + báo UI. Marker <goal-complete> đã bị strip khỏi
           `clean` nên không dính DB/UI. */
        if (getGoalLoop(useAppStore.getState().currentChatId)?.status === 'active') {
          const verdict = evaluateGoalTurn(useAppStore.getState().currentChatId, message.content);
          setGoalLoop(verdict.state);
          if (verdict.decision === 'continue' && verdict.steering) {
            void append(
              { role: 'user', content: verdict.steering },
              { body: routingBodyFor(messages, verdict.steering) },
            );
            return;
          } else if (verdict.state) {
            showNotice(describeGoalStop(verdict.state), 6000);
          }
        }

        const followDrained = drainQueue(followUpRef.current, followUpModeRef.current);
        if (followDrained.taken.length > 0) {
          followUpRef.current = followDrained.rest;
          setFollowUpCount(followDrained.rest.length);
          const followText = followDrained.taken.join('\n\n');
          void append({ role: 'user', content: followText }, { body: routingBodyFor(messages, followText) });
        }
      }
    },
    onError: (err) => {
      console.error('[useChat]', err);
      failRun();

      // UX: Parse error code de hien thi toast phu hop thay vi im lang.
      const errMsg = err instanceof Error ? err.message : String(err);
      const codeMatch = /\[([A-Z_]+)#/.exec(errMsg);
      const code = codeMatch?.[1] ?? '';
      if (code === 'UPSTREAM_PAYMENT_402') {
        showNotice('Tai khoan upstream het credit. Vui long nap them hoac doi provider.', 8000);
      } else if (code === 'UPSTREAM_AUTH_401') {
        showNotice('API Key khong hop le hoac da bi thu hoi. Kiem tra lai trong Cai dat.', 8000);
      } else if (code === 'UPSTREAM_CONTEXT_OVERFLOW') {
        showNotice('Hoi thoai qua dai. Hay nen bot hoac bat dau cuoc tro chuyen moi.', 6000);
      } else if (code === 'RATE_LIMITED') {
        showNotice('Dang gui tin nhan qua nhanh. Vui long doi vai giay.', 4000);
      } else if (code === 'INJECTION_BLOCKED') {
        showNotice('Tin nhan bi tu choi vi co dau hieu vuot qua huong dan he thong.', 5000);
      } else if (code && !code.startsWith('UPSTREAM_SERVER_')) {
        const cleanMsg = errMsg.replace(/\s*\[[\w#]+\]$/, '').slice(0, 200);
        showNotice(cleanMsg, 6000);
      }
    },
  });

  /* ------------------------------------------------------------------ */
  /* Subagent client-tool relay                                          */
  /* ------------------------------------------------------------------ */
  /* Annotation {subagentCall} do route phát khi SUBAGENT (chạy server-side)
     gọi tool client (fs_*, shell, git, MCP). Renderer thực thi bằng ĐÚNG
     executor của tool thường (handleClientToolCall) rồi POST kết quả về
     /api/chat/subagent-relay — route resolve promise cho loop subagent đang
     chờ, subagent nhận kết quả và chạy tiếp.
     CHỈ xử lý khi stream đang active: annotation cũ persist theo message,
     nếu xử lý cả khi idle thì mở lại hội thoại sẽ re-execute fs tool. */
  const subagentRelayDoneRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isLoading) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const anns = (last.annotations ?? []) as Array<Record<string, unknown>>;
    for (const ann of anns) {
      const call = ann?.subagentCall as
        | { toolCallId?: unknown; toolName?: unknown; args?: unknown }
        | undefined;
      const reqId = typeof ann?.requestId === 'string' ? ann.requestId : null;
      if (
        !call ||
        typeof call.toolCallId !== 'string' ||
        typeof call.toolName !== 'string' ||
        !reqId
      ) {
        continue;
      }
      const dedupeKey = `${reqId}:${call.toolCallId}`;
      if (subagentRelayDoneRef.current.has(dedupeKey)) continue;
      subagentRelayDoneRef.current.add(dedupeKey);
      /* Hoist giá trị đã narrow ra khỏi closure async — TS không giữ property
         narrowing (typeof call.toolName) khi đi vào callback. */
      const relayToolCallId = call.toolCallId;
      const relayToolName = call.toolName;
      const relayArgs = call.args;
      void (async () => {
        let resultText: string;
        try {
          const executed = await handleClientToolCall({
            toolCall: { toolName: relayToolName, args: relayArgs },
          });
          resultText =
            typeof executed === 'string'
              ? executed
              : JSON.stringify(executed ?? {
                  error: `Tool "${relayToolName}" không trả kết quả.`,
                });
        } catch (err) {
          resultText = JSON.stringify({
            error: String(err instanceof Error ? err.message : err),
          });
        }
        try {
          await fetch('/api/chat/subagent-relay', {
            method: 'POST',
            headers: { ...buildApiHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requestId: reqId,
              toolCallId: relayToolCallId,
              result: resultText,
            }),
          });
        } catch {
          /* Stream có thể đã đóng (subagent timeout) — relay bên server tự dọn. */
        }
      })();
    }
  }, [messages, isLoading, handleClientToolCall, buildApiHeaders]);

  /* Nối các ref mà reconciler dùng — dùng ref để callback ở trên không bị
     phụ thuộc vào identity của hàm/mảng do useChat cấp. */
  useEffect(() => {
    chatStopRef.current = stop;
    chatReloadRef.current = () => void reload();
    messagesForRepairRef.current = messages;
  }, [stop, reload, messages]);

  useEffect(() => {
    awaitUserRef.current = awaitUserRun;
    resumeRef.current = resumeRun;
  }, [awaitUserRun, resumeRun]);

  /**
   * KHÔI PHỤC RUN MỒ CÔI SAU RELOAD.
   *
   * Vấn đề: reconciler chỉ sống trong bộ nhớ tab. Reload = mất hết timer, trong
   * khi upstream có thể vẫn đang stream. Không làm gì thì UI treo spinner ma
   * (useChat `isLoading` tắt nhưng không ai giải thích vì sao không có câu
   * trả lời).
   *
   * Cách xử lý — và lý do KHÔNG rescue: sau reload, mọi continuation đang kẹt
   * đều đã mất cùng tab, nên `canRepair` bị ép về false. Run còn tươi
   * (≤ ORPHAN_GRACE_MS) được giao lại cho vòng reconcile bình thường; run đã
   * im lặng quá ngưỡng thì `reconcileOnBoot` chốt luôn là gián đoạn thay vì
   * bắt người dùng chờ một thứ không bao giờ tới.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await (async () => {
        try {
          const row = await db.kv.get(RUN_LIFECYCLE_KV_KEY);
          return parseRunState(row?.value);
        } catch {
          return null; // kv hỏng/private mode — coi như không có gì để khôi phục
        }
      })();
      if (cancelled || !saved) return;

      /* Run đã kết thúc từ trước → không có gì để khôi phục. Xoá để lần boot
         sau không đọc nhầm (kv có thể còn sót từ bản cũ chưa biết xoá). */
      if (isTerminal(saved.observed)) {
        void db.kv.delete(RUN_LIFECYCLE_KV_KEY).catch(() => {});
        return;
      }

      const { action, next } = reconcileOnBoot(saved);
      /* Ép canRepair=false: repair sau reload là vô nghĩa (không còn
         continuation để gửi lại), và nếu để true, vòng reconcile sẽ gọi
         reload() trên một cuộc hội thoại chưa kịp nạp xong. */
      hydrateRun({ ...next, canRepair: false });

      if (action.kind === 'terminate') {
        showNotice('Phiên trả lời trước bị gián đoạn do trang được tải lại.', 6000);
        chatStopRef.current();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrateRun]);

  /**
   * Ghi trạng thái run xuống kv để lần boot sau có cái mà khôi phục.
   * Chỉ chạy khi `runSnapshot` đổi — tức là khi phần "đáng để vẽ lại" của
   * state đổi, không phải mỗi token (heartbeat đi qua ref, không re-render).
   */
  useEffect(() => {
    if (runSnapshot.observed === 'idle') return;
    const state = currentRun();
    /* Run đã xong → dọn kv, kẻo lần boot sau đọc phải trạng thái cũ và hiện
       nhãn "Hoàn tất"/"Bị gián đoạn" oan. */
    if (isTerminal(state.observed)) {
      void db.kv.delete(RUN_LIFECYCLE_KV_KEY).catch(() => {});
      return;
    }
    void db.kv.put({ key: RUN_LIFECYCLE_KV_KEY, value: serializeRunState(state) }).catch(() => {});
  }, [runSnapshot, currentRun]);

  /**
   * Heartbeat của run suy ra từ NỘI DUNG stream.
   *
   * useChat KHÔNG có callback per-chunk, nên cách đáng tin duy nhất để biết
   * "run vẫn đang sống" là xem chiều dài nội dung assistant có tăng không.
   * Thiếu cái này thì một câu trả lời stream trong 60s sẽ bị STARTUP_GRACE_MS
   * (25s) kết luận là đứt — giết oan run đang chạy bình thường.
   *
   * Rẻ: chỉ đọc chiều dài chuỗi rồi ghi ref, KHÔNG gây re-render.
   */
  const streamProgressRef = useRef('');
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) return;
    const content = String(last.content ?? '').length;
    const reasoning = String((last as { reasoning?: string }).reasoning ?? '').length;
    const sig = `${last.id}:${content}:${reasoning}`;
    if (sig === streamProgressRef.current) return;
    streamProgressRef.current = sig;
    touchRun();
  }, [messages, touchRun]);

  /* Reset bộ đếm auto-retry emulated khi user gửi tin nhắn MỚI — reload()
     của lượt thử giữ nguyên user message nên không đụng effect này, tránh
     vòng lặp retry vô hạn trong khi mỗi lượt user vẫn được cấp lại lượt thử. */
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user') emulatedRetryCountRef.current = 0;
  }, [messages]);

  /* ------------------------------------------------------------------ */
  /* Compaction hội thoại dài                                            */
  /* ------------------------------------------------------------------ */

  /* memory_save: server CHẤP NHẬN đề xuất qua annotation {memoryProposal}
     — nơi ghi thật là client (IndexedDB của user). Ref chặn xử lý trùng:
     annotation persist theo message nên mở lại hội thoại cũ sẽ thấy lại
     proposals, nhưng addMemory tự dedupe nguyên văn nên không sinh bản
     sao; ref chỉ để tránh gọi lặp trong cùng phiên render. */
  const processedMemoryProposalsRef = useRef(new Set<string>());
  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant?.annotations) return;
    for (const ann of lastAssistant.annotations as Array<Record<string, unknown>>) {
      const proposal = ann?.memoryProposal as { text?: unknown } | undefined;
      const text = typeof proposal?.text === 'string' ? proposal.text.trim() : '';
      if (!text) continue;
      const dedupeKey = `${lastAssistant.id}:${text}`;
      if (processedMemoryProposalsRef.current.has(dedupeKey)) continue;
      processedMemoryProposalsRef.current.add(dedupeKey);
      void proposeCandidate({
        text,
        kind: 'pattern',
        scope: { kind: 'project', ref: currentChat?.id || 'default' },
        provenance: { threadId: currentChat?.id || 'main', messageId: lastAssistant.id },
      }).then((cand) => {
        if (cand) {
          showNotice(`Đề xuất ghi nhớ: ${text.slice(0, 50)}${text.length > 50 ? '…' : ''} (Chờ duyệt)`, 4000);
        }
      });
    }
  }, [messages]);

  const compaction = currentChat?.compaction;
  // Marker chỉ hợp lệ khi ranh giới vẫn nằm trên projection nhánh đang mở
  // (đổi nhánh sang nơi chưa từng nén → marker cũ tự vô hiệu).
  const activeCompaction = useMemo(
    () => findActiveCompaction(compaction, messages),
    /* Compiler từ chối preserve memo này vì `messages` được truyền vào các
       routing callback (P1-5) — false positive: callback chỉ ĐỌC, không đổi.
       Memo thủ công vẫn đúng và CẦN THIẾT: bỏ memo thì object mới mỗi render
       khiến effect setRequestCompaction bên dưới chạy vô hạn. */
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    [compaction, messages],
  );

  useEffect(() => {
    setRequestCompaction(activeCompaction);
  }, [activeCompaction]);

  const compactBusyRef = useRef(false);

  /**
   * Usage thật từ lần stream CUỐI — để auto-compact trigger dùng số đo chính
   * xác thay vì ước lượng chars/4. Reset mỗi khi stream mới bắt đầu (isLoading
   * chuyển true) để không đọc usage cũ của lượt trước.
   */
  const lastUsageRef = useRef<{ promptTokens: number; completionTokens: number; finishReason?: string } | null>(null);

  /**
   * Mốc bắt đầu lượt trả lời hiện tại (submitTurn / regenerate) — onFinish
   * dùng để tính durationMs ghi vào usage annotation. KHÔNG reset giữa các
   * bước tool-calls của cùng lượt: thời lượng hiển thị là wall-clock của cả
   * lượt, không phải từng bước con.
   */
  const turnStartedAtRef = useRef<number | null>(null);

  /**
   * Nén phần cũ: gọi /api/compact rồi lưu marker vào ChatSession.
   *
   * Khi gateway không tạo được tóm tắt, KHÔNG còn hard-trim trắng: dựng bản
   * tóm tắt TẤT ĐỊNH từ chính phần bị nén (yêu cầu đã nêu, file đã đọc/sửa,
   * kết luận cuối — xem buildEmergencySummary). Nhờ vậy đường `overflow` vẫn
   * cứu được lượt chat mà model không mất dấu công việc đã làm.
   * Nén lần thứ hai sẽ ghép tóm tắt cũ vào đầu payload để không đứt mạch
   * ngữ cảnh giữa hai marker.
   */
  const performCompaction = useCallback(
    async (reason: 'auto' | 'manual' | 'overflow'): Promise<boolean> => {
      const chatId = currentChatId;
      if (!chatId || isLoading || compactBusyRef.current) return false;
      if (reason === 'auto' && !autoCompactEnabled) return false;
      if (activeCompaction && Date.now() - activeCompaction.createdAt < 60_000) return false;

      /* Ranh giới cắt phải tính theo NGÂN SÁCH TOKEN của model đang dùng, chứ
         không chỉ theo số lượng tin: 8 tin cuối của một lượt agent coding có
         thể là 8 tool result đầy trần 24k ký tự. */
      const split = splitForCompaction(
        messages,
        resolveContextWindow(model, activeProvider?.models),
      );
      if (!split) return false;
      const upToId = split.older[split.older.length - 1]?.id ?? '';
      if (!upToId) return false;

      const payload = serializeForCompaction(split.older);
      const previousSummary =
        activeCompaction &&
        split.older.some((m) => m.id === activeCompaction.upToId) &&
        activeCompaction.summary
          ? activeCompaction.summary
          : undefined;
      if (previousSummary) {
        payload.unshift({
          role: 'system',
          content: `[Tóm tắt các lượt nén trước đó]\n${previousSummary}`,
        });
      }

      /* Trích dữ liệu CÓ CẤU TRÚC từ phần bị nén để gửi kèm cho LLM và lưu
         tích lũy. Transcript prose một mình không đủ: tool trace rút gọn thành
         "[đã gọi fs_edit src/a.ts]" dễ bị LLM bỏ qua hoặc diễn giải sai. */
      const currentFileOps = extractFileOps(split.older);
      const currentRequests = extractUserRequests(split.older);
      const splitTurnPrefixText =
        split.splitTurnStart !== undefined
          ? extractUserRequests(messages.slice(split.splitTurnStart, split.firstKept)).slice(-1)[0]
          : undefined;
      const compactContext = formatCompactContextBlock(
        currentFileOps,
        currentRequests,
        splitTurnPrefixText,
        activeCompaction?.state,
      );

      compactBusyRef.current = true;
      setCompactBusy(true);
      try {
        let summary = '';
        try {
          const res = await fetch('/api/compact', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...buildApiHeaders(),
            },
            body: JSON.stringify({
              messages: payload,
              /* Provider active là nguồn duy nhất: model đang chat được thử
                 ĐẦU TIÊN cho bản tóm tắt, chuỗi env chỉ là dự phòng. Thiếu
                 field này thì nén luôn chạy bằng model env — trên provider
                 BYOK thường là 404 rồi rơi về tóm tắt tất định. */
              model,
              ...(compactContext ? { context: compactContext } : {}),
            }),
          });
          const j = (await res.json().catch(() => null)) as { summary?: unknown } | null;
          if (typeof j?.summary === 'string' && j.summary.trim()) {
            summary = j.summary.trim().slice(0, 16_000);
          }
        } catch {
          /* mạng/gateway lỗi → summary rỗng, fallback tất định ở dưới. */
        }

        /* LLM thất bại → tóm tắt tất định. Nó không cần mạng và không bao giờ
           lỗi, nên chỉ rỗng khi phần bị nén thực sự không có gì đáng giữ. */
        let deterministic = false;
        if (!summary) {
          summary = buildEmergencySummary({
            messages: split.older,
            previousSummary,
            ...(split.splitTurnStart !== undefined
              ? { splitTurnPrefix: messages.slice(split.splitTurnStart, split.firstKept) }
              : {}),
          });
          deterministic = Boolean(summary);
        }

        /* Auto/manual vẫn hẹn lần sau khi KHÔNG có tóm tắt nào (kể cả tất
           định) — không lược ngữ cảnh âm thầm. Đường overflow buộc phải cắt
           vì lượt chat đang bị gateway từ chối. */
        if (!summary && reason !== 'overflow') return false;

        /* Merge state tích lũy: dữ kiện file/request của lần nén này được hợp
           nhất với state từ lần trước. State sống trong ChatSession.compaction
           (field không index) nên mở rộng không cần bump Dexie schema. */
        const newState = mergeCompactionState(
          activeCompaction?.state,
          currentFileOps,
          currentRequests,
        );

        await db.chats.update(chatId, {
          compaction: {
            upToId,
            summary,
            compactedCount: split.older.length,
            createdAt: Date.now(),
            state: newState,
          },
          updatedAt: Date.now(),
        });
        showNotice(
          summary
            ? deterministic
              ? `Đã nén ${split.older.length} tin nhắn cũ (tóm tắt tự động — gateway không tạo được bản tóm tắt bằng AI).`
              : `Đã nén ${split.older.length} tin nhắn cũ thành tóm tắt — chat tiếp nhẹ hơn.`
            : `Đã lược bỏ ${split.older.length} tin nhắn cũ (không tạo được tóm tắt).`,
        );
        return true;
      } finally {
        compactBusyRef.current = false;
        setCompactBusy(false);
      }
    },
    [
      currentChatId, isLoading, activeCompaction, autoCompactEnabled, messages,
      /* Cửa sổ ngữ cảnh phụ thuộc vào danh sách model của provider đang active
         (resolveContextWindow). Thiếu thì đổi provider mà compaction vẫn tính
         theo cửa sổ của provider trước. */
      buildApiHeaders, model, activeProvider?.models,
    ],
  );

  /**
   * Auto-nén sau stream: ước lượng trên phần SAU marker (+ bản thân summary)
   * thay vì toàn bộ projection — nếu không, sau khi nén xong ước lượng vẫn
   * đếm cả tin cũ và kích hoạt nén lại vô hạn.
   *
   * contextUsage được tách thành useMemo dùng chung với ContextMeter (render).
   *
   * HIỆU NĂNG: `messages` đổi theo TỪNG token khi stream, mà estimate quét
   * toàn bộ nội dung + tool result (đo được ~0,73 ms với hội thoại 300 tin).
   * Khoá lại `messagesForUsage` trong lúc đang stream: thanh đo giữ nguyên giá
   * trị cuối rồi cập nhật một lần khi stream xong — người dùng không đọc kịp
   * con số nhảy từng token, còn nhánh auto-compact vốn đã bỏ qua khi
   * `isLoading` nên không hề bị ảnh hưởng.
   */
  const frozenUsageMessagesRef = useRef(messages);
  /* Cập nhật ref qua useEffect chứ KHÔNG mutate ngay trong thân render:
     đổi ref giữa render khiến hai consumer đọc ref ở cùng một render thấy
     giá trị khác nhau tuỳ thời điểm, và render bị vứt (StrictMode) vẫn để
     lại effect cạnh trong ref. Ngữ nghĩa giữ nguyên: chỉ khoá lại khi
     KHÔNG stream — effect bỏ qua khi isLoading nên ref giữ snapshot cuối
     trước khi stream bắt đầu. */
  useEffect(() => {
    if (!isLoading) frozenUsageMessagesRef.current = messages;
  }, [isLoading, messages]);
  const messagesForUsage = isLoading ? frozenUsageMessagesRef.current : messages;

  const contextUsage = useMemo(() => {
    if (!messagesForUsage.length) return null;
    const boundaryIndex = activeCompaction
      ? messagesForUsage.findIndex((m) => m.id === activeCompaction.upToId)
      : -1;
    const effective =
      boundaryIndex >= 0 ? messagesForUsage.slice(boundaryIndex + 1) : messagesForUsage;
    const tokens = estimatePromptTokens(effective, [
      activeCompaction?.summary,
      systemPrompt,
    ]);
    return { tokens, max: resolveContextWindow(model, activeProvider?.models) };
    /* Liệt kê ĐÚNG thứ được đọc (activeProvider?.models) thay vì cả object
       activeProvider: khai báo rộng hơn mức cần khiến memo tính lại khi bất kỳ
       trường nào của provider đổi (kể cả trường không ảnh hưởng cửa sổ ngữ
       cảnh). Đổi provider thì chính mảng models cũng đổi nên không bỏ sót. */
  }, [messagesForUsage, activeCompaction, model, activeProvider?.models, systemPrompt]);

  useEffect(() => {
    if (isLoading || !currentChatId || !contextUsage) return;
    const { max } = contextUsage;

    /* Ưu tiên usage THẬT từ upstream (chính xác hơn ước lượng chars/4).
       Chỉ fallback sang estimate khi gateway không trả usage. */
    const lastUsage = lastUsageRef.current;
    let trigger = false;
    if (lastUsage && lastUsage.promptTokens > 0) {
      const decision = evaluateUsageTrigger({
        promptTokens: lastUsage.promptTokens,
        completionTokens: lastUsage.completionTokens,
        finishReason: lastUsage.finishReason,
        windowTokens: max,
      });
      trigger = decision.kind !== 'skip';
    } else {
      trigger = shouldCompact(contextUsage.tokens, max);
    }

    if (!trigger) return;
    const timer = setTimeout(() => {
      void performCompaction('auto');
    }, 3_000);
    return () => clearTimeout(timer);
  }, [contextUsage, isLoading, currentChatId, performCompaction]);

  /**
   * Có gì đáng nén thủ công không. Dùng `messagesForUsage` (đã đóng băng khi
   * stream) vì splitForCompaction giờ phải tích token phần đuôi — chạy lại
   * theo từng token của stream là vô ích, và nút nén vốn đã tắt khi isLoading.
   */
  const canCompactNow = useMemo(
    () => !isLoading && !!splitForCompaction(messagesForUsage, contextUsage?.max),
    [isLoading, messagesForUsage, contextUsage?.max],
  );

  /**
   * Recovery khi upstream trả UPSTREAM_CONTEXT_OVERFLOW: nén rồi gửi lại đúng
   * MỘT lần — ref đặt lại khi lượt stream kế bắt đầu (state machine kiểu
   * prime-agent chống vòng lặp nén-retry).
   */
  const overflowRetryUsedRef = useRef(false);
  useEffect(() => {
    if (isLoading) {
      overflowRetryUsedRef.current = false;
      return;
    }
    if (!error) return;
    const text = error instanceof Error ? error.message : String(error ?? '');
    if (!text.includes('UPSTREAM_CONTEXT_OVERFLOW')) return;
    if (overflowRetryUsedRef.current) return;
    overflowRetryUsedRef.current = true;
    void (async () => {
      const ok = await performCompaction('overflow');
      if (ok) void reload();
    })();
  }, [error, isLoading, performCompaction, reload]);

  /* Goal Loop — vòng lặp hướng mục tiêu (Loop Engineering). State machine thuần
     ở lib/goal-loop.ts (conversation-scoped, TTL tự dọn); state React dưới đây
     chỉ là PHẢN CHIẾU cho UI. onFinish đọc trực tiếp lib store qua getGoalLoop()
     nên vòng lặp không phụ thuộc thứ tự khai báo của state này. */
  const [goalLoop, setGoalLoop] = useState<GoalLoopState | null>(() => getGoalLoop(currentChatId));
  useEffect(() => {
    setGoalLoop(getGoalLoop(currentChatId));
  }, [currentChatId]);

  const handleGoalLoopClick = useCallback(
    (goalText: string) => {
      const chatId = useAppStore.getState().currentChatId;
      if (!chatId) {
        showNotice('Cần một hội thoại trước khi đặt mục tiêu.', 4000);
        return;
      }
      /* Goal đang chạy → click = dừng (nút có hai nghĩa, nhãn gọi rõ). */
      if (goalLoop?.status === 'active') {
        const stopped = stopGoalLoop(chatId);
        setGoalLoop(stopped);
        showNotice('🎯 Đã dừng goal loop.', 4000);
        return;
      }
      const goal = (goalText ?? '').trim();
      if (!goal) {
        showNotice(
          '🎯 Gõ mục tiêu vào ô nhập rồi bấm Goal loop — agent sẽ tự lặp đến khi hoàn thành (tối đa 5 lượt).',
          6000,
        );
        return;
      }
      const started = startGoalLoop(chatId, { instruction: goal });
      setGoalLoop(started);
      composerApiRef.current?.clear();
      const goalKickoff = buildGoalKickoff(started);
      void append({ role: 'user', content: goalKickoff }, { body: routingBodyFor(messages, goalKickoff) });
    },
    [goalLoop, append, composerApiRef, messages, routingBodyFor],
  );

  const continueGenerating = useCallback(() => {
    void append(
      { role: 'user', content: CONTINUE_PROMPT },
      { body: routingBodyFor(messages, CONTINUE_PROMPT) },
    );
  }, [append, messages, routingBodyFor]);

  /**
   * Duyệt kế hoạch (P1-5): chuyển ACT + gửi lượt kick-off thực thi. Plan đã
   * được agent lưu qua plan_create từ lúc lập; lượt kick-off đi qua routing
   * như mọi lượt user nên có thể rơi vào worker model đúng pha thực thi.
   */
  const handleApprovePlan = useCallback(() => {
    updateSettings({ agentMode: 'act' });
    showNotice('Đã duyệt kế hoạch — chuyển sang ACT mode, agent bắt đầu thực thi.', 5000);
    if (!isLoading) {
      const kick =
        'Người dùng đã duyệt kế hoạch. Hãy bắt đầu thực hiện theo đúng thứ tự subtask, dùng plan_update để đánh dấu tiến độ (in_progress → done/failed).';
      void append({ role: 'user', content: kick }, { body: routingBodyFor(messages, kick) });
    }
  }, [updateSettings, isLoading, append, messages, routingBodyFor]);

  const { isAtBottom, isAtBottomRef, onScroll, pin, scrollToBottom } = useStickToBottom(scrollRef, {
    streaming: isLoading,
  });

  const isLoadingRef = useRef(isLoading);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  const { generateTitle, markTitled } = useTitleGenerator({
    onTitle: async (chatId, title) => {
      await db.chats.update(chatId, { title: String(title).slice(0, 60), updatedAt: Date.now() });
      notifyChatUpdated(chatId);
    },
    accessCode,
    apiKey,
    providerBase: activeProvider?.baseUrl,
    providerKey: activeProvider?.apiKey,
    /* Model đang chat được /api/title thử đầu tiên khi có provider active —
       không gửi thì tiêu đề chạy bằng model env, thường 404 trên gateway BYOK
       và tụt về tiêu đề heuristic cắt 5 từ. */
    model,
  });

  const reloadTreeFromDatabase = useCallback(async () => {
    const chatId = currentChatId;
    if (!chatId) return;

    try {
      const [chat, rows] = await Promise.all([
        db.chats.get(chatId),
        db.messages.where('chatId').equals(chatId).toArray(),
      ]);

      if (!chat) return;

      const nextActiveLeafId = chat.activeLeafId ?? null;
      const recon = reconstructActiveThreadSafe(rows, nextActiveLeafId ?? undefined);

      allStoredMessagesRef.current = rows;
      activeLeafIdRef.current = nextActiveLeafId;
      setAllStoredMessages(rows);
      setActiveLeafId(nextActiveLeafId);

      revokeObjectUrls(createdObjectUrls.current);
      const nextMessages = recon.messages.map((row) =>
        toChatMessage(row, createdObjectUrls.current),
      );
      setMessages(nextMessages);
    } catch (err) {
      console.error('[reloadTreeFromDatabase]', err);
    }
  }, [currentChatId, setMessages]);

  useCrossTabChatSync({
    sessionId: currentChatId,
    onReload: () => {
      void reloadTreeFromDatabase();
    },
  });

  const branchInfoByMessageId = useMemo(() => {
    const result = new Map<string, BranchInfo>();

    for (const message of messages) {
      const siblingInfo = getSiblings(
        allStoredMessages,
        message.id,
      );

      if (siblingInfo.total <= 1) {
        continue;
      }

      result.set(message.id, {
        currentIndex: siblingInfo.currentIndex,
        total: siblingInfo.total,
      });
    }

    return result;
  }, [messages, allStoredMessages]);

  const currentChatIdRef = useRef(currentChatId);
  useEffect(() => {
    currentChatIdRef.current = currentChatId;
    loadedToolNamesRef.current.clear();
  }, [currentChatId]);

  useEffect(() => {
    if (
      previousChatId.current !==
      currentChatId
    ) {
      const isSwitchingExisting =
        previousChatId.current !== null &&
        currentChatId !== null &&
        previousChatId.current !== currentChatId;

      if (isSwitchingExisting) {
        requestEpoch.current += 1;
        treePersistEpochRef.current += 1;

        /**
         * Panel xác nhận xoá + trạng thái sửa của chat cũ không được
         * kéo sang chat mới — nếu không, "Xóa hẳn" đang chờ xác nhận ở
         * chat A sẽ xoá nhầm chat B vừa mở.
         */
        setConfirmClear(false);
        setEditingId(null);
        setDraft('');

        /**
         * Hủy timer persist chưa chạy.
         */
        if (treePersistTimerRef.current) {
          clearTimeout(
            treePersistTimerRef.current,
          );

          treePersistTimerRef.current = null;
        }

        /**
         * Fork reservation chỉ hợp lệ trong chat đã tạo ra nó.
         */
        pendingAssistantForkRef.current =
          null;

        if (isLoading && previousChatId.current) {
          finishRef.current = 'abort';
          /* Báo reconciler TRƯỚC khi abort: nó chuyển desired='stopped' và tự
             chốt terminated, nên UI hiện "Đã dừng" thay vì kẹt ở "Đang
             trả lời" nếu abort() không làm isLoading rơi xuống ngay. */
          stopRun();
          stop();
        }

        /* Capture của chat cũ không được dính vào lượt ghi của chat mới. */
        closeTurnCapture();
      }

      previousChatId.current =
        currentChatId;
    }
  }, [
    currentChatId,
    isLoading,
    stop,
    stopRun,
    closeTurnCapture,
  ]);

  useEffect(() => {
    if (error) {
      finishRef.current = 'error';
      closeTurnCapture();
    }
  }, [error, closeTurnCapture]);

  useEffect(() => {
    if (!data?.length) return;
    const lastData = data[data.length - 1] as any;
    if (lastData?.type === 'generation-error') {
      finishRef.current = 'error';
      closeTurnCapture();
      showNotice(lastData.message || 'Kết nối AI bị gián đoạn giữa chừng.');
    }
  }, [data, closeTurnCapture]);

  const handleStop = useCallback(() => {
    finishRef.current = 'abort';
    /* Báo reconciler TRƯỚC khi abort: nó chuyển desired='stopped' và tự
       chốt terminated, nên UI hiện "Đã dừng" thay vì kẹt ở "Đang
       trả lời" nếu abort() không làm isLoading rơi xuống ngay. */
    stopRun();
    stop();
    closeTurnCapture();

    // Hủy luôn lượt tạo ảnh/video đang chạy trực tiếp từ trình duyệt.
    mediaAbortRef.current?.abort();
    /**
     * P3.1 (Escape) — abort rồi TRẢ message đã queue về ô nhập: ưu tiên tin
     * steering mới nhất, hết steering mới tới follow-up.
     */
    const steerTakeBack = steeringRef.current[steeringRef.current.length - 1];
    const followTakeBack = followUpRef.current[followUpRef.current.length - 1];
    const takeBack = steerTakeBack ?? followTakeBack;
    /* Clear TOÀN BỘ hàng đợi: tin còn sót sau abort không được tự bắn ở turn
       kế tiếp (onFinish drain sẽ gặp queue cũ → gửi tin stale). Tin mới nhất
       về ô nhập, số còn lại bị bỏ kèm thông báo. */
    const discarded =
      steeringRef.current.length +
      followUpRef.current.length -
      (takeBack !== undefined ? 1 : 0);
    steeringRef.current = [];
    followUpRef.current = [];
    setSteeringCount(0);
    setFollowUpCount(0);
    if (takeBack !== undefined) composerApiRef.current?.setText(takeBack);
    if (discarded > 0) showNotice(`Đã bỏ ${discarded} tin còn lại trong hàng đợi.`, 4000);
    /**
     * Không xóa ngay nếu Assistant đã xuất hiện vì persistence
     * vẫn cần metadata của node đó.
     */
    const pending = pendingAssistantForkRef.current;

    if (
      pending &&
      !pending.assistantMessageId
    ) {
      pendingAssistantForkRef.current = null;
    }
  }, [stop, stopRun, closeTurnCapture]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const pending = pendingAssistantForkRef.current;

    if (!pending) {
      return;
    }

    /**
     * Nếu request đã dừng nhưng Assistant chưa từng xuất hiện,
     * reservation này không còn sử dụng được.
     */
    if (
      !pending.assistantMessageId &&
      (error || finishRef.current === 'error')
    ) {
      pendingAssistantForkRef.current = null;
    }
  }, [isLoading, error]);

  useEffect(() => {
    if (!currentChatId) {
      hydratedFor.current = null;

      revokeObjectUrls(createdObjectUrls.current);

      allStoredMessagesRef.current = [];
      activeLeafIdRef.current = null;

      setAllStoredMessages([]);
      setActiveLeafId(null);
      setMessages([]);

      return;
    }

    const chatId = currentChatId;
    if (hydratedFor.current === chatId) {
      return;
    }

    const epoch = requestEpoch.current;
    let cancelled = false;

    (async () => {
      try {
        const repairResult = await repairSessionIfNeeded(chatId);
        const [chat, rows] = await Promise.all([
          db.chats.get(chatId),
          db.messages
            .where('chatId')
            .equals(chatId)
            .toArray(),
        ]);

        if (
          cancelled ||
          epoch !== requestEpoch.current ||
          chatId !== useAppStore.getState().currentChatId
        ) {
          return;
        }

        const nextActiveLeafId =
          chat?.activeLeafId ?? repairResult.nextActiveLeafId ?? null;

        const reconstruction =
          reconstructActiveThreadSafe(
            rows,
            nextActiveLeafId ?? undefined,
          );

        if (reconstruction.broken) {
          showNotice('Một phần lịch sử nhánh bị lỗi. Dữ liệu hợp lệ vẫn được hiển thị và hệ thống đang tự phục hồi.');
        }

        const activeThread = reconstruction.messages;

        revokeObjectUrls(createdObjectUrls.current);

        const nextMessages = activeThread.map((row) =>
          toChatMessage(
            row,
            createdObjectUrls.current,
          ),
        );

        if (cancelled) return;

        allStoredMessagesRef.current = rows;
        activeLeafIdRef.current = nextActiveLeafId;

        setAllStoredMessages(rows);
        setActiveLeafId(nextActiveLeafId);
        setMessages(nextMessages);

        hydratedFor.current = chatId;
      } catch (error) {
        console.error('[hydrate-tree]', error);
      }
    })();

    return () => {
      /* Chỉ hủy async đang treo — KHÔNG revoke blob URL ở đây. Cleanup chạy
         TRƯỚC thân effect kế tiếp, kể cả khi lần chạy đó early-return vì
         hydratedFor đã khớp chatId (deps ngoài ý muốn đổi danh tính). Revoke
         trong cleanup lúc đó giết URL mà DOM đang hiển thị → ảnh vỡ vĩnh viễn.
         Mọi đường THAY messages đều revoke ở đúng lúc trong thân effect (nhánh
         !currentChatId, và trước khi tạo URL cho chat mới); unmount có effect
         dọn riêng bên dưới. */
      cancelled = true;
    };
    // showNotice là hàm module từ lib/notice-store — ổn định vĩnh viễn.
  }, [currentChatId, setMessages]);

  useEffect(() => {
    return () => {
      requestEpoch.current += 1;
      treePersistEpochRef.current += 1;

      pendingAssistantForkRef.current = null;

      /* Như trên: Set giữ nguyên danh tính, phải đọc tại lúc unmount. */
      // eslint-disable-next-line react-hooks/exhaustive-deps
      revokeObjectUrls(createdObjectUrls.current);

      if (copiedTimer.current) {
        clearTimeout(copiedTimer.current);
      }

      if (reloadTimer.current) {
        clearTimeout(reloadTimer.current);
      }

      if (treePersistTimerRef.current) {
        clearTimeout(
          treePersistTimerRef.current,
        );
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleVisibilityChange = async () => {
      if (document.visibilityState !== 'visible') return;
      const chatId = currentChatId;
      if (!chatId || isLoading) return;

      try {
        await repairAndBroadcastSession(chatId);

        const [chat, rows] = await Promise.all([
          db.chats.get(chatId),
          db.messages.where('chatId').equals(chatId).toArray(),
        ]);

        if (!chat) return;

        const nextActiveLeafId = chat.activeLeafId ?? null;
        const recon = reconstructActiveThreadSafe(rows, nextActiveLeafId ?? undefined);

        allStoredMessagesRef.current = rows;
        activeLeafIdRef.current = nextActiveLeafId;
        setAllStoredMessages(rows);
        setActiveLeafId(nextActiveLeafId);

        revokeObjectUrls(createdObjectUrls.current);
        const nextMessages = recon.messages.map((row) =>
          toChatMessage(row, createdObjectUrls.current),
        );
        setMessages(nextMessages);
      } catch (error) {
        console.error('[visibilitychange recovery]', error);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [currentChatId, isLoading, setMessages]);

  const persistActiveProjection = useCallback(
    async (
      chatId: string,
      visibleMessages: Message[],
      epoch: number,
    ) => {
      if (
        visibleMessages.length === 0 ||
        chatId !==
          useAppStore.getState()
            .currentChatId ||
        epoch !==
          treePersistEpochRef.current
      ) {
        return;
      }

      const currentTree =
        allStoredMessagesRef.current;

      const pendingFork =
        pendingAssistantForkRef.current;

      const loading =
        isLoadingRef.current;

      const finalReason =
        finishRef.current;

      const result =
        await reconcileActiveMessages(
          chatId,
          visibleMessages,
          currentTree,
          pendingFork,
          loading,
          finalReason,
        );

      if (
        epoch !==
          treePersistEpochRef.current ||
        chatId !==
          useAppStore.getState().currentChatId
      ) {
        return;
      }

      /**
       * Nếu Assistant mới do reload() tạo đã được phát hiện,
       * gắn ID thật của SDK vào reservation.
       */
      if (
        result.createdAssistantId &&
        pendingAssistantForkRef.current &&
        pendingAssistantForkRef.current
          .chatId === chatId
      ) {
        pendingAssistantForkRef.current = {
          ...pendingAssistantForkRef.current,
          assistantMessageId:
            result.createdAssistantId,
        };
      }

      /**
       * Nếu không có row thay đổi, chỉ cần bảo đảm pointer đúng.
       */
      const leafId =
        result.activeLeafId;

      try {
        await db.transaction(
          'rw',
          db.messages,
          db.chats,
          async () => {
            /**
             * Row mới bắt buộc đi qua appendMessage: seq/branchOrder
             * được cấp trong transaction, hai tab không thể đè nhau.
             */
            for (const row of result.newRows) {
              const { seq: _seq, branchOrder: _bo, branchTieBreaker: _tb, ...insert } = row;
              await appendMessage({
                ...insert,
                parentId: fromParentKey(insert.parentId),
              });
            }

            if (
              result.changedRows.length > 0
            ) {
              /**
               * Chỉ upsert row đã tồn tại.
               * Không xóa bất kỳ node nào.
               */
              await db.messages.bulkPut(
                result.changedRows,
              );
            }

            if (leafId) {
              await db.chats.update(chatId, {
                activeLeafId: leafId,

                /**
                 * Không làm sidebar reorder mỗi 250ms.
                 */
                ...(!loading
                  ? {
                      updatedAt: Date.now(),
                    }
                  : {}),
              });
            }
          },
        );

        if (
          epoch !==
          treePersistEpochRef.current
        ) {
          return;
        }

        /**
         * Đồng bộ toàn bộ in-memory tree.
         */
        allStoredMessagesRef.current =
          result.allRows;

        setAllStoredMessages(
          result.allRows,
        );

        activeLeafIdRef.current =
          leafId;

        setActiveLeafId(leafId);

        /**
         * Khi stream đã kết thúc, reservation có thể được dọn.
         *
         * Chỉ dọn nếu Assistant thực tế đã xuất hiện.
         */
        const currentPending =
          pendingAssistantForkRef.current;

        if (
          !loading &&
          currentPending?.assistantMessageId
        ) {
          pendingAssistantForkRef.current =
            null;
        }

        /**
         * Không broadcast mỗi token để tránh các tab khác
         * hydrate liên tục.
         */
        if (!loading) {
          notifyChatUpdated(chatId);
        }
      } catch (error: any) {
        console.error(
          '[persistActiveProjection]',
          error,
        );

        if (
          error?.name ===
          'QuotaExceededError'
        ) {
          showNotice(
            'Bộ nhớ IndexedDB đã đầy. Vui lòng xóa bớt file hoặc cuộc trò chuyện cũ.',
          );
        }
      }
    },
    [
      notifyChatUpdated,

    ],
  );

  const enqueueTreePersistence = useCallback(
    (
      chatId: string,
      snapshot: Message[],
      epoch: number,
    ) => {
      treePersistQueueRef.current =
        treePersistQueueRef.current
          .catch((error) => {
            /**
             * Một task lỗi không được phá hỏng toàn bộ queue.
             */
            console.error(
              '[treePersistQueue] Previous task failed:',
              error,
            );
          })
          .then(() =>
            persistActiveProjection(
              chatId,
              snapshot,
              epoch,
            ),
          );
    },
    [persistActiveProjection],
  );

  useEffect(() => {
    if (
      !currentChatId ||
      messages.length === 0
    ) {
      latestPersistSnapshotRef.current = null;
      wasLoadingRef.current = isLoading;
      return;
    }

    const chatId = currentChatId;
    const epoch = treePersistEpochRef.current;

    /**
     * Luôn lưu snapshot mới nhất.
     *
     * Shallow copy array là đủ vì Message object từ useChat được xem
     * như immutable snapshot trong flow hiện tại.
     */
    latestPersistSnapshotRef.current = {
      chatId,
      messages: [...messages],
      epoch,
    };

    const streamJustFinished =
      wasLoadingRef.current && !isLoading;

    wasLoadingRef.current = isLoading;

    /**
     * Khi stream kết thúc, phải flush snapshot cuối ngay lập tức.
     */
    if (streamJustFinished || !isLoading) {
      if (treePersistTimerRef.current) {
        clearTimeout(treePersistTimerRef.current);
        treePersistTimerRef.current = null;
      }

      const latest =
        latestPersistSnapshotRef.current;

      latestPersistSnapshotRef.current = null;

      if (latest) {
        enqueueTreePersistence(
          latest.chatId,
          latest.messages,
          latest.epoch,
        );
      }

      return;
    }

    /**
     * Đang stream:
     * Nếu đã có timer thì chỉ cập nhật latestPersistSnapshotRef,
     * không reset timer.
     */
    if (treePersistTimerRef.current) {
      return;
    }

    treePersistTimerRef.current =
      setTimeout(() => {
        treePersistTimerRef.current = null;

        const latest =
          latestPersistSnapshotRef.current;

        latestPersistSnapshotRef.current = null;

        if (!latest) {
          return;
        }

        enqueueTreePersistence(
          latest.chatId,
          latest.messages,
          latest.epoch,
        );
      }, 250);
  }, [
    currentChatId,
    messages,
    isLoading,
    enqueueTreePersistence,
  ]);

  /* Đồng bộ hoá khi tab khác ghi vào cùng chat (qua chatBroadcast chung). */
  useEffect(() => {
    const unsubscribe = chatBroadcast.subscribe(async (event) => {
      /* B5: chat vừa bị xoá ở tab khác — stop stream + thoát ngay, nếu không
         persist tiếp tục appendMessage vào chat đã mất (message mồ côi). */
      if (event.type === 'chat-deleted') {
        if (event.sessionId !== currentChatIdRef.current) return;
        finishRef.current = 'abort';
        /* Báo reconciler TRƯỚC khi abort: nó chuyển desired='stopped' và tự
           chốt terminated, nên UI hiện "Đã dừng" thay vì kẹt ở "Đang
           trả lời" nếu abort() không làm isLoading rơi xuống ngay. */
        stopRun();
        stop();
        setCurrentChatId(null);
        showNotice('Cuộc trò chuyện này đã bị xoá ở tab khác.');
        return;
      }
      if (event.type !== 'chat-updated') return;
      if (event.sessionId !== currentChatIdRef.current) return;
      if (isLoadingRef.current || !currentChatIdRef.current) return;

      hydratedFor.current = null;
      const chatId = currentChatIdRef.current;
      try {
        const [chat, rows] = await Promise.all([
          db.chats.get(chatId),
          db.messages
            .where('chatId')
            .equals(chatId)
            .toArray(),
        ]);

        if (chatId !== useAppStore.getState().currentChatId) return;

        const nextLeafId =
          chat?.activeLeafId ??
          rows
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)[0]
            ?.id ??
          null;

        const activeThread = reconstructActiveThread(
          rows,
          nextLeafId ?? undefined,
        );

        revokeObjectUrls(createdObjectUrls.current);

        const nextMessages = activeThread.map((row) =>
          toChatMessage(
            row,
            createdObjectUrls.current,
          ),
        );

        allStoredMessagesRef.current = rows;
        activeLeafIdRef.current = nextLeafId;

        setAllStoredMessages(rows);
        setActiveLeafId(nextLeafId);
        setMessages(nextMessages);
      } catch (err) {
        console.error('[broadcastSync]', err);
      }
    });

    return unsubscribe;
    /* Tất cả đều ỔN ĐỊNH nên thêm vào không làm effect chạy lại:
       - setCurrentChatId: selector Zustand
       - showNotice: hàm module từ lib/notice-store (bất biến)
       - stop: useCallback của useChat (chỉ đọc abortControllerRef)
       - stopRun: stop() của useRunLifecycle — useCallback([publish]), mà
         publish là useCallback([]) nên không bao giờ đổi danh tính
       Khai báo đầy đủ để lint kiểm tra được thật, thay vì tắt cảnh báo. */
  }, [setMessages, setCurrentChatId, stop, stopRun]);

  useEffect(() => {
    if (!currentChatId) return;
    db.chats.get(currentChatId).then((chat) => {
      if (chat && chat.title && chat.title !== 'New Chat' && chat.title !== 'Cuộc trò chuyện mới') {
        markTitled(currentChatId);
      }
    }).catch(() => {});
  }, [currentChatId, markTitled]);

  const triggerReload = useCallback(() => {
    if (reloadTimer.current) {
      clearTimeout(reloadTimer.current);
    }
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, 0);
  }, [reload]);

  const handleSwitchBranch = useCallback(
    async (
      targetMessageId: string,
      direction: 'previous' | 'next',
    ) => {
      if (switchLockRef.current) {
        return;
      }

      const chatId = currentChatId;

      if (!chatId) {
        return;
      }

      const rows = allStoredMessagesRef.current;

      if (rows.length === 0) {
        return;
      }

      const siblings = getSiblings(
        rows,
        targetMessageId,
      );

      if (
        siblings.total <= 1 ||
        siblings.currentIndex < 0
      ) {
        return;
      }

      const nextIndex =
        direction === 'previous'
          ? siblings.currentIndex - 1
          : siblings.currentIndex + 1;

      if (
        nextIndex < 0 ||
        nextIndex >= siblings.total
      ) {
        return;
      }

      const selectedSibling =
        siblings.siblings[nextIndex];

      if (!selectedSibling) {
        return;
      }

      const nextLeafId = findDeepestLeafId(
        rows,
        selectedSibling.id,
      );

      if (!nextLeafId || nextLeafId === activeLeafIdRef.current) {
        return;
      }

      const previousLeafId = activeLeafIdRef.current;
      const previousMessages = messages;

      switchLockRef.current = true;
      setIsSwitchingBranch(true);

      try {
        if (isLoading) {
          finishRef.current = 'abort';
          /* Báo reconciler TRƯỚC khi abort: nó chuyển desired='stopped' và tự
             chốt terminated, nên UI hiện "Đã dừng" thay vì kẹt ở "Đang
             trả lời" nếu abort() không làm isLoading rơi xuống ngay. */
          stopRun();
          stop();
          /* B2: reset NGAY — nếu không, persist flush kế tiếp đẩy snapshot
             nhánh MỚI qua reconcile với finishReason 'abort' đứng sót →
             nhánh hiển thị hoàn chỉnh bị đóng dấu status:'aborted' trong DB. */
          finishRef.current = 'stop';
        }

        const latestRows = allStoredMessagesRef.current;
        const nextThread = reconstructActiveThread(
          latestRows,
          nextLeafId,
        );

        if (nextThread.length === 0) {
          return;
        }

        revokeObjectUrls(createdObjectUrls.current);

        const nextMessages = nextThread.map((row) =>
          toChatMessage(
            row,
            createdObjectUrls.current,
          ),
        );

        treePersistEpochRef.current += 1;
        activeLeafIdRef.current = nextLeafId;
        setActiveLeafId(nextLeafId);
        setMessages(nextMessages);

        await db.chats.update(chatId, {
          activeLeafId: nextLeafId,
          updatedAt: Date.now(),
        });

        notifyChatUpdated(chatId);
      } catch (error) {
        console.error(
          '[handleSwitchBranch] Failed to persist active leaf:',
          error,
        );
        activeLeafIdRef.current = previousLeafId;
        setActiveLeafId(previousLeafId);
        setMessages(previousMessages);
        showNotice('Không thể chuyển nhánh. Đã khôi phục trạng thái trước.');
      } finally {
        switchLockRef.current = false;
        setIsSwitchingBranch(false);
      }
    },
    [
      currentChatId,
      isLoading,
      messages,
      notifyChatUpdated,
      setMessages,

      stop,
      stopRun,
    ],
  );

  const branchedMessageInThread = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const siblingInfo = getSiblings(allStoredMessages, msg.id);
      if (siblingInfo.total > 1) {
        return msg.id;
      }
    }
    return null;
  }, [messages, allStoredMessages]);

  const handleShortcutPreviousBranch = useCallback(() => {
    if (!branchedMessageInThread) return;
    void handleSwitchBranch(branchedMessageInThread, 'previous');
  }, [branchedMessageInThread, handleSwitchBranch]);

  const handleShortcutNextBranch = useCallback(() => {
    if (!branchedMessageInThread) return;
    void handleSwitchBranch(branchedMessageInThread, 'next');
  }, [branchedMessageInThread, handleSwitchBranch]);

  useBranchKeyboardShortcuts({
    enabled: !isLoading && !isSwitchingBranch,
    onPrevious: handleShortcutPreviousBranch,
    onNext: handleShortcutNextBranch,
  });

  const [swipeDirection, setSwipeDirection] = useState<'left' | 'right' | null>(null);

  const swipeFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSwipeFeedback = useCallback((direction: 'left' | 'right') => {
    setSwipeDirection(direction);
    if (swipeFeedbackTimerRef.current) clearTimeout(swipeFeedbackTimerRef.current);
    swipeFeedbackTimerRef.current = setTimeout(() => {
      setSwipeDirection(null);
      swipeFeedbackTimerRef.current = null;
    }, 400);
  }, []);

  /* Dọn timer phản hồi vuốt khi unmount. Effect này PHẢI đứng sau
     showSwipeFeedback: ref được GHI trong callback đó, mà React Compiler cấm
     ghi một giá trị đã được đọc ở effect đứng trước nó. Gom vào effect dọn
     chung ở trên (đứng trước) sẽ vỡ quy tắc bất biến. */
  useEffect(
    () => () => {
      if (swipeFeedbackTimerRef.current) clearTimeout(swipeFeedbackTimerRef.current);
    },
    [],
  );

  const swipeHandlers = useSwipeBranch({
    onSwipeLeft: () => {
      // Đang stream thì cấm đổi nhánh — handleSwitchBranch sẽ hủy stream
      // và nhảy nhánh, cuộn tay vô ý trên mobile làm mất câu trả lời.
      if (isLoading || isSwitchingBranch) return;
      showSwipeFeedback('left');
      handleShortcutNextBranch();
    },
    onSwipeRight: () => {
      if (isLoading || isSwitchingBranch) return;
      showSwipeFeedback('right');
      handleShortcutPreviousBranch();
    },
  });

  const handleRegenerate = useCallback(
    async (assistantMessageId: string) => {
      if (
        isLoading ||
        !currentChatId
      ) {
        return;
      }

      turnStartedAtRef.current = Date.now();
      const chatId = currentChatId;
      const currentRows =
        allStoredMessagesRef.current;

      const originalAssistant =
        currentRows.find(
          (message) =>
            message.id === assistantMessageId,
        );

      if (
        !originalAssistant ||
        originalAssistant.role !== 'assistant'
      ) {
        console.warn(
          '[handleRegenerate] Không tìm thấy Assistant message hợp lệ:',
          assistantMessageId,
        );
        return;
      }

      /**
       * Assistant mới phải có cùng parentId với Assistant cũ.
       * Parent thông thường là User message ngay trước đó.
       */
      const userParentId =
        originalAssistant.parentId;

      if (!userParentId) {
        showNotice(
          'Không thể tạo lại phản hồi vì không tìm thấy User message cha.',
        );
        return;
      }

      const userParent = currentRows.find(
        (message) =>
          message.id === userParentId,
      );

      if (
        !userParent ||
        userParent.role !== 'user'
      ) {
        showNotice(
          'Không thể tạo lại phản hồi vì cấu trúc hội thoại không hợp lệ.',
        );
        return;
      }

      const contextThread =
        reconstructActiveThread(
          currentRows,
          userParentId,
        );

      if (
        contextThread.length === 0 ||
        contextThread[
          contextThread.length - 1
        ]?.id !== userParentId
      ) {
        showNotice(
          'Không thể tái tạo ngữ cảnh hội thoại.',
        );
        return;
      }

      finishRef.current = 'stop';

      treePersistEpochRef.current += 1;

      if (treePersistTimerRef.current) {
        clearTimeout(treePersistTimerRef.current);
        treePersistTimerRef.current = null;
      }

      latestPersistSnapshotRef.current = null;

      const now = Date.now();

      const pendingFork: PendingAssistantFork = {
        chatId,
        parentId: userParentId,
        branchOrder: getNextBranchOrder(
          currentRows,
          toParentKey(userParentId),
        ),
        source: 'regenerate',
        createdAt: now,
      };

      try {
        /**
         * Assistant mới chưa xuất hiện, nên User parent tạm là leaf.
         */
        await db.chats.update(chatId, {
          activeLeafId: userParentId,
          updatedAt: now,
        });

        pendingAssistantForkRef.current =
          pendingFork;

        activeLeafIdRef.current =
          userParentId;

        setActiveLeafId(userParentId);

        revokeObjectUrls(
          createdObjectUrls.current,
        );

        setMessages(
          contextThread.map((row) =>
            toChatMessage(
              row,
              createdObjectUrls.current,
            ),
          ),
        );

        pin(1000);

        notifyChatUpdated(chatId);

        triggerReload();
      } catch (error) {
        pendingAssistantForkRef.current =
          null;

        console.error(
          '[handleRegenerate]',
          error,
        );

        showNotice(
          'Không thể bắt đầu tạo lại phản hồi.',
        );
      }
    },
    [
      currentChatId,
      isLoading,
      notifyChatUpdated,
      pin,
      setMessages,

      triggerReload,
    ],
  );

  const startEdit = useCallback((m: Message) => {
    setEditingId(m.id);
    setDraft(m.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft('');
  }, []);

  const saveEdit = useCallback(
    async (messageId: string) => {
      const text = draft.trim();

      if (
        !text ||
        isLoading ||
        !currentChatId
      ) {
        return;
      }

      const chatId = currentChatId;
      const currentRows =
        allStoredMessagesRef.current;

      const originalUser = currentRows.find(
        (message) => message.id === messageId,
      );

      if (
        !originalUser ||
        originalUser.role !== 'user'
      ) {
        console.warn(
          '[saveEdit] Không tìm thấy User message hợp lệ:',
          messageId,
        );
        return;
      }

      finishRef.current = 'stop';

      /**
       * Projection cũ không còn là active projection.
       */
      treePersistEpochRef.current += 1;

      if (treePersistTimerRef.current) {
        clearTimeout(treePersistTimerRef.current);
        treePersistTimerRef.current = null;
      }

      latestPersistSnapshotRef.current = null;

      const now = Date.now();

      /**
       * Edited User phải là sibling của User cũ,
       * do đó dùng cùng parentId.
       */
      const editedUserParentId =
        originalUser.parentId;

      const editedUser: StoredMessage = {
        /**
         * Copy các metadata có thể tái sử dụng,
         * đặc biệt là attachments.
         */
        ...originalUser,

        /**
         * Tuyệt đối không dùng lại ID cũ.
         */
        id: crypto.randomUUID(),

        chatId,

        role: 'user',

        content: text,

        parentId: editedUserParentId,

        seq: getNextSequence(currentRows),

        createdAt: now,

        branchOrder: getNextBranchOrder(
          currentRows,
          toParentKey(editedUserParentId),
        ),

        finishReason: 'stop',

        status: 'complete',
      };

      /**
       * Thêm node mới vào cây mà không thay đổi hoặc xóa
       * originalUser và descendants cũ.
       */
      const nextAllRows = [
        ...currentRows,
        editedUser,
      ];

      /**
       * Active thread mới:
       *
       * ancestors của User cũ
       * + edited User mới
       *
       * Không copy assistant descendant cũ sang branch mới.
       */
      const parentPath = reconstructParentPath(
        currentRows,
        editedUserParentId,
      );

      const nextThread = [
        ...parentPath,
        editedUser,
      ];

      /**
       * Chuẩn bị metadata cho Assistant sắp được useChat tạo.
       * Assistant mới sẽ là child của editedUser.
       */
      const pendingFork: PendingAssistantFork = {
        chatId,
        parentId: editedUser.id,
        branchOrder: getNextBranchOrder(
          nextAllRows,
          editedUser.id,
        ),
        source: 'edit',
        createdAt: now,
      };

      try {
        /**
         * Ghi User branch mới trước khi gọi AI.
         *
         * Nếu ghi IndexedDB thất bại, không nên khởi động stream,
         * vì nếu không UI và database sẽ lệch nhau.
         */
        await db.transaction(
          'rw',
          db.messages,
          db.chats,
          async () => {
            await db.messages.put(editedUser);

            await db.chats.update(chatId, {
              /**
               * Trước khi Assistant mới xuất hiện,
               * editedUser tạm thời là active leaf.
               */
              activeLeafId: editedUser.id,
              updatedAt: now,
            });
          },
        );

        /**
         * Chỉ reserve sau khi User branch đã được lưu thành công.
         */
        pendingAssistantForkRef.current =
          pendingFork;

        /**
         * Đồng bộ in-memory tree.
         */
        allStoredMessagesRef.current =
          nextAllRows;

        setAllStoredMessages(nextAllRows);

        activeLeafIdRef.current =
          editedUser.id;

        setActiveLeafId(editedUser.id);

        /**
         * Chuyển projection của useChat sang branch mới.
         */
        revokeObjectUrls(
          createdObjectUrls.current,
        );

        const nextChatMessages =
          nextThread.map((row) =>
            toChatMessage(
              row,
              createdObjectUrls.current,
            ),
          );

        setMessages(nextChatMessages);

        pin(1000);

        setEditingId(null);
        setDraft('');

        notifyChatUpdated(chatId);

        /**
         * Active thread hiện kết thúc bằng User message,
         * nên reload() sẽ yêu cầu AI tạo Assistant mới.
         */
        triggerReload();
      } catch (error) {
        pendingAssistantForkRef.current = null;

        console.error('[saveEdit]', error);

        showNotice(
          'Không thể tạo nhánh chỉnh sửa. Vui lòng thử lại.',
        );
      }
    },
    [
      currentChatId,
      draft,
      isLoading,
      notifyChatUpdated,
      pin,
      setMessages,

      triggerReload,
    ],
  );

  const copyMessage = useCallback(async (m: Message) => {
    try {
      await navigator.clipboard.writeText(m.content);
      setCopiedId(m.id);
      if (copiedTimer.current) {
        clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = setTimeout(() => {
        setCopiedId(null);
        copiedTimer.current = null;
      }, 1500);
    } catch (err) {
      console.error('[copy]', err);
    }
  }, []);

  const deleteChat = useCallback(async () => {
    try {
      handleStop();

      requestEpoch.current += 1;
      treePersistEpochRef.current += 1;

      if (treePersistTimerRef.current) {
        clearTimeout(
          treePersistTimerRef.current,
        );

        treePersistTimerRef.current = null;
      }

      pendingAssistantForkRef.current = null;

      if (currentChatId) {
        await db.transaction(
          'rw',
          db.messages,
          db.chats,
          async () => {
            /**
             * Đây là thao tác xóa toàn bộ chat do người dùng yêu cầu,
             * nên được phép xóa tất cả message của chat.
             *
             * Quy tắc "không xóa message" chỉ áp dụng cho
             * Edit và Regenerate.
             */
            await db.messages
              .where('chatId')
              .equals(currentChatId)
              .delete();

            await db.chats.delete(
              currentChatId,
            );
          },
        );
      }

      revokeObjectUrls(
        createdObjectUrls.current,
      );

      allStoredMessagesRef.current = [];
      activeLeafIdRef.current = null;

      setAllStoredMessages([]);
      setActiveLeafId(null);
      setMessages([]);

      hydratedFor.current = null;

      setDraftId(crypto.randomUUID());
      setCurrentChatId(null);
      attachGenRef.current += 1;
      setAttachments([]);
      setEditingId(null);
      setDraft('');
      setConfirmClear(false);
    } catch (error) {
      console.error('[deleteChat]', error);
      setConfirmClear(false);
    }
  }, [
    currentChatId,
    handleStop,
    setCurrentChatId,
    setMessages,
  ]);

  /**
   * Gửi lượt chat. `modelOverride` dùng cho 2 nút tạo ảnh / tạo video: chỉ
   * lượt này đi bằng model media, model đang chọn trong ModelSelector giữ nguyên.
   */
  /**
   * draftText là SNAPSHOT từ composer (draft-local) — submit không đọc state
   * `input` của useChat nữa. Trả true = tin nhắn đã được đẩy vào pipeline
   * (append đã gọi), composer mới dám xoá draft; false = bail (đang bận,
   * rỗng…) và draft được giữ nguyên.
   */
  const submitTurn = useCallback(async (draftText: string, modelOverride?: string): Promise<boolean> => {
    if ((!draftText.trim() && attachments.length === 0) || isLoading) return false;
    /* B4: gate thêm 2 đường hở — webBusy (tra cứu tới ~15s, isLoading vẫn
       false) và mediaBusy (Enter bypass nút Send đã disabled). */
    if (webBusyRef.current) {
      showNotice('Đang tra cứu web — chờ xíu rồi gửi tiếp nhé.');
      return false;
    }
    if (mediaBusy) {
      showNotice('Đang tạo media — đợi xong hoặc bấm Dừng đã nhé.');
      return false;
    }

    // Trình duyệt không có DataTransfer constructor thì không gắn được file —
    // chặn sớm kèm thông báo, thay vì nuốt lỗi rồi mất tin nhắn.
    if (attachments.length > 0 && typeof DataTransfer !== 'function') {
      showNotice('Trình duyệt không hỗ trợ gửi tệp đính kèm. Hãy bỏ tệp và thử lại.');
      return false;
    }

    try {
      finishRef.current = 'stop';
      /* Ref đồng hồ lượt trả lời: submitTurn và handleRegenerate là hai đường
         submit khác nhau nên không dùng được startedAt của run-lifecycle
         (chỉ beginRun ở submitTurn ghi). Ghi ref trong callback là cố ý —
         rule immutability của react-hooks v7 phân tích tĩnh không phân biệt
         callback chạy-lâu-sau-render với code render. */
      // eslint-disable-next-line react-hooks/immutability
      turnStartedAtRef.current = Date.now();

      /**
       * Đây là lượt gửi bình thường,
       * không phải Edit hoặc Regenerate.
       */
      pendingAssistantForkRef.current = null;

      /* Goal loop: tin nhắn THỦ CÔNG của người dùng = đổi hướng → dừng loop.
         Steering do goal gate append() trực tiếp (không qua submitTurn) nên
         không thể tự dừng nhầm vòng lặp của chính nó. */
      if (getGoalLoop(currentChatId)?.status === 'active') {
        const stopped = stopGoalLoop(currentChatId);
        setGoalLoop(stopped);
        showNotice('🎯 Goal loop dừng vì bạn gửi tin nhắn mới.', 4000);
      }

      let chatId = currentChatId;
      if (!chatId) {
        chatId = draftId;
        hydratedFor.current = chatId;
        await db.chats.put({
          id: chatId,
          title: 'New Chat',
          pinned: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setCurrentChatId(chatId);
      }

      const isFirstMessage = messages.length === 0;
      const userText = draftText.trim();

      const options: {
        experimental_attachments?: FileList;
        body?: Record<string, unknown>;
      } = {};
      if (attachments.length > 0) {
        const dataTransfer = new DataTransfer();
        attachments.forEach((f) => dataTransfer.items.add(f));
        options.experimental_attachments = dataTransfer.files;
      }
      if (modelOverride) options.body = { model: modelOverride };

      /* Skills 2 tầng: matcher từ khóa (fold dấu) chọn tối đa 2 skill khớp
         tin nhắn → body inject vào system LƯỢT NÀY qua per-call body. Không
         khớp thì không đốt token nào — khác catalog-thường-trực của fx. */
      if (!modelOverride && promptTemplates.length > 0 && userText) {
        const active = matchActiveSkills(toSkills(promptTemplates), userText);
        if (active.length > 0) {
          options.body = {
            ...options.body,
            skills: active.map((s) => ({
              name: s.name,
              ...(s.description ? { description: s.description } : {}),
              body: s.body,
            })),
          };
        }
      }

      /* Tìm kiếm web (toggle Globe): tra cứu TRƯỚC khi submit rồi gửi kèm qua
         per-call body — useChat gộp options.body lên config body mỗi lần gọi,
         nên không đụng stale closure như đường state→ref của compaction.
         Media không cần web; lỗi tra cứu chỉ cảnh báo, KHÔNG chặn gửi. */
      if (!modelOverride && webSearchEnabled && userText) {
        setWebBusy(true);
        webBusyRef.current = true;
        try {
          const ctx = await gatherWebContext(userText);
          if (ctx) {
            options.body = { ...options.body, webContext: ctx };
          } else {
            showNotice('Không lấy được kết quả web — gửi tin nhắn bình thường.');
          }
        } catch (err) {
          console.warn('[web-search]', err);
          showNotice(
            `${err instanceof Error ? err.message : 'Tra cứu web lỗi.'} Tin nhắn sẽ được gửi không kèm kết quả web.`,
            6000,
          );
        } finally {
          setWebBusy(false);
          webBusyRef.current = false;
        }
      }

      /* Live tools (thời tiết/tỷ giá): chạy MỌI lượt có ý định, không phụ thuộc
         toggle web. Lỗi tool chỉ nghĩa là thiếu khối dữ liệu, không báo lỗi. */
      if (userText) {
        try {
          const liveCtx = await gatherLiveContext(userText);
          if (liveCtx) options.body = { ...options.body, liveContext: liveCtx };
        } catch {
          /* bỏ qua — đã là best-effort */
        }
      }

      /* Ghi nhớ dài hạn: nạp Recall Pack theo ngân sách token từ ký ức đã duyệt (OMH P1-D) */
      try {
        const recallPack = await queryRecallPack({
          taskText: userText || '',
          scope: { kind: 'thread', ref: currentChat?.id || 'default' },
        });
        if (recallPack.items.length) {
          options.body = {
            ...options.body,
            memories: recallPack.items.map(({ id, text }) => ({ id, text })),
          };
          setActiveRecallPack(recallPack);
        } else {
          setActiveRecallPack(null);
        }
      } catch {
        /* bỏ qua */
      }

      /* Bộ nhớ có cấu trúc (P1-4): index scope-aware + lesson từ bảng mới
         ghép vào mảng memories (giữ đường formatLessonsBlock cũ hoạt động). */
      if (userText) {
        try {
          const workspaceKey = await resolveWorkspaceKey();
          const all = await listAgentMemories();
          if (all.length) {
            const indexBlock = buildMemoryIndexBlock(memoriesForWorkspace(all, workspaceKey)).block;
            if (indexBlock) options.body = { ...options.body, memoryIndex: indexBlock };
            const asLessons = agentMemoriesAsLessons(all, workspaceKey);
            if (asLessons.length) {
              const prevMemories = (options.body?.memories ?? []) as Array<{ id: string; text: string }>;
              options.body = {
                ...options.body,
                memories: [...prevMemories, ...asLessons],
              };
            }
          }
        } catch {
          /* lỗi đọc memory — gửi không kèm */
        }
      }

      /* Workspace agent coding: đọc TƯƠI lúc submit (web = cache module-level
         của fs-access; desktop = hỏi main qua IPC) rồi gửi qua per-call body.
         KHÔNG gửi qua hook body — nó bị chốt ở mount, khi restore handle chưa
         xong nên luôn connected:false → model mãi không biết workspace tồn tại
         (lỗi thật "đã kết nối folder nhưng agent coding không nhận diện"). */
      if (userText) {
        try {
          const wsInfo = isVyenDesktop()
            ? await desktopGetWorkspaceInfo()
            : getWorkspaceInfo();
          options.body = { ...options.body, workspace: wsInfo };
        } catch {
          /* bridge lỗi — gửi không workspace, server giữ prompt như thường */
        }
      }

      /* Disk skills + .vyenhints (P0-3): index đọc từ scan đã chạy trong
         effect (theo workspace); hints đọc fresh mỗi lượt vì file nhỏ.
         Index lọc theo disabledSkills của người dùng. */
      if (userText) {
        try {
          const disabled = useAppStore.getState().settings.disabledSkills ?? [];
          const index = useDiskSkillsStore
            .getState()
            .entries.filter((e) => !disabled.includes(e.name))
            .map(({ name, description, source, dir }) => ({ name, description, source, dir }));
          if (index.length > 0) options.body = { ...options.body, skillIndex: index };
          if (isVyenDesktop() ? (await desktopGetWorkspaceInfo()).connected : getWorkspaceInfo().connected) {
            const hints = await readHintsFromWorkspace();
            setHintsChip(hints);
            if (hints) options.body = { ...options.body, hints: buildHintsBlock(hints) };
          } else {
            setHintsChip(null);
          }
        } catch {
          /* quét skills/hints lỗi — gửi không kèm, chat vẫn chạy */
        }
      }

      /* Per-call body cho 2 cờ tool: gửi TƯƠI mỗi lượt (hook body bị chốt ở
         mount — toggle trong settings sẽ không có tác dụng nếu đi đường đó). */
      if (!modelOverride) {
        options.body = {
          ...options.body,
          agentTools: approvalPolicy === 'chat_only' ? false : agentToolsEnabled,
          /* Plan/Act mode: server lọc write tools + chèn chỉ thị vào system prompt. */
      ...(agentMode !== 'act' ? { agentMode } : {}),
      /* Staging sandbox: server chèn ghi chú vào system prompt. */
      ...(stagingEnabled ? { staging: true } : {}),
          ...(forceEmulatedTools ? { forceEmulatedTools: true } : {}),
        };
      }

      /* Recipe đang chạy (port Goose): MỌI lượt của run — kể cả prompt retry —
         đều mang body.recipe để server inject instructions + áp tool policy.
         Model override của recipe chỉ áp khi model đó nằm trong danh sách
         provider hiện tại (tránh gửi tên model gateway không có). */
      const activeRecipeRun = useRecipeUiStore.getState().activeRun;
      if (
        activeRecipeRun &&
        activeRecipeRun.status !== 'passed' &&
        activeRecipeRun.status !== 'failed' &&
        activeRecipeRun.status !== 'error' &&
        activeRecipeRun.status !== 'stopped'
      ) {
        options.body = { ...options.body, recipe: activeRecipeRun.body };
        const recipeModel = activeRecipeRun.recipe.settings?.model;
        if (!modelOverride && recipeModel && MODELS.some((m) => m.id === recipeModel)) {
          options.body = { ...options.body, model: recipeModel };
        }
      }

      /* Lead/Worker routing (P1-5): recipe không chạy thì override model của
         lượt này theo state machine. /plan đã cắm planner model vào ref —
         planner thắng routing thường (lập kế hoạch luôn cần model mạnh). */
      if (!modelOverride && userText) {
        const plannerModel = plannerKickoffRef.current;
        plannerKickoffRef.current = null;
        if (plannerModel && isRoutableModel(plannerModel)) {
          routingRoleRef.current = 'planner';
          options.body = { ...options.body, model: plannerModel };
        } else {
          options.body = { ...options.body, ...routingBodyFor(messages, userText) };
        }
      }

      /* Chat với PDF: attachment PDF được trích text qua /api/pdf rồi gửi kèm
         body. Không trích được (scan/lỗi) vẫn gửi như cũ. */
      if (attachments.length > 0) {
        try {
          const pdfCtxs = await gatherPdfContexts(attachments);
          if (pdfCtxs.length) options.body = { ...options.body, pdfContexts: pdfCtxs };
        } catch {
          /* bỏ qua */
        }
      }

      pin(1500);

      attachGenRef.current += 1;
      setAttachments([]);
      /* Bắt đầu một run MỚI: reconciler chuyển idle → starting và bắt đầu đếm
         STARTUP_GRACE_MS. Phải gọi TRƯỚC handleSubmit — nếu gọi sau, request
         có thể đã xong trước khi bộ đếm kịp đặt. */
      beginRun();
      /**
       * Bật quyền tự sửa CHO RUN NÀY. `canRepair=false` sẽ làm run bị kẹt đi
       * thẳng tới terminate (run-lifecycle.ts:356) — tức là tính năng tự gửi
       * lại không bao giờ chạy nếu thiếu dòng này.
       *
       * Chỉ bật khi `beginRun()` thật sự tạo run mới: nó là no-op nếu run trước
       * chưa kết thúc, mà lúc đó thì không được phép gắn quyền sửa vào run cũ.
       * `currentRun()` đọc state đồng bộ từ ref, nên thấy ngay kết quả.
       *
       * Khi run kết thúc, `settle()` tự trả `canRepair` về false — không cần
       * tắt thủ công.
       */
      if (currentRun().observed === 'starting') setRepairable(true);
      /* append thay handleSubmit: draft nằm ở composer nên SDK không còn state
         `input` để đọc — append nhận nội dung tường minh, cùng ChatRequestOptions
         (experimental_attachments + per-call body) như handleSubmit cũ. */
      void append({ role: 'user', content: userText }, options);
      if (isFirstMessage && userText) {
        /* Phiên sinh từ recipe: đặt tên ngay (icon 🍳 làm marker) thay vì đợi
           generateTitle — run recipe cần nhận diện trong sidebar từ lượt đầu. */
        const rr = useRecipeUiStore.getState().activeRun;
        if (rr) {
          void db.chats.update(chatId, { title: `🍳 ${rr.recipe.title}`.slice(0, 80) });
        } else {
          void generateTitle(chatId, userText);
        }
      }
      return true;
    } catch (err) {
      console.error('[onSubmit]', err);
      return false;
    }
    /* beginRun/currentRun/setRepairable là hàm ổn định (useCallback rỗng bên
       trong hook), nên thêm vào đây không làm submitTurn bị tạo lại. */
  }, [attachments, isLoading, mediaBusy, currentChat, currentChatId, draftId, setCurrentChatId, append, pin, generateTitle, messages, webSearchEnabled, promptTemplates, agentToolsEnabled, forceEmulatedTools, agentMode, stagingEnabled, beginRun, currentRun, setRepairable, MODELS, isRoutableModel, routingBodyFor, approvalPolicy]);

  /* ---------------------------------------------------------------- */
  /* Recipe runner (port Goose): attempt → checks → retry/pass/stop.   */
  /* ---------------------------------------------------------------- */
  const recipeActiveRun = useRecipeUiStore((s) => s.activeRun);
  const lastRecipeRunIdRef = useRef<string | null>(null);
  /** Snapshot messages lúc bắt đầu run — reset context cho mỗi lần retry. */
  const recipeSnapshotRef = useRef<readonly Message[] | null>(null);

  /* Run mới xuất hiện trong store → chụp snapshot + gửi lượt mở đầu qua
     submitTurn (hưởng đủ gate busy/web/media + body.recipe). */
  useEffect(() => {
    const run = recipeActiveRun;
    if (!run || run.runId === lastRecipeRunIdRef.current) return;
    lastRecipeRunIdRef.current = run.runId;
    recipeSnapshotRef.current = [...messages];
    void submitTurn(run.firstUserMessage).then((ok) => {
      if (!ok) {
        useRecipeUiStore.getState().patchActiveRun({ status: 'error' });
        showNotice('Không bắt đầu được recipe — agent đang bận. Thử lại sau.', 5000);
      }
    });
  }, [recipeActiveRun, submitTurn, messages]);

  /**
   * Chạy shell checks sau khi agent kết thúc một attempt. Mọi lệnh check vẫn
   * đi qua autoApproveShell (recipe KHÔNG bypass phê duyệt); bị từ chối thì
   * coi như checks-blocked → dừng, không tự retry mù.
   */
  const runRecipeChecks = useCallback(
    async (finalText: string): Promise<boolean> => {
      const run = useRecipeUiStore.getState().activeRun;
      if (!run || (run.status !== 'running' && run.status !== 'retrying')) return false;
      const patch = useRecipeUiStore.getState().patchActiveRun;
      const appendLog = useRecipeUiStore.getState().appendLog;
      patch({ status: 'checking' });

      const annotateLast = (annotation: Record<string, unknown>) => {
        setMessages((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i]!.role === 'assistant') {
              return prev.map((m, idx) =>
                idx === i
                  ? {
                      ...m,
                      annotations: [
                        ...((m.annotations ?? []) as Array<Record<string, unknown>>),
                        annotation,
                      ] as typeof m.annotations,
                    }
                  : m,
              );
            }
          }
          return prev;
        });
      };

      const checks = run.recipe.retry?.checks ?? [];

      /* Web thuần không có shell: recipe KHÔNG khai báo check thì vẫn pass
         (agent đã trả lời xong); có check thì báo rõ thay vì fail mù. */
      if (checks.length > 0 && !isVyenDesktop()) {
        patch({ status: 'failed' });
        showNotice('Recipe có kiểm chứng shell — cần bản desktop (npm run app) để chạy checks.', 7000);
        return true;
      }

      const outcomes: RetryCheckOutcome[] = [];
      let blocked = false;
      for (const check of checks) {
        const command = renderTemplate(check.command, run.values);
        let approved = false;
        try {
          approved = await autoApproveShell({ command, cwd: undefined });
        } catch {
          approved = false;
        }
        if (!approved) {
          blocked = true;
          appendLog(`phê duyệt từ chối: ${command}`);
          break;
        }
        try {
          const bridge = (await import('@/lib/desktop-bridge')).vyenDesktop();
          if (!bridge) throw new Error('bridge desktop không khả dụng');
          const r = await bridge.shell.run({
            command,
            timeoutMs: (run.recipe.retry?.timeout_seconds ?? 120) * 1000,
          });
          const output = r.stderr?.trim()
            ? `${r.stdout ?? ''}\n${r.stderr}`
            : (r.stdout ?? '');
          outcomes.push({ command, exitCode: r.code ?? null, ok: r.code === 0, tail: output.slice(-1_500) });
          appendLog(`${command} → ${r.code === 0 ? 'PASS' : `exit ${r.code ?? '?'}`}`);
        } catch (err) {
          outcomes.push({
            command,
            exitCode: null,
            ok: false,
            tail: (err instanceof Error ? err.message : String(err)).slice(0, 300),
          });
        }
      }

      const action = nextRetryAction({
        recipe: run.recipe,
        state: { attempt: run.attempt, maxRetries: run.recipe.retry?.max_retries ?? 0 },
        outcomes,
        checksBlocked: blocked,
      });

      if (action.action === 'pass') {
        const structured = processStructuredOutput(
          finalText,
          (run.body.jsonSchema ?? undefined) as Parameters<typeof processStructuredOutput>[1],
        );
        const line = structured.ok
          ? formatStructuredLine({ recipe: run.recipe.title, ok: true, data: structured.value })
          : formatStructuredLine({ recipe: run.recipe.title, ok: false, errors: structured.errors });
        annotateLast({ recipeResult: { line, attempts: action.attemptsUsed } });
        patch({ status: 'passed' });
        showNotice(`Recipe "${run.recipe.title}" đạt sau ${action.attemptsUsed} lượt.`, 6000);
        return true;
      }

      if (action.action === 'stop') {
        annotateLast({
          recipeResult: {
            line: formatStructuredLine({
              recipe: run.recipe.title,
              ok: false,
              errors: [
                `stop:${action.reason}`,
                ...outcomes.filter((o) => !o.ok).map((o) => `${o.command} exit=${o.exitCode ?? '?'}`),
              ],
            }),
            attempts: action.attemptsUsed,
          },
        });
        patch({ status: action.reason === 'destructive_check' ? 'stopped' : 'failed' });
        showNotice(
          action.reason === 'destructive_check'
            ? 'Check destructive thất bại — recipe dừng, không tự chạy lại.'
            : `Recipe dừng: ${action.reason === 'max_retries' ? 'hết lượt retry' : 'checks bị chặn phê duyệt'}.`,
          7000,
        );
        return true;
      }

      /* retry: reset context về snapshot đầu (đúng spec) rồi gửi failurePrompt
         như lượt user mới — submitTurn tự gắn lại body.recipe cho run này. */
      patch({ status: 'retrying', attempt: action.nextAttempt });
      showNotice(`Kiểm chứng chưa đạt — chạy lại lần ${action.nextAttempt}/${run.maxAttempts}.`, 5000);
      if (recipeSnapshotRef.current) setMessages([...recipeSnapshotRef.current]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      void submitTurn(action.failurePrompt);
      return true;
    },
    [submitTurn, setMessages, autoApproveShell],
  );

  useEffect(() => {
    runRecipeChecksRef.current = runRecipeChecks;
  }, [runRecipeChecks]);

  /** Panel gọi khi user bấm Run: chỉ đặt store — effect trên tự kick. */
  const startRecipeRun = useCallback((run: ActiveRecipeRun) => {
    useRecipeUiStore.getState().setActiveRun(run);
  }, []);

  /**
   * Slash menu: chọn mục kind='recipe' (badge 🍳) mở panel với recipe đó
   * thay vì chèn text; trả true để composer bỏ qua insert mặc định.
   */
  const handleApplySlashPrompt = useCallback(
    (p: SlashPrompt): boolean => {
      if (p.kind !== 'recipe') return false;
      const recordId = p.id.startsWith('recipe:') ? p.id.slice('recipe:'.length) : '';
      const record = (recipeRecords ?? []).find((r) => r.id === recordId);
      if (record) {
        const recipe = readRecipeRecord(record);
        if (recipe) {
          useRecipeUiStore.getState().select({ recipe, origin: 'db', recordId });
        } else {
          useRecipeUiStore.getState().select(null);
        }
        useRecipeUiStore.getState().openPanel();
        return true;
      }
      // Record vừa bị xoá giữa chừng — mở panel danh sách cho user chọn lại.
      useRecipeUiStore.getState().select(null);
      useRecipeUiStore.getState().openPanel();
      return true;
    },
    [recipeRecords],
  );

  /**
   * P3.1 — API hàng đợi cho composer (Enter → steer, Alt+Enter → follow-up).
   * Trả 'sent' (đã append vì idle), 'queued' (đang chạy, đã xếp hàng),
   * 'dropped' (hàng đợi đầy — composer giữ draft + báo UI).
   */
  const queueWhileBusy = useCallback(
    (text: string, kind: 'steer' | 'follow-up'): 'sent' | 'queued' | 'dropped' => {
      const trimmed = text.trim();
      if (!trimmed) return 'dropped';
      if (!isLoading) return 'sent';
      const ref = kind === 'steer' ? steeringRef : followUpRef;
      const setCount = kind === 'steer' ? setSteeringCount : setFollowUpCount;
      const r = enqueueMessage(ref.current, trimmed);
      if (r.dropped) {
        showNotice(
          kind === 'steer' ? 'Hàng đợi steering đã đầy (5) — đợi agent xong bớt rồi gửi tiếp.' : 'Hàng đợi follow-up đã đầy (5) — đợi agent xong bớt rồi gửi tiếp.',
          4000,
        );
        return 'dropped';
      }
      ref.current = r.queue;
      setCount(r.queue.length);
      showNotice(
        kind === 'steer'
          ? `Đã xếp steering (${r.queue.length}) — sẽ gửi ngay khi turn hiện tại xong.`
          : `Đã xếp follow-up (${r.queue.length}) — sẽ gửi khi agent hết việc.`,
        3000,
      );
      return 'queued';
    },
    [isLoading],
  );

  /**
   * P3.1 (Alt+Up) — lấy lại message đã queue mới nhất vào ô nhập để sửa.
   * Steering trước, rồi follow-up. Hết queue → false (composer giữ draft).
   */
  const takeBackQueued = useCallback((): boolean => {
    const steerLast = steeringRef.current[steeringRef.current.length - 1];
    if (steerLast !== undefined) {
      steeringRef.current = steeringRef.current.slice(0, -1);
      setSteeringCount(steeringRef.current.length);
      composerApiRef.current?.setText(steerLast);
      return true;
    }
    const followLast = followUpRef.current[followUpRef.current.length - 1];
    if (followLast !== undefined) {
      followUpRef.current = followUpRef.current.slice(0, -1);
      setFollowUpCount(followUpRef.current.length);
      composerApiRef.current?.setText(followLast);
      return true;
    }
    return false;
  }, []);

  /**
   * /plan <mục tiêu> (P1-5): lập kế hoạch bằng planner model ở chế độ chỉ-đọc.
   * PLAN mode phía server đã ép explore-only + hướng dẫn plan_create; planner
   * model (nếu cấu hình) áp cho ĐÚNG lượt kế tiếp qua ref rồi tự nhả — các
   * lượt sau quay lại routing thường.
   */
  const handlePlanCommand = useCallback(
    async (target: string): Promise<boolean> => {
      const cfg = normalizeModelRoutingConfig(modelRouting);
      if (cfg.plannerModel && isRoutableModel(cfg.plannerModel)) {
        plannerKickoffRef.current = cfg.plannerModel;
      }
      if (agentMode !== 'plan') {
        updateSettings({ agentMode: 'plan' });
        showNotice(
          'Đã bật PLAN mode — agent chỉ khảo sát, chưa ghi file. Kế hoạch sẽ hiện trong panel.',
          6000,
        );
      }
      return submitTurn(
        `Hãy lập kế hoạch chi tiết cho yêu cầu sau (gọi plan_create để lưu kế hoạch):\n\n${target}`,
      );
    },
    [modelRouting, isRoutableModel, agentMode, updateSettings, submitTurn],
  );

  /**
   * Router gửi tin (P3.1): idle → submitTurn như cũ; đang chạy → hàng đợi.
   * Enter không opts → mặc định STEERING (Pi: inject ngay khi turn xong);
   * Alt+Enter truyền queueAs:'follow-up' (chỉ bắn khi agent rảnh).
   */
  const onSubmit = useCallback(
    async (draft: string, opts?: { queueAs?: 'steer' | 'follow-up' }): Promise<boolean> => {
      /* Intercept Slash Commands chuẩn hoá (Goose P2-10) khi agent rảnh */
      const trimmed = draft.trim();
      if (!isLoading && trimmed.startsWith('/')) {
        const slash = parseSlashCommand(trimmed, customSlashCommands);
        if (slash) {
          if (slash.kind === 'plan') {
            if (!slash.target) {
              showNotice('Gõ theo mẫu: /plan <mục tiêu cần lập kế hoạch>', 5000);
              return false;
            }
            return handlePlanCommand(slash.target);
          }

          if (slash.kind === 'mode') {
            const policyLabels = {
              always: 'Luôn hỏi (Manual)',
              smart: 'Thông minh (Smart)',
              never: 'Tự động (Autonomous / YOLO)',
              chat_only: 'Chỉ chat (Chat Only)',
            };
            useAppStore.getState().updateSettings({ approvalPolicy: slash.mode });
            showNotice(`Đã chuyển chế độ phê duyệt công cụ sang: ${policyLabels[slash.mode]}`, 4000);
            return true;
          }

          if (slash.kind === 'summarize') {
            void performCompaction('manual');
            showNotice('Đang thực hiện nén ngữ cảnh hội thoại...', 3000);
            return true;
          }

          if (slash.kind === 'recipe') {
            const name = slash.recipeName.trim().toLowerCase();
            if (!name) {
              useRecipeUiStore.getState().select(null);
              useRecipeUiStore.getState().openPanel();
              return true;
            }
            const found = (recipeRecords ?? []).find(
              (r) =>
                r.id.toLowerCase() === name ||
                r.title.toLowerCase() === name ||
                r.title.toLowerCase().includes(name),
            );
            if (found) {
              const recipe = readRecipeRecord(found);
              if (recipe) {
                useRecipeUiStore.getState().select({ recipe, origin: 'db', recordId: found.id });
              }
              useRecipeUiStore.getState().openPanel();
              return true;
            } else {
              showNotice(`Không tìm thấy recipe nào khớp với: "${slash.recipeName}".`, 4000);
              return false;
            }
          }

          if (slash.kind === 'skills') {
            useAppStore.getState().openSettings('skills');
            return true;
          }

          if (slash.kind === 'memory') {
            useAppStore.getState().openSettings('memory');
            return true;
          }

          if (slash.kind === 'tools') {
            useAppStore.getState().openSettings('chung');
            if (slash.query) {
              showNotice(`Đã mở cài đặt công cụ (tìm kiếm: ${slash.query}).`, 3000);
            }
            return true;
          }

          if (slash.kind === 'cost') {
            useAppStore.getState().openSettings('stats');
            return true;
          }

          if (slash.kind === 'custom_recipe') {
            const found = (recipeRecords ?? []).find((r) => r.id === slash.recipeId);
            if (found) {
              const recipe = readRecipeRecord(found);
              if (recipe) {
                useRecipeUiStore.getState().select({ recipe, origin: 'db', recordId: found.id });
                useRecipeUiStore.getState().openPanel();
                return true;
              }
            }
            showNotice(`Không tìm thấy workflow recipe được liên kết (${slash.recipeId}).`, 4000);
            return false;
          }

          if (slash.kind === 'unknown') {
            showNotice(`Lệnh slash không nhận diện: "${slash.raw}". Gõ / để xem danh sách lệnh có sẵn.`, 4000);
            return false;
          }
        }
      }

      if (isLoading) {
        const kind = opts?.queueAs ?? 'steer';
        return queueWhileBusy(draft, kind) !== 'dropped';
      }
      return submitTurn(draft);
    },
    [
      isLoading,
      submitTurn,
      queueWhileBusy,
      handlePlanCommand,
      customSlashCommands,
      recipeRecords,
      performCompaction,
    ],
  );

  /**
   * Tạo ảnh/video.
   *
   * Hai đường đi, chọn theo `action.direct`:
   * - `direct` = gateway cho phép cross-origin VÀ có key phía client → fetch
   *   thẳng từ tab, không đụng giới hạn thời gian của serverless.
   * - ngược lại → qua /api/chat. Đây là đường của crax (crax trả 403 cho mọi
   *   request có `Origin`, và không dùng API key), và nó KỊP: video đo được
   *   120-126s, dưới ngân sách 290s của route.
   *
   * Tin nhắn user + assistant được đẩy vào state ngay để lớp persistence
   * hiện có ghi xuống IndexedDB như một lượt chat bình thường.
   */
  const handleGenerateMedia = useCallback(
    async (action: MediaAction, kind: 'image' | 'video', draftPrompt: string) => {
      const prompt = draftPrompt.trim();
      if (!prompt || isLoading || mediaBusy) return;

      // Không gọi thẳng được → đi đường server. Video mất vài phút nên nói
      // trước để người dùng không đóng tab giữa lúc đang tạo.
      if (!action.direct) {
        if (kind === 'video') {
          showNotice('Đang tạo video — thường mất 2–3 phút. Giữ tab này mở.', 6000);
        }
        void submitTurn(prompt, action.modelId);
        return;
      }

      const baseUrl = activeProvider?.baseUrl;
      // Key phải thuộc đúng gateway sẽ được gọi. settings.apiKey là key của
      // "Máy chủ mặc định" (server env) — không được gửi tới baseUrl mà người
      // dùng tự khai, vì đường này fetch trực tiếp từ trình duyệt.
      const key = activeProvider?.apiKey;
      if (!baseUrl || !key) {
        showNotice('Nhà cung cấp chưa có API key trong trình duyệt.');
        return;
      }

      let chatId = currentChatId;
      if (!chatId) {
        chatId = draftId;
        hydratedFor.current = chatId;
        await db.chats.put({
          id: chatId,
          title: 'New Chat',
          pinned: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        setCurrentChatId(chatId);
      }

      const isFirstMessage = messages.length === 0;
      const userId = crypto.randomUUID();
      const assistantId = crypto.randomUUID();
      const controller = new AbortController();

      mediaAbortRef.current = controller;
      setMediaBusy(true);
      composerApiRef.current?.clear();
      finishRef.current = 'stop';
      pendingAssistantForkRef.current = null;
      pin(1500);

      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content: prompt },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          reasoning: kind === 'image' ? 'Đang tạo ảnh…' : 'Đang gửi yêu cầu tạo video…',
          annotations: [{ model: action.modelId }],
        } as Message,
      ]);

      const setAssistant = (patch: Partial<Message>) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? ({ ...m, ...patch } as Message) : m)),
        );
      };

      try {
        const result = await generateMedia({
          kind,
          baseUrl,
          apiKey: key,
          model: action.modelId,
          prompt,
          signal: controller.signal,
          onProgress: (text) => setAssistant({ reasoning: text } as Partial<Message>),
        });

        setAssistant({ content: result.markdown, reasoning: undefined } as Partial<Message>);

        if (isFirstMessage) void generateTitle(chatId, prompt);
      } catch (err) {
        if (controller.signal.aborted) {
          setAssistant({ content: '_Đã hủy._', reasoning: undefined } as Partial<Message>);
        } else if (err instanceof MediaGenerationError && err.originBlocked) {
          /**
           * Gateway chỉ allowlist origin của chính họ (crax: 403 "Origin not
           * allowed"), hoặc trình duyệt chặn CORS. Bỏ 2 tin nhắn vừa thêm rồi
           * gửi lại qua /api/chat — server không gửi Origin nên không bị chặn.
           *
           * Dùng append() chứ không phải submitTurn(): input đã bị xoá nên
           * handleSubmit() của useChat sẽ gửi chuỗi rỗng.
           */
          setMessages((prev) => prev.filter((m) => m.id !== userId && m.id !== assistantId));
          if (kind === 'video') {
            showNotice(
              'Đang tạo video qua máy chủ — thường mất 2–3 phút. Giữ tab này mở.',
              6000,
            );
          }
          void append(
            { role: 'user', content: prompt },
            { body: { model: action.modelId } },
          );
          if (isFirstMessage) void generateTitle(chatId, prompt);
        } else {
          const message =
            err instanceof MediaGenerationError ? err.message : 'Tạo media thất bại.';
          finishRef.current = 'error';
          showNotice(message, 6000);
          setAssistant({ content: `_${message}_`, reasoning: undefined } as Partial<Message>);
        }
      } finally {
        mediaAbortRef.current = null;
        setMediaBusy(false);
      }
    },
    [
      activeProvider,
      append,
      composerApiRef,
      currentChatId,
      draftId,
      generateTitle,
      isLoading,
      mediaBusy,
      messages.length,
      pin,
      setCurrentChatId,
      setMessages,
      submitTurn,
    ],
  );

  /** Chọn prompt trong slash menu giờ xử lý ngay trong composer (draft-local). */

  const handleSaveQuickPrompt = useCallback(async (title: string, content: string) => {
    try {
      await savePrompt({ title, content });
    } catch (err) {
      console.error('[prompt] lưu nhanh thất bại:', err);
    }
  }, []);

  /**
   * Chạy orchestrator. Ngữ cảnh gửi kèm là 8 tin gần nhất — đủ để lưới hiểu
   * "đang nói về cái gì" mà không phình payload (mỗi tin bị cắt 8k ký tự ở
   * server, nhưng client cũng tự cắt để không gửi thừa).
   */
  const handleOrchestratorRun = useCallback(
    (opts: { goal: string; maxRuns: number; judge: boolean }) => {
      const context = messages
        .slice(-8)
        .map((m) => ({
          role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user') as
            | 'user'
            | 'assistant'
            | 'system',
          content: typeof m.content === 'string' ? m.content.slice(0, 2_000) : '',
        }))
        .filter((m) => m.content.trim().length > 0);

      void orchestrator.start({
        goal: opts.goal,
        context,
        maxRuns: opts.maxRuns,
        judge: opts.judge,
        model,
        headers: buildApiHeaders(),
      });
    },
    [messages, model, orchestrator, buildApiHeaders],
  );

  /** "Đưa vào ô nhập" (hành vi cũ của nút chính, giờ là nút phụ): người dùng sửa rồi tự gửi. */
  const handleOrchestratorAdopt = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      composerApiRef.current?.setText(text.trim());
    },
    [composerApiRef],
  );

  /**
   * "Thêm vào hội thoại": ghi đáp án tổng hợp của orchestrator vào hội thoại
   * HIỆN TẠI như một message assistant (nguyên văn, không cắt), kèm annotation
   * `orchestratorAdopted` làm provenance để UI sau này gắn huy hiệu cho đúng
   * message kể cả sau reload.
   *
   * Persist đi qua đúng lớp đồng bộ sẵn có: setMessages → effect sync →
   * reconcileActiveMessages → appendMessage (cấp seq/branchOrder nguyên tử
   * trong transaction, parentId = message cuối nhánh đang xem). KHÔNG dùng
   * append() của useChat — hook ai@4 trigger request /api/chat cho MỌI append,
   * mà message "chép" này không được phép tốn token.
   */
  const handleOrchestratorAppendToChat = useCallback(
    async (text: string): Promise<boolean> => {
      const answer = text.trim();
      /* Nút đã disable khi answer rỗng — guard này cho các đường gọi khác. */
      if (!answer) return false;
      /* Run đang sống (stream/media) → ghi giữa chừng phá projection persist. */
      if (isLoading) {
        showNotice('Đang trả lời — chờ hết lượt này rồi thêm kết quả nhé.');
        return false;
      }
      if (mediaBusy) {
        showNotice('Đang tạo media — đợi xong hoặc bấm Dừng đã nhé.');
        return false;
      }
      if (orchestratorAdoptLockRef.current) return false;
      orchestratorAdoptLockRef.current = true;

      try {
        /* Persist đọc finishRef làm finishReason cho assistant CUỐI projection —
           reset để run lỗi/abort trước đó không dính status 'error' lên message mới. */
        finishRef.current = 'stop';
        /* Message này KHÔNG phải assistant fork của Edit/Regenerate. */
        pendingAssistantForkRef.current = null;

        /* Chưa có chat (mới là draftId): effect persist bỏ qua messages khi
           currentChatId null, nên phải tạo chat trước — đúng pattern của
           submitTurn / handleGenerateMedia. */
        let chatId = currentChatId;
        if (!chatId) {
          chatId = draftId;
          hydratedFor.current = chatId;
          await db.chats.put({
            id: chatId,
            title: 'New Chat',
            pinned: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
          setCurrentChatId(chatId);
        }

        /* Hành động thủ công của user = đổi hướng — dừng goal loop như
           submitTurn, tránh message adopt lọt vào giữa các steering turn
           thành ngữ cảnh lạ cho lượt kế. */
        if (getGoalLoop(chatId)?.status === 'active') {
          setGoalLoop(stopGoalLoop(chatId));
        }

        const isFirstMessage = messages.length === 0;
        const st = orchestrator.state;
        const adopted: Message = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: answer,
          createdAt: new Date(),
          annotations: [
            {
              orchestratorAdopted: {
                goal: st.plan?.goal ?? '',
                runs: st.total,
                ok: st.stats?.ok ?? null,
                failed: st.stats?.failed ?? null,
                model,
                adoptedAt: Date.now(),
              },
            },
          ] as Message['annotations'],
        };

        /* Không loading → effect persist flush NGAY (không đợi timer 250ms)
           nhưng vẫn là eventual: ghi Dexie đi qua effect + promise chain,
           KHÔNG await được — đóng tab ngay sau khi bấm có thể mất message. */
        setMessages((prev) => [...prev, adopted]);
        pin(1500);

        /* Draft vừa thành chat: sinh title từ mục tiêu sweep (đầy đủ ý hơn
           đáp án dài); plan hỏng thì fallback về chính đáp án. */
        if (isFirstMessage) {
          void generateTitle(chatId, st.plan?.goal || answer);
        }
        return true;
      } catch (err) {
        console.error('[orchestrator-adopt]', err);
        showNotice('Không thêm được kết quả vào hội thoại. Thử lại giúp nhé.');
        return false;
      } finally {
        orchestratorAdoptLockRef.current = false;
      }
    },
    [
      currentChatId,
      draftId,
      generateTitle,
      isLoading,
      mediaBusy,
      messages.length,
      model,
      orchestrator,
      pin,
      setCurrentChatId,
      setGoalLoop,
      setMessages,

    ],
  );

  /** Suggestion chip (empty state) → đặt draft composer + focus. */
  const onSelectSuggestion = useCallback((text: string) => {
    composerApiRef.current?.setText(text);
  }, [composerApiRef]);

  const onToggleWebSearch = useCallback(() => {
    updateSettings({ webSearch: !webSearchEnabled });
  }, [updateSettings, webSearchEnabled]);

  const onToggleAgentMode = useCallback(() => {
    updateSettings({ agentMode: agentMode === 'plan' ? 'act' : 'plan' });
  }, [updateSettings, agentMode]);

  const onCycleAutoPilot = useCallback(() => {
    // Chu trình 4 chế độ: Manual (always) -> Smart (smart) -> Autonomous (never) -> Chat Only (chat_only) -> Manual (always)
    const current = approvalPolicy ?? (autoPilot ? 'smart' : 'always');
    if (current === 'always') {
      updateSettings({ approvalPolicy: 'smart', autoPilot: true });
    } else if (current === 'smart') {
      updateSettings({ approvalPolicy: 'never', autoPilot: true });
    } else if (current === 'never') {
      updateSettings({ approvalPolicy: 'chat_only', autoPilot: false });
    } else if (current === 'chat_only') {
      updateSettings({ approvalPolicy: 'always', autoPilot: false });
    } else {
      updateSettings({ approvalPolicy: 'smart', autoPilot: true });
    }
  }, [updateSettings, autoPilot, approvalPolicy]);

  const onOpenStaging = useCallback(() => setStagingPanelOpen(true), []);

  const onOpenToolsPanel = useCallback(() => setToolsPanelOpen(true), []);

  const onOpenOrchestrator = useCallback(() => {
    setOrchestratorSeed(composerApiRef.current?.getText() ?? '');
    setOrchestratorOpen(true);
  }, []);

  const onCompact = useCallback(() => {
    void performCompaction('manual');
  }, [performCompaction]);

  const onOpenSidebar = useCallback(() => {
    // Mobile: mở drawer. Desktop đang thu gọn: mở rộng sidebar.
    if (window.matchMedia('(min-width: 768px)').matches) {
      useAppStore.getState().setSidebarCollapsed(false);
    } else {
      setSidebarOpen(true);
    }
  }, [setSidebarOpen]);

  const isSidebarCollapsed = useAppStore((s) => s.isSidebarCollapsed);

  const lastMessageId = messages[messages.length - 1]?.id;
  const hasMessages = messages.length > 0;

  const canContinue = useMemo(() => {
    const lastMsg = messages[messages.length - 1];
    return Boolean(
      lastMsg &&
        lastMsg.role === 'assistant' &&
        getFinishInfo(lastMsg).truncated &&
        !isLoading,
    );
  }, [messages, isLoading]);

  const composerAttachments = useMemo(
    () =>
      attachments.map((f, i) => ({
        id: `${f.name}-${i}`,
        name: f.name,
        size: f.size,
      })),
    [attachments],
  );

  const handleRemoveAttachmentById = useCallback(
    (id: string) => {
      const idx = composerAttachments.findIndex((a) => a.id === id);
      if (idx !== -1) removeAttachment(idx);
    },
    [composerAttachments, removeAttachment],
  );

  const handleModelChange = useCallback(
    (newModelId: string) => {
      // Điểm ghi Gần đây duy nhất: chọn model trong picker = dùng model đó.
      // Effect auto-reset model khi đổi provider KHÔNG ghi recents (model bị
      // ép chọn chứ không phải user chọn).
      updateSettings({
        model: newModelId,
        recentModels: upsertRecent(recentModels, newModelId, activeProviderId, Date.now()),
      });
    },
    [updateSettings, recentModels, activeProviderId],
  );

  const handleToggleModelFavorite = useCallback(
    (id: string) => {
      updateSettings({
        modelFavorites: toggleFavorite(modelFavorites, id, activeProviderId),
      });
    },
    [updateSettings, modelFavorites, activeProviderId],
  );

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevel) => {
      updateSettings({ thinkingLevel: level });
    },
    [updateSettings],
  );

  return (
    <div
      {...swipeHandlers}
      className="flex h-full flex-col overflow-hidden bg-transparent touch-pan-y"
    >
      <StatusLine
        onOpenSidebar={onOpenSidebar}
        sidebarCollapsed={isSidebarCollapsed}
        models={MODELS}
        model={model}
        onModelChange={handleModelChange}
        modelSelectorDisabled={isLoading || mediaBusy}
        modelProviderId={activeProviderId}
        modelCatalogBuiltin={!activeProvider?.models?.length}
        modelFavorites={modelFavorites}
        modelRecents={recentModels}
        onToggleModelFavorite={handleToggleModelFavorite}
        agentMode={agentMode}
        onToggleAgentMode={onToggleAgentMode}
        agentModeDisabled={isLoading || mediaBusy}
        workspace={workspace ? { ...workspace, branch: gitBranch } : workspace}
        ctxUsed={contextUsage?.tokens}
        ctxMax={contextUsage?.max}
        thinkingLevel={
          (activeProvider ? supportsThinkingLevel(activeProvider.baseUrl) : serverCaps.thinkingLevel) ||
          !!modelReasoningCap
            ? thinkingLevel
            : undefined
        }
        thinkingSupportedLevels={modelReasoningCap ? modelReasoningCap.efforts : null}
        onThinkingLevelChange={handleThinkingLevelChange}
        thinkingDisabled={isLoading || mediaBusy}
        thinkingMandatory={modelReasoningCap?.mandatory ?? false}
        run={{ streaming: isLoading, mediaBusy, webBusy }}
        hasMessages={hasMessages}
        canCompact={canCompactNow}
        compactBusy={compactBusy}
        onCompact={onCompact}
        currentChatId={currentChatId}
        confirmClear={confirmClear}
        onSetConfirmClear={setConfirmClear}
        onDeleteChat={deleteChat}
      />

      {swipeDirection && (
        <div
          className={[
            'pointer-events-none fixed top-1/2 z-50 -translate-y-1/2',
            'rounded-full border border-[#495059] bg-[#212730] px-3.5 py-1.5 font-mono text-xs text-[#ebe7e4]',
            'animate-pop-in',
            swipeDirection === 'left' ? 'right-4' : 'left-4',
          ].join(' ')}
          aria-live="polite"
        >
          {swipeDirection === 'left' ? 'Nhánh tiếp theo →' : '← Nhánh trước'}
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <MessageList
          chatId={chatKey}
          messages={messages}
          compaction={activeCompaction}
          branchInfoByMessageId={branchInfoByMessageId}
          isLoading={isLoading || mediaBusy}
          lastMessageId={lastMessageId}
          editingId={editingId}
          copiedId={copiedId}
          draft={draft}
          isTouchDevice={isTouchDevice}
          sendOnEnter={sendOnEnter}
          throttleMs={throttleMs}
          error={error}
          isAtBottom={isAtBottom}
          isAtBottomRef={isAtBottomRef}
          pin={pin}
          scrollRef={scrollRef}
          onScroll={onScroll}
          onScrollToBottom={scrollToBottom}
          onCopy={copyMessage}
          onRegenerate={handleRegenerate}
          onSwitchBranch={handleSwitchBranch}
          onStartEdit={startEdit}
          onSaveEdit={saveEdit}
          onCancelEdit={cancelEdit}
          onDraftChange={setDraft}
          onSelectSuggestion={onSelectSuggestion}
          onReload={reload}
          onContinueGenerating={continueGenerating}
        />
      </div>

      {/* Đề nghị kết nối lại workspace gắn với phiên (Goose P2-8) */}
      {sessionWorkspacePath && !isWorkspaceMatched && !dismissedReconnect && (
        <div className="mx-auto mb-2 w-full max-w-thread px-4">
          <div className="flex items-center justify-between gap-2 rounded-none border border-[#495059] bg-[#161d27] px-3 py-2 font-mono text-xs text-[#ebe7e4]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[#6a9fcc] flex-none">📁</span>
              <span className="text-[#9fa4ab] flex-none">Phiên này gắn với thư mục:</span>
              <span className="truncate font-semibold text-[#6a9fcc]">{sessionWorkspacePath}</span>
            </div>
            <div className="flex items-center gap-2 flex-none">
              <button
                type="button"
                onClick={pickFolder}
                className="bg-[#212730] hover:bg-[#2e3744] text-[#6a9fcc] border border-[#495059] px-2.5 py-1 text-[11px] transition-colors cursor-pointer"
              >
                Kết nối lại
              </button>
              <button
                type="button"
                onClick={() => setDismissedReconnect(true)}
                className="text-[#9fa4ab] hover:text-[#ebe7e4] px-1.5 py-1 text-[11px] transition-colors cursor-pointer"
              >
                Bỏ qua
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Undo agent coding: chỉ hiện khi chat này có snapshot restorable. */}
      <WorkspaceCheckpointBar
        chatId={currentChatId}
        busy={isLoading || mediaBusy}
        onNotice={showNotice}
      />

      {/* Checklist tiến độ của plan hiện tại — promise [PLANNING] trong
          system prompt giờ có UI thật. */}
      {plan && !planHidden && (
        <PlanPanel
          plan={plan}
          onHide={() => setPlanHidden(true)}
          canApprove={agentMode === 'plan' && !isLoading}
          onApprove={handleApprovePlan}
        />
      )}

      {/* P0-3: chip "hints loaded" — bấm để xem nguyên văn ngữ cảnh dự án
          (.vyenhints/AGENTS.md/CLAUDE.md) đã nạp vào system prompt. */}
      {hintsChip && (
        <div className="mx-auto mb-2 w-full max-w-thread px-4">
          <div className="rounded-none border border-[#495059] bg-[#1b2430] font-mono text-[11.5px] text-[#9fa4ab]">
            <button
              type="button"
              onClick={() => setShowHints((v) => !v)}
              aria-expanded={showHints}
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-[#161d27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
            >
              <span className="text-[#6a9fcc]">hints loaded</span>
              <span className="truncate">{hintsChip.file}</span>
              <span className="ml-auto flex-none text-[10.5px] text-[#5c6470]">
                {showHints ? 'thu gọn' : 'xem nội dung'}
              </span>
            </button>
            {showHints && (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-[#495059] bg-[#12181f] px-3 py-2 text-[11px] leading-relaxed">
                {hintsChip.content}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* OMH P1-D: 🧠 recalled N memories banner */}
      {activeRecallPack && activeRecallPack.items.length > 0 && (
        <div className="mx-auto mb-2 w-full max-w-thread px-4">
          <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-200/80 bg-sky-50/90 px-3 py-1.5 text-xs text-sky-800 shadow-sm dark:border-sky-900/60 dark:bg-sky-950/50 dark:text-sky-300">
            <button
              type="button"
              onClick={() => setShowRecalledDetail((v) => !v)}
              className="flex items-center gap-1.5 font-medium hover:underline text-[12px]"
            >
              <span>🧠 Đã nhớ {activeRecallPack.items.length} ghi chú</span>
              <span className="text-[10px] text-sky-600 dark:text-sky-400">
                ({showRecalledDetail ? 'thu gọn' : 'xem chi tiết'})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveRecallPack(null)}
              className="rounded p-0.5 text-sky-500 hover:text-sky-700 dark:hover:text-sky-300"
              aria-label="Đóng thông báo ghi nhớ"
            >
              <X size={13} />
            </button>
          </div>

          {showRecalledDetail && (
            <div className="mt-1.5 rounded-lg border border-sky-200 bg-white p-2.5 text-xs shadow-sm dark:border-sky-900 dark:bg-zinc-900">
              <div className="mb-1.5 text-[11px] font-semibold text-zinc-700 dark:text-zinc-300">
                Ghi chú đã nạp vào ngữ cảnh ({activeRecallPack.budget.usedTokens}/{activeRecallPack.budget.limitTokens} tokens):
              </div>
              <ul className="space-y-1.5">
                {activeRecallPack.items.map((item) => (
                  <li key={item.id} className="flex items-start gap-1.5 text-[11px] text-zinc-700 dark:text-zinc-300">
                    <span className="text-sky-500 font-bold">•</span>
                    <span className="flex-1 leading-relaxed">{item.text}</span>
                    <span className="shrink-0 text-[10px] text-zinc-400">[{item.why}]</span>
                  </li>
                ))}
              </ul>
              {activeRecallPack.budget.droppedIds.length > 0 && (
                <div className="mt-1.5 border-t border-zinc-100 pt-1 text-[10px] text-zinc-400 italic dark:border-zinc-800">
                  Đã cắt {activeRecallPack.budget.droppedIds.length} ghi chú do giới hạn ngân sách token.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Composer
        onSubmit={onSubmit}
        isStreaming={isLoading || mediaBusy}
        onStop={handleStop}
        attachments={composerAttachments}
        onAddFiles={addFiles}
        slashPrompts={insertPrompts}
        onApplySlashPrompt={handleApplySlashPrompt}
        onSavePrompt={handleSaveQuickPrompt}
        onRemoveAttachment={handleRemoveAttachmentById}
        mediaActions={mediaActions}
        onGenerateMedia={handleGenerateMedia}
        webSearch={webSearchEnabled}
        onToggleWebSearch={onToggleWebSearch}
        agentMode={agentMode}
        onToggleAgentMode={onToggleAgentMode}
        autoPilot={autoPilot}
        approvalPolicy={approvalPolicy}
        onCycleAutoPilot={onCycleAutoPilot}
        stagedFileCount={stagingVersion >= 0 ? stagingCount(stagingRef.current) : 0}
        onOpenStaging={onOpenStaging}
        onOpenToolsPanel={onOpenToolsPanel}
        onOpenRecipes={() => setRecipesPanelOpen(true)}
        orchestratorOpen={orchestratorOpen}
        onOpenOrchestrator={onOpenOrchestrator}
        webBusy={webBusy}
        workspace={workspace}
        onPickWorkspace={pickFolder}
        onDisconnectWorkspace={disconnectFolder}
        sendOnEnter={sendOnEnter}
        isTouchDevice={isTouchDevice}
        canContinue={canContinue}
        goalLoopActive={goalLoop?.status === 'active'}
        goalLoopInfo={
          goalLoop?.status === 'active' ? `${goalLoop.iterations + 1}/${goalLoop.maxIterations}` : undefined
        }
        onGoalLoopClick={handleGoalLoopClick}
        onContinue={continueGenerating}
        composerApiRef={composerApiRef}
        onTakeBackQueued={takeBackQueued}
      />

      {/* Agent Telemetry HUD (dock dưới composer) */}
      <AgentHud className="mx-auto w-full max-w-thread" />

      {/* Thông báo lỗi/cảnh báo từ showNotice() — trước đây không hề được render. */}
      <DiffConfirm state={diffState} onClose={closeDiffModal} />
      <ShellConfirm state={shellState} onClose={closeShellModal} />
      {/* Phê duyệt tool MCP: event đến từ Electron main bất kể đang ở đâu trong
          app, nên mount ở gốc chat thay vì trong một panel cụ thể. Component tự
          ẩn khi không có yêu cầu nào đang chờ. */}
      <McpToolApprovalDialog />
      {stagingPanelOpen && (
        <StagingPanel
          store={stagingRef.current}
          onClose={() => setStagingPanelOpen(false)}
          onApplyAll={applyAllStaged}
          onRejectFile={rejectStagedFile}
          onRejectAll={rejectAllStaged}
        />
      )}
      {orchestratorOpen && (
        <OrchestratorPanel
          open={orchestratorOpen}
          state={orchestrator.state}
          busy={orchestrator.busy}
          chatBusy={isLoading || mediaBusy}
          initialGoal={orchestratorSeed}
          onRun={handleOrchestratorRun}
          onCancel={orchestrator.cancel}
          onClose={() => setOrchestratorOpen(false)}
          onAdopt={handleOrchestratorAdopt}
          onAppendToChat={handleOrchestratorAppendToChat}
        />
      )}
      {toolsPanelOpen && (
        <ToolsPanel open={toolsPanelOpen} onClose={() => setToolsPanelOpen(false)} />
      )}
      <RecipesPanel
        open={recipesPanelOpen}
        onClose={() => setRecipesPanelOpen(false)}
        onRun={startRecipeRun}
      />
      <ToastHost />
    </div>
  );
}
