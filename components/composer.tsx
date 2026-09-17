'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  ArrowUp,
  Check,
  ChefHat,
  CornerDownLeft,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Loader2,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Square,
  Target,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useHaptics } from '@/components/effects';
import { filterPrompts } from '@/lib/prompt-library';
import { TOOL_CATALOG } from '@/lib/tool-catalog';

export interface Attachment {
  id: string;
  name: string;
  size?: number;
}

export interface SlashPrompt {
  id: string;
  title: string;
  content: string;
  /**
   * 'recipe': mục là workflow (panel Recipes) — chọn sẽ MỞ panel thay vì chèn
   * text; composer hiển thị nhãn 🍳 để phân biệt với prompt chèn thường.
   * 'command': lệnh built-in (vd /plan) — chọn chỉ chèn tiền tố lệnh, Enter
   * gửi thẳng cho ChatInterface xử lý.
   */
  kind?: 'prompt' | 'recipe' | 'command';
}

export interface ComposerApi {
  getText: () => string;
  setText: (text: string) => void;
  appendText: (text: string) => void;
  clear: () => void;
  focus: () => void;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Nút icon 32px như thanh công cụ; vùng chạm mở rộng bằng pseudo `after:-inset-6px`
 * (32+12=44px) để đạt tap target mobile mà không phình thanh công cụ.
 */
function ToolbarButton({
  icon: Icon,
  active,
  disabled,
  onClick,
  label,
  badge,
  className,
  ariaExpanded,
  buttonRef,
}: {
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  badge?: string;
  className?: string;
  ariaExpanded?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-expanded={ariaExpanded}
      title={label}
      className={`relative flex h-8 w-8 flex-none items-center justify-center rounded-none transition-colors duration-100 after:absolute after:-inset-[6px] after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] ${
        active
          ? 'bg-[#252f3d] text-[#6a9fcc]'
          : 'text-[#9fa4ab] hover:bg-[#161d27] hover:text-[#ebe7e4]'
      } disabled:cursor-not-allowed disabled:opacity-30 ${className ?? ''}`}
    >
      <Icon size={14} />
      {badge && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-[#e8993a] px-0.5 text-[9px] font-mono font-bold text-[#0d1116]">
          {badge}
        </span>
      )}
    </button>
  );
}

function SendButton({
  isStreaming,
  canSubmit,
  onStop,
}: {
  isStreaming: boolean;
  canSubmit: boolean;
  onStop: () => void;
}) {
  return (
    <button
      type={isStreaming ? 'button' : 'submit'}
      onClick={isStreaming ? onStop : undefined}
      disabled={!isStreaming && !canSubmit}
      aria-label={isStreaming ? 'Dừng tạo' : 'Gửi tin nhắn'}
      className={`relative flex h-8 w-8 flex-none items-center justify-center rounded-none transition-colors duration-100 after:absolute after:-inset-[6px] after:content-[''] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] ${
        isStreaming
          ? 'bg-[#252f3d] text-[#ebe7e4] hover:bg-[#495059]'
          : canSubmit
            ? 'bg-[#6a9fcc] text-[#0d1116] hover:bg-[#6a9fcc]/85 active:scale-95'
            : 'bg-white/[0.04] text-[#9fa4ab]/40'
      }`}
    >
      {isStreaming ? (
        <Square size={11} className="fill-current" aria-hidden="true" />
      ) : (
        <ArrowUp size={15} strokeWidth={2.5} aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * Mô tả một mục trong menu "Tác vụ".
 */
interface TaskSpec {
  key: string;
  icon: React.ElementType;
  /** Nhãn đầy đủ — tooltip/aria. */
  label: string;
  /** Nhãn gọn trong menu. */
  shortLabel?: string;
  /** Mô tả một dòng dưới nhãn: nói rõ mục này LÀM GÌ, chống "tool lộn xộn". */
  description?: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  /** Mục mở panel overlay: focus nút Tác vụ trước khi chạy để panel đóng
   * xong trả focus về đúng nút đã mở (không rơi về body). */
  returnsFocusToTrigger?: boolean;
  onClick: () => void;
}

interface TaskGroupSpec {
  key: string;
  label: string;
  items: TaskSpec[];
}

function TaskMenu({ groups }: { groups: TaskGroupSpec[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeCount = groups.reduce((acc, g) => acc + g.items.filter((t) => t.active).length, 0);

  return (
    <div ref={wrapRef} className="relative">
      <ToolbarButton
        icon={open ? X : MoreHorizontal}
        active={activeCount > 0}
        onClick={() => setOpen((v) => !v)}
        label="Tác vụ"
        badge={activeCount > 1 ? String(activeCount) : undefined}
        ariaExpanded={open}
        buttonRef={triggerRef}
      />
      {open && (
        <div
          role="menu"
          aria-label="Tác vụ"
          className="surface-panel absolute bottom-full right-0 z-40 mb-2 w-[min(18rem,calc(100vw-2rem))] animate-slide-up overflow-hidden p-1.5"
        >
          {groups.map((group) => (
            <div key={group.key} role="presentation">
              <div
                aria-hidden="true"
                className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-[#6a9fcc]"
              >
                {group.label}
              </div>
              {group.items.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="menuitem"
                    disabled={t.disabled}
                    onClick={() => {
                      if (t.returnsFocusToTrigger) triggerRef.current?.focus();
                      t.onClick();
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-none px-2 py-2 text-left transition-colors hover:bg-[#161d27] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Icon
                      size={15}
                      className={`flex-none ${t.active ? 'text-[#5db87a]' : 'text-[#9fa4ab]'}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-[#ebe7e4]">
                        {t.shortLabel ?? t.label}
                      </span>
                      {t.description && (
                        <span className="block truncate text-[10.5px] leading-tight text-[#9fa4ab]">
                          {t.description}
                        </span>
                      )}
                    </span>
                    {t.badge && (
                      <span className="flex-none rounded-full bg-[#e8993a] px-1.5 text-[10px] font-bold text-[#0d1116]">
                        {t.badge}
                      </span>
                    )}
                    {t.active && !t.badge && (
                      <Check size={13} className="flex-none text-[#5db87a]" />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  onSubmit: (draft: string, opts?: { queueAs?: 'steer' | 'follow-up' }) => Promise<boolean>;
  isStreaming: boolean;
  onStop: () => void;
  attachments: Attachment[];
  onAddFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (id: string) => void;
  slashPrompts?: SlashPrompt[];
  /** Chọn mục slash: trả true = đã xử lý riêng (vd mở panel), bỏ qua insert. */
  onApplySlashPrompt?: (prompt: SlashPrompt) => boolean;
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  agentMode?: 'plan' | 'act';
  onToggleAgentMode?: () => void;
  autoPilot?: boolean;
  approvalPolicy?: 'always' | 'smart' | 'never' | 'chat_only';
  onCycleAutoPilot?: () => void;
  goalLoopActive?: boolean;
  goalLoopInfo?: string;
  onGoalLoopClick?: (goalText: string) => void;
  stagedFileCount?: number;
  onOpenStaging?: () => void;
  /** Mở panel "Công cụ & quyền" (catalog tool + quyền theo nhóm). */
  onOpenToolsPanel?: () => void;
  /** Mở panel Recipes (workflow đóng gói tái sử dụng). */
  onOpenRecipes?: () => void;
  webBusy?: boolean;
  workspace?: { connected: boolean; name: string | null };
  onPickWorkspace?: () => Promise<void>;
  onDisconnectWorkspace?: () => void;
  sendOnEnter: boolean;
  isTouchDevice: boolean;
  canContinue?: boolean;
  onContinue?: () => void;
  maxFileBytes?: number;
  composerApiRef?: React.MutableRefObject<ComposerApi | null>;
  /** P3.1 (Alt+↑): lấy lại tin đã queue mới nhất vào ô nhập. false = queue rỗng. */
  onTakeBackQueued?: () => boolean;
}

/**
 * Ô nhập terminal (DESIGN.md): full-bleed, hairline, prompt glyph.
 *
 * Draft là state NỘI BỘ composer: mỗi keystroke không re-render ChatInterface
 * (trước đây input nằm ở useChat trong component 4.8k dòng — gõ một phím là
 * re-render cả cây). onSubmit nhận snapshot draft và trả true nếu tin nhắn đã
 * được đẩy vào pipeline — composer chỉ xoá draft khi được nhận, và chỉ xoá nếu
 * draft chưa bị gõ tiếp trong lúc chờ.
 */
export const Composer = memo(function Composer({
  onSubmit,
  isStreaming,
  onStop,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  slashPrompts,
  webSearch,
  onToggleWebSearch,
  agentMode,
  onToggleAgentMode,
  autoPilot,
  approvalPolicy,
  onCycleAutoPilot,
  goalLoopActive,
  goalLoopInfo,
  onGoalLoopClick,
  stagedFileCount,
  onOpenStaging,
  onOpenToolsPanel,
  onOpenRecipes,
  onApplySlashPrompt,
  webBusy,
  workspace,
  onPickWorkspace,
  onDisconnectWorkspace,
  sendOnEnter,
  isTouchDevice,
  canContinue,
  onContinue,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  composerApiRef,
  onTakeBackQueued,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pickPending, setPickPending] = useState(false);

  useImperativeHandle(
    composerApiRef,
    () => ({
      getText: () => draft,
      setText: (text: string) => {
        setDraft(text);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(el.value.length, el.value.length);
          }
        });
      },
      appendText: (text: string) => {
        setDraft((d) => d + (d.length > 0 && !/\s$/.test(d) ? ' ' : '') + text);
      },
      clear: () => setDraft(''),
      focus: () => textareaRef.current?.focus(),
    }),
    [draft],
  );

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const slashQuery =
    draft.startsWith('/') && !draft.includes('\n') ? draft.slice(1) : null;

  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : filterPrompts(slashPrompts ?? [], slashQuery)),
    [slashPrompts, slashQuery],
  );

  const slashOpen =
    slashQuery !== null && !slashDismissed && slashMatches.length > 0;

  useEffect(() => {
    setSlashIndex(0);
    setSlashDismissed(false);
  }, [slashQuery]);

  const applyPrompt = useCallback(
    (prompt: SlashPrompt) => {
      // Recipe: nhường cho ChatInterface mở panel — không chèn text.
      if (prompt.kind === 'recipe' && onApplySlashPrompt?.(prompt)) {
        setSlashDismissed(true);
        return;
      }
      setDraft(prompt.content);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
      setSlashDismissed(true);
    },
    [onApplySlashPrompt],
  );

  const hasContent = draft.trim().length > 0 || attachments.length > 0;
  /* P3.1: KHÔNG chặn khi đang stream — Enter/Alt+Enter khi agent chạy là
     steering/follow-up queue (onSubmit ở ChatInterface tự route). SendButton
     vẫn hiện Stop khi streaming (type="button"), nên đổi này không phá nút dừng. */
  const canSubmit = hasContent;

  const acceptFiles = useCallback(
    (files: FileList | File[] | null) => {
      if (!files) return;
      const list = Array.from(files);
      const tooBig = list.filter((f) => f.size > maxFileBytes);
      const ok = list.filter((f) => f.size <= maxFileBytes);
      setFileError(
        tooBig.length > 0
          ? `Bỏ qua ${tooBig.length} tệp vượt ${Math.round(maxFileBytes / 1024 / 1024)}MB.`
          : null,
      );
      if (ok.length > 0) onAddFiles(ok);
    },
    [maxFileBytes, onAddFiles],
  );

  const haptics = useHaptics();

  const submitDraft = useCallback(
    async (opts?: { queueAs?: 'steer' | 'follow-up' }) => {
      if (!canSubmit) return;
      const text = draft;
      const accepted = await onSubmit(text, opts);
      if (accepted) {
        // Chỉ xoá khi draft KHÔNG bị gõ tiếp trong lúc chờ (web search có thể
        // mất tới ~15s) — draft mới của người dùng luôn được giữ.
        setDraft((d) => (d === text ? '' : d));
      }
    },
    [canSubmit, draft, onSubmit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
      if (composingRef.current || native.isComposing || native.keyCode === 229) {
        if (e.key === 'Enter') e.stopPropagation();
        return;
      }

      if (slashOpen && slashMatches.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashMatches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          e.stopPropagation();
          applyPrompt(slashMatches[slashIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setSlashDismissed(true);
          return;
        }
      }

      /* P3.1: Alt+Enter = follow-up queue ; Alt+↑ = lấy lại tin đã queue. */
      if (e.key === 'Enter' && e.altKey && !isTouchDevice) {
        e.preventDefault();
        void submitDraft({ queueAs: 'follow-up' });
        return;
      }
      if (e.key === 'ArrowUp' && e.altKey && !isTouchDevice) {
        e.preventDefault();
        onTakeBackQueued?.();
        return;
      }
      if (e.key === 'Escape') {
        onStop();
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice && sendOnEnter) {
        e.preventDefault();
        void submitDraft();
      }
    },
    [slashOpen, slashMatches, slashIndex, applyPrompt, onStop, isTouchDevice, sendOnEnter, submitDraft, onTakeBackQueued],
  );

  const handleFormSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!canSubmit) return;
      haptics.trigger('light');
      void submitDraft();
    },
    [canSubmit, submitDraft, haptics],
  );

  const handlePickWorkspace = useCallback(async () => {
    if (!onPickWorkspace || pickPending) return;
    // Pressed/pending state renders ngay trong cùng tick của click — nhãn
    // phản hồi tức thì thay vì im lặng chờ dialog native (baseline: 252ms).
    setPickPending(true);
    try {
      await onPickWorkspace();
    } finally {
      setPickPending(false);
    }
  }, [onPickWorkspace, pickPending]);

  const modeTasks: TaskSpec[] = [];
  const lookupTasks: TaskSpec[] = [];
  const advancedTasks: TaskSpec[] = [];

  if (onToggleAgentMode) {
    modeTasks.push({
      key: 'agent-mode',
      icon: Pencil,
      active: agentMode === 'plan',
      disabled: isStreaming,
      label: agentMode === 'plan' ? 'Chuyển sang ACT mode' : 'Chuyển sang PLAN mode',
      shortLabel: 'PLAN mode',
      description: 'PLAN chỉ đọc, ACT được ghi file và chạy lệnh',
      onClick: onToggleAgentMode,
    });
  }

  if (onCycleAutoPilot) {
    const currentPolicy = approvalPolicy ?? (autoPilot ? 'smart' : 'always');
    const policyLabel =
      currentPolicy === 'never'
        ? 'Autonomous'
        : currentPolicy === 'always'
          ? 'Manual'
          : currentPolicy === 'chat_only'
            ? 'Chat Only'
            : 'Smart';
    const isChatOnly = currentPolicy === 'chat_only';
    const isManual = currentPolicy === 'always';
    modeTasks.push({
      key: 'auto-pilot',
      icon: Zap,
      active: currentPolicy === 'smart' || currentPolicy === 'never',
      disabled: isStreaming,
      label: isChatOnly
        ? 'Chế độ: Chat Only (vô hiệu tools) · bấm để đổi'
        : isManual
          ? 'Chế độ: Manual (luôn hỏi duyệt) · bấm để đổi'
          : `Chế độ: ${policyLabel} · bấm để đổi`,
      shortLabel: policyLabel,
      description: isChatOnly
        ? 'Vô hiệu hoàn toàn tool, dùng cho phân tích & viết'
        : isManual
          ? 'Luôn hỏi xác nhận trước khi chạy bất kỳ tool nào'
          : currentPolicy === 'never'
            ? 'Tự động duyệt mọi tool an toàn, trừ lệnh phá hoại'
            : 'Tự duyệt đọc & safe shell, hỏi ghi/destructive',
      onClick: onCycleAutoPilot,
    });
  }

  if (onToggleWebSearch) {
    lookupTasks.push({
      key: 'web',
      icon: Globe,
      active: webSearch,
      disabled: isStreaming,
      label: webSearch ? 'Tắt tìm kiếm web' : 'Bật tìm kiếm web',
      shortLabel: 'Tìm kiếm web',
      description: 'Cho phép agent tìm kiếm web khi trả lời',
      onClick: onToggleWebSearch,
    });
  }

  if (onGoalLoopClick) {
    advancedTasks.push({
      key: 'goal-loop',
      icon: Target,
      active: goalLoopActive ?? false,
      disabled: isStreaming && !(goalLoopActive ?? false),
      label: goalLoopActive
        ? `Goal loop đang chạy${goalLoopInfo ? ` (lượt ${goalLoopInfo})` : ''} · bấm để dừng`
        : 'Goal loop · gõ mục tiêu vào ô nhập rồi bấm để agent tự lặp đến khi hoàn thành',
      shortLabel: goalLoopActive ? `Goal ${goalLoopInfo ?? ''}`.trim() : 'Goal loop',
      description: 'Agent tự lặp từng lượt tới khi xong mục tiêu',
      onClick: () => onGoalLoopClick(draft),
    });
  }

  if (onOpenStaging && (stagedFileCount ?? 0) > 0) {
    advancedTasks.push({
      key: 'staging',
      icon: FileText,
      label: `${stagedFileCount} file đang staged`,
      shortLabel: 'File đã staged',
      badge: String(stagedFileCount),
      description: 'Xem diff, Apply hoặc Reject trước khi ghi đĩa',
      onClick: onOpenStaging,
    });
  }

  if (onDisconnectWorkspace && workspace?.connected) {
    advancedTasks.push({
      key: 'workspace-disconnect',
      icon: FolderOpen,
      disabled: isStreaming,
      label: `Ngắt kết nối: ${workspace.name ?? 'workspace'}`,
      shortLabel: 'Ngắt thư mục làm việc',
      description: 'Gỡ kết nối thư mục làm việc hiện tại khỏi phiên',
      onClick: onDisconnectWorkspace,
    });
  }

  if (onOpenToolsPanel) {
    advancedTasks.push({
      key: 'tools-panel',
      icon: Wrench,
      label: 'Công cụ & quyền…',
      description: `Xem ${TOOL_CATALOG.length} tool AI đang có và đặt quyền`,
      returnsFocusToTrigger: true,
      onClick: onOpenToolsPanel,
    });
  }

  if (onOpenRecipes) {
    advancedTasks.push({
      key: 'recipes-panel',
      icon: ChefHat,
      label: 'Recipes…',
      description: 'Workflow đóng gói chạy lại được: tham số, kiểm chứng, retry',
      returnsFocusToTrigger: true,
      onClick: onOpenRecipes,
    });
  }

  const taskGroups: TaskGroupSpec[] = [
    { key: 'mode', label: 'Chế độ', items: modeTasks },
    { key: 'lookup', label: 'Tra cứu', items: lookupTasks },
    { key: 'advanced', label: 'Nâng cao', items: advancedTasks },
  ].filter((g) => g.items.length > 0);

  return (
    // Terminal Input Box (DESIGN.md): full-bleed, dính mép trái/phải, viền
    // hairline 1px, góc vuông. Chỉ chừa safe-area dưới cho iOS.
    <div className="w-full pb-[env(safe-area-inset-bottom)]">
      {canContinue && !isStreaming && (
        <div className="mb-1.5 flex justify-center">
          <button
            type="button"
            onClick={onContinue}
            className="flex items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-3 py-1.5 font-mono text-[12px] font-medium text-[#6a9fcc] transition-colors duration-100 hover:border-[#757d89] hover:bg-[#212730] hover:text-[#ebe7e4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc]"
          >
            <CornerDownLeft size={12} aria-hidden="true" />
            Viết tiếp
          </button>
        </div>
      )}

      {fileError && (
        <div role="status" className="notice-warn mb-2 px-2">
          {fileError}
        </div>
      )}

      <form
        onSubmit={handleFormSubmit}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          acceptFiles(e.dataTransfer?.files ?? null);
        }}
        className={`group relative rounded-none border border-[#495059] bg-[#212730] transition-colors duration-100 focus-within:border-[#6a9fcc] ${
          dragging ? 'border-[#6a9fcc]' : ''
        }`}
      >
        {slashOpen && (
          <div
            role="listbox"
            aria-label="Danh sách prompt"
            className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-y-auto rounded-none border border-[#495059] bg-[#212730] p-1 font-mono"
            onMouseDown={(e) => e.preventDefault()}
          >
            {slashMatches.map((p, i) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={i === slashIndex}
                id={`slash-opt-${p.id}`}
                onClick={() => applyPrompt(p)}
                onMouseEnter={() => setSlashIndex(i)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-none px-3 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc] ${
                  i === slashIndex ? 'bg-[#252f3d] text-[#ebe7e4]' : 'text-[#ebe7e4] hover:bg-[#161d27]'
                }`}
              >
                <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-[#ebe7e4]">
                  {p.kind === 'recipe' ? (
                    <ChefHat size={11} aria-hidden="true" className="flex-none text-[#6a9fcc]" />
                  ) : null}
                  {p.kind === 'command' ? (
                    <ListChecks size={11} aria-hidden="true" className="flex-none text-[#6a9fcc]" />
                  ) : null}
                  /{p.title}
                </span>
                <span className="line-clamp-1 w-full text-[11px] text-[#9fa4ab]">
                  {p.kind === 'recipe'
                    ? 'workflow · mở panel để chạy'
                    : p.kind === 'command'
                      ? 'lệnh · lập kế hoạch bằng planner model (PLAN mode)'
                      : p.content.replace(/\n+/g, ' ').trim()}
                </span>
              </button>
            ))}
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="flex max-w-[200px] items-center gap-1.5 rounded-none border border-[#495059] bg-[#161d27] px-2 py-1 font-mono text-[11px] text-[#ebe7e4]"
              >
                <Paperclip size={10} aria-hidden="true" className="flex-shrink-0 text-[#6a9fcc]" />
                <span className="truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  aria-label={`Gỡ ${a.name}`}
                  className="ml-0.5 rounded-none p-1 text-[#9fa4ab] transition-colors hover:bg-[#252f3d] hover:text-[#ebe7e4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}

        {webBusy && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pt-3 font-mono text-[12px] leading-relaxed">
            <span className="flex min-w-0 items-center gap-1.5 text-[#9fa4ab]">
              <span aria-hidden="true" className="terminal-cursor" />
              <span className="truncate">Đang tra cứu web…</span>
            </span>
          </div>
        )}

        <div className="relative flex items-start">
          <span className="select-none pl-3.5 pt-3 font-mono text-[14px] text-[#757d89] group-focus-within:text-[#6a9fcc]">
            $
          </span>
          <TextareaAutosize
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []);
              if (files.length > 0) {
                e.preventDefault();
                acceptFiles(files);
              }
            }}
            minRows={1}
            maxRows={10}
            aria-label="Nội dung tin nhắn"
            aria-autocomplete={slashOpen ? 'list' : undefined}
            aria-activedescendant={
              slashOpen ? `slash-opt-${slashMatches[slashIndex]?.id}` : undefined
            }
            placeholder="Nêu việc cho agent, hoặc gõ / để dùng prompt mẫu..."
              className="w-full resize-none bg-transparent pl-2 pr-4 pb-1 pt-3 font-mono text-[14px] leading-relaxed text-[#ebe7e4] outline-none placeholder:text-[#9fa4ab]"
          />
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            acceptFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="flex items-center gap-2 px-2 pb-2 pt-1">
          {/* Cụm TRÁI: đính kèm + thư mục + Tác vụ. Vùng chứa co được (min-w-0). */}
          <div className="flex min-w-0 grow shrink-0 items-center gap-0.5 sm:shrink">
            <ToolbarButton
              icon={Paperclip}
              label="Đính kèm tệp"
              onClick={() => fileInputRef.current?.click()}
            />
            {onPickWorkspace && (
              <ToolbarButton
                icon={pickPending ? Loader2 : FolderOpen}
                className={pickPending ? 'animate-spin' : undefined}
                active={workspace?.connected}
                label={
                  workspace?.connected
                    ? `Workspace: ${workspace.name}`
                    : 'Kết nối thư mục làm việc'
                }
                onClick={handlePickWorkspace}
              />
            )}
          </div>

          <div className="flex flex-none items-center gap-1.5">
            <TaskMenu groups={taskGroups} />
            <div className="hidden h-4 w-px flex-none bg-[#495059] sm:block" />
            <SendButton
              isStreaming={isStreaming}
              canSubmit={canSubmit}
              onStop={onStop}
            />
          </div>
        </div>
      </form>
        <div className="mt-1.5 px-2 font-mono text-[10.5px] text-[#9fa4ab]">
          Enter để gửi · Shift+Enter xuống dòng · Enter/Alt+Enter khi AI chạy = xếp hàng · Alt+↑ lấy lại · / lệnh nhanh
        </div>
    </div>
  );
});
