'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, BookmarkPlus, CornerDownLeft, Mic, Paperclip, Square, X } from 'lucide-react';
import { ModelSelector, type ModelOption } from '@/components/model-selector';
import { ThinkingSlider } from '@/components/thinking-slider';
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
  /** Nhận đoạn text hoàn chỉnh từ voice input — nối vào cuối input hiện tại. */
  onAppendText?: (text: string) => void;
  /** Thư viện prompt: gõ "/" để mở menu, chọn sẽ thay toàn bộ input. */
  slashPrompts?: SlashPrompt[];
  onApplyPrompt?: (content: string) => void;
  /** Lưu nhanh prompt mới từ nội dung đang gõ. */
  onSavePrompt?: (title: string, content: string) => void | Promise<void>;
  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
  /** Mức suy luận — chỉ hiển thị khi provider hiện tại hỗ trợ (crax). */
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  canContinue?: boolean;
  onContinue?: () => void;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

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
  onThinkingLevelChange,
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

  /* ---------------- Slash menu "/" ---------------- */
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

  // Đổi từ khoá → reset highlight + mở lại menu nếu từng đóng.
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

  /** Guard IME: Enter khi đang compose là xác nhận ký tự, không phải gửi. */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
      if (composingRef.current || native.isComposing || native.keyCode === 229) {
        if (e.key === 'Enter') e.stopPropagation();
        return;
      }

      // Slash menu: điều hướng/phím tắt ăn trước hành vi mặc định của textarea.
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

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      if (!canSubmit) {
        e.preventDefault();
        return;
      }
      onSubmit(e);
    },
    [canSubmit, onSubmit],
  );

  return (
    <div className="pb-composer w-full bg-gradient-to-t from-surface via-surface to-transparent px-4 pt-2">
      <div className="mx-auto w-full max-w-thread">
        {canContinue && !isStreaming && (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={onContinue}
              className="flex items-center gap-1.5 rounded-full border border-zinc-300/60 bg-surface-raised px-3 py-1.5 text-[12px] text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <CornerDownLeft size={12} />
              Viết tiếp
            </button>
          </div>
        )}

        {fileError && (
          <div role="status" className="notice-warn mb-2 text-center">
            {fileError}
          </div>
        )}

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
          className={`relative rounded-2xl border bg-surface-raised shadow-panel transition-all duration-150 focus-within:border-brand/50 focus-within:shadow-[0_0_0_3px_rgb(var(--brand)/0.10),0_12px_32px_-16px_rgb(15_23_42/0.18)] ${
            dragging ? 'border-brand' : 'border-zinc-300/60'
          }`}
        >
          {slashOpen && (
            <div
              role="listbox"
              aria-label="Danh sách prompt"
              className="surface-panel absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 animate-slide-up overflow-y-auto py-1"
              // Giữ focus textarea khi click vào menu
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
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${
                    i === slashIndex ? 'bg-zinc-100' : ''
                  }`}
                >
                  <span className="text-[13px] font-medium text-zinc-800">{p.title}</span>
                  <span className="line-clamp-1 w-full text-[11px] text-zinc-500">
                    {p.content.replace(/\n+/g, ' ').trim()}
                  </span>
                </button>
              ))}
              {onSavePrompt && input.length > 1 && (
                <button
                  type="button"
                  onClick={() => void quickSavePrompt()}
                  className="flex w-full items-center gap-1.5 border-t border-zinc-200 px-3 py-2 text-left text-[12px] text-zinc-600 transition hover:text-zinc-900"
                >
                  <BookmarkPlus size={13} />
                  Lưu nhanh &quot;/{slashQuery}&quot; làm mẫu
                </button>
              )}
            </div>
          )}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-zinc-300/60 bg-surface-muted px-2 py-1 text-[11px] text-zinc-700"
                >
                  <Paperclip size={11} className="flex-shrink-0 text-zinc-500" />
                  <span className="truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    aria-label={`Gỡ ${a.name}`}
                    className="text-zinc-500 transition-colors hover:text-zinc-900"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {(voice.listening || voice.error) && (
            <div className="flex items-center gap-2 px-4 pt-3 text-[12px] leading-relaxed">
              {voice.listening && (
                <span className="flex min-w-0 items-center gap-1.5 text-zinc-600">
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-brand" />
                  <span className="truncate">
                    {voice.interim || 'Đang nghe… nói tiếng Việt nhé'}
                  </span>
                </span>
              )}
              {voice.error && (
                <span role="alert" className="text-amber-700">
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
            placeholder="Gửi tin nhắn cho AI... (gõ / để chèn prompt mẫu)"
            className="w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400"
          />

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Đính kèm tệp"
                title="Đính kèm tệp"
                className="icon-btn h-9 w-9 rounded-full"
              >
                <Paperclip size={16} />
              </button>
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
                <button
                  type="button"
                  onClick={() => {
                    voice.clearError();
                    voice.toggle();
                  }}
                  aria-label={voice.listening ? 'Dừng nhận diện giọng nói' : 'Nhập bằng giọng nói'}
                  aria-pressed={voice.listening}
                  title={voice.listening ? 'Dừng nhận diện giọng nói' : 'Nhập bằng giọng nói'}
                  className={
                    voice.listening
                      ? 'flex h-9 w-9 items-center justify-center rounded-full bg-brand text-white transition-colors'
                      : 'icon-btn h-9 w-9 rounded-full'
                  }
                >
                  {voice.listening ? (
                    <Square size={11} className="animate-pulse fill-current" />
                  ) : (
                    <Mic size={16} />
                  )}
                </button>
              )}
              {thinkingLevel && onThinkingLevelChange && (
                <ThinkingSlider
                  value={thinkingLevel}
                  onChange={onThinkingLevelChange}
                  disabled={isStreaming}
                />
              )}
              <ModelSelector
                models={models}
                value={model}
                onChange={onModelChange}
                disabled={isStreaming}
              />
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Dừng tạo"
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-zinc-800 text-white transition hover:bg-zinc-900"
              >
                <Square size={13} className="fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                aria-label="Gửi tin nhắn"
                className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-all ${
                  canSubmit
                    ? 'bg-brand text-white shadow-brand hover:bg-brand-hover active:scale-95'
                    : 'cursor-not-allowed bg-zinc-200 text-zinc-400'
                }`}
              >
                <ArrowUp size={17} />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}