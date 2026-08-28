/**
 * Ba lỗi an toàn của agent coding, phát hiện khi kiểm toán tính năng.
 * Mỗi ca dưới đây ĐỀU fail trên code trước khi sửa.
 */

import { describe, expect, it } from 'vitest';
import { normalizeRelPath } from '@/lib/fs-access';
import { replaceMostSimilarChunk } from '@/lib/edit-blocks';
import {
  captureFile,
  captureToSnapshot,
  getUndoTarget,
  newTurnCapture,
  WS_MAX_FILES_PER_SNAPSHOT,
} from '@/lib/workspace-checkpoints';

/* ------------------------------------------------------------------ */
/* 1. Path traversal                                                   */
/* ------------------------------------------------------------------ */

describe('normalizeRelPath — chống leo thư mục', () => {
  /* Bản cũ return sớm khi thấy '.', bỏ qua luôn bước kiểm tra '..':
       'a/./../../b' -> 'a/../../b'   (thoát khỏi workspace)
     Đây là ghi file RA NGOÀI thư mục người dùng đã cấp quyền. */
  it('kết hợp "." và ".." KHÔNG được thoát ra ngoài', () => {
    expect(normalizeRelPath('a/./../../b')).toBeNull();
    expect(normalizeRelPath('./../../x')).toBeNull();
    expect(normalizeRelPath('a/.././../b')).toBeNull();
  });

  it('segment toàn dấu chấm bị từ chối', () => {
    expect(normalizeRelPath('....//x')).toBeNull();
    expect(normalizeRelPath('a/...././b')).toBeNull();
    expect(normalizeRelPath('...')).toBeNull();
  });

  it('".." thuần và đường dẫn tuyệt đối vẫn bị chặn', () => {
    expect(normalizeRelPath('../etc/passwd')).toBeNull();
    expect(normalizeRelPath('..')).toBeNull();
    expect(normalizeRelPath('C:/win')).toBeNull();
    expect(normalizeRelPath('//server/share')).toBeNull();
    expect(normalizeRelPath('a\\..\\..\\b')).toBeNull();
  });

  it('đường dẫn hợp lệ KHÔNG bị ảnh hưởng', () => {
    expect(normalizeRelPath('src/index.ts')).toBe('src/index.ts');
    expect(normalizeRelPath('a/./b')).toBe('a/b');
    expect(normalizeRelPath('a//b')).toBe('a/b');
    expect(normalizeRelPath('/abs/path')).toBe('abs/path');
    expect(normalizeRelPath('.')).toBe('');
    expect(normalizeRelPath('')).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* 2. SEARCH mơ hồ                                                     */
/* ------------------------------------------------------------------ */

const MULTI_MATCH = [
  'function a() {',
  '  return 1;',
  '}',
  '',
  'function b() {',
  '  return 1;',
  '}',
].join('\n');

describe('fs_edit — SEARCH phải khớp DUY NHẤT', () => {
  /* Mô tả tool nói với model rằng SEARCH "phải khớp DUY NHẤT". Bản cũ lại
     lặng lẽ sửa chỗ khớp ĐẦU TIÊN, nên model tưởng an toàn còn người dùng
     chỉ thấy diff một chỗ rồi bấm duyệt — sai chỗ mà không ai biết. */
  it('khớp nhiều chỗ → TỪ CHỐI kèm hướng dẫn mở rộng ngữ cảnh', () => {
    const r = replaceMostSimilarChunk(MULTI_MATCH, '  return 1;', '  return 999;');
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/NHIỀU vị trí/i);
  });

  it('khớp duy nhất → vẫn sửa bình thường', () => {
    const r = replaceMostSimilarChunk(
      MULTI_MATCH,
      'function b() {\n  return 1;\n}',
      'function b() {\n  return 2;\n}',
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('return 2');
    // Không đụng tới hàm a.
    expect(r.text).toContain('function a() {\n  return 1;\n}');
  });

  it('SEARCH rỗng vẫn tạo được file mới (không bị chặn nhầm)', () => {
    const r = replaceMostSimilarChunk('', '', 'nội dung mới');
    expect(r.ok).toBe(true);
    expect(r.text).toBe('nội dung mới');
  });

  it('SEARCH không tồn tại → báo lỗi rõ, không sửa bừa', () => {
    const r = replaceMostSimilarChunk(MULTI_MATCH, 'khong-he-co', 'x');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Trần số file mỗi snapshot                                        */
/* ------------------------------------------------------------------ */

describe('checkpoint — trần số file được áp thật', () => {
  /* WS_MAX_FILES_PER_SNAPSHOT từng được khai báo nhưng KHÔNG nơi nào dùng:
     một lượt sửa 50 file nhồi hết vào một record IndexedDB. */
  it(`giữ tối đa ${WS_MAX_FILES_PER_SNAPSHOT} file`, () => {
    const turn = newTurnCapture('c1');
    for (let i = 0; i < 50; i++) {
      captureFile(turn, { path: `f${i}.ts`, status: 'ok', content: 'x' });
    }
    expect(turn.files.length).toBe(WS_MAX_FILES_PER_SNAPSHOT);
  });

  it('vượt trần → đánh dấu incomplete và CHẶN rollback', () => {
    const turn = newTurnCapture('c2');
    for (let i = 0; i < WS_MAX_FILES_PER_SNAPSHOT + 1; i++) {
      captureFile(turn, { path: `f${i}.ts`, status: 'ok', content: 'x' });
    }
    const snap = captureToSnapshot(turn);
    expect(snap.incomplete).toBe(true);
    // Snapshot thiếu dữ liệu không được phép restore nửa vời.
    expect(getUndoTarget([snap])).toBeNull();
  });

  it('dưới trần → snapshot đầy đủ, rollback được', () => {
    const turn = newTurnCapture('c3');
    captureFile(turn, { path: 'a.ts', status: 'ok', content: 'truoc' });
    captureFile(turn, { path: 'b.ts', status: 'missing' });
    const snap = captureToSnapshot(turn);
    expect(snap.incomplete).toBeUndefined();
    expect(getUndoTarget([snap])?.id).toBe(snap.id);
  });

  it('first-wins theo path vẫn đúng (sửa 2 lần → giữ bản TRƯỚC lần đầu)', () => {
    const turn = newTurnCapture('c4');
    captureFile(turn, { path: 'a.ts', status: 'ok', content: 'ban-goc' });
    captureFile(turn, { path: 'a.ts', status: 'ok', content: 'ban-giua' });
    expect(turn.files).toHaveLength(1);
    expect(turn.files[0].content).toBe('ban-goc');
  });
});
