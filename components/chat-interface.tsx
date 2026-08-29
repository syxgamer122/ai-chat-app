import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useAppStore } from '@/lib/store';
import { syncActiveProviderSnapshot } from '@/lib/providers';
import {
  db,
  appendMessage,
  fromParentKey,
  toParentKey,
  type StoredMessage,
} from '@/lib/db';
import { AVAILABLE_MODELS, MEDIA_MODELS } from '@/lib/models';
import {
  reconstructActiveThread,
  reconstructActiveThreadSafe,
  getSiblings,
  findDeepestLeafId,
} from '@/lib/tree-utils';
import {
  Send, StopCircle, RefreshCcw, ArrowDown, Paperclip, X, Menu,
  ChevronLeft, ChevronRight,
} from 'lucide-react';
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
import { Composer, type MediaAction, type MediaActions } from '@/components/composer';
import { Toast } from '@/components/toast';
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
import { isKodaDesktop } from '@/lib/desktop-bridge';
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
import { describeWorkspaceImage, isImagePath } from '@/lib/fs-vision';
import {
  captureFile,
  newTurnCapture,
  saveTurnCapture,
  type CaptureInput,
  type TurnCapture,
} from '@/lib/workspace-checkpoints';
import { CLIENT_TOOL_NAMES } from '@/lib/agent-tools';
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
  type SubtaskStatus,
} from '@/lib/subtask-plan';
import {
  serializeLesson,
  validateLessonText,
  suggestLessonFromDebug,
  type LessonCategory,
} from '@/lib/lessons';
import { normalizePathKey } from '@/lib/path-utils';
import { DiffConfirm, type DiffConfirmState } from '@/components/diff-confirm';
import { ShellConfirm } from '@/components/shell-confirm';
import { StagingPanel, type StagingPanelState } from '@/components/staging-panel';
import { OrchestratorPanel } from '@/components/orchestrator/orchestrator-panel';
import { useOrchestrator } from '@/lib/use-orchestrator';
import { toSkills } from '@/lib/prompt-library';
import { matchActiveSkills } from '@/lib/skills';
import { gatherPdfContexts } from '@/lib/use-pdf-context';
import { gatherLiveContext } from '@/lib/live-tools';
import { addMemory, listMemories } from '@/lib/db';
import { compressImageFiles } from '@/lib/image-compress';
import { ChatHeader } from './chat/chat-header';
import { MessageList } from './chat/message-list';
import { ContextMeter } from '@/components/context-meter';
import { WorkspaceCheckpointBar } from '@/components/workspace-checkpoints';
import type { BranchInfo } from './chat/message-item';

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
  const temperature = useAppStore((s) => s.settings.temperature);
  const thinkingLevel = useAppStore((s) => s.settings.thinkingLevel);
  const systemPrompt = useAppStore((s) => s.settings.systemPrompt);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const accessCode = useAppStore((s) => s.settings.accessCode);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const activeProvider = useAppStore((s) => s.activeProvider);
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  const autoCompactEnabled = useAppStore((s) => s.settings.autoCompact);
  const webSearchEnabled = useAppStore((s) => s.settings.webSearch);
  /** Tắt = model không nhận tool nào (chat thuần, không agent coding). */
  const agentToolsEnabled = useAppStore((s) => s.settings.agentTools ?? true);
  /** Ép đường tool giả lập — gateway strip `tools` im lặng (vd crax). */
  const forceEmulatedTools = useAppStore((s) => s.settings.forceEmulatedTools ?? false);
  /** Chế độ agent: 'plan' = chỉ explore, 'act' = đọc + ghi. */
  const agentMode = useAppStore((s) => s.settings.agentMode ?? 'act');
  /** Staging sandbox: fs_edit/fs_write ghi vào bộ đệm thay vì đĩa. */
  const stagingEnabled = useAppStore((s) => s.settings.stagingSandbox ?? true);
  /** Capability suy luận của model đang chọn (metadata kiểu OpenRouter). */
  const modelReasoningCap = activeProvider?.models?.find((m) => m.id === model)?.reasoning ?? null;
  const throttleMs = useAppStore((s) => s.settings.perf.throttleMs);

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
  }, []);
  const promptTemplates = useLiveQuery(
    () => db.prompts.orderBy('updatedAt').reverse().toArray(),
    [],
    [],
  );
  /** Slash menu chỉ hiển thị prompt CHÈN — skill (mode='skill') tự kích hoạt
      theo ngữ cảnh, không chọn tay qua "/". */
  const insertPrompts = useMemo(
    () => (promptTemplates ?? []).filter((p) => p.mode !== 'skill'),
    [promptTemplates],
  );

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
      const base = activeProvider.models.map((m) => ({
        id: m.id,
        label: m.name || m.id,
        hint: m.contextLength
          ? `${Math.round(m.contextLength / 1000)}k ngữ cảnh`
          : activeProvider.name,
      }));
      // Bổ sung model media built-in mà /v1/models của gateway không khai báo.
      const known = new Set(base.map((m) => m.id));
      const extra = mediaCatalog
        .filter((m) => !known.has(m.id))
        .map((m) => ({ id: m.id, label: m.label, hint: 'Tạo ảnh / video' }));
      return [...base, ...extra];
    }
    // Provider của server: bỏ model media nếu gateway env không hỗ trợ.
    return AVAILABLE_MODELS.filter((m) => serverCaps.media || m.media === undefined).map((m) => ({
      id: m.id,
      label: m.name,
      hint: m.description,
    }));
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
  const [notice, setNotice] = useState<string | null>(null);
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

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string, duration = 4000) => {
    setNotice(message);
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
      noticeTimer.current = null;
    }, duration);
  }, []);

  const onClearNotice = useCallback(() => {
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    setNotice(null);
  }, []);

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
   * chỉ đi vào hội thoại khi người dùng bấm "Dùng kết quả" (đẩy text vào ô
   * nhập). Nhờ vậy không đụng vào cây nhánh (seq/branchOrder/parentId).
   */
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const orchestrator = useOrchestrator();

  /** Auto-debug loop state: track retry attempts per command. */
  const debugLoopRef = useRef<DebugStore>(emptyDebugStore());

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
      const r = isKodaDesktop() ? await desktopFsReadFull(rawPath) : await fsReadFull(deps!, rawPath);
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

    const isDesktop = typeof window !== 'undefined' && (window as any).koda?.desktop === true;
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
  }, [readCaptureForPath, showNotice, updateStaging]);

  /** Reject từng file — chỉ xóa khỏi overlay, đĩa không bị đụng. */
  const rejectStagedFile = useCallback((path: string) => {
    updateStaging(unstageFile(stagingRef.current, path));
  }, [updateStaging]);

  /** Reject all — clear overlay, đĩa không bị đụng. */
  const rejectAllStaged = useCallback(() => {
    updateStaging(clearStaging(stagingRef.current));
    setStagingPanelOpen(false);
    showNotice('Đã hủy tất cả thay đổi staged (đĩa không bị ảnh hưởng).');
  }, [updateStaging, showNotice]);

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
  }, [showNotice]);

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

  /* ---------------- Agent coding: workspace + client tools ---------------- */
  const [workspace, setWorkspace] = useState(getWorkspaceInfo());
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
  useEffect(() => {
    /* Khôi phục handle phiên trước. PHẢI đồng bộ lại state sau khi xong:
       restoreWorkspaceRoot() chỉ nạp handle vào biến module của fs-access,
       còn `workspace` được khởi tạo bằng getWorkspaceInfo() ở lần render ĐẦU
       — lúc đó handle chưa nạp nên luôn là {connected:false}. Thiếu bước này,
       nút 📁 mãi hiện "chưa kết nối" dù thư mục đã sẵn sàng, và người dùng
       tưởng tính năng hỏng. */
    let alive = true;
    if (isKodaDesktop()) {
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
    if (isKodaDesktop()) {
      const r = await desktopPickWorkspaceRoot();
      if (!r.ok) {
        showNotice(r.error);
      } else {
        showNotice(`Đã kết nối thư mục: ${r.name}`, 3000);
      }
      setWorkspace(await desktopGetWorkspaceInfo());
      return;
    }
    const r = await pickWorkspaceRoot();
    if (!r.ok) {
      showNotice(r.error);
    } else {
      showNotice(`Đã kết nối thư mục: ${r.name}`, 3000);
    }
    setWorkspace(getWorkspaceInfo());
  }, [showNotice]);

  /**
   * Ngắt kết nối workspace: xoá handle khỏi bộ nhớ + IndexedDB (web) hoặc
   * gọi IPC clear (desktop). Sync lại state ngay để nút 📁/FolderX phản ánh
   * đúng trạng thái — thiếu bước này UI vẫn tưởng còn kết nối.
   */
  const disconnectFolder = useCallback(async () => {
    if (isKodaDesktop()) {
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
  }, [showNotice]);

  /**
   * fs_*, shell, git tools chạy NGAY TRÊN MÁY USER — server không thể chạm file.
   * onToolCall trả kết quả (JSON string) → useChat đặt state 'result' → sau stream,
   * maxSteps phía client tự resubmit cho model đọc kết quả tiếp.
   * fs_write/shell_run PHẢI qua confirm: người dùng duyệt mới ghi/chạy.
   */
  const handleClientToolCall = useCallback(
    async ({ toolCall }: { toolCall: { toolName: string; args?: unknown } }) => {
      if (!CLIENT_TOOL_NAMES.has(toolCall.toolName)) return undefined;
      const isDesktop = isKodaDesktop();
      const desktopOnly = new Set(['shell_run', 'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit']);
      if (desktopOnly.has(toolCall.toolName) && !isDesktop) {
        return JSON.stringify({ error: 'Tool này chỉ khả dụng trong Koda desktop (Electron). Hãy chạy app bằng npm run app:dev / app:prod.' });
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
              const truncated = lineCount !== undefined
                ? startLine - 1 + lineCount < lines.length
                : false;
              return JSON.stringify({
                content: sliced.join('\n'),
                size: content.length,
                truncated,
                staged: true,
              });
            }
            /* Ảnh trong workspace: đọc bytes → /api/vision mô tả → model nhận
               bản mô tả text thay vì bị từ chối (lỗi "image input" người dùng
               từng gặp khi bytes nhị phân đi thẳng vào context). */
            if (isImagePath(rel)) {
              const result = await describeWorkspaceImage(
                rel,
                isDesktop ? desktopFsReadImage : (p) => fsReadImage(wsForFs!, p),
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
            const beforeText = existingStaged
              ? existingStaged.content
              : isDesktop ? (await desktopFsRead(path)).content : (await fsRead(wsForFs!, path)).content;
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
            const approved = await showDiffModal({ path, oldText: beforeText, newText: current });
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
            return JSON.stringify({ applied: true, blocks: applied.length, strategies: applied, ...res });
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
            try {
              oldText = isDesktop ? (await desktopFsRead(path)).content : (await fsRead(wsForFs!, path)).content;
            } catch {
              /* file mới — diff toàn bộ là add */
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
            const approved = await showDiffModal({ path, oldText, newText: content });
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
            return JSON.stringify({ written: true, ...writeRes });
          }
          case 'shell_run': {
            const command = String(args.command ?? '');
            const cwd = args.cwd ? String(args.cwd) : undefined;
            const approved = await showShellModal({ command, cwd });
            if (!approved) {
              return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI chạy lệnh này.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const result = await bridge.shell.run({ command, cwd });

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
          case 'git_status': {
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const result = await bridge.git.status();
            return JSON.stringify(result);
          }
          case 'git_diff': {
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const result = await bridge.git.diff({ relPath: args.path ? String(args.path) : undefined, staged: args.staged === true });
            return JSON.stringify({ diff: result });
          }
          case 'git_log': {
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const limit = typeof args.limit === 'number' ? args.limit : 20;
            const result = await bridge.git.log({ limit });
            return JSON.stringify({ log: result });
          }
          case 'git_add': {
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
            const result = await bridge.git.add(paths);
            return JSON.stringify(result);
          }
          case 'git_commit': {
            const message = String(args.message ?? '');
            const approved = await showShellModal({ command: `git commit -m "${message.slice(0, 80)}"`, cwd: undefined });
            if (!approved) {
              return JSON.stringify({ approved: false, note: 'Người dùng TỪ CHỐI commit này.' });
            }
            const bridge = (await import('@/lib/desktop-bridge')).kodaDesktop()!;
            const result = await bridge.git.commit(message);
            return JSON.stringify(result);
          }

          /* ------------------------------------------------------------------ */
          /* Sub-task Plan                                                       */
          /* ------------------------------------------------------------------ */

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
            // Persist plan vào kv
            await db.kv.put({ key: `plan:${currentChatId}`, value: JSON.stringify(plan) }).catch(() => {});
            showNotice(`Đã tạo plan "${title}" với ${plan.subtasks.length} subtask.`);
            return JSON.stringify({ ok: true, plan: formatPlanSummary(plan), subtaskCount: plan.subtasks.length });
          }

          case 'plan_update': {
            const subtaskId = String(args.subtaskId ?? '');
            const status = String(args.status ?? '') as SubtaskStatus;
            // Load plan từ kv
            const row = await db.kv.get(`plan:${currentChatId}`).catch(() => null);
            const plan = row?.value ? parsePlan(typeof row.value === 'string' ? JSON.parse(row.value) : row.value) : null;
            if (!plan) {
              return JSON.stringify({ ok: false, error: 'Không tìm thấy plan hiện tại. Gọi plan_create trước.' });
            }
            const updated = updateSubtaskStatus(plan, subtaskId, status);
            if (!updated) {
              return JSON.stringify({ ok: false, error: `Subtask "${subtaskId}" không tồn tại trong plan.` });
            }
            await db.kv.put({ key: `plan:${currentChatId}`, value: JSON.stringify(updated) }).catch(() => {});
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
            const serialized = serializeLesson({ category, text: validated });
            // Lưu vào memories table (reuse existing infrastructure)
            try {
              const record = await addMemory(serialized);
              if (!record) {
                return JSON.stringify({ ok: false, error: 'Bài học trùng lặp hoặc không lưu được.' });
              }
              showNotice(`Đã lưu bài học [${category}]: ${validated.slice(0, 60)}…`);
              return JSON.stringify({ ok: true, id: record.id, category, text: validated });
            } catch (e) {
              return JSON.stringify({ ok: false, error: `Lỗi lưu bài học: ${e instanceof Error ? e.message : String(e)}` });
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
    [showNotice, showDiffModal, showShellModal, readCaptureForPath],
  );

  /** Build API headers cho fetch calls — gộp logic trùng lặp từ useChat + performCompaction. */
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

  const {
    messages, setMessages, input, setInput, handleInputChange,
    handleSubmit, stop, reload, append, isLoading, error, data,
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
      /* Cho phép tắt hẳn tool-calling. Server mặc định `?? true`, nên TRƯỚC
         ĐÂY không gửi trường này đồng nghĩa tool luôn bật và người dùng
         không có cách nào huỷ. */
      agentTools: agentToolsEnabled,
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

      // Đóng checkpoint turn — các snapshot của response này đã được lưu
      // (fire-and-forget); lượt agent kế tiếp mở capture mới.
      closeTurnCapture();
      // Guard markup tool-call model tự nhả vào kênh text — strip TRƯỚC khi
      // sanitize/lưu để nội dung trong DB cũng sạch (tokens + search index).
      const clean = sanitizeContent(stripEmulatedToolMarkup(message.content).text);

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
        const usageAnn = [
          ...anns,
          { usage: { promptTokens, completionTokens }, model: lastModel ?? model },
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
      }
    },
    onError: (err) => {
      console.error('[useChat]', err);
      failRun();
    },
  });

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
  }, [hydrateRun, showNotice]);

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
      void addMemory(text).then((saved) => {
        if (saved) {
          showNotice(`Đã nhớ: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`, 4000);
        }
      });
    }
  }, [messages, showNotice]);

  const compaction = currentChat?.compaction;
  // Marker chỉ hợp lệ khi ranh giới vẫn nằm trên projection nhánh đang mở
  // (đổi nhánh sang nơi chưa từng nén → marker cũ tự vô hiệu).
  const activeCompaction = useMemo(
    () => findActiveCompaction(compaction, messages),
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
      buildApiHeaders, showNotice, model,
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
  if (!isLoading) frozenUsageMessagesRef.current = messages;
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
  }, [messagesForUsage, activeCompaction, model, activeProvider, systemPrompt]);

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

  const continueGenerating = useCallback(() => {
    void append({ role: 'user', content: CONTINUE_PROMPT });
  }, [append]);

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
  }, [data, showNotice, closeTurnCapture]);

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
  }, [stop, closeTurnCapture]);

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
      cancelled = true;
      /* CỐ Ý đọc .current tại thời điểm cleanup, không snapshot ở đầu effect:
         `createdObjectUrls` giữ NGUYÊN một Set suốt vòng đời component (chỉ
         .add/.clear, không bao giờ gán lại), và ta cần revoke đúng những URL
         ĐANG tồn tại lúc dọn. Snapshot theo gợi ý của lint sẽ bỏ sót mọi URL
         tạo sau khi effect chạy → rò rỉ blob thật. */
      // eslint-disable-next-line react-hooks/exhaustive-deps
      revokeObjectUrls(createdObjectUrls.current);
    };
    // showNotice là useCallback([]) — ổn định vĩnh viễn, thêm vào không gây
    // chạy lại effect nhưng làm lint kiểm tra được đầy đủ.
  }, [currentChatId, setMessages, showNotice]);

  useEffect(() => {
    return () => {
      requestEpoch.current += 1;
      treePersistEpochRef.current += 1;

      pendingAssistantForkRef.current = null;

      /* Như trên: Set giữ nguyên danh tính, phải đọc tại lúc unmount. */
      // eslint-disable-next-line react-hooks/exhaustive-deps
      revokeObjectUrls(createdObjectUrls.current);

      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }

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
      showNotice,
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
    /* Cả ba đều ỔN ĐỊNH nên thêm vào không làm effect chạy lại:
       - setCurrentChatId: selector Zustand
       - showNotice: useCallback([])
       - stop: useCallback của useChat (chỉ đọc abortControllerRef)
       Khai báo đầy đủ để lint kiểm tra được thật, thay vì tắt cảnh báo. */
  }, [setMessages, setCurrentChatId, showNotice, stop]);

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
      showNotice,
      stop,
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

  const showSwipeFeedback = useCallback((direction: 'left' | 'right') => {
    setSwipeDirection(direction);
    window.setTimeout(() => {
      setSwipeDirection(null);
    }, 400);
  }, []);

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
      showNotice,
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
      showNotice,
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
  const submitTurn = useCallback(async (modelOverride?: string) => {
    if ((!input.trim() && attachments.length === 0) || isLoading) return;
    /* B4: gate thêm 2 đường hở — webBusy (tra cứu tới ~15s, isLoading vẫn
       false) và mediaBusy (Enter bypass nút Send đã disabled). */
    if (webBusyRef.current) {
      showNotice('Đang tra cứu web — chờ xíu rồi gửi tiếp nhé.');
      return;
    }
    if (mediaBusy) {
      showNotice('Đang tạo media — đợi xong hoặc bấm Dừng đã nhé.');
      return;
    }

    // Trình duyệt không có DataTransfer constructor thì không gắn được file —
    // chặn sớm kèm thông báo, thay vì nuốt lỗi rồi mất luôn tin nhắn.
    if (attachments.length > 0 && typeof DataTransfer !== 'function') {
      showNotice('Trình duyệt không hỗ trợ gửi tệp đính kèm. Hãy bỏ tệp và thử lại.');
      return;
    }

    try {
      finishRef.current = 'stop';

      /**
       * Đây là lượt gửi bình thường,
       * không phải Edit hoặc Regenerate.
       */
      pendingAssistantForkRef.current = null;

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
      const userText = input.trim();

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

      /* Ghi nhớ dài hạn: đọc trực tiếp Dexie mỗi lượt gửi (≤40 fact, rẻ) để
         luôn mới nhất kể cả khi vừa thêm trong settings. */
      try {
        const mems = await listMemories();
        if (mems.length) {
          options.body = {
            ...options.body,
            memories: mems.map(({ id, text }) => ({ id, text })),
          };
        }
      } catch {
        /* bỏ qua */
      }

      /* Workspace agent coding: đọc TƯƠI lúc submit (web = cache module-level
         của fs-access; desktop = hỏi main qua IPC) rồi gửi qua per-call body.
         KHÔNG gửi qua hook body — nó bị chốt ở mount, khi restore handle chưa
         xong nên luôn connected:false → model mãi không biết workspace tồn tại
         (lỗi thật "đã kết nối folder nhưng agent coding không nhận diện"). */
      if (userText) {
        try {
          const wsInfo = isKodaDesktop()
            ? await desktopGetWorkspaceInfo()
            : getWorkspaceInfo();
          options.body = { ...options.body, workspace: wsInfo };
        } catch {
          /* bridge lỗi — gửi không workspace, server giữ prompt như thường */
        }
      }

      /* Per-call body cho 2 cờ tool: gửi TƯƠI mỗi lượt (hook body bị chốt ở
         mount — toggle trong settings sẽ không có tác dụng nếu đi đường đó). */
      if (!modelOverride) {
        options.body = {
          ...options.body,
      agentTools: agentToolsEnabled,
      /* Plan/Act mode: server lọc write tools + chèn chỉ thị vào system prompt. */
      ...(agentMode !== 'act' ? { agentMode } : {}),
      /* Staging sandbox: server chèn ghi chú vào system prompt. */
      ...(stagingEnabled ? { staging: true } : {}),
          ...(forceEmulatedTools ? { forceEmulatedTools: true } : {}),
        };
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
      handleSubmit(undefined, options);
      if (isFirstMessage && userText) {
        void generateTitle(chatId, userText);
      }
    } catch (err) {
      console.error('[onSubmit]', err);
    }
    /* beginRun/currentRun/setRepairable là hàm ổn định (useCallback rỗng bên
       trong hook), nên thêm vào đây không làm submitTurn bị tạo lại. */
  }, [input, attachments, isLoading, mediaBusy, currentChatId, draftId, setCurrentChatId, handleSubmit, pin, generateTitle, messages.length, showNotice, webSearchEnabled, promptTemplates, agentToolsEnabled, forceEmulatedTools, agentMode, stagingEnabled, beginRun, currentRun, setRepairable]);

  const onSubmit = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      await submitTurn();
    },
    [submitTurn],
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
    async (action: MediaAction, kind: 'image' | 'video') => {
      const prompt = input.trim();
      if (!prompt || isLoading || mediaBusy) return;

      // Không gọi thẳng được → đi đường server. Video mất vài phút nên nói
      // trước để người dùng không đóng tab giữa lúc đang tạo.
      if (!action.direct) {
        if (kind === 'video') {
          showNotice('Đang tạo video — thường mất 2–3 phút. Giữ tab này mở.', 6000);
        }
        void submitTurn(action.modelId);
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
      setInput('');
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
      currentChatId,
      draftId,
      generateTitle,
      input,
      isLoading,
      mediaBusy,
      messages.length,
      pin,
      setCurrentChatId,
      setInput,
      setMessages,
      showNotice,
      submitTurn,
    ],
  );

  /** Voice input: nối câu đã nhận diện vào cuối input hiện tại. */
  const handleAppendVoiceText = useCallback(
    (text: string) => {
      setInput((prev) => {
        const base = prev ?? '';
        const needsSpace = base.length > 0 && !/\s$/.test(base);
        return base + (needsSpace ? ' ' : '') + text;
      });
    },
    [setInput],
  );

  /** Chọn prompt trong slash menu → thay toàn bộ input. */
  const handleApplyPrompt = useCallback(
    (content: string) => {
      setInput(content);
    },
    [setInput],
  );

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

  /** "Dùng kết quả": đưa câu trả lời tổng hợp vào ô nhập, người dùng gửi thủ công. */
  const handleOrchestratorAdopt = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setInput(text.trim());
    },
    [setInput],
  );

  const onTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { handleStop(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (isTouchDevice || !sendOnEnter) return;
    e.preventDefault();
    void onSubmit();
  }, [handleStop, isTouchDevice, sendOnEnter, onSubmit]);

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
      updateSettings({ model: newModelId });
    },
    [updateSettings],
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
      <ChatHeader
        title={currentChat?.title}
        hasMessages={hasMessages}
        confirmClear={confirmClear}
        onSetConfirmClear={setConfirmClear}
        onDeleteChat={deleteChat}
        onOpenSidebar={onOpenSidebar}
        sidebarCollapsed={isSidebarCollapsed}
        currentChatId={currentChatId}
        canCompact={canCompactNow}
        compactBusy={compactBusy}
        onCompact={() => void performCompaction('manual')}
      />

      {swipeDirection && (
        <div
          className={[
            'pointer-events-none fixed top-1/2 z-50 -translate-y-1/2',
            'rounded-full border border-zinc-200 bg-surface-raised/90 px-3.5 py-1.5 text-xs text-zinc-700 shadow-card backdrop-blur',
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
          onSelectSuggestion={setInput}
          onReload={reload}
          onContinueGenerating={continueGenerating}
        />
      </div>

      {contextUsage && (
        <div className="pb-1 pt-2">
          <ContextMeter used={contextUsage.tokens} max={contextUsage.max} />
        </div>
      )}

      {/* Undo agent coding: chỉ hiện khi chat này có snapshot restorable. */}
      <WorkspaceCheckpointBar
        chatId={currentChatId}
        busy={isLoading || mediaBusy}
        onNotice={showNotice}
      />

      <Composer
        input={input}
        onInputChange={handleInputChange}
        onSubmit={onSubmit}
        onKeyDown={onTextareaKeyDown}
        isStreaming={isLoading || mediaBusy}
        onStop={handleStop}
        attachments={composerAttachments}
        onAddFiles={addFiles}
        onAppendText={handleAppendVoiceText}
        slashPrompts={insertPrompts}
        onApplyPrompt={handleApplyPrompt}
        onSavePrompt={handleSaveQuickPrompt}
        onRemoveAttachment={handleRemoveAttachmentById}
        models={MODELS}
        model={model}
        onModelChange={handleModelChange}
        mediaActions={mediaActions}
        onGenerateMedia={handleGenerateMedia}
        webSearch={webSearchEnabled}
        onToggleWebSearch={() => updateSettings({ webSearch: !webSearchEnabled })}
        agentMode={agentMode}
        onToggleAgentMode={() => updateSettings({ agentMode: agentMode === 'plan' ? 'act' : 'plan' })}
        stagedFileCount={stagingVersion >= 0 ? stagingCount(stagingRef.current) : 0}
        onOpenStaging={() => setStagingPanelOpen(true)}
        orchestratorOpen={orchestratorOpen}
        onOpenOrchestrator={() => setOrchestratorOpen(true)}
        webBusy={webBusy}
        workspace={workspace}
        onPickWorkspace={pickFolder}
        onDisconnectWorkspace={disconnectFolder}
        canContinue={canContinue}
        onContinue={continueGenerating}
        thinkingLevel={
          (activeProvider ? supportsThinkingLevel(activeProvider.baseUrl) : serverCaps.thinkingLevel) ||
          !!modelReasoningCap
            ? thinkingLevel
            : undefined
        }
        thinkingSupportedLevels={
          modelReasoningCap && modelReasoningCap.efforts.length > 0
            ? modelReasoningCap.efforts
            : null
        }
        onThinkingLevelChange={handleThinkingLevelChange}
      />

      {/* Thông báo lỗi/cảnh báo từ showNotice() — trước đây không hề được render. */}
      <DiffConfirm state={diffState} onClose={closeDiffModal} />
      <ShellConfirm state={shellState} onClose={closeShellModal} />
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
          initialGoal={input ?? ''}
          onRun={handleOrchestratorRun}
          onCancel={orchestrator.cancel}
          onClose={() => setOrchestratorOpen(false)}
          onAdopt={handleOrchestratorAdopt}
        />
      )}
      <Toast message={notice} onClose={onClearNotice} />
    </div>
  );
}
