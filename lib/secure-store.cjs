'use strict';

/*
 * Secure store — kho mã hoá opt-in cho dữ liệu nhạy cảm (API key provider).
 *
 * Dùng safeStorage của Electron (chỉmix credential manager của OS: DPAPI trên
 * Windows, Keychain trên macOS, libsecret trên Linux) thay vì thêm dependency
 * keytar: safeStorage có sẵn, đủ dùng cho cặp key→value nhỏ.
 *
 * TỪ CHỐI plaintext fallback một cách CÓ CHỦ Ý: nếu safeStorage không khả dụng
 * (Linux thiếu libsecret, policy doanh nghiệp...), set() ném lỗi rõ ràng thay
 * vì lặng lẽ lưu key không mã hoá — người dùng phải Biết key của mình không
 * được bảo vệ, thay vì tin nhầm.
 *
 * File persist `vyen-secure.json` ghi ATOMIC (ghi .tmp rồi rename): mất điện
 * giữa chừng để lại file .tmp rác chứ không làm hỏng kho thật.
 *
 * Toàn bộ dependencies (safeStorage + I/O) được TIÊM qua factory để test chạy
 * được trong node thuần không cần Electron (pattern tests/mcp-electron.test.ts).
 */

/** Mã hoá base64 an toàn cho Buffer của Node lẫn polyfill test. */
function toB64(buf) {
  return Buffer.from(buf).toString('base64');
}

function fromB64(s) {
  return Buffer.from(s, 'base64');
}

/**
 * Kho mã hoá thuần — mọi副作用 đều đi qua `deps`.
 *
 * @param deps.safeStorage object có isEncryptionAvailable/encryptString/
 *   decryptString (safeStorage thật hoặc fake của test).
 * @param deps.read () => string | null — nội dung file persist hiện tại.
 * @param deps.write (content: string) => void — ghi lại file persist.
 */
function createSecureStore({ safeStorage, read, write }) {
  function loadEntries() {
    const raw = read();
    if (typeof raw !== 'string' || !raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.version === 1 &&
        parsed.entries &&
        typeof parsed.entries === 'object'
      ) {
        return parsed.entries;
      }
    } catch {
      // File rác/hỏng nửa chừng — coi như rỗng; lần save kế sẽ ghi đè lành lại.
    }
    return {};
  }

  /** Đọc + bọc mọi lỗi của safeStorage thành false — caller chỉ cần boolean. */
  function available() {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  function get(key) {
    const entries = loadEntries();
    const blob = entries[key];
    if (typeof blob !== 'string' || !blob) return null;
    if (!available()) return null;
    try {
      const plain = safeStorage.decryptString(fromB64(blob));
      return typeof plain === 'string' ? plain : null;
    } catch {
      // Entry không decrypt được (đổi máy, đổi credential OS, file hỏng) —
      // trả null để caller coi như chưa từng lưu, đừng ném vỡ luồng khởi động.
      return null;
    }
  }

  function set(key, value) {
    if (!available()) {
      throw new Error(
        'Máy này không bật được mã hoá an toàn (safeStorage) nên không lưu key mã hoá được. ' +
          'Thử lại sau khi cấp quyền cho ứng dụng, hoặc lưu key theo cách thường.',
      );
    }
    const entries = loadEntries();
    entries[key] = toB64(safeStorage.encryptString(value));
    write(JSON.stringify({ version: 1, entries }));
  }

  function del(key) {
    const entries = loadEntries();
    if (!(key in entries)) return;
    delete entries[key];
    write(JSON.stringify({ version: 1, entries }));
  }

  return { available, get, set, del };
}

/**
 * Dependencies I/O thật cho createSecureStore: một file JSON trong userData,
 * ghi atomic (tmp + rename) để đứt giữa chừng không phá kho cũ.
 */
function createFileStoreDeps(filePath, fs) {
  const nodeFs = fs ?? require('node:fs');
  const path = require('node:path');
  const tmpPath = `${filePath}.tmp`;
  return {
    read: () => {
      try {
        return nodeFs.readFileSync(filePath, 'utf8');
      } catch {
        return null; // chưa có file lần đầu — bình thường.
      }
    },
    write: (content) => {
      nodeFs.mkdirSync(path.dirname(filePath), { recursive: true });
      nodeFs.writeFileSync(tmpPath, content, 'utf8');
      nodeFs.renameSync(tmpPath, filePath);
    },
  };
}

module.exports = { createSecureStore, createFileStoreDeps };
