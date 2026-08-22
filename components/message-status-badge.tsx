"use client";

import type { MessageStatus } from "@/lib/chat-types";
import type { StoredMessageStatus } from "@/lib/db";

interface MessageStatusBadgeProps {
  status?: MessageStatus | StoredMessageStatus;
}

export function MessageStatusBadge({
  status,
}: MessageStatusBadgeProps) {
  if (status === "streaming") {
    return (
      <span className="text-[11px] text-zinc-500 dark:text-zinc-500 animate-pulse">
        Đang tạo…
      </span>
    );
  }

  if (status === "aborted") {
    return (
      <span className="text-[11px] font-medium text-amber-500/90 dark:text-amber-400/90">
        Đã dừng giữa chừng
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="text-[11px] font-medium text-red-500/90 dark:text-red-400/90">
        Có lỗi khi tạo nội dung
      </span>
    );
  }

  return null;
}
