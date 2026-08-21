const CLIENT_ID_KEY = "ai-chat-client-id";

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

let lamportClock = 0;

export function nextLamport(remoteRevision?: number): number {
  lamportClock = Math.max(lamportClock, remoteRevision ?? 0) + 1;
  return lamportClock;
}

export function observeLamport(remoteRevision?: number) {
  lamportClock = Math.max(lamportClock, remoteRevision ?? 0);
}

export function createMutationId() {
  return createId("mutation");
}
