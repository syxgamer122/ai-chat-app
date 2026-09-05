/*
 * Header hội thoại: tiêu đề, xuất/nhập, xoá chat — Vyen minimal topbar
 */
import React, { memo } from 'react';
import { Trash2, Menu, Scissors } from 'lucide-react';
import { ChatExportMenu } from '@/components/chat-export-menu';

interface ChatHeaderProps {
  title?: string;
  hasMessages: boolean;
  confirmClear: boolean;
  onSetConfirmClear: (val: boolean) => void;
  onDeleteChat: () => void;
  onOpenSidebar: () => void;
  /** Desktop: sidebar đang thu gọn → hiện nút mở rộng bên trái header. */
  sidebarCollapsed: boolean;
  currentChatId: string | null;
  /** Nén hội thoại: đủ tin đáng nén (và không đang stream) mới hiện nút. */
  canCompact?: boolean;
  compactBusy?: boolean;
  onCompact?: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  title,
  hasMessages,
  confirmClear,
  onSetConfirmClear,
  onDeleteChat,
  onOpenSidebar,
  sidebarCollapsed,
  currentChatId,
  canCompact,
  compactBusy,
  onCompact,
}: ChatHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex min-h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-[#495059] bg-[#0d1116] px-3 py-1.5 pt-safe-2 md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={sidebarCollapsed ? 'Mở rộng thanh bên' : 'Mở thanh bên'}
          className={`icon-btn-sm ${sidebarCollapsed ? '' : 'md:hidden'}`}
        >
          <Menu size={16} />
        </button>

        <div className="flex min-w-0 items-center">
          <h2 className="truncate font-pixel text-[16px] font-semibold tracking-[0.05em] text-[#ebe7e4] [image-rendering:pixelated]">
            {title ?? 'new-session'}
          </h2>
        </div>
      </div>

      <div className="flex items-center gap-1">
        {canCompact && onCompact && (
          <button
            type="button"
            onClick={onCompact}
            disabled={compactBusy}
            aria-label={compactBusy ? 'Đang nén hội thoại' : 'Nén hội thoại'}
            title={
              compactBusy
                ? 'Đang nén hội thoại...'
                : 'Nén phần hội thoại cũ thành tóm tắt'
            }
            className="icon-btn-sm text-[#9fa4ab] hover:text-[#6a9fcc]"
          >
            <Scissors size={14} />
          </button>
        )}
        <ChatExportMenu chatId={currentChatId} />

        {hasMessages &&
          (confirmClear ? (
            <div className="flex items-center gap-1 rounded-none border border-[#495059] bg-[#161d27] p-1 font-mono text-xs">
              <button
                type="button"
                onClick={onDeleteChat}
                className="rounded-none px-2 py-0.5 font-medium text-[#e8704f] transition-colors hover:bg-[#e8704f]/10"
              >
                Xóa
              </button>
              <button
                type="button"
                onClick={() => onSetConfirmClear(false)}
                className="rounded-none px-2 py-0.5 text-[#9fa4ab] transition-colors hover:bg-[#252f3d]"
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
              className="icon-btn-sm icon-btn-danger text-[#9fa4ab] hover:text-[#e8704f]"
            >
              <Trash2 size={14} />
            </button>
          ))}
      </div>
    </header>
  );
});
