/*
 * Header hội thoại: tiêu đề, xuất/nhập, xoá chat.
 */
import React, { memo } from 'react';
import { X, Trash2, Menu } from 'lucide-react';
import { ChatExportMenu } from '@/components/chat-export-menu';

/* ------------------------------------------------------------------ */
/* Subcomponent 1: Memoized ChatHeader                                 */
/* ------------------------------------------------------------------ */
interface ChatHeaderProps {
  title?: string;
  hasMessages: boolean;
  confirmClear: boolean;
  onSetConfirmClear: (val: boolean) => void;
  onDeleteChat: () => void;
  onOpenSidebar: () => void;
  currentChatId: string | null;
}

export const ChatHeader = memo(function ChatHeader({
  title,
  hasMessages,
  confirmClear,
  onSetConfirmClear,
  onDeleteChat,
  onOpenSidebar,
  currentChatId,
}: ChatHeaderProps) {
  return (
    <header className="flex h-14 flex-shrink-0 items-center justify-between border-b border-zinc-200/60 bg-[#F7F9FC]/90 px-3 backdrop-blur pt-safe z-20 md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label="Mở thanh bên"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-200/70 md:hidden"
        >
          <Menu size={17} />
        </button>
        <h1 className="truncate text-[14px] font-semibold tracking-tight text-zinc-700">
          {title ?? 'Cuộc trò chuyện mới'}
        </h1>
      </div>

      <div className="flex items-center gap-1">
        <ChatExportMenu chatId={currentChatId} />

        {hasMessages &&
          (confirmClear ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-[#FFFFFF] p-1 shadow-lg">
              <button
                type="button"
                onClick={onDeleteChat}
                className="rounded px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 transition"
              >
                Xóa hẳn
              </button>
              <button
                type="button"
                onClick={() => onSetConfirmClear(false)}
                className="rounded px-2.5 py-1 text-xs text-zinc-500 hover:bg-zinc-200 transition"
              >
                Hủy
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSetConfirmClear(true)}
              aria-label="Xóa cuộc trò chuyện"
              title="Xóa cuộc trò chuyện này"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-500/10 hover:text-red-400 transition"
            >
              <Trash2 size={16} />
            </button>
          ))}
      </div>
    </header>
  );
});

