'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  ArrowUp,
  BookmarkPlus,
  Check,
  CornerDownLeft,
  FileText,
  Film,
  FolderOpen,
  FolderX,
  Globe,
  ImagePlus,
  Mic,
  MoreHorizontal,
  Network,
  Paperclip,
  Pencil,
  Square,
  X,
} from 'lucide-react';
import { ModelSelector, type ModelOption } from '@/components/model-selector';
import { ThinkingSlider } from '@/components/thinking-slider';
import { MorphIcon, SiriWave, TextShimmer, useHaptics } from '@/components/effects';
import { motion, AnimatePresence } from 'framer-motion';
import type { ThinkingLevel } from '@/lib/provider-url';
import { useSpeechRecognition } from '@/lib/use-speech-recognition';
import { filterPrompts } from '@/lib/prompt-library';

export interface Attachment {
  id: string;
  name: string;
  size?: number;
}

export interface SlashPrompt {
  id: string;
  title: string;
  content: string;
}

export interface MediaAction {
  modelId: string;
  label: string;
  direct: boolean;
}

export interface MediaActions {
  image?: MediaAction;
  video?: MediaAction;
}

interface ComposerProps {
  input: string;
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  isStreaming: boolean;
  onStop: () => void;
  attachments: Attachment[];
  onAddFiles: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (id: string) => void;
  onAppendText?: (text: string) => void;
  slashPrompts?: SlashPrompt[];
  onApplyPrompt?: (content: string) => void;
  onSavePrompt?: (title: string, content: string) => void | Promise<void>;
  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
  thinkingLevel?: ThinkingLevel;
  thinkingSupportedLevels?: ThinkingLevel[] | null;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  mediaActions?: MediaActions;
  onGenerateMedia?: (action: MediaAction, kind: 'image' | 'video') => void;
  webSearch?: boolean;
  onToggleWebSearch?: () => void;
  agentMode?: 'plan' | 'act';
  onToggleAgentMode?: () => void;
  stagedFileCount?: number;
  onOpenStaging?: () => void;
  /** Orchestrator: panel quét tham số đang mở? */
  orchestratorOpen?: boolean;
  onOpenOrchestrator?: () => void;
  webBusy?: boolean;
  workspace?: { connected: boolean; name: string | null };
  onPickWorkspace?: () => void;
  onDisconnectWorkspace?: () => void;
  canContinue?: boolean;
  onContinue?: () => void;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

function ToolbarButton({
  icon: Icon,
  active,
  disabled,
  onClick,
  label,
  badge,
  className,
  ariaExpanded,
}: {
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  badge?: string;
  className?: string;
  ariaExpanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-expanded={ariaExpanded}
      title={label}
      className={`relative flex h-10 w-10 flex-none sm:h-8 sm:w-8 items-center justify-center rounded-lg transition-all duration-150 ${
        active
          ? 'bg-emerald-500/20 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.3)]'
          : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'
      } disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ''}`}
    >
      <Icon size={16} />
      {badge && (
        <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-brand px-0.5 text-[9px] font-bold text-white">
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
      className={`flex h-10 w-10 flex-none sm:h-8 sm:w-8 items-center justify-center rounded-lg transition-all duration-150 ${
        isStreaming
          ? 'bg-slate-700 text-slate-200 hover:bg-slate-600'
          : canSubmit
            ? 'bg-emerald-600 text-white shadow-[0_0_12px_rgba(16,185,129,0.3)] hover:bg-emerald-500 active:scale-95'
            : 'bg-white/5 text-slate-600'
      }`}
    >
      <MorphIcon active={isStreaming} inactive={<ArrowUp size={16} strokeWidth={2.5} />}>
        <Square size={12} className="fill-current" />
      </MorphIcon>
    </button>
  );
}

/**
 * Mô tả một nút công cụ trên thanh dưới khung nhập.
 *
 * `primary: true` = luôn hiện thẳng trên thanh (kể cả mobile). Các nút còn lại
 * vẫn hiện thẳng từ `sm` trở lên, nhưng bị gom vào menu "⋯" trên mobile — nếu
 * không, 10 nút × 40px = 400px sẽ đẩy cụm [model][gửi] ra khỏi thanh trên màn
 * hình 375px.
 */
interface ToolSpec {
  key: string;
  icon: React.ElementType;
  /** Nhãn đầy đủ — dùng cho tooltip/aria và làm dự phòng trong menu. */
  label: string;
  /**
   * Nhãn gọn dùng trong menu "⋯". Label gốc nhiều nút viết theo dạng hành động
   * ("Tắt tìm kiếm web", "Chuyển sang ACT mode") nên không hợp để liệt kê.
   */
  shortLabel?: string;
  active?: boolean;
  disabled?: boolean;
  badge?: string;
  onClick: () => void;
  primary?: boolean;
}

/**
 * Menu "⋯" chứa các công cụ không đủ chỗ trên mobile.
 * Chỉ render ở kích thước < sm (`sm:hidden`); từ sm trở lên các nút này hiện
 * thẳng trên thanh.
 */
function OverflowMenu({ tools }: { tools: ToolSpec[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  const activeCount = tools.filter((t) => t.active).length;

  return (
    <div ref={wrapRef} className="relative sm:hidden">
      <ToolbarButton
        icon={open ? X : MoreHorizontal}
        active={activeCount > 0}
        onClick={() => setOpen((v) => !v)}
        label="Công cụ khác"
        badge={activeCount > 1 ? String(activeCount) : undefined}
        ariaExpanded={open}
      />
      {open && (
        <div
          role="menu"
          aria-label="Công cụ khác"
          className="surface-panel absolute bottom-full left-0 z-40 mb-2 w-[min(15rem,calc(100vw-2rem))] animate-slide-up overflow-hidden p-1.5"
        >
          {tools.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                type="button"
                role="menuitem"
                disabled={t.disabled}
                onClick={() => {
                  t.onClick();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon
                  size={15}
                  className={`flex-none ${t.active ? 'text-emerald-400' : 'text-slate-400'}`}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">
                  {t.shortLabel ?? t.label}
                </span>
                {t.badge && (
                  <span className="flex-none rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">
                    {t.badge}
                  </span>
                )}
                {t.active && !t.badge && (
                  <Check size={13} className="flex-none text-emerald-400" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Composer({
  input,
  onInputChange,
  onSubmit,
  onKeyDown,
  isStreaming,
  onStop,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  onAppendText,
  slashPrompts,
  onApplyPrompt,
  onSavePrompt,
  models,
  model,
  onModelChange,
  thinkingLevel,
  thinkingSupportedLevels,
  onThinkingLevelChange,
  mediaActions,
  onGenerateMedia,
  webSearch,
  onToggleWebSearch,
  agentMode,
  onToggleAgentMode,
  stagedFileCount,
  onOpenStaging,
  /**
   * Orchestrator: mở panel quét tham số — chạy N agent theo N cấu hình khác
   * nhau rồi tổng hợp. Không thay đổi luồng gửi tin nhắn.
   */
  orchestratorOpen,
  onOpenOrchestrator,
  webBusy,
  workspace,
  onPickWorkspace,
  onDisconnectWorkspace,
  canContinue,
  onContinue,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const voice = useSpeechRecognition({
    lang: 'vi-VN',
    onFinalText: useCallback(
      (text: string) => {
        onAppendText?.(text);
      },
      [onAppendText],
    ),
  });

  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const slashQuery =
    input.startsWith('/') && !input.includes('\n') ? input.slice(1) : null;

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
      onApplyPrompt?.(prompt.content);
      setSlashDismissed(true);
    },
    [onApplyPrompt],
  );

  const quickSavePrompt = useCallback(async () => {
    if (!onSavePrompt || input.length <= 1) return;
    const title = (slashQuery ?? '').trim() || `Prompt ${new Date().toLocaleDateString('vi-VN')}`;
    await onSavePrompt(title.slice(0, 80), input);
    setSlashDismissed(true);
  }, [input, onSavePrompt, slashQuery]);

  const hasContent = input.trim().length > 0 || attachments.length > 0;
  const canSubmit = hasContent && !isStreaming;
  const canGenerateMedia = Boolean(onGenerateMedia) && input.trim().length > 0 && !isStreaming;

  const startMedia = useCallback(
    (action: MediaAction | undefined, kind: 'image' | 'video') => {
      if (!action || !onGenerateMedia || !canGenerateMedia) return;
      onGenerateMedia(action, kind);
    },
    [canGenerateMedia, onGenerateMedia],
  );

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

      onKeyDown(e);
    },
    [slashOpen, slashMatches, slashIndex, applyPrompt, onKeyDown],
  );

  const haptics = useHaptics();
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      if (!canSubmit) {
        e.preventDefault();
        return;
      }
      haptics.trigger('light');
      onSubmit(e);
    },
    [canSubmit, onSubmit, haptics],
  );

  /**
   * Danh sách công cụ — khai báo thành data (thay vì JSX rải rác) để có thể
   * render 2 lần: hiện thẳng trên thanh, và gom vào menu "⋯" trên mobile.
   * Thứ tự trong mảng = thứ tự trong menu.
   */
  const tools: ToolSpec[] = [
    {
      key: 'attach',
      icon: Paperclip,
      label: 'Đính kèm tệp',
      onClick: () => fileInputRef.current?.click(),
      primary: true,
    },
  ];

  if (voice.supported) {
    tools.push({
      key: 'voice',
      icon: voice.listening ? Square : Mic,
      active: voice.listening,
      label: voice.listening ? 'Dừng nhận diện giọng nói' : 'Nhập bằng giọng nói',
      shortLabel: voice.listening ? 'Dừng ghi âm' : 'Giọng nói',
      onClick: () => {
        voice.clearError();
        voice.toggle();
      },
      primary: true,
    });
  }

  if (onToggleWebSearch) {
    tools.push({
      key: 'web',
      icon: Globe,
      active: webSearch,
      disabled: isStreaming,
      label: webSearch ? 'Tắt tìm kiếm web' : 'Bật tìm kiếm web',
      shortLabel: 'Tìm kiếm web',
      onClick: onToggleWebSearch,
    });
  }

  if (onToggleAgentMode) {
    tools.push({
      key: 'agent-mode',
      icon: Pencil,
      active: agentMode === 'plan',
      disabled: isStreaming,
      label: agentMode === 'plan' ? 'Chuyển sang ACT mode' : 'Chuyển sang PLAN mode',
      shortLabel: 'PLAN mode',
      onClick: onToggleAgentMode,
    });
  }

  if (onOpenOrchestrator) {
    tools.push({
      key: 'orchestrator',
      icon: Network,
      active: orchestratorOpen,
      label: 'Orchestrator — chạy nhiều agent theo lưới tham số rồi tổng hợp',
      shortLabel: 'Orchestrator',
      onClick: onOpenOrchestrator,
    });
  }

  if (onPickWorkspace) {
    tools.push({
      key: 'workspace',
      icon: FolderOpen,
      active: workspace?.connected,
      label: workspace?.connected ? `Workspace: ${workspace.name}` : 'Kết nối thư mục làm việc',
      shortLabel: 'Thư mục làm việc',
      onClick: onPickWorkspace,
    });
  }

  if (onDisconnectWorkspace && workspace?.connected) {
    tools.push({
      key: 'workspace-disconnect',
      icon: FolderX,
      disabled: isStreaming,
      label: `Ngắt kết nối: ${workspace.name ?? 'workspace'}`,
      shortLabel: 'Ngắt thư mục làm việc',
      onClick: onDisconnectWorkspace,
    });
  }

  if (onOpenStaging && (stagedFileCount ?? 0) > 0) {
    tools.push({
      key: 'staging',
      icon: FileText,
      label: `${stagedFileCount} file đang staged`,
      shortLabel: 'File đã staged',
      badge: String(stagedFileCount),
      onClick: onOpenStaging,
    });
  }

  if (mediaActions?.image) {
    tools.push({
      key: 'image',
      icon: ImagePlus,
      disabled: !canGenerateMedia,
      label: `Tạo ảnh bằng ${mediaActions.image.label}`,
      shortLabel: 'Tạo ảnh',
      onClick: () => startMedia(mediaActions.image, 'image'),
    });
  }

  if (mediaActions?.video) {
    tools.push({
      key: 'video',
      icon: Film,
      disabled: !canGenerateMedia,
      label: `Tạo video bằng ${mediaActions.video.label}`,
      shortLabel: 'Tạo video',
      onClick: () => startMedia(mediaActions.video, 'video'),
    });
  }

  const primaryTools = tools.filter((t) => t.primary);
  const overflowTools = tools.filter((t) => !t.primary);

  return (
    <div className="pb-composer w-full px-4 pt-3">
      <div className="mx-auto w-full max-w-thread">
        {canContinue && !isStreaming && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              onClick={onContinue}
              className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[12px] font-medium text-slate-300 backdrop-blur-sm transition-all hover:bg-white/10 hover:text-white"
            >
              <CornerDownLeft size={12} />
              Viết tiếp
            </button>
          </div>
        )}

        <AnimatePresence>
          {fileError && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              role="status"
              className="notice-warn mb-2 text-center"
            >
              {fileError}
            </motion.div>
          )}
        </AnimatePresence>

        <form
          onSubmit={handleSubmit}
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
          className={`group relative rounded-2xl border border-white/10 bg-slate-800/50 shadow-[0_0_15px_rgba(16,185,129,0.1)] backdrop-blur-lg transition-all duration-200 focus-within:border-emerald-500/30 focus-within:shadow-[0_0_20px_rgba(16,185,129,0.15)] ${
            dragging ? 'border-emerald-500/40 ring-2 ring-emerald-500/10' : ''
          }`}
        >
          {slashOpen && (
            <div
              role="listbox"
              aria-label="Danh sách prompt"
              className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
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
                  className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-3 py-2 text-left transition-colors ${
                    i === slashIndex ? 'bg-zinc-100 dark:bg-zinc-900' : ''
                  }`}
                >
                  <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100">{p.title}</span>
                  <span className="line-clamp-1 w-full text-[11px] text-zinc-500 dark:text-zinc-400">
                    {p.content.replace(/\n+/g, ' ').trim()}
                  </span>
                </button>
              ))}
              {onSavePrompt && input.length > 1 && (
                <button
                  type="button"
                  onClick={() => void quickSavePrompt()}
                  className="flex w-full items-center gap-1.5 border-t border-zinc-100 px-3 py-2 text-left text-[12px] text-zinc-600 transition-colors hover:text-zinc-900 dark:border-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  <BookmarkPlus size={13} />
                  Lưu nhanh &quot;/{slashQuery}&quot; làm mẫu
                </button>
              )}
            </div>
          )}

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((a) => (
                <motion.span
                  key={a.id}
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  className="flex max-w-[200px] items-center gap-1.5 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  <Paperclip size={10} className="flex-shrink-0 text-zinc-400" />
                  <span className="truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    aria-label={`Gỡ ${a.name}`}
                    className="ml-0.5 rounded p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    <X size={10} />
                  </button>
                </motion.span>
              ))}
            </div>
          )}

          {(voice.listening || voice.error || webBusy) && (
            <div className="flex items-center gap-3 px-4 pt-3 text-[12px] leading-relaxed">
              {webBusy && (
                <span className="flex min-w-0 items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-brand" />
                  <TextShimmer text="Đang tra cứu web…" className="truncate" />
                </span>
              )}
              {voice.listening && (
                <span className="flex min-w-0 items-center gap-2 text-zinc-500 dark:text-zinc-400">
                  <SiriWave active />
                  <span className="truncate">
                    {voice.interim || 'Đang nghe… nói tiếng Việt nhé'}
                  </span>
                </span>
              )}
              {voice.error && (
                <span role="alert" className="text-amber-600 dark:text-amber-400">
                  {voice.error}
                </span>
              )}
            </div>
          )}

          <TextareaAutosize
            value={input}
            onChange={onInputChange}
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
            placeholder="Nhắn tin cho AI..."
            className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[16px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500 sm:text-[15px]"
          />

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

          <div className="flex items-center gap-2 px-2 pb-safe-2 pt-1">
            {/*
             * Cụm TRÁI (công cụ). Hai lớp bảo vệ để cụm phải không bao giờ bị
             * đẩy ra khỏi thanh:
             *  1. Vùng chứa nút là scroll container (`overflow-x-auto` +
             *     `min-w-0`) → có thể co về 0 và cuộn ngang thay vì tràn.
             *  2. Các công cụ phụ gom vào menu "⋯" trên mobile → cụm trái chỉ
             *     còn 2–3 nút, hiếm khi phải cuộn.
             * Dùng `grow` (basis auto) chứ không dùng `flex-1` (basis 0%):
             * với basis 0 cụm này không báo kích thước nội dung, nên khi thiếu
             * chỗ nó co về 0 và dồn toàn bộ phần thiếu hụt sang bên phải.
             */}
            <div className="flex min-w-0 grow shrink-0 items-center gap-0.5 sm:shrink">
              <div className="no-scrollbar -mx-0.5 -my-1 flex min-w-0 grow items-center gap-0.5 overflow-x-auto overscroll-x-contain px-0.5 py-1">
                {primaryTools.map((t) => (
                  <ToolbarButton
                    key={t.key}
                    icon={t.icon}
                    label={t.label}
                    active={t.active}
                    disabled={t.disabled}
                    badge={t.badge}
                    onClick={t.onClick}
                  />
                ))}
                {overflowTools.map((t) => (
                  <ToolbarButton
                    key={t.key}
                    icon={t.icon}
                    label={t.label}
                    active={t.active}
                    disabled={t.disabled}
                    badge={t.badge}
                    onClick={t.onClick}
                    className="hidden sm:flex"
                  />
                ))}
              </div>

              {overflowTools.length > 0 && <OverflowMenu tools={overflowTools} />}
            </div>

            {/*
             * Cụm PHẢI (mức suy luận + model + gửi). Không có `shrink-0` ở đây:
             * cụm được phép co lại (nhãn model tự truncate) nhưng nút gửi và
             * thanh suy luận thì không — vậy chúng luôn nằm trong thanh.
             */}
            <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              {thinkingLevel && onThinkingLevelChange && (
                <div className="flex-none">
                  <ThinkingSlider
                    value={thinkingLevel}
                    onChange={onThinkingLevelChange}
                    disabled={isStreaming}
                    supportedLevels={thinkingSupportedLevels}
                  />
                </div>
              )}
              <ModelSelector
                models={models}
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
              />
              <div className="hidden h-4 w-px flex-none bg-white/10 sm:block" />
              <SendButton
                isStreaming={isStreaming}
                canSubmit={canSubmit}
                onStop={onStop}
              />
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
