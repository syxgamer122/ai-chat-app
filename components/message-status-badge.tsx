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
      <span className="animate-pulse text-[11px] text-zinc-600">
        Äang tạo…
      </span>
    );
  }

  if (status === "aborted") {
    return (
      <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
        Äã dừng giữa chừng
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="text-[11px] font-medium text-red-700 dark:text-red-400">
        Có lỗi khi tạo nội dung
      </span>
    );
  }

  return null;
}
