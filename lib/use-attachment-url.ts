"use client";

import { useEffect, useState } from "react";
import type { AttachmentRecord } from "@/lib/chat-types";
import type { StoredAttachment } from "@/lib/db";
import {
  releaseObjectUrl,
  retainObjectUrl,
} from "@/lib/object-url-registry";

export type CompatibleAttachment = AttachmentRecord | (StoredAttachment & { id?: string; mimeType?: string });

export function useAttachmentUrl(
  attachment: CompatibleAttachment | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(
    (attachment as AttachmentRecord)?.remoteUrl ?? (attachment as StoredAttachment)?.url ?? null,
  );

  useEffect(() => {
    if (!attachment) {
      setUrl(null);
      return;
    }

    const remote = (attachment as AttachmentRecord)?.remoteUrl ?? (attachment as StoredAttachment)?.url;
    if (remote && (remote.startsWith("http://") || remote.startsWith("https://") || remote.startsWith("data:"))) {
      setUrl(remote);
      return;
    }

    if (!attachment.blob) {
      setUrl(remote ?? null);
      return;
    }

    const attachmentId = (attachment as AttachmentRecord).id || `${attachment.name}_${attachment.blob.size}`;

    const objectUrl = retainObjectUrl(
      attachmentId,
      attachment.blob,
    );

    setUrl(objectUrl);

    return () => {
      releaseObjectUrl(
        attachmentId,
        attachment.blob as Blob,
      );
    };
  }, [attachment]);

  return url;
}
