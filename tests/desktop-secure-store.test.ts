/**
 * Tests cho secure store (kho mã hoá opt-in bằng safeStorage — giai đoạn 2).
 *
 * Toàn bộ dependencies (safeStorage + I/O file) tiêm qua factory nên test chạy
 * node thuần: fake safeStorage mã hoá đảo base64 (đủ kiểm tra roundtrip + lỗi),
 * I/O là Map hoặc tmpdir thật (cho createFileStoreDeps — xác nhận shape file
 * JSON persist + ghi atomic).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSecureStore, createFileStoreDeps } = require('../lib/secure-store.cjs');

/** Fake safeStorage: encrypt/decrypt đảo nhau qua base64; bật/tắt được. */
function fakeSafeStorage({ available = true }: { available?: boolean } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('Failed to decrypt');
      return text.slice(4);
    },
  };
}

function memoryStore(safeStorage = fakeSafeStorage()) {
  let persisted: string | null = null;
  const writes: string[] = [];
  const store = createSecureStore({
    safeStorage,
    read: () => persisted,
    write: (content: string) => {
      writes.push(content);
      persisted = content;
    },
  });
  return { store, get persisted() { return persisted; }, writes };
}

describe('createSecureStore — vòng đời cơ bản', () => {
  it('set → get roundtrip trả đúng giá trị', () => {
    const { store } = memoryStore();
    store.set('provider:abc', 'sk-secret-123');
    expect(store.get('provider:abc')).toBe('sk-secret-123');
  });

  it('get key chưa từng lưu → null (không ném)', () => {
    const { store } = memoryStore();
    expect(store.get('provider:khong-co')).toBeNull();
  });

  it('nhiều entry độc lập; delete bỏ đúng một entry', () => {
    const { store } = memoryStore();
    store.set('provider:a', 'key-a');
    store.set('provider:b', 'key-b');
    store.del('provider:a');
    expect(store.get('provider:a')).toBeNull();
    expect(store.get('provider:b')).toBe('key-b');
  });

  it('delete key không tồn tại không ghi file (no-op)', () => {
    const { store, writes } = memoryStore();
    store.del('provider:chua-co');
    expect(writes.length).toBe(0);
  });

  it('persist đúng shape { version:1, entries } và giá trị đã mã hoá', () => {
    // Truy cập qua property (getter) — destructuring sẽ đóng giá trị null ban đầu.
    const mem = memoryStore();
    mem.store.set('provider:x', 'sk-plain');
    const persisted = mem.persisted as string;
    const parsed = JSON.parse(persisted);
    expect(parsed.version).toBe(1);
    expect(parsed.entries['provider:x']).toBe(Buffer.from('enc:sk-plain').toString('base64'));
    // Key thật KHÔNG bao giờ nằm trong file persist.
    expect(persisted).not.toContain('sk-plain');
  });
});

describe('createSecureStore — safeStorage không khả dụng', () => {
  it('set NÉM lỗi tiếng Việt — không bao giờ lưu plaintext', () => {
    const { store, persisted } = memoryStore(fakeSafeStorage({ available: false }));
    expect(() => store.set('provider:a', 'sk-x')).toThrow(/mã hoá/i);
    expect(persisted).toBeNull();
  });

  it('get khi unavailable → null ngay cả khi có entry cũ', () => {
    const saved = memoryStore();
    saved.store.set('provider:a', 'sk-x');
    // Khởi động lại trên máy MẤT khả năng mã hoá, giữ nguyên file cũ:
    const reopened = createSecureStore({
      safeStorage: fakeSafeStorage({ available: false }),
      read: () => saved.persisted,
      write: () => {},
    });
    expect(reopened.get('provider:a')).toBeNull();
  });

  it('available() nuốt lỗi ném từ isEncryptionAvailable → false', () => {
    const store = createSecureStore({
      safeStorage: { isEncryptionAvailable: () => { throw new Error('boom'); } },
      read: () => null,
      write: () => {},
    });
    expect(store.available()).toBe(false);
  });
});

describe('createSecureStore — dữ liệu hỏng', () => {
  it('file persist rác (không JSON) → coi như rỗng, set vẫn chạy được', () => {
    const { store } = memoryStore();
    // memoryStore khởi đầu null; giả file rác:
    let persisted = '{{{not json';
    const store2 = createSecureStore({
      safeStorage: fakeSafeStorage(),
      read: () => persisted,
      write: (c: string) => { persisted = c; },
    });
    expect(store2.get('provider:any')).toBeNull();
    store2.set('provider:a', 'sk-1');
    expect(store2.get('provider:a')).toBe('sk-1');
  });

  it('entry không decrypt được (đổi máy/credential) → null, không ném', () => {
    let persisted = JSON.stringify({
      version: 1,
      entries: { 'provider:a': Buffer.from('garbage-not-enc').toString('base64') },
    });
    const store = createSecureStore({
      safeStorage: fakeSafeStorage(),
      read: () => persisted,
      write: (c: string) => { persisted = c; },
    });
    expect(store.get('provider:a')).toBeNull();
  });
});

describe('createFileStoreDeps — I/O file thật (tmpdir)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vyen-secure-test-'));
  });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it('roundtrip qua file thật + file .tmp bị rename đi (không sót)', () => {
    try {
      const filePath = path.join(dir, 'vyen-secure.json');
      const deps = createFileStoreDeps(filePath);
      const store = createSecureStore({ safeStorage: fakeSafeStorage(), ...deps });
      store.set('provider:a', 'sk-file');
      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(`${filePath}.tmp`)).toBe(false); // atomic: tmp đã rename
      const raw = readFileSync(filePath, 'utf8');
      expect(raw).toContain('"version":1');
      // Khởi động lại (đọc lại từ đĩa) vẫn decrypt được:
      const reopened = createSecureStore({ safeStorage: fakeSafeStorage(), ...createFileStoreDeps(filePath) });
      expect(reopened.get('provider:a')).toBe('sk-file');
    } finally {
      cleanup();
    }
  });

  it('read khi file chưa tồn tại → null (lần đầu chạy app)', () => {
    try {
      const deps = createFileStoreDeps(path.join(dir, 'chua-co.json'));
      expect(deps.read()).toBeNull();
    } finally {
      cleanup();
    }
  });
});
