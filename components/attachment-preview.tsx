"use client";

import type { AttachmentRecord } from "@/lib/chat-types";
import { useAttachmentUrl, type CompatibleAttachment } from "@/lib/use-attachment-url";

interface AttachmentPreviewProps {
  attachment: CompatibleAttachment;
}

export function AttachmentPreview({
  attachment,
}: AttachmentPreviewProps) {
  const url = useAttachmentUrl(attachment);
  const mimeType = (attachment as AttachmentRecord).mimeType || (attachment as any).contentType || "";

  if (!url) {
    return (
      <div className="rounded-md border border-black/10 p-2 text-xs text-zinc-400 dark:border-white/10">
        Không thể tải tệp: {attachment.name}
      </div>
    );
  }

  if (mimeType.startsWith("image/")) {
    return (
      <img
        src={url}
        alt={attachment.name}
        loading="lazy"
        draggable={false}
        className="max-h-80 max-w-full rounded-lg object-contain"
      />
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="max-h-80 max-w-full rounded-lg"
      />
    );
  }

  if (mimeType.startsWith("audio/")) {
    return (
      <audio
        src={url}
        controls
        preload="metadata"
        className="max-w-full"
      />
    );
  }

  return (
    <a
      href={url}
      download={attachment.name}
      className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2"
    >
      Tải xuống {attachment.name}
    </a>
  );
}
