/**
 * Con trỏ key mã hoá cho provider — giai đoạn 2 (desktop tự chủ).
 *
 * Vấn đề: API key của người dùng nằm PLAINTEXT trong IndexedDB (bảng
 * providers) — mọi script chạy trong ngữ cảnh trang đọc được. Desktop có
 * safeStorage (credential manager của OS) nên cho phép lưu key mã hoá: DB chỉ
 * giữ CON TRỎ `@secure:`, key thật nằm trong vault của desktop main
 * (lib/secure-store.cjs).
 *
 * Module THUẦN (không Dexie) để test được độc lập; lookup vault tiêm được.
 */

import { desktopSecureStore } from '@/lib/desktop-bridge';

/** Prefix trong ProviderConfig.apiKey — báo "key thật nằm trong kho mã hoá". */
export const SECURE_KEY_MARKER = '@secure:';

/** Key vault của một provider — namespace chặn lạm dụng kho cho mục khác. */
export function secureKeyOf(providerId: string): string {
  return `provider:${providerId}`;
}

/** true khi apiKey trong DB chỉ là con trỏ tới kho mã hoá desktop. */
export function isSecureKeyPointer(
  stored: string | undefined | null,
): boolean {
  return typeof stored === 'string' && stored.startsWith(SECURE_KEY_MARKER);
}

/** Subset của VyenSecureStoreApi mà resolve cần — test tiêm fake dễ hơn. */
export interface SecureKeyLookup {
  get(key: string): Promise<{ value: string | null }>;
}

/**
 * Key THẬT để gửi lên route/gateway:
 * - key thường → trả nguyên vẹn (hành vi cũ).
 * - con trỏ `@secure:` → đọc vault (desktop). Không có vault (web, shell cũ)
 *   hoặc đọc hỏng → '' — route sẽ trả 401 rõ ràng thay vì gửi key rác; người
 *   dùng biết key mã hoá chỉ dùng được trên máy đã lưu nó.
 */
export async function resolveProviderApiKey(
  stored: string | undefined,
  providerId: string,
  lookup: SecureKeyLookup | null = desktopSecureStore(),
): Promise<string> {
  if (!isSecureKeyPointer(stored)) return stored ?? '';
  if (!lookup) return '';
  try {
    const { value } = await lookup.get(secureKeyOf(providerId));
    return value ?? '';
  } catch {
    return '';
  }
}
