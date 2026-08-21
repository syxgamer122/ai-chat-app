function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withDexieRetry<T>(
  operation: () => Promise<T>,
  options: {
    retries?: number;
    baseDelayMs?: number;
  } = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 100;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt === retries) {
        break;
      }

      const delay =
        baseDelayMs * 2 ** attempt +
        Math.floor(Math.random() * 50);

      await sleep(delay);
    }
  }

  throw lastError;
}

export function writePendingStream(
  sessionId: string,
  messageId: string,
  content: string,
) {
  if (typeof window === "undefined") return;
  try {
    const key = `pending-stream:${sessionId}:${messageId}`;
    sessionStorage.setItem(
      key,
      JSON.stringify({
        content,
        updatedAt: Date.now(),
      }),
    );
  } catch (err) {
    console.warn("[pending-stream] write error", err);
  }
}

export function readPendingStream(
  sessionId: string,
  messageId: string,
): { content: string; updatedAt: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const key = `pending-stream:${sessionId}:${messageId}`;
    const raw = sessionStorage.getItem(key);

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as {
      content: string;
      updatedAt: number;
    };
  } catch {
    const key = `pending-stream:${sessionId}:${messageId}`;
    sessionStorage.removeItem(key);
    return null;
  }
}

export function clearPendingStream(
  sessionId: string,
  messageId: string,
) {
  if (typeof window === "undefined") return;
  try {
    const key = `pending-stream:${sessionId}:${messageId}`;
    sessionStorage.removeItem(key);
  } catch {}
}
