'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat, type Message } from 'ai/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useAppStore } from '@/lib/store';
import { db, Dexie, type StoredMessage, type StoredAttachment } from '@/lib/db';
import {
  reconstructActiveThread,
  getSiblings,
  findDeepestLeafId,
  type SiblingResult,
} from '@/lib/tree-utils';
import { MarkdownRenderer } from './markdown-renderer';
import { ErrorBoundary } from './error-boundary';
import { motion } from 'framer-motion';
import TextareaAutosize from 'react-textarea-autosize';
import {
  Send, StopCircle, RefreshCcw, ArrowDown, Paperclip, X,
  Pencil, Copy, Check, Trash2, Menu,
  ChevronLeft, ChevronRight,
} from 'lucide-react';

const attachmentCache = new WeakMap<object, StoredAttachment>();

async function toStoredAttachment(a: any): Promise<StoredAttachment> {
  if (typeof a === 'object' && a !== null && attachmentCache.has(a)) {
    return attachmentCache.get(a)!;
  }

  const name = a.name ?? 'file';
  const contentType = a.contentType ?? '';

  let stored: StoredAttachment;

  if (a.blob instanceof Blob) {
    stored = {
      name,
      contentType: contentType || a.blob.type,
      blob: a.blob,
    };
  } else {
    const url = typeof a.url === 'string' ? a.url : '';

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        stored = {
          name,
          contentType: contentType || blob.type,
          blob,
        };
      } catch {
        stored = { name, contentType };
      }
    } else if (/^https?:\/\//i.test(url)) {
      stored = { name, contentType, url };
    } else {
      stored = { name, contentType };
    }
  }

  if (typeof a === 'object' && a !== null) {
    attachmentCache.set(a, stored);
  }
  return stored;
}

async function getStoredAttachments(
  message: Message,
): Promise<StoredAttachment[] | undefined> {
  const rawAttachments =
    message.experimental_attachments as
      | any[]
      | undefined;

  if (
    !rawAttachments ||
    rawAttachments.length === 0
  ) {
    return undefined;
  }

  return Promise.all(
    rawAttachments.map(toStoredAttachment),
  );
}

function getMessageCreatedAt(
  message: Message,
  fallback: number,
): number {
  if (typeof message.createdAt === 'number') {
    return message.createdAt;
  }

  if (message.createdAt instanceof Date) {
    return message.createdAt.getTime();
  }

  return fallback;
}

function revokeObjectUrls(urls: Set<string>) {
  for (const url of urls) {
    URL.revokeObjectURL(url);
  }
  urls.clear();
}

function createAttachmentUrl(attachment: StoredAttachment, urls: Set<string>): string {
  if (attachment.blob) {
    const url = URL.createObjectURL(attachment.blob);
    urls.add(url);
    return url;
  }
  return attachment.url ?? '';
}

function toChatMessage(
  row: StoredMessage,
  objectUrls: Set<string>,
): Message {
  return {
    id: row.id,
    role: row.role as Message['role'],
    content: row.content,
    experimental_attachments: row.attachments?.map(
      (attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        url: createAttachmentUrl(
          attachment,
          objectUrls,
        ),
      }),
    ) as any,
  };
}

function getNextBranchOrder(
  allMessages: StoredMessage[],
  parentId: string | null,
): number {
  let maxBranchOrder = -1;

  for (const message of allMessages) {
    if (message.parentId !== parentId) {
      continue;
    }

    const order =
      typeof message.branchOrder === 'number'
        ? message.branchOrder
        : 0;

    if (order > maxBranchOrder) {
      maxBranchOrder = order;
    }
  }

  return maxBranchOrder + 1;
}

function getNextSequence(
  allMessages: StoredMessage[],
): number {
  let maxSequence = -1;

  for (const message of allMessages) {
    if (
      typeof message.seq === 'number' &&
      Number.isFinite(message.seq) &&
      message.seq > maxSequence
    ) {
      maxSequence = message.seq;
    }
  }

  return maxSequence + 1;
}

function upsertStoredMessages(
  current: StoredMessage[],
  updates: StoredMessage[],
): StoredMessage[] {
  if (updates.length === 0) {
    return current;
  }

  const updateById = new Map(
    updates.map((message) => [
      message.id,
      message,
    ]),
  );

  const result = current.map(
    (message) =>
      updateById.get(message.id) ?? message,
  );

  const existingIds = new Set(
    current.map((message) => message.id),
  );

  for (const update of updates) {
    if (!existingIds.has(update.id)) {
      result.push(update);
    }
  }

  return result;
}

function reconstructParentPath(
  allMessages: StoredMessage[],
  parentId: string | null,
): StoredMessage[] {
  if (parentId === null) {
    return [];
  }

  return reconstructActiveThread(
    allMessages,
    parentId,
  );
}

function getFinalStoredStatus(
  finishReason: StoredMessage['finishReason'],
): StoredMessage['status'] {
  switch (finishReason) {
    case 'abort':
      return 'aborted';

    case 'error':
      return 'error';

    case 'stop':
    default:
      return 'complete';
  }
}

interface ReconcileResult {
  /**
   * Toàn bộ tree sau khi reconcile.
   */
  allRows: StoredMessage[];

  /**
   * Chỉ các row cần ghi vào IndexedDB.
   */
  changedRows: StoredMessage[];

  /**
   * Leaf mới nhất của active projection.
   */
  activeLeafId: string | null;

  /**
   * Assistant mới được phát hiện trong lần reconcile này.
   */
  createdAssistantId?: string;
}

function attachmentMetadataSignature(
  attachments:
    | StoredAttachment[]
    | undefined,
): string {
  if (!attachments?.length) {
    return '';
  }

  return attachments
    .map((attachment) =>
      [
        attachment.name,
        attachment.contentType,
        attachment.url ?? '',
        attachment.blob?.size ?? 0,
      ].join(':'),
    )
    .join('|');
}

function hasStoredMessageChanged(
  previous: StoredMessage,
  next: StoredMessage,
): boolean {
  return (
    previous.content !== next.content ||
    previous.status !== next.status ||
    previous.finishReason !==
      next.finishReason ||
    attachmentMetadataSignature(
      previous.attachments,
    ) !==
      attachmentMetadataSignature(
        next.attachments,
      )
  );
}

async function reconcileActiveMessages(
  chatId: string,
  visibleMessages: Message[],
  currentTree: StoredMessage[],
  pendingFork: PendingAssistantFork | null,
  isCurrentlyLoading: boolean,
  finishReason: StoredMessage['finishReason'],
): Promise<ReconcileResult> {
  if (visibleMessages.length === 0) {
    return {
      allRows: currentTree,
      changedRows: [],
      activeLeafId: null,
    };
  }

  /**
   * Map toàn bộ tree hiện tại để lookup O(1).
   */
  const rowById = new Map<string, StoredMessage>();

  for (const row of currentTree) {
    rowById.set(row.id, row);
  }

  /**
   * workingRows chứa cả dữ liệu cũ và node mới được phát hiện
   * trong cùng một lượt reconcile.
   */
  const workingRows = [...currentTree];
  const changedRows: StoredMessage[] = [];

  let nextSequence =
    getNextSequence(currentTree);

  let previousVisibleId: string | null = null;
  let createdAssistantId: string | undefined;

  for (
    let index = 0;
    index < visibleMessages.length;
    index++
  ) {
    const message = visibleMessages[index];
    const existing = rowById.get(message.id);

    const isLast =
      index === visibleMessages.length - 1;

    const isStreamingAssistant =
      isCurrentlyLoading &&
      isLast &&
      message.role === 'assistant';

    /**
     * Message đã tồn tại trong tree.
     */
    if (existing) {
      const nextFinishReason:
        StoredMessage['finishReason'] =
        isStreamingAssistant
          ? existing.finishReason
          : isLast &&
              message.role === 'assistant'
            ? finishReason ?? 'stop'
            : existing.finishReason ?? 'stop';

      const nextStatus:
        StoredMessage['status'] =
        isStreamingAssistant
          ? 'streaming'
          : isLast &&
              message.role === 'assistant'
            ? getFinalStoredStatus(
                nextFinishReason,
              )
            : existing.status ?? 'complete';

      const updated: StoredMessage = {
        ...existing,

        /**
         * Content có thể thay đổi từng token trong lúc stream.
         */
        content: message.content,

        /**
         * Không thay đổi:
         * - parentId
         * - seq
         * - branchOrder
         */
        finishReason: nextFinishReason,
        status: nextStatus,
      };

      if (
        hasStoredMessageChanged(
          existing,
          updated,
        )
      ) {
        changedRows.push(updated);
        rowById.set(updated.id, updated);

        const existingIndex =
          workingRows.findIndex(
            (row) => row.id === updated.id,
          );

        if (existingIndex >= 0) {
          workingRows[existingIndex] =
            updated;
        }
      }

      previousVisibleId = existing.id;
      continue;
    }

    /**
     * Message mới chưa tồn tại trong cây.
     */
    let parentId: string | null =
      previousVisibleId;

    let branchOrder: number;

    const isPendingForkAssistant =
      message.role === 'assistant' &&
      pendingFork !== null &&
      pendingFork.chatId === chatId &&
      !pendingFork.assistantMessageId &&
      previousVisibleId ===
        pendingFork.parentId;

    if (isPendingForkAssistant) {
      /**
       * Assistant được tạo bởi Edit hoặc Regenerate.
       * Metadata phải lấy từ reservation đã tạo trước reload().
       */
      parentId = pendingFork.parentId;
      branchOrder =
        pendingFork.branchOrder;

      createdAssistantId = message.id;
    } else {
      /**
       * Message bình thường nối vào message trước đó
       * trong active projection.
       */
      branchOrder = getNextBranchOrder(
        workingRows,
        parentId,
      );
    }

    const attachments =
      await getStoredAttachments(message);

    const now = Date.now();

    const newRow: StoredMessage = {
      id: message.id,
      chatId,
      role:
        message.role as StoredMessage['role'],
      content: message.content,

      parentId,

      seq: nextSequence++,

      createdAt: getMessageCreatedAt(
        message,
        now + index,
      ),

      attachments,

      branchOrder,

      finishReason:
        isStreamingAssistant
          ? undefined
          : isLast &&
              message.role === 'assistant'
            ? finishReason ?? 'stop'
            : 'stop',

      status:
        isStreamingAssistant
          ? 'streaming'
          : isLast &&
              message.role === 'assistant'
            ? getFinalStoredStatus(
                finishReason ?? 'stop',
              )
            : 'complete',
    };

    workingRows.push(newRow);
    changedRows.push(newRow);
    rowById.set(newRow.id, newRow);

    previousVisibleId = newRow.id;
  }

  return {
    allRows: workingRows,
    changedRows,
    activeLeafId:
      visibleMessages[
        visibleMessages.length - 1
      ]?.id ?? null,
    createdAssistantId,
  };
}

type AssistantForkSource =
  | 'edit'
  | 'regenerate';

interface PendingAssistantFork {
  chatId: string;

  /**
   * User message mà assistant mới sẽ trả lời.
   */
  parentId: string;

  /**
   * Thứ tự assistant mới trong nhóm siblings.
   */
  branchOrder: number;

  source: AssistantForkSource;

  /**
   * Khi useChat tạo assistant thực tế, lưu id tại đây.
   */
  assistantMessageId?: string;

  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Memoized Message Item                                              */
/* ------------------------------------------------------------------ */
interface BranchInfo {
  /**
   * Index zero-based của message hiện tại trong nhóm siblings.
   */
  currentIndex: number;

  /**
   * Tổng số siblings.
   */
  total: number;
}

interface BranchSwitcherProps {
  currentIndex: number;
  total: number;
  isTouchDevice: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

const BranchSwitcher = memo(function BranchSwitcher({
  currentIndex,
  total,
  isTouchDevice,
  disabled = false,
  onPrevious,
  onNext,
}: BranchSwitcherProps) {
  /**
   * Không hiển thị widget nếu message không có nhiều version.
   */
  if (total <= 1) {
    return null;
  }

  const isFirst = currentIndex <= 0;
  const isLast = currentIndex >= total - 1;

  return (
    <div
      role="group"
      aria-label={`Phiên bản ${currentIndex + 1} trên ${total}`}
      className={`mt-2 flex items-center gap-1 text-zinc-400 ${
        isTouchDevice ? 'min-h-8' : 'min-h-6'
      }`}
    >
      <button
        type="button"
        onClick={onPrevious}
        disabled={disabled || isFirst}
        aria-label="Chuyển sang phiên bản trước"
        title="Phiên bản trước"
        className={`inline-flex items-center justify-center rounded-md
          text-zinc-400 transition-colors
          hover:bg-black/10 hover:text-zinc-100
          dark:hover:bg-white/10
          disabled:pointer-events-none disabled:opacity-30
          ${
            isTouchDevice
              ? 'min-h-8 min-w-8'
              : 'min-h-6 min-w-6'
          }`}
      >
        <ChevronLeft size={15} strokeWidth={2} />
      </button>

      <span
        aria-live="polite"
        className="min-w-[42px] select-none text-center font-mono text-[11px]"
      >
        {currentIndex + 1} / {total}
      </span>

      <button
        type="button"
        onClick={onNext}
        disabled={disabled || isLast}
        aria-label="Chuyển sang phiên bản tiếp theo"
        title="Phiên bản tiếp theo"
        className={`inline-flex items-center justify-center rounded-md
          text-zinc-400 transition-colors
          hover:bg-black/10 hover:text-zinc-100
          dark:hover:bg-white/10
          disabled:pointer-events-none disabled:opacity-30
          ${
            isTouchDevice
              ? 'min-h-8 min-w-8'
              : 'min-h-6 min-w-6'
          }`}
      >
        <ChevronRight size={15} strokeWidth={2} />
      </button>
    </div>
  );
});

interface MessageItemProps {
  m: Message;

  /**
   * Thông tin branch của message đang hiển thị.
   * undefined nếu message không có siblings.
   */
  branchInfo?: BranchInfo;

  isStreaming: boolean;
  isEditing: boolean;
  isCopied: boolean;
  draft: string;
  isTouchDevice: boolean;
  sendOnEnter: boolean;
  throttleMs: number;
  animations: boolean;

  onCopy: (m: Message) => void;
  onRegenerate: (id: string) => void;
  onSwitchBranch: (
    messageId: string,
    direction: 'previous' | 'next',
  ) => void;
  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
}

const MessageItem = memo(
  function MessageItem({
    m,
    branchInfo,
    isStreaming,
    isEditing,
    isCopied,
    draft,
    isTouchDevice,
    sendOnEnter,
    throttleMs,
    animations,
    onCopy,
    onRegenerate,
    onSwitchBranch,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
    onDraftChange,
  }: MessageItemProps) {
    const shouldAnimate = animations && !isStreaming;

    return (
      <motion.div
        layout={false}
        initial={shouldAnimate ? { opacity: 0, y: 10 } : false}
        animate={shouldAnimate ? { opacity: 1, y: 0 } : false}
        transition={{ duration: shouldAnimate ? 0.2 : 0 }}
        style={{ contentVisibility: 'auto', containIntrinsicSize: '0 160px' }}
        className={`group flex w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
      >
        <div
          className={`relative max-w-[85%] rounded-2xl px-4 py-3 shadow-sm md:max-w-[75%] ${
            m.role === 'user'
              ? 'bg-blue-600 text-white rounded-br-none'
              : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100 rounded-bl-none border border-zinc-200/50 dark:border-zinc-700/50'
          }`}
        >
          {/* File Attachments */}
          {m.experimental_attachments && m.experimental_attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {m.experimental_attachments.map((att, idx) => (
                <div key={idx} className="relative overflow-hidden rounded-lg border border-black/10 dark:border-white/10">
                  {att.contentType?.startsWith('image/') ? (
                    <img
                      src={att.url}
                      alt={att.name ?? 'attachment'}
                      className="max-h-48 max-w-xs object-cover rounded-md"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex items-center gap-2 bg-black/5 p-2 text-xs dark:bg-white/5">
                      <Paperclip className="h-4 w-4" />
                      <span className="truncate max-w-[150px]">{att.name}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Nội dung tin nhắn / Chỉnh sửa */}
          {isEditing ? (
            <div className="flex flex-col gap-2 min-w-[240px]">
              <TextareaAutosize
                value={draft}
                onChange={(e) => onDraftChange(e.target.value)}
                onKeyDown={(e) => {
                  if (sendOnEnter && e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSaveEdit(m.id);
                  }
                  if (e.key === 'Escape') onCancelEdit();
                }}
                className="w-full resize-none rounded-lg bg-white p-2 text-sm text-zinc-900 outline-none ring-2 ring-blue-500 dark:bg-zinc-900 dark:text-zinc-100"
                autoFocus
              />
              <div className="flex justify-end gap-2 text-xs">
                <button
                  onClick={onCancelEdit}
                  className="rounded px-2.5 py-1 text-zinc-500 hover:bg-black/5 dark:hover:bg-white/5"
                >
                  Hủy
                </button>
                <button
                  onClick={() => onSaveEdit(m.id)}
                  className="rounded bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700"
                >
                  Lưu & Gửi lại
                </button>
              </div>
            </div>
          ) : (
            <ErrorBoundary>
              <MarkdownRenderer
                content={m.content}
                isStreaming={isStreaming}
                throttleMs={throttleMs}
              />
            </ErrorBoundary>
          )}

          {/* Branch Switcher */}
          {!isEditing && branchInfo && (
            <BranchSwitcher
              currentIndex={branchInfo.currentIndex}
              total={branchInfo.total}
              isTouchDevice={isTouchDevice}
              disabled={isStreaming}
              onPrevious={() =>
                onSwitchBranch(m.id, 'previous')
              }
              onNext={() =>
                onSwitchBranch(m.id, 'next')
              }
            />
          )}

          {/* Action toolbar */}
          {!isEditing && (
            <div
              className={`mt-2 flex items-center gap-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 ${
                isTouchDevice ? 'opacity-100' : ''
              } ${m.role === 'user' ? 'justify-end text-blue-100' : 'justify-start text-zinc-400'}`}
            >
              <button
                onClick={() => onCopy(m)}
                title="Sao chép nội dung"
                className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
              >
                {isCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </button>

              {m.role === 'user' && (
                <button
                  onClick={() => onStartEdit(m)}
                  title="Chỉnh sửa và gửi lại"
                  className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}

              {m.role === 'assistant' && (
                <button
                  onClick={() => onRegenerate(m.id)}
                  title="Tạo lại câu trả lời"
                  className="rounded p-1 hover:bg-black/10 dark:hover:bg-white/10"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    );
  },
  (prev, next) =>
    prev.m.id === next.m.id &&
    prev.m.content === next.m.content &&
    prev.m.role === next.m.role &&
    prev.branchInfo?.currentIndex === next.branchInfo?.currentIndex &&
    prev.branchInfo?.total === next.branchInfo?.total &&
    prev.isStreaming === next.isStreaming &&
    prev.isEditing === next.isEditing &&
    prev.isCopied === next.isCopied &&
    prev.draft === next.draft &&
    prev.isTouchDevice === next.isTouchDevice &&
    prev.sendOnEnter === next.sendOnEnter &&
    prev.animations === next.animations &&
    prev.throttleMs === next.throttleMs,
);

/* ------------------------------------------------------------------ */
/* Subcomponent 1: Memoized ChatHeader                                 */
/* ------------------------------------------------------------------ */
interface ChatHeaderProps {
  hasMessages: boolean;
  confirmClear: boolean;
  onSetConfirmClear: (val: boolean) => void;
  onDeleteChat: () => void;
  onOpenSidebar: () => void;
}

const ChatHeader = memo(function ChatHeader({
  hasMessages,
  confirmClear,
  onSetConfirmClear,
  onDeleteChat,
  onOpenSidebar,
}: ChatHeaderProps) {
  return (
    <div className="absolute top-0 left-0 right-0 z-20 p-3 flex items-center justify-between pointer-events-none">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label="Open sidebar menu"
        className="md:hidden pointer-events-auto p-2 bg-zinc-900/80 border border-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-xl backdrop-blur-sm transition-colors shadow-sm"
      >
        <Menu size={18} />
      </button>

      {hasMessages && (
        <div className="ml-auto pointer-events-auto flex items-center gap-2">
          {confirmClear ? (
            <div className="flex items-center gap-1.5 bg-zinc-900/90 border border-zinc-800 rounded-xl p-1 backdrop-blur-sm shadow-lg">
              <button
                onClick={onDeleteChat}
                className="px-2.5 py-1 text-xs text-red-400 hover:bg-red-950/50 rounded-lg transition font-medium"
              >
                Xóa hẳn
              </button>
              <button
                onClick={() => onSetConfirmClear(false)}
                className="px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 rounded-lg transition"
              >
                Hủy
              </button>
            </div>
          ) : (
            <button
              onClick={() => onSetConfirmClear(true)}
              title="Xóa cuộc trò chuyện này"
              aria-label="Delete chat conversation"
              className="p-2 text-zinc-500 hover:text-red-400 hover:bg-zinc-900/80 border border-transparent hover:border-zinc-800 rounded-xl transition-all"
            >
              <Trash2 size={18} />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Subcomponent 2: Memoized MessageList with Virtualization           */
/* ------------------------------------------------------------------ */
interface MessageListProps {
  messages: Message[];

  branchInfoByMessageId: Map<
    string,
    BranchInfo
  >;

  isLoading: boolean;
  lastMessageId?: string;
  editingId: string | null;
  copiedId: string | null;
  draft: string;
  isTouchDevice: boolean;
  sendOnEnter: boolean;
  throttleMs: number;
  animations: boolean;
  error?: Error;
  autoScroll: boolean;
  scrollRef: React.RefObject<HTMLDivElement | null>;

  onScroll: () => void;
  onScrollToBottom: () => void;
  onCopy: (m: Message) => void;
  onRegenerate: (id: string) => void;

  onSwitchBranch: (
    messageId: string,
    direction: 'previous' | 'next',
  ) => void;

  onStartEdit: (m: Message) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onDraftChange: (text: string) => void;
  onSelectSuggestion: (prompt: string) => void;
  onReload: () => void;
}

const MessageList = memo(function MessageList({
  messages,
  branchInfoByMessageId,
  isLoading,
  lastMessageId,
  editingId,
  copiedId,
  draft,
  isTouchDevice,
  sendOnEnter,
  throttleMs,
  animations,
  error,
  autoScroll,
  scrollRef,
  onScroll,
  onScrollToBottom,
  onCopy,
  onRegenerate,
  onSwitchBranch,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDraftChange,
  onSelectSuggestion,
  onReload,
}: MessageListProps) {
  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 5,

    /**
     * Message id ổn định quan trọng hơn index.
     * Khi đổi branch, row có thể đổi nội dung và thứ tự,
     * nhưng mỗi message vẫn có identity riêng.
     */
    getItemKey: (index) =>
      messages[index]?.id ?? `row-${index}`,
  });

  const branchLayoutSignature = useMemo(
    () =>
      messages
        .map((message) => {
          const info =
            branchInfoByMessageId.get(message.id);

          return [
            message.id,
            message.content.length,
            info?.currentIndex ?? -1,
            info?.total ?? 1,
          ].join(':');
        })
        .join('|'),
    [messages, branchInfoByMessageId],
  );

  useEffect(() => {
    rowVirtualizer.measure();
  }, [branchLayoutSignature, rowVirtualizer]);

  const suggestions = useMemo(
    () => ['Explain quantum computing', 'Write a Python script for scraping', 'Plan a healthy meal', 'Summarize an article'],
    [],
  );

  const hasMessages = messages.length > 0;

  return (
    <>
      <div
        ref={scrollRef as any}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 pb-40 pt-14 md:pt-8"
      >
        {!hasMessages ? (
          <div className="flex flex-col items-center justify-center h-full pt-10 space-y-8">
            <div className="w-16 h-16 bg-indigo-500/10 rounded-2xl flex items-center justify-center text-indigo-500 mb-4">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h1 className="text-2xl font-medium text-zinc-200">How can I help you today?</h1>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-2xl">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => onSelectSuggestion(prompt)}
                  className="p-4 text-left border border-zinc-800 rounded-xl hover:bg-zinc-900 transition-all text-sm text-zinc-400 hover:text-zinc-200"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const m = messages[virtualRow.index];
              if (!m) return null;

              return (
                <div
                  key={m.id}
                  ref={rowVirtualizer.measureElement}
                  data-index={virtualRow.index}
                  data-message-id={m.id}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    paddingBottom: '1.5rem',
                  }}
                >
                  <MessageItem
                    m={m}
                    branchInfo={branchInfoByMessageId.get(m.id)}
                    isStreaming={isLoading && m.role === 'assistant' && m.id === lastMessageId}
                    isEditing={editingId === m.id}
                    isCopied={copiedId === m.id}
                    draft={editingId === m.id ? draft : ''}
                    isTouchDevice={isTouchDevice}
                    sendOnEnter={sendOnEnter}
                    throttleMs={throttleMs}
                    animations={animations}
                    onCopy={onCopy}
                    onRegenerate={onRegenerate}
                    onSwitchBranch={onSwitchBranch}
                    onStartEdit={onStartEdit}
                    onSaveEdit={onSaveEdit}
                    onCancelEdit={onCancelEdit}
                    onDraftChange={onDraftChange}
                  />
                </div>
              );
            })}

            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${rowVirtualizer.getTotalSize()}px)`,
                }}
                className="flex justify-start"
              >
                <div className="max-w-[720px] p-5">
                  <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse" />
                </div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="max-w-[720px] p-4 bg-red-950/50 border border-red-900 text-red-400 rounded-xl mx-auto flex items-center justify-between">
            <span>{error.message || 'An error occurred.'}</span>
            <button onClick={onReload} className="px-3 py-1 bg-red-900/50 rounded hover:bg-red-800 transition">
              Thử lại
            </button>
          </div>
        )}
      </div>

      {!autoScroll && (
        <button
          type="button"
          onClick={onScrollToBottom}
          aria-label="Scroll to bottom"
          className="absolute bottom-32 left-1/2 -translate-x-1/2 p-2 bg-zinc-800 text-zinc-300 rounded-full shadow-lg border border-zinc-700 hover:bg-zinc-700 transition"
        >
          <ArrowDown size={18} />
        </button>
      )}
    </>
  );
});

/* ------------------------------------------------------------------ */
/* Subcomponent 3: Memoized ChatComposer                               */
/* ------------------------------------------------------------------ */
interface ChatComposerProps {
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement> | React.ChangeEvent<HTMLInputElement>) => void;
  onTextareaKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: (e?: React.FormEvent) => void;
  isLoading: boolean;
  handleStop: () => void;
  notice: string | null;
  onClearNotice: () => void;
  attachments: File[];
  addFiles: (files: FileList | File[] | null) => void;
  removeAttachment: (index: number) => void;
  previewMap: Map<File, string>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isTouchDevice: boolean;
}

const ChatComposer = memo(function ChatComposer({
  input,
  handleInputChange,
  onTextareaKeyDown,
  onSubmit,
  isLoading,
  handleStop,
  notice,
  onClearNotice,
  attachments,
  addFiles,
  removeAttachment,
  previewMap,
  fileInputRef,
  isTouchDevice,
}: ChatComposerProps) {
  return (
    <div className="absolute bottom-0 left-0 right-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent pt-10">
      <div className="max-w-[720px] mx-auto relative">
        {notice && (
          <div className="mb-2 p-2.5 bg-amber-950/80 border border-amber-800/80 rounded-xl text-xs text-amber-300 flex items-center justify-between shadow-lg">
            <span>{notice}</span>
            <button type="button" onClick={onClearNotice} className="p-1 hover:text-amber-100 transition">
              <X size={14} />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 p-2 bg-zinc-900/80 border border-zinc-800 rounded-xl backdrop-blur-sm">
            {attachments.map((file, i) => {
              const isImage = file.type.startsWith('image/');
              const previewUrl = previewMap.get(file);
              return (
                <div key={`${file.name}-${i}`} className="relative flex items-center gap-2 bg-zinc-800 p-2 rounded-lg text-xs text-zinc-300">
                  {isImage && previewUrl ? (
                    <img src={previewUrl} alt={file.name} className="w-8 h-8 object-cover rounded" />
                  ) : (
                    <Paperclip size={14} className="text-zinc-500" />
                  )}
                  <span className="truncate max-w-[120px]">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(i)}
                    aria-label="Remove attachment"
                    className="absolute -top-1.5 -right-1.5 bg-zinc-700 hover:bg-zinc-600 rounded-full p-0.5"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="relative bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden focus-within:border-indigo-500/50 transition-colors shadow-sm"
        >
          <input
            type="file"
            multiple
            className="hidden"
            ref={fileInputRef as any}
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            className="absolute left-3 bottom-3 p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-xl transition-colors"
          >
            <Paperclip size={18} />
          </button>

          <TextareaAutosize
            value={input}
            onChange={handleInputChange}
            onKeyDown={onTextareaKeyDown}
            enterKeyHint={isTouchDevice ? 'enter' : 'send'}
            autoCapitalize="sentences"
            spellCheck={false}
            placeholder="Gửi tin nhắn..."
            className="w-full max-h-[200px] bg-transparent text-zinc-100 placeholder:text-zinc-600 resize-none outline-none p-4 pl-14 pr-16 py-5"
            minRows={1}
            maxRows={8}
          />

          <div className="absolute right-3 bottom-3 flex items-center gap-2">
            {isLoading ? (
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop generation"
                className="p-2 bg-zinc-800 text-zinc-300 rounded-xl hover:text-red-400 transition-colors"
              >
                <StopCircle size={18} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() && attachments.length === 0}
                aria-label="Send message"
                className="p-2 bg-indigo-600 text-white rounded-xl disabled:opacity-50 disabled:bg-zinc-800 transition-colors"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Main ChatInterface Orchestrator                                     */
/* ------------------------------------------------------------------ */
export default function ChatInterface() {
  const currentChatId = useAppStore((s) => s.currentChatId);
  const setCurrentChatId = useAppStore((s) => s.setCurrentChatId);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);

  const model = useAppStore((s) => s.settings.model);
  const temperature = useAppStore((s) => s.settings.temperature);
  const systemPrompt = useAppStore((s) => s.settings.systemPrompt);
  const apiKey = useAppStore((s) => s.settings.apiKey);
  const accessCode = useAppStore((s) => s.settings.accessCode);
  const sendOnEnter = useAppStore((s) => s.settings.sendOnEnter);
  const throttleMs = useAppStore((s) => s.settings.perf.throttleMs);
  const animations = useAppStore((s) => s.settings.perf.animations);

  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const chatKey = currentChatId ?? draftId;
  const tabId = useRef(crypto.randomUUID());
  const requestEpoch = useRef(0);
  const previousChatId = useRef<string | null>(currentChatId);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('ai-chat-sync');
    broadcastRef.current = channel;
    return () => {
      channel.close();
      broadcastRef.current = null;
    };
  }, []);

  const notifyChatUpdated = useCallback((chatId: string) => {
    try {
      broadcastRef.current?.postMessage({
        type: 'CHAT_UPDATED',
        chatId,
        from: tabId.current,
      });
    } catch {}
  }, []);

  const [autoScroll, setAutoScroll] = useState(true);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

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

  const [previewMap, setPreviewMap] = useState<Map<File, string>>(new Map());
  const createdObjectUrls = useRef<Set<string>>(new Set());

  useEffect(() => {
    const created: string[] = [];
    const next = new Map<File, string>();
    for (const f of attachments) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      created.push(url);
      next.set(f, url);
    }
    setPreviewMap(next);
    return () => {
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [attachments]);

  const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const MAX_FILES = 4;

  const addFiles = useCallback((files: FileList | File[] | null) => {
    if (!files) return;
    const fileArr = Array.from(files);
    let totalSize = attachments.reduce((sum, f) => sum + f.size, 0);
    const ok: File[] = [];
    const rejected: string[] = [];

    for (const f of fileArr) {
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
  }, [attachments, showNotice]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | null>(null);
  const lastTop = useRef(0);
  const stick = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedFor = useRef<string | null>(null);
  const titledFor = useRef<string | null>(null);
  const finishRef = useRef<'stop' | 'abort' | 'error'>('stop');
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

  const {
    messages, setMessages, input, setInput, handleInputChange,
    handleSubmit, stop, reload, isLoading, error, data,
  } = useChat({
    id: chatKey,
    headers: {
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
      ...(accessCode ? { 'x-access-code': accessCode } : {}),
    },
    body: {
      model,
      temperature,
      system: systemPrompt,
    },
    experimental_throttle: throttleMs,
    onError: (err) => console.error('[useChat]', err),
  });

  const isLoadingRef = useRef(isLoading);

  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

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

  useEffect(() => {
    if (
      previousChatId.current !==
      currentChatId
    ) {
      requestEpoch.current += 1;
      treePersistEpochRef.current += 1;

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

      if (isLoading) {
        finishRef.current = 'abort';
        stop();
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
    const epoch = requestEpoch.current;
    let cancelled = false;

    (async () => {
      try {
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

        /**
         * activeLeafId trong ChatSession là nguồn chính.
         * Fallback về message cuối theo createdAt nếu dữ liệu cũ
         * chưa có activeLeafId.
         */
        const fallbackLeafId = rows
          .slice()
          .sort((a, b) => {
            if (a.createdAt !== b.createdAt) {
              return b.createdAt - a.createdAt;
            }

            return b.seq - a.seq;
          })[0]?.id;

        const nextActiveLeafId =
          chat?.activeLeafId ?? fallbackLeafId ?? null;

        const activeThread =
          reconstructActiveThread(
            rows,
            nextActiveLeafId ?? undefined,
          );

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

      if (scrollFrame.current !== null) {
        cancelAnimationFrame(
          scrollFrame.current,
        );
      }
    };
  }, []);

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
            if (
              result.changedRows.length > 0
            ) {
              /**
               * Chỉ upsert row thay đổi.
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

  useEffect(() => {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    let cancelled = false;
    const bc = new BroadcastChannel('ai-chat-sync');

    bc.onmessage = async (e) => {
      if (cancelled) return;
      if (e.data?.from === tabId.current) return;
      if (e.data?.type !== 'CHAT_UPDATED') return;
      if (e.data?.chatId !== currentChatId) return;
      if (isLoading || !currentChatId) return;

      hydratedFor.current = null;
      const chatId = currentChatId;
      try {
        const [chat, rows] = await Promise.all([
          db.chats.get(chatId),
          db.messages
            .where('chatId')
            .equals(chatId)
            .toArray(),
        ]);

        if (cancelled || chatId !== useAppStore.getState().currentChatId) return;

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
    };

    return () => {
      cancelled = true;
      bc.close();
    };
  }, [currentChatId, isLoading, setMessages]);

  useEffect(() => {
    if (!currentChatId || isLoading || messages.length < 2) return;
    const chatId = currentChatId;
    if (titledFor.current === chatId) return;

    const firstUserMsg = messages.find((m) => m.role === 'user');
    const userPrompt = (firstUserMsg?.content || '').slice(0, 1000).trim();
    if (!userPrompt) return;

    const ctrl = new AbortController();
    (async () => {
      try {
        const chat = await db.chats.get(chatId);
        if (!chat) return;
        if (chat.title !== 'New Chat') {
          titledFor.current = chatId;
          return;
        }

        titledFor.current = chatId;

        const res = await fetch('/api/title', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
            ...(accessCode ? { 'x-access-code': accessCode } : {}),
          },
          body: JSON.stringify({ message: userPrompt }),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          if (titledFor.current === chatId) titledFor.current = null;
          return;
        }

        const data = await res.json();
        if (data?.title) {
          await db.chats.update(chatId, { title: String(data.title).slice(0, 60) });
          notifyChatUpdated(chatId);
        }
      } catch (err: any) {
        if (titledFor.current === chatId) titledFor.current = null;
        if (err?.name !== 'AbortError') console.error('[title]', err);
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [messages, currentChatId, isLoading, apiKey, accessCode, notifyChatUpdated]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const up = el.scrollTop < lastTop.current - 4;
    lastTop.current = el.scrollTop;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (up) stick.current = false;
    else if (atBottom) stick.current = true;
    setAutoScroll(stick.current);
  }, []);

  useEffect(() => {
    if (!stick.current) return;

    if (scrollFrame.current !== null) {
      cancelAnimationFrame(scrollFrame.current);
    }

    scrollFrame.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
      scrollFrame.current = null;
    });

    return () => {
      if (scrollFrame.current !== null) {
        cancelAnimationFrame(scrollFrame.current);
        scrollFrame.current = null;
      }
    };
  }, [messages.length, messages[messages.length - 1]?.content]);

  const scrollToBottom = useCallback(() => {
    stick.current = true;
    setAutoScroll(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, []);


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
      /**
       * Chưa xử lý stop stream trong Giai đoạn 2.
       * Widget cũng đã disabled khi message đang stream.
       */
      if (isLoading) {
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

      if (!nextLeafId) {
        return;
      }

      const nextThread = reconstructActiveThread(
        rows,
        nextLeafId,
      );

      if (nextThread.length === 0) {
        return;
      }

      /**
       * Đổi URL attachment theo active thread mới.
       */
      revokeObjectUrls(createdObjectUrls.current);

      const nextMessages = nextThread.map((row) =>
        toChatMessage(
          row,
          createdObjectUrls.current,
        ),
      );

      /**
       * Optimistic UI update.
       */
      treePersistEpochRef.current += 1;
      activeLeafIdRef.current = nextLeafId;
      setActiveLeafId(nextLeafId);
      setMessages(nextMessages);

      /**
       * Chỉ cập nhật pointer, không xóa message và không thay đổi cây.
       */
      try {
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
      }
    },
    [
      currentChatId,
      isLoading,
      notifyChatUpdated,
      setMessages,
    ],
  );

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
          userParentId,
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
          editedUserParentId,
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
      titledFor.current = null;

      setDraftId(crypto.randomUUID());
      setCurrentChatId(null);
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

  const onSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if ((!input.trim() && attachments.length === 0) || isLoading) return;

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

      const dataTransfer = new DataTransfer();
      attachments.forEach((f) => dataTransfer.items.add(f));
      const options = attachments.length ? { experimental_attachments: dataTransfer.files } : undefined;

      setAttachments([]);
      handleSubmit(undefined, options);
    } catch (err) {
      console.error('[onSubmit]', err);
    }
  }, [input, attachments, isLoading, currentChatId, draftId, setCurrentChatId, handleSubmit]);

  const onTextareaKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as any).isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { handleStop(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (isTouchDevice || !sendOnEnter) return;
    e.preventDefault();
    void onSubmit();
  }, [handleStop, isTouchDevice, sendOnEnter, onSubmit]);

  const onOpenSidebar = useCallback(() => setSidebarOpen(true), [setSidebarOpen]);

  const lastMessageId = messages[messages.length - 1]?.id;
  const hasMessages = messages.length > 0;

  return (
    <div className="flex-1 flex flex-col relative h-[100dvh]">
      <ChatHeader
        hasMessages={hasMessages}
        confirmClear={confirmClear}
        onSetConfirmClear={setConfirmClear}
        onDeleteChat={deleteChat}
        onOpenSidebar={onOpenSidebar}
      />

      <MessageList
        messages={messages}
        branchInfoByMessageId={branchInfoByMessageId}
        isLoading={isLoading}
        lastMessageId={lastMessageId}
        editingId={editingId}
        copiedId={copiedId}
        draft={draft}
        isTouchDevice={isTouchDevice}
        sendOnEnter={sendOnEnter}
        throttleMs={throttleMs}
        animations={animations}
        error={error}
        autoScroll={autoScroll}
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
      />

      <ChatComposer
        input={input}
        handleInputChange={handleInputChange}
        onTextareaKeyDown={onTextareaKeyDown}
        onSubmit={onSubmit}
        isLoading={isLoading}
        handleStop={handleStop}
        notice={notice}
        onClearNotice={onClearNotice}
        attachments={attachments}
        addFiles={addFiles}
        removeAttachment={removeAttachment}
        previewMap={previewMap}
        fileInputRef={fileInputRef}
        isTouchDevice={isTouchDevice}
      />
    </div>
  );
}