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
      <span className="animate-pulse text-[11px] text-[#9fa4ab]">
        Đang tạo…
      </span>
    );
  }

  if (status === "aborted") {
    return (
      <span className="text-[11px] font-medium text-[#e8993a]">
        Đã dừng giữa chừng
      </span>
    );
  }

  if (status === "error") {
    return (
      <span className="text-[11px] font-medium text-[#e8704f]">
        Có lỗi khi tạo nội dung
      </span>
    );
  }

  return null;
}
