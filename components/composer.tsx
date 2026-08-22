'use client';

import React, { useRef } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { ArrowUp, Paperclip, Square, X, CornerDownLeft } from 'lucide-react';
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
  onAddFiles: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
  canContinue?: boolean;
  onContinue?: () => void;
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
  models,
  model,
  onModelChange,
  canContinue,
  onContinue,
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <div className="w-full bg-gradient-to-t from-[#0f0f10] via-[#0f0f10] to-transparent px-4 pb-4 pt-2 pb-safe">
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

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-zinc-700/50 bg-[#1e1e22] shadow-lg focus-within:border-zinc-600"
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
            onKeyDown={onKeyDown}
            minRows={1}
            maxRows={10}
            placeholder="Gửi tin nhắn cho AI..."
            className="w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-[15px] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500"
          />

          {/* Bottom toolbar */}
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
                  onAddFiles(e.target.files);
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
                disabled={!hasContent}
                aria-label="Gửi tin nhắn"
                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                  hasContent
                    ? 'bg-[#c96442] text-white hover:bg-[#b5573a]'
                    : 'cursor-not-allowed bg-zinc-700/60 text-zinc-500'
                }`}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </form>

        <p className="mt-2 text-center text-[11px] text-zinc-600">
          AI có thể mắc lỗi. Hãy kiểm chứng thông tin quan trọng.
        </p>
      </div>
    </div>
  );
}
