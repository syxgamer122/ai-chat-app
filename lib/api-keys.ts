export type UpstreamScope = 'key-auth' | 'key-rate' | 'request' | 'transient' | 'unknown';

/** Key giả dùng khi provider khai base nhưng không có key (provider tự miễn auth). */
export const PROVIDER_NO_KEY_SENTINEL = 'provider-no-key';

export function getKeyLabel(key: string): string {
  if (!key) return 'empty';
  if (key.length < 14) return `len:${key.length}:${key.slice(-2)}`;
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

export function classifyUpstreamStatus(status?: number): UpstreamScope {
  if (!status) return 'transient';
  if (status === 401 || status === 403) return 'key-auth';
  if (status === 429) return 'key-rate';
  if (status === 400 || status === 422 || status === 404) return 'request';
  if (status >= 500) return 'transient';
  return 'unknown';
}
