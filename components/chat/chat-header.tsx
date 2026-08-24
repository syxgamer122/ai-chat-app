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
  /** Desktop: sidebar đang thu gọn → hiện nút mở rộng bên trái header. */
  sidebarCollapsed: boolean;
  currentChatId: string | null;
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
}: ChatHeaderProps) {
  return (
    /*
     * `h-14` + `pt-safe` khiến notch ăn vào chiều cao cố định làm bóp nội dung
     * header. Dùng min-height + padding để header tự cao thêm đúng phần an toàn.
     */
    <header className="sticky top-0 z-20 flex min-h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-zinc-200/60 bg-surface/90 px-3 pb-2 pt-safe-2 backdrop-blur md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenSidebar}
          aria-label={sidebarCollapsed ? 'Mở rộng thanh bên' : 'Mở thanh bên'}
          className={`icon-btn-md ${sidebarCollapsed ? '' : 'md:hidden'}`}
        >
          <Menu size={17} />
        </button>
        {/* h2 (không phải h1): h1 thuộc trạng thái rỗng / nội dung trang. */}
        <h2 className="truncate text-[14px] font-semibold tracking-tight text-zinc-700">
          {title ?? 'Cuộc trò chuyện mới'}
        </h2>
      </div>

      <div className="flex items-center gap-1">
        <ChatExportMenu chatId={currentChatId} />

        {hasMessages &&
          (confirmClear ? (
            <div className="surface-panel flex animate-pop-in items-center gap-1.5 p-1">
              <button
                type="button"
                onClick={onDeleteChat}
                className="rounded-md px-2.5 py-1 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:hover:bg-red-500/10"
              >
                Xóa hẳn
              </button>
              <button
                type="button"
                onClick={() => onSetConfirmClear(false)}
                className="rounded-md px-2.5 py-1 text-xs text-zinc-600 transition-colors hover:bg-zinc-100"
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
              className="icon-btn-sm icon-btn-danger"
            >
              <Trash2 size={16} />
            </button>
          ))}
      </div>
    </header>
  );
});

