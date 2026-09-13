import { describe, expect, it, vi } from 'vitest';
import {
  recallFromMemoryList,
  recallChatSessions,
  type MemorySearchChat,
  type ChatRecallItem,
} from '@/lib/chat-recall';
import { shouldAutoApprove } from '@/lib/auto-pilot';
import { isToolDenied } from '@/lib/tool-catalog';
import type { ChatSearchResult } from '@/lib/chat-search';
import type { ChatSession } from '@/lib/db';

describe('chat_recall — InMemory Matcher & Tiếng Việt', () => {
  const sampleChats: MemorySearchChat[] = [
    {
      id: 'chat-react',
      title: 'Hướng dẫn cài đặt React Hooks',
      updatedAt: 1726000000000,
      workspacePath: 'C:/Projects/web-app',
      messages: [
        { role: 'user', content: 'Làm thế nào để sử dụng useMemo và useCallback trong React?' },
        { role: 'assistant', content: 'useMemo dùng để cache giá trị tính toán, còn useCallback cache function instance.' },
      ],
    },
    {
      id: 'chat-sqlite',
      title: 'Tối ưu hóa cơ sở dữ liệu SQLite',
      updatedAt: 1726100000000,
      workspacePath: 'C:/Projects/db-tool',
      messages: [
        { role: 'user', content: 'Giải thích cách dùng index và explain query plan trong SQLite' },
        { role: 'assistant', content: 'Dùng CREATE INDEX để tăng tốc độ tìm kiếm và EXPLAIN QUERY PLAN để kiểm tra.' },
      ],
    },
    {
      id: 'chat-docker',
      title: 'Thiết lập Docker compose cho microservices',
      updatedAt: 1726200000000,
      workspacePath: 'C:/Projects/infra',
      messages: [
        { role: 'user', content: 'Viết docker-compose.yml cho redis và postgres' },
      ],
    },
  ];

  it('tìm đúng session khi hỏi bằng tiếng Việt KHÔNG DẤU', () => {
    const results = recallFromMemoryList(sampleChats, 'huong dan react hooks');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sessionId).toBe('chat-react');
    expect(results[0].title).toBe('Hướng dẫn cài đặt React Hooks');
    expect(results[0].workspacePath).toBe('C:/Projects/web-app');
  });

  it('tìm đúng session khi hỏi bằng tiếng Việt CÓ DẤU', () => {
    const results = recallFromMemoryList(sampleChats, 'cơ sở dữ liệu SQLite');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sessionId).toBe('chat-sqlite');
    expect(results[0].title).toBe('Tối ưu hóa cơ sở dữ liệu SQLite');
  });

  it('tìm thấy nội dung nằm trong tin nhắn', () => {
    const results = recallFromMemoryList(sampleChats, 'usecallback cache function');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].sessionId).toBe('chat-react');
    expect(results[0].snippet).toContain('useCallback');
  });

  it('giới hạn số lượng kết quả theo tham số limit', () => {
    const results = recallFromMemoryList(sampleChats, 'để', 1);
    expect(results.length).toBe(1);
  });

  it('trả về mảng rỗng khi query không khớp hoặc chỉ chứa khoảng trắng', () => {
    expect(recallFromMemoryList(sampleChats, '')).toEqual([]);
    expect(recallFromMemoryList(sampleChats, '   ')).toEqual([]);
    expect(recallFromMemoryList(sampleChats, 'từ_khoá_hoàn_toàn_không_tồn_tại_12345')).toEqual([]);
  });
});

describe('chat_recall — recallChatSessions integration', () => {
  it('định dạng kết quả và chuyển đổi ngày sang ISO string', async () => {
    const mockSearchResults: ChatSearchResult[] = [
      {
        chat: {
          id: 'session-123',
          title: 'Hội thoại kiểm thử',
          pinned: 0,
          createdAt: 1700000000000,
          updatedAt: 1700000005000,
          workspacePath: '/home/user/app',
        } as ChatSession,
        score: 15,
        snippets: [
          [{ text: 'Đoạn trích ', match: false }, { text: 'khớp từ khoá', match: true }],
        ],
      },
    ];

    const mockSearchFn = vi.fn().mockResolvedValue(mockSearchResults);

    const results = await recallChatSessions('từ khoá', 5, { searchFn: mockSearchFn });

    expect(mockSearchFn).toHaveBeenCalledWith('từ khoá', { signal: undefined });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      sessionId: 'session-123',
      title: 'Hội thoại kiểm thử',
      snippet: 'Đoạn trích khớp từ khoá',
      matchedAt: new Date(1700000005000).toISOString(),
      score: 15,
      workspacePath: '/home/user/app',
    });
  });

  it('fallback snippet về tiêu đề nếu không có snippets trong kết quả', async () => {
    const mockSearchResults: ChatSearchResult[] = [
      {
        chat: {
          id: 'session-no-snippet',
          title: 'Tiêu đề dự phòng',
          pinned: 0,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        } as ChatSession,
        score: 5,
        snippets: [],
      },
    ];

    const results = await recallChatSessions('tiêu đề', 5, {
      searchFn: async () => mockSearchResults,
    });

    expect(results[0].snippet).toBe('Tiêu đề dự phòng');
  });
});

describe('chat_recall — Quyền & Auto-pilot classification', () => {
  it('chat_recall được phân loại là READ_ONLY và tự động duyệt trong smart mode', () => {
    const approved = shouldAutoApprove({
      toolName: 'chat_recall',
      args: { query: 'React' },
      policy: 'smart',
      autoPilotEnabled: true,
    });
    expect(approved).toBe(true);
  });

  it('chat_recall bị chặn khi quyền per-tool là deny', () => {
    const denied = isToolDenied('chat_recall', {
      chat_recall: 'deny',
    });
    expect(denied).toBe(true);
  });

  it('chat_recall bị chặn khi category memory bị deny', () => {
    const denied = isToolDenied('chat_recall', {
      memory: 'deny',
    });
    expect(denied).toBe(true);
  });
});
