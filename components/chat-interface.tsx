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
import { estimateContextTokens, shouldCompact, splitForCompaction } from '@/lib/context-budget';
import {
  resolveContextWindow,
  serializeForCompaction,
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
import { gatherPdfContexts } from '@/lib/use-pdf-context';
import { gatherLiveContext } from '@/lib/live-tools';
import { addMemory, listMemories } from '@/lib/db';
import { compressImageFiles } from '@/lib/image-compress';
import { ChatHeader } from './chat/chat-header';
import { MessageList } from './chat/message-list';
import type { BranchInfo } from './chat/message-item';

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

  const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 4;

  // Đếm thế hệ attachment: mỗi lần clear (gửi/xóa) tăng 1 — đợt nén ảnh chạy
  // nền khởi động trước đó sẽ tự hủy kết quả nếu giữa chừng list đã bị clear
  // (chống file "ma" dính nhầm vào tin nhắn kế tiếp).
  const attachGenRef = useRef(0);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files);
    const gen = attachGenRef.current;

    // Nén ảnh trước khi xét trần: ảnh chụp điện thoại 3-5MB về vài trăm KB
    // (canvas resize + WebP) nên trần 3MB không còn chặn oan người dùng.
    void compressImageFiles(fileArr)
      .catch(() => fileArr) // nén lỗi thì dùng file gốc như cũ
      .then((processed) => {
        if (attachGenRef.current !== gen) return; // đã clear trong lúc nén
        let totalSize = attachments.reduce((sum, f) => sum + f.size, 0);
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
          showNotice(`Bỏ qua file vượt quá tổng giới hạn 3MB: ${rejected.join(', ')}`);
        }
        setAttachments((prev) => [...prev, ...ok].slice(0, MAX_FILES));
      });
  }, [attachments, showNotice]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);
  const finishRef = useRef<'stop' | 'abort' | 'error'>('stop');
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
    headers: {
      ...(accessCode ? { 'x-access-code': accessCode } : {}),
      ...(activeProvider?.baseUrl
        ? {
            'x-api-base': activeProvider.baseUrl,
            ...(activeProvider.apiKey ? { 'x-api-key': activeProvider.apiKey } : {}),
          }
        : apiKey
          ? { 'x-api-key': apiKey }
          : {}),
    },
    body: {
      model,
      temperature,
      thinkingLevel,
      system: systemPrompt,
      /* Compaction: chỉ gửi khi marker còn hợp lệ trên nhánh hiện tại. */
      ...(requestCompaction
        ? {
            contextSummary: requestCompaction.summary,
            compactBoundaryId: requestCompaction.upToId,
          }
        : {}),
    },
    experimental_throttle: throttleMs,
    onFinish: (message, { finishReason, usage }) => {
      // Guard markup tool-call model tự nhả vào kênh text — strip TRƯỚC khi
      // sanitize/lưu để nội dung trong DB cũng sạch (tokens + search index).
      const clean = sanitizeContent(stripEmulatedToolMarkup(message.content).text);

      /**
       * Gateway đôi khi trả stream rỗng (502 ngầm, quá tải, model reasoning
       * bị nuốt token). Kết thúc im lặng để lại bong bóng trống vô nghĩa —
       * đánh dấu error, ghi câu gợi ý vào bong bóng và báo toast.
       */
      if (!clean.trim()) {
        finishRef.current = 'error';
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
    },
    onError: (err) => console.error('[useChat]', err),
  });

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
   * Nén phần cũ: gọi /api/compact rồi lưu marker vào ChatSession. Thất bại
   * tóm tắt (gateway bận/hỏng/mạng) thì CHỈ hard-trim khi đang cứu lỗi tràn
   * context; auto/manual bỏ qua để hẹn lần sau — không mất ngữ cảnh âm thầm.
   * Nén lần thứ hai sẽ ghép tóm tắt cũ vào đầu payload để không đứt mạch
   * ngữ cảnh giữa hai marker.
   */
  const performCompaction = useCallback(
    async (reason: 'auto' | 'manual' | 'overflow'): Promise<boolean> => {
      const chatId = currentChatId;
      if (!chatId || isLoading || compactBusyRef.current) return false;
      if (reason === 'auto' && !autoCompactEnabled) return false;
      if (activeCompaction && Date.now() - activeCompaction.createdAt < 60_000) return false;

      const split = splitForCompaction(messages);
      if (!split) return false;
      const upToId = split.older[split.older.length - 1]?.id ?? '';
      if (!upToId) return false;

      const payload = serializeForCompaction(split.older);
      if (
        activeCompaction &&
        split.older.some((m) => m.id === activeCompaction.upToId) &&
        activeCompaction.summary
      ) {
        payload.unshift({
          role: 'system',
          content: `[Tóm tắt các lượt nén trước đó]\n${activeCompaction.summary}`,
        });
      }

      compactBusyRef.current = true;
      setCompactBusy(true);
      try {
        let summary = '';
        try {
          const res = await fetch('/api/compact', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(accessCode ? { 'x-access-code': accessCode } : {}),
              ...(activeProvider?.baseUrl
                ? {
                    'x-api-base': activeProvider.baseUrl,
                    ...(activeProvider.apiKey ? { 'x-api-key': activeProvider.apiKey } : {}),
                  }
                : apiKey
                  ? { 'x-api-key': apiKey }
                  : {}),
            },
            body: JSON.stringify({ messages: payload }),
          });
          const j = (await res.json().catch(() => null)) as { summary?: unknown } | null;
          if (typeof j?.summary === 'string' && j.summary.trim()) {
            summary = j.summary.trim().slice(0, 16_000);
          }
        } catch {
          /* mạng/gateway lỗi → summary rỗng, quyết định ở dưới. */
        }

        if (!summary && reason !== 'overflow') return false;

        await db.chats.update(chatId, {
          compaction: {
            upToId,
            summary,
            compactedCount: split.older.length,
            createdAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
        showNotice(
          summary
            ? `Đã nén ${split.older.length} tin nhắn cũ thành tóm tắt — chat tiếp nhẹ hơn.`
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
      accessCode, activeProvider, apiKey, showNotice,
    ],
  );

  /**
   * Auto-nén sau stream: ước lượng trên phần SAU marker (+ bản thân summary)
   * thay vì toàn bộ projection — nếu không, sau khi nén xong ước lượng vẫn
   * đếm cả tin cũ và kích hoạt nén lại vô hạn.
   */
  useEffect(() => {
    if (isLoading || !currentChatId || !messages.length) return;
    const boundaryIndex = activeCompaction
      ? messages.findIndex((m) => m.id === activeCompaction.upToId)
      : -1;
    const effective =
      boundaryIndex >= 0 ? messages.slice(boundaryIndex + 1) : messages;
    const tokens =
      estimateContextTokens(effective) +
      (activeCompaction ? Math.ceil(activeCompaction.summary.length / 4) : 0);
    const windowTokens = resolveContextWindow(model, activeProvider?.models);
    if (!shouldCompact(tokens, windowTokens)) return;
    const timer = setTimeout(() => {
      void performCompaction('auto');
    }, 3_000);
    return () => clearTimeout(timer);
  }, [messages, isLoading, currentChatId, model, activeProvider, activeCompaction, performCompaction]);

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
          stop();
        }
      }

      previousChatId.current =
        currentChatId;
    }
  }, [
    currentChatId,
    isLoading,
    stop,
  ]);

  useEffect(() => {
    if (error) finishRef.current = 'error';
  }, [error]);

  useEffect(() => {
    if (!data?.length) return;
    const lastData = data[data.length - 1] as any;
    if (lastData?.type === 'generation-error') {
      finishRef.current = 'error';
      showNotice(lastData.message || 'Kết nối AI bị gián đoạn giữa chừng.');
    }
  }, [data, showNotice]);

  const handleStop = useCallback(() => {
    finishRef.current = 'abort';
    stop();

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
  }, [stop]);

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
      revokeObjectUrls(createdObjectUrls.current);
    };
  }, [currentChatId, setMessages]);

  useEffect(() => {
    return () => {
      requestEpoch.current += 1;
      treePersistEpochRef.current += 1;

      pendingAssistantForkRef.current = null;

      revokeObjectUrls(
        createdObjectUrls.current,
      );

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
  }, [setMessages]);

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
          stop();
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

      /* Tìm kiếm web (toggle Globe): tra cứu TRƯỚC khi submit rồi gửi kèm qua
         per-call body — useChat gộp options.body lên config body mỗi lần gọi,
         nên không đụng stale closure như đường state→ref của compaction.
         Media không cần web; lỗi tra cứu chỉ cảnh báo, KHÔNG chặn gửi. */
      if (!modelOverride && webSearchEnabled && userText) {
        setWebBusy(true);
        try {
          const ctx = await gatherWebContext(userText);
          if (ctx) {
            options.body = { ...options.body, webContext: ctx };
          } else {
            showNotice('Không lấy được kết quả web — gửi tin nhắn bình thường.');
          }
        } catch (err) {
          console.warn('[web-search]', err);
          showNotice('Tra cứu web lỗi — gửi tin nhắn bình thường.');
        } finally {
          setWebBusy(false);
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
      handleSubmit(undefined, options);
      if (isFirstMessage && userText) {
        void generateTitle(chatId, userText);
      }
    } catch (err) {
      console.error('[onSubmit]', err);
    }
  }, [input, attachments, isLoading, currentChatId, draftId, setCurrentChatId, handleSubmit, pin, generateTitle, messages.length, showNotice, webSearchEnabled]);

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
      className="flex h-full flex-col overflow-hidden bg-surface touch-pan-y"
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
        canCompact={!!splitForCompaction(messages) && !isLoading}
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
        slashPrompts={promptTemplates ?? []}
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
        webBusy={webBusy}
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
      <Toast message={notice} onClose={onClearNotice} />
    </div>
  );
}