'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import {
  ArrowUp,
  BookmarkPlus,
  CornerDownLeft,
  FileText,
  Film,
  FolderOpen,
  FolderX,
  Globe,
  ImagePlus,
  Mic,
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
}: {
  icon: React.ElementType;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`relative flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg transition-all duration-150 ${
        active
          ? 'bg-emerald-500/20 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.3)]'
          : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'
      } disabled:cursor-not-allowed disabled:opacity-40`}
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
      className={`flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center rounded-lg transition-all duration-150 ${
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
            className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-500"
          />

          <div className="flex items-center justify-between gap-2 px-2 pb-2 pb-safe-2 pt-1">
            <div className="flex items-center gap-0.5">
              <ToolbarButton
                icon={Paperclip}
                onClick={() => fileInputRef.current?.click()}
                label="Đính kèm tệp"
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

              {voice.supported && (
                <ToolbarButton
                  icon={voice.listening ? Square : Mic}
                  active={voice.listening}
                  onClick={() => {
                    voice.clearError();
                    voice.toggle();
                  }}
                  label={voice.listening ? 'Dừng nhận diện giọng nói' : 'Nhập bằng giọng nói'}
                />
              )}

              {onPickWorkspace && (
                <ToolbarButton
                  icon={FolderOpen}
                  active={workspace?.connected}
                  onClick={onPickWorkspace}
                  label={workspace?.connected ? `Workspace: ${workspace.name}` : 'Kết nối thư mục làm việc'}
                />
              )}

              {onDisconnectWorkspace && workspace?.connected && (
                <ToolbarButton
                  icon={FolderX}
                  disabled={isStreaming}
                  onClick={onDisconnectWorkspace}
                  label={`Ngắt kết nối: ${workspace.name ?? 'workspace'}`}
                />
              )}

              {onToggleWebSearch && (
                <ToolbarButton
                  icon={Globe}
                  active={webSearch}
                  disabled={isStreaming}
                  onClick={onToggleWebSearch}
                  label={webSearch ? 'Tắt tìm kiếm web' : 'Bật tìm kiếm web'}
                />
              )}

              {onToggleAgentMode && (
                <ToolbarButton
                  icon={Pencil}
                  active={agentMode === 'plan'}
                  disabled={isStreaming}
                  onClick={onToggleAgentMode}
                  label={agentMode === 'plan' ? 'Chuyển sang ACT mode' : 'Chuyển sang PLAN mode'}
                />
              )}

              {onOpenOrchestrator && (
                <ToolbarButton
                  icon={Network}
                  active={orchestratorOpen}
                  onClick={onOpenOrchestrator}
                  label="Orchestrator — chạy nhiều agent theo lưới tham số rồi tổng hợp"
                />
              )}

              {onOpenStaging && (stagedFileCount ?? 0) > 0 && (
                <ToolbarButton
                  icon={FileText}
                  onClick={onOpenStaging}
                  label={`${stagedFileCount} file đang staged`}
                  badge={String(stagedFileCount)}
                />
              )}

              {mediaActions?.image && (
                <ToolbarButton
                  icon={ImagePlus}
                  disabled={!canGenerateMedia}
                  onClick={() => startMedia(mediaActions.image, 'image')}
                  label={`Tạo ảnh bằng ${mediaActions.image.label}`}
                />
              )}

              {mediaActions?.video && (
                <ToolbarButton
                  icon={Film}
                  disabled={!canGenerateMedia}
                  onClick={() => startMedia(mediaActions.video, 'video')}
                  label={`Tạo video bằng ${mediaActions.video.label}`}
                />
              )}
            </div>

            <div className="flex items-center gap-2">
              {thinkingLevel && onThinkingLevelChange && (
                <ThinkingSlider
                  value={thinkingLevel}
                  onChange={onThinkingLevelChange}
                  disabled={isStreaming}
                  supportedLevels={thinkingSupportedLevels}
                />
              )}
              <ModelSelector
                models={models}
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
              />
              <div className="h-4 w-px bg-white/10" />
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
