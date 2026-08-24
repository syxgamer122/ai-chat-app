import { db, type PromptTemplate } from '@/lib/db';
import { foldText } from '@/lib/search-utils';

/**
 * Thư viện prompt: gõ "/" trong ô nhập để chèn nhanh.
 * Lưu trong IndexedDB (bảng prompts), có sẵn vài mẫu tiếng Việt ở lần đầu.
 */

const SEED_FLAG = 'promptsSeeded';

interface SeedPrompt {
  title: string;
  content: string;
}

const DEFAULT_PROMPTS: SeedPrompt[] = [
  {
    title: 'Dịch Trung - Việt',
    content:
      'Bạn là dịch giả chuyên nghiệp. Hãy dịch đoạn văn sau từ tiếng Trung sang tiếng Việt, giữ nguyên nghĩa và văn phong. Chỉ xuất bản dịch, không giải thích:\n\n',
  },
  {
    title: 'Giải thích code',
    content:
      'Giải thích đoạn code sau bằng tiếng Việt, dễ hiểu cho người mới: code này làm gì, từng phần có ý nghĩa gì, có điểm gì cần cải thiện:\n\n```\n\n```',
  },
  {
    title: 'Sửa lỗi chính tả',
    content:
      'Hãy sửa lỗi chính tả và dấu câu tiếng Việt trong đoạn văn sau, không đổi nội dung. Trả về bản đã sửa trước, sau đó liệt kê các thay đổi (nếu có):\n\n',
  },
  {
    title: 'Tóm tắt văn bản',
    content:
      'Tóm tắt đoạn văn sau thành 3-5 gạch đầu dòng bằng tiếng Việt, giữ các con số và tên riêng quan trọng:\n\n',
  },
  {
    title: 'Viết unit test',
    content:
      'Viết unit test (vitest) đầy đủ cho hàm sau, bao gồm case biên: liệt kê case trước rồi viết code:\n\n```\n\n```',
  },
];

function newPromptId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** Khoá module: chống 2 effect chạy song song cùng lúc (StrictMode / 2 tab). */
let seedPromise: Promise<void> | null = null;

/** Seed mẫu mặc định lần đầu (idempotent qua flag trong bảng kv). */
export async function ensurePromptSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedOnce().catch((err) => {
      seedPromise = null; // lỗi → cho phép thử lại lần sau
      throw err;
    });
  }
  return seedPromise;
}

async function seedOnce(): Promise<void> {
  const flag = await db.kv.get(SEED_FLAG);
  if (flag) return;
  // Transaction + flag ghi trong cùng transaction: 2 tab khởi động đồng thời
  // cũng chỉ 1 bên seed được, không sinh bản mẫu trùng lặp.
  await db.transaction('rw', [db.prompts, db.kv], async () => {
    const confirmed = await db.kv.get(SEED_FLAG);
    if (confirmed) return;
    const now = Date.now();
    await db.prompts.bulkAdd(
      DEFAULT_PROMPTS.map((p, i) => ({
        id: newPromptId(),
        title: p.title,
        content: p.content,
        createdAt: now + i,
        updatedAt: now + i,
      })),
    );
    await db.kv.put({ key: SEED_FLAG, value: true });
  });
}

export async function listPrompts(): Promise<PromptTemplate[]> {
  await ensurePromptSeed();
  return db.prompts.orderBy('updatedAt').reverse().toArray();
}

export async function savePrompt(input: {
  id?: string;
  title: string;
  content: string;
}): Promise<PromptTemplate> {
  const title = input.title.trim().slice(0, 80);
  const content = input.content.slice(0, 8000);
  if (!title) throw new Error('Tên prompt không được để trống.');
  if (!content.trim()) throw new Error('Nội dung prompt không được để trống.');

  const now = Date.now();
  if (input.id) {
    const existing = await db.prompts.get(input.id);
    if (!existing) throw new Error('Prompt không tồn tại nữa.');
    const updated: PromptTemplate = { ...existing, title, content, updatedAt: now };
    await db.prompts.put(updated);
    return updated;
  }

  const created: PromptTemplate = {
    id: newPromptId(),
    title,
    content,
    createdAt: now,
    updatedAt: now,
  };
  await db.prompts.add(created);
  return created;
}

export async function deletePrompt(id: string): Promise<void> {
  await db.prompts.delete(id);
}

/** Filter prompt theo từ khoá sau "/". Fold dấu tiếng Việt — "tom tat" ra "Tóm tắt". */
export function filterPrompts(
  prompts: Pick<PromptTemplate, 'id' | 'title' | 'content'>[],
  query: string,
  limit = 8,
): Pick<PromptTemplate, 'id' | 'title' | 'content'>[] {
  const q = foldText(query.trim());
  if (!q) return prompts.slice(0, limit);

  const scored: Array<{ p: Pick<PromptTemplate, 'id' | 'title' | 'content'>; score: number }> = [];
  for (const p of prompts) {
    const title = foldText(p.title);
    const content = foldText(p.content);
    let score = -1;
    if (title.startsWith(q)) score = 0;
    else if (title.includes(q)) score = 1;
    else if (content.includes(q)) score = 2;
    if (score >= 0) scored.push({ p, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.p);
}
