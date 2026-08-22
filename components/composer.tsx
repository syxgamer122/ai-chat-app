'use client';

import React, { useCallback, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, CornerDownLeft, Paperclip, Square, X } from 'lucide-react';
import { ModelSelector, type ModelOption } from '@/components/model-selector';

export interface Attachment {
  id: string;
  name: string;
  size?: number;
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
  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
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
  models,
  model,
  onModelChange,
  canContinue,
  onContinue,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

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
      onKeyDown(e);
    },
    [onKeyDown],
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
    <div
      className="w-full bg-gradient-to-t from-[#0f0f10] via-[#0f0f10] to-transparent px-4 pt-2"
      style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto w-full max-w-3xl">
        {canContinue && !isStreaming && (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={onContinue}
              className="flex items-center gap-1.5 rounded-full border border-zinc-700/60 bg-[#1e1e22] px-3 py-1.5 text-[12px] text-zinc-300 hover:bg-zinc-800"
            >
              <CornerDownLeft size={12} />
              Viết tiếp
            </button>
          </div>
        )}

        {fileError && (
          <div role="status" className="mb-2 text-center text-[12px] text-amber-400/90">
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
          className={`rounded-2xl border bg-[#1e1e22] shadow-lg transition-colors focus-within:border-zinc-600 ${
            dragging ? 'border-[#c96442]' : 'border-zinc-700/50'
          }`}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="flex max-w-[220px] items-center gap-1.5 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-2 py-1 text-[11px] text-zinc-300"
                >
                  <Paperclip size={11} className="flex-shrink-0 text-zinc-500" />
                  <span className="truncate">{a.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(a.id)}
                    aria-label={`Gỡ ${a.name}`}
                    className="text-zinc-500 hover:text-zinc-200"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
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
            placeholder="Gửi tin nhắn cho AI..."
            className="w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500"
          />

          <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Đính kèm tệp"
                title="Đính kèm tệp"
                className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800/70 hover:text-zinc-200"
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
                className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-700 text-zinc-100 hover:bg-zinc-600"
              >
                <Square size={13} className="fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                aria-label="Gửi tin nhắn"
                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                  canSubmit
                    ? 'bg-[#c96442] text-white hover:bg-[#b5573a]'
                    : 'cursor-not-allowed bg-zinc-700/60 text-zinc-500'
                }`}
              >
                <ArrowUp size={16} />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}