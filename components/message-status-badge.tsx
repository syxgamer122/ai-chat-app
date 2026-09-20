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
      <span className="animate-pulse text-[11px] text-text-muted">
        Đang tạo…
      </span>
    );
  }

  if (status === "aborted") {
    return (
      <span className="text-[11px] font-medium text-status-warning">
        Đã dừng giữa chừng
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="text-[11px] font-medium text-status-error">
        Có lỗi khi tạo nội dung
      </span>
    );
  }

  return null;
}
