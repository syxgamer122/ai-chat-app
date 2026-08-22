const CLIENT_ID_KEY = "ai-chat-client-id";
const LAMPORT_KEY = "ai-chat-lamport-clock";

function createId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function getClientId(): string {
  if (typeof window === "undefined") {
    return "server";
  }

  let clientId = window.sessionStorage.getItem(CLIENT_ID_KEY);

  if (!clientId) {
    clientId = createId("client");
    window.sessionStorage.setItem(CLIENT_ID_KEY, clientId);
  }

  return clientId;
}

/**
 * Lamport clock DURABLE qua reload (localStorage). Nếu chỉ giữ trong memory,
 * tab vừa reload sẽ phát revision nhỏ hơn giá trị peer đang giữ và bị
 * use-cross-tab-chat-sync bỏ qua event (revision <= lastRevision).
 */
function readLamport(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(LAMPORT_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function writeLamport(value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAMPORT_KEY, String(value));
  } catch {
    // localStorage đầy/bị chặn — clock vẫn đúng trong phạm vi tab.
  }
}

let lamportClock = readLamport();

export function nextLamport(remoteRevision?: number): number {
  lamportClock = Math.max(lamportClock, remoteRevision ?? 0) + 1;
  writeLamport(lamportClock);
  return lamportClock;
}

export function observeLamport(remoteRevision?: number) {
  const next = Math.max(lamportClock, remoteRevision ?? 0);
  if (next !== lamportClock) {
    lamportClock = next;
    writeLamport(lamportClock);
  }
}

export function createMutationId() {
  return createId("mutation");
}
