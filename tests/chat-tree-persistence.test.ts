import { describe, expect, it } from 'vitest';
import {
  sanitizeContent,
  getNextBranchOrder,
  getNextSequence,
  upsertStoredMessages,
  getFinalStoredStatus,
} from '@/lib/chat-tree-persistence';
import type { StoredMessage } from '@/lib/db';

const ROOT = '__ROOT__';

describe('sanitizeContent', () => {
  it('artifact ở cuối dòng riêng bị cắt, artifact giữa câu được giữ', () => {
    expect(sanitizeContent('Câu trả lời\nundefined')).toBe('Câu trả lời');
    expect(sanitizeContent('Câu trả lời\n\nnull\n')).toBe('Câu trả lời');
    // Trên cùng dòng với nội dung là code/value hợp lệ — không được cắt
    expect(sanitizeContent('Kết quả: [object Object]')).toBe('Kết quả: [object Object]');
    expect(sanitizeContent('giá trị null')).toBe('giá trị null');
  });

  it('whitespace cuối bị trim, không đụng nội dung giữa', () => {
    expect(sanitizeContent('đúng sai   \u200B')).toBe('đúng sai');
    expect(sanitizeContent('  khoảng trắng đầu')).toBe('  khoảng trắng đầu');
  });

  it('đầu vào không phải string → rỗng / extract object', () => {
    expect(sanitizeContent(null)).toBe('');
    expect(sanitizeContent(undefined)).toBe('');
    expect(sanitizeContent(123)).toBe('');
  });
});

describe('cấp số cây', () => {
  const rows: StoredMessage[] = [
    { id: 'u1', chatId: 'c1', role: 'user', content: 'a', parentId: ROOT, seq: 0, branchOrder: 0, branchTieBreaker: 'u1', createdAt: 1 },
    { id: 'u2', chatId: 'c1', role: 'user', content: 'b', parentId: ROOT, seq: 1, branchOrder: 1, branchTieBreaker: 'u2', createdAt: 2 },
    { id: 'a1', chatId: 'c1', role: 'assistant', content: 'c', parentId: 'u1', seq: 2, branchOrder: 0, branchTieBreaker: 'a1', createdAt: 3 },
  ];

  it('getNextBranchOrder dựa trên key đã chuẩn hoá (__ROOT__)', () => {
    // siblings của root là u1, u2 → next = 2
    expect(getNextBranchOrder(rows, ROOT)).toBe(2);
    // chưa có sibling nào dưới a1
    expect(getNextBranchOrder(rows, 'a1')).toBe(0);
  });

  it('getNextSequence lấy seq lớn nhất + 1', () => {
    expect(getNextSequence(rows)).toBe(3);
    expect(getNextSequence([])).toBe(0);
  });

  it('upsertStoredMessages thay row cũ, thêm row mới, giữ thứ tự', () => {
    const updated = { ...rows[1], content: 'đã sửa' };
    const result = upsertStoredMessages(rows, [updated]);
    expect(result.map((r) => r.content)).toEqual(['a', 'đã sửa', 'c']);

    const added: StoredMessage = { id: 'new', chatId: 'c1', role: 'user', content: 'mới', parentId: ROOT, seq: 3, branchOrder: 2, branchTieBreaker: 'new', createdAt: 9 };
    const result2 = upsertStoredMessages(rows, [added]);
    expect(result2).toHaveLength(4);
    expect(result2[3].id).toBe('new');
  });
});

describe('getFinalStoredStatus', () => {
  it('map finishReason sang status (mặc định complete cho message legacy)', () => {
    expect(getFinalStoredStatus('stop')).toBe('complete');
    expect(getFinalStoredStatus('abort')).toBe('aborted');
    expect(getFinalStoredStatus('error')).toBe('error');
    expect(getFinalStoredStatus(undefined)).toBe('complete');
  });
});
