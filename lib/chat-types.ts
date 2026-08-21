export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "aborted"
  | "error";

export interface AttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  size: number;

  /**
   * Blob được lưu trong IndexedDB.
   * Không lưu ObjectURL vào DB.
   */
  blob?: Blob;

  /**
   * Nếu file nằm ở remote storage thì dùng url này.
   */
  remoteUrl?: string;

  createdAt: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;

  role: MessageRole;
  content: string;

  parentId: string | null;

  /**
   * Số thứ tự nhánh sinh ra từ cùng một parent.
   * Có thể bị trùng giữa hai tab, vì vậy khi sort nên dùng tie-breaker.
   */
  branchOrder: number;

  createdAt: number;

  status?: MessageStatus;

  /**
   * Dùng cho stream đang chạy.
   */
  streamId?: string;
  streamedTokenCount?: number;

  attachments?: AttachmentRecord[];

  /**
   * Lamport clock của mutation cuối cùng.
   */
  revision?: number;

  /**
   * Tab hoặc client tạo ra message.
   */
  originClientId?: string;

  /**
   * Dùng để xác định thứ tự ổn định nếu branchOrder trùng.
   */
  branchTieBreaker?: string;

  /**
   * Nếu fork từ một assistant message cũ,
   * lưu lại message gốc để audit/debug.
   */
  forkedFromMessageId?: string;
}

export interface StreamLease {
  streamId: string;
  clientId: string;
  messageId: string;
  startedAt: number;
  heartbeatAt: number;
}

export interface ChatSession {
  id: string;
  title?: string;

  rootMessageId: string | null;
  activeLeafId: string | null;

  createdAt: number;
  updatedAt: number;

  revision?: number;
  revisionOriginClientId?: string;
  activeLease?: StreamLease | null;
}

export interface StreamTokenCheckpoint {
  id: string;
  sessionId: string;
  messageId: string;
  streamId: string;

  content: string;
  tokenCount: number;

  status: "streaming" | "aborted" | "complete" | "error";

  createdAt: number;
  updatedAt: number;
}
