/**
 * Tests cho bg-jobs store — file-backed job nền cho shell (bg_run/bg_status).
 * Chạy node với tmpdir thật (fs là phần của contract, không mock).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BgJobStore, MAX_JOBS, MAX_RUNNING } from '../lib/bg-jobs.cjs';

let dir: string;
let store: InstanceType<typeof BgJobStore>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vyen-bg-jobs-'));
  store = new BgJobStore(dir);
});

describe('BgJobStore', () => {
  it('create → get: meta đầy đủ, status mặc định running', () => {
    const rec = store.create({ id: 'bg-1', command: 'npm test', pid: 123 });
    expect(rec.status).toBe('running');
    expect(rec.exitCode).toBeNull();
    const back = store.get('bg-1');
    expect(back?.command).toBe('npm test');
    expect(back?.pid).toBe(123);
  });

  it('update ghi đè trường, job lạ trả null', () => {
    store.create({ id: 'bg-2', command: 'x' });
    const updated = store.update('bg-2', { status: 'done', exitCode: 0 });
    expect(updated?.status).toBe('done');
    expect(store.get('bg-khong-ton-tai')).toBeNull();
    expect(store.update('bg-khong-ton-tai', { status: 'done' })).toBeNull();
  });

  it('readTail trả đuôi log, không có log → rỗng', () => {
    store.create({ id: 'bg-3', command: 'x' });
    writeFileSync(store.logPath('bg-3'), 'a'.repeat(3000) + 'KET_QUA_CUOI');
    // 20 ký tự CUỐI của log — gồm cả phần 'a' liền trước marker.
    expect(store.readTail('bg-3', 20)).toBe('a'.repeat(8) + 'KET_QUA_CUOI');
    expect(store.readTail('bg-4', 20)).toBe('');
  });

  it('list sắp mới nhất trước; runningCount chỉ đếm running', () => {
    store.create({ id: 'bg-a', command: 'a' });
    store.create({ id: 'bg-b', command: 'b' });
    store.update('bg-a', { status: 'done', exitCode: 0 });
    expect(store.list().map((j) => j.id)).toEqual(['bg-b', 'bg-a']);
    expect(store.runningCount()).toBe(1);
  });

  it('reconcile: job running pid chết → done + ghi chú; pid sống giữ nguyên', () => {
    store.create({ id: 'bg-dead', command: 'x', pid: 111 });
    store.create({ id: 'bg-alive', command: 'y', pid: 222 });
    store.reconcile((pid: number) => pid === 222);
    expect(store.get('bg-dead')?.status).toBe('done');
    expect(store.get('bg-dead')?.note).toBeTruthy();
    expect(store.get('bg-alive')?.status).toBe('running');
  });

  it('prune bỏ job cũ nhất nhưng KHÔNG đụng job đang chạy', () => {
    const many = Array.from({ length: MAX_JOBS + 5 }, (_, i) =>
      store.create({ id: `bg-p${i}`, command: 'x' }),
    );
    // Các job đầu (cũ nhất) đã done — có thể bị dọn; job mới nhất phải còn.
    store.update('bg-p0', { status: 'done', exitCode: 0 });
    store.update('bg-p1', { status: 'failed', exitCode: 1 });
    store.prune(MAX_JOBS);
    expect(store.get('bg-p0')).toBeNull();
    expect(existsSync(store.logPath('bg-p0'))).toBe(false);
    const newest = many[many.length - 1];
    expect(store.get(newest.id)).not.toBeNull();
  });

  it('hằng số hợp lý: max running 5, max jobs 50', () => {
    expect(MAX_RUNNING).toBe(5);
    expect(MAX_JOBS).toBe(50);
  });
});
