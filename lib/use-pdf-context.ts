/**
 * Điều phối phía client cho tính năng "chat với PDF": đọc file PDF đính kèm
 * thành data URL, gửi qua /api/pdf để trích text, gói thành pdfContexts gửi
 * kèm body /api/chat (giống pattern webContext).
 *
 * Thất bại ở bất kỳ bước nào KHÔNG chặn gửi tin nhắn — trả mảng rỗng, caller
 * tự quyết có báo notice hay không.
 */

import { useAppStore } from '@/lib/store';

const REQUEST_TIMEOUT_MS = 30_000;
/** Trần dung lượng PDF binary (base64 phình ~1.37 lần nhưng route cap 9MB body). */
export const MAX_PDF_BYTES = 6 * 1024 * 1024;
export const MAX_PDF_FILES = 2;

function authHeaders(): Record<string, string> {
  const s = useAppStore.getState();
  const headers: Record<string, string> = {};
  if (s.settings.accessCode) headers['x-access-code'] = s.settings.accessCode;
  const p = s.activeProvider;
  if (p?.baseUrl) {
    headers['x-api-base'] = p.baseUrl;
    if (p.apiKey) headers['x-api-key'] = p.apiKey;
  } else if (s.settings.apiKey) {
    headers['x-api-key'] = s.settings.apiKey;
  }
  return headers;
}

export interface PdfContext {
  name: string;
  content: string;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Lọc các file PDF từ danh sách attachment và trích text. Trả tối đa
 * MAX_PDF_FILES ngữ cảnh; file quá to/lỗi bị bỏ qua im lặng.
 */
export async function gatherPdfContexts(
  files: readonly File[],
): Promise<PdfContext[]> {
  const pdfs = files.filter(
    (f) => f.type === 'application/pdf' && f.size > 0 && f.size <= MAX_PDF_BYTES,
  ).slice(0, MAX_PDF_FILES);
  if (!pdfs.length || typeof window === 'undefined') return [];

  const settled = await Promise.allSettled(pdfs.map(async (file): Promise<PdfContext> => {
    const dataUrl = await readAsDataUrl(file);
    const res = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ dataUrl, name: file.name.slice(0, 200) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`pdf route ${res.status}`);
    const j = (await res.json()) as { content?: unknown };
    if (typeof j?.content !== 'string' || !j.content.trim()) throw new Error('empty text');
    return { name: file.name.slice(0, 200), content: j.content };
  }));

  return settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
}
