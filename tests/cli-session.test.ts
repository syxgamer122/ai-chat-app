import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  saveCliSession,
  listCliSessions,
  getLatestCliSession,
  loadCliSession,
  renameCliSession,
  type CliSessionData,
} from '@/lib/cli/session-manager';

describe('CLI Session Manager (Goose P2-8)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyen-cli-session-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('lưu phiên hội thoại CLI vào .vyen/sessions/ và nạp lại chính xác', () => {
    const session1: CliSessionData = {
      id: 'session-123',
      name: 'Phân tích mã nguồn',
      workspace: tmpDir,
      createdAt: 1000,
      updatedAt: 2000,
      history: [
        { role: 'user', content: 'Hãy kiểm tra thư mục' },
        { role: 'assistant', content: 'Đã tìm thấy 5 tệp tin' },
      ],
    };

    saveCliSession(tmpDir, session1);

    const loaded = loadCliSession(tmpDir, 'session-123');
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe('session-123');
    expect(loaded?.name).toBe('Phân tích mã nguồn');
    expect(loaded?.history).toHaveLength(2);
  });

  it('liệt kê danh sách phiên sắp xếp theo thời gian mới nhất (updatedAt giảm dần)', () => {
    const s1: CliSessionData = {
      id: 's1',
      name: 'Phiên cũ',
      workspace: tmpDir,
      createdAt: 100,
      updatedAt: 200,
      history: [],
    };
    const s2: CliSessionData = {
      id: 's2',
      name: 'Phiên mới nhất',
      workspace: tmpDir,
      createdAt: 300,
      updatedAt: 500,
      history: [],
    };
    const s3: CliSessionData = {
      id: 's3',
      name: 'Phiên trung gian',
      workspace: tmpDir,
      createdAt: 150,
      updatedAt: 350,
      history: [],
    };

    saveCliSession(tmpDir, s1);
    saveCliSession(tmpDir, s2);
    saveCliSession(tmpDir, s3);

    const list = listCliSessions(tmpDir).filter((s) => ['s1', 's2', 's3'].includes(s.id));
    expect(list.map((s) => s.id)).toEqual(['s2', 's3', 's1']);

    const latest = getLatestCliSession(tmpDir);
    expect(latest?.id).toBe('s2');
  });

  it('tìm và nạp phiên theo tên tiếng Việt không dấu hoặc có dấu', () => {
    const session: CliSessionData = {
      id: 's-react-hooks',
      name: 'Tối ưu hoá React Hooks và Bộ nhớ',
      workspace: tmpDir,
      createdAt: 1000,
      updatedAt: 2000,
      history: [],
    };
    saveCliSession(tmpDir, session);

    // Tìm chính xác bằng id
    expect(loadCliSession(tmpDir, 's-react-hooks')?.id).toBe('s-react-hooks');

    // Tìm bằng tiếng Việt có dấu
    expect(loadCliSession(tmpDir, 'Tối ưu hoá')?.id).toBe('s-react-hooks');

    // Tìm bằng tiếng Việt không dấu viết thường
    expect(loadCliSession(tmpDir, 'toi uu hoa react')?.id).toBe('s-react-hooks');

    // Tìm không ra trả về null
    expect(loadCliSession(tmpDir, 'khong-ton-tai')).toBeNull();
    expect(loadCliSession(tmpDir, '   ')).toBeNull();
  });

  it('đổi tên phiên thành công và cập nhật updatedAt', () => {
    const session: CliSessionData = {
      id: 's-rename',
      name: 'Tên ban đầu',
      workspace: tmpDir,
      createdAt: 1000,
      updatedAt: 1000,
      history: [],
    };
    saveCliSession(tmpDir, session);

    const ok = renameCliSession(tmpDir, 's-rename', 'Tên mới sau khi đổi');
    expect(ok).toBe(true);

    const reloaded = loadCliSession(tmpDir, 's-rename');
    expect(reloaded?.name).toBe('Tên mới sau khi đổi');
    expect(reloaded?.updatedAt).toBeGreaterThan(1000);

    const failed = renameCliSession(tmpDir, 'khong-co', 'Tên mới');
    expect(failed).toBe(false);
  });
});
