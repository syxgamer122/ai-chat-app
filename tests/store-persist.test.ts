/**
 * Persist settings của store thật (zustand persist middleware).
 *
 * Bug gốc: partialize thiếu agentTools + forceEmulatedTools — hai toggle user
 * bấm trong composer và gửi kèm mỗi request, F5 là mất.
 *
 * Lưu ý môi trường: zustand 5 gắn api.persist SAU khi kiểm storage; trong
 * node không có window.localStorage nên nó return sớm và store KHÔNG có
 * .persist. Phải dựng stub window trước rồi mới import store (dynamic import
 * vì import tĩnh bị hoist lên trước phần setup).
 */

import { beforeAll, describe, expect, it } from 'vitest';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

type StoreModule = typeof import('@/lib/store');
let useAppStore: StoreModule['useAppStore'];

beforeAll(async () => {
  (globalThis as { window?: unknown }).window = { localStorage: new MemoryStorage() };
  ({ useAppStore } = await import('@/lib/store'));
});

type PersistedShape = {
  activeProviderId?: unknown;
  theme?: unknown;
  settings?: Record<string, unknown>;
};

type PersistOptions = {
  partialize?: (s: unknown) => PersistedShape;
  merge?: (persisted: unknown, current: unknown) => { settings?: Record<string, unknown> };
  version?: number;
};

/** Mọi khoá settings mà partialize phải giữ qua reload. */
const REQUIRED_SETTING_KEYS = [
  'model',
  'visionModel',
  'temperature',
  'thinkingLevel',
  'systemPrompt',
  'perf',
  'sendOnEnter',
  'autoCompact',
  'webSearch',
  'agentTools',
  'forceEmulatedTools',
  'agentMode',
  'stagingSandbox',
  'autoPilot',
  'approvalPolicy',
  'toolPermissions',
] as const;

describe('partialize — đủ khoá settings sống qua reload', () => {
  it('chứa toàn bộ khoá yêu cầu, kể cả agentTools + forceEmulatedTools', () => {
    const { partialize } = useAppStore.persist.getOptions() as PersistOptions;
    expect(partialize).toBeTypeOf('function');
    const persisted = partialize!(useAppStore.getState());
    const keys = Object.keys(persisted.settings ?? {});
    for (const k of REQUIRED_SETTING_KEYS) {
      // Đảo điều kiện: thiếu khoá nào (đúng bug cũ thiếu agentTools) → đỏ ở khoá đó.
      expect(keys, `partialize thiếu khoá settings.${k}`).toContain(k);
    }
  });

  it('phản ánh giá trị user vừa đổi, không phải mặc định cứng', () => {
    useAppStore.getState().updateSettings({ agentTools: false, forceEmulatedTools: true });
    const { partialize } = useAppStore.persist.getOptions() as PersistOptions;
    const persisted = partialize!(useAppStore.getState());
    expect(persisted.settings?.agentTools).toBe(false);
    expect(persisted.settings?.forceEmulatedTools).toBe(true);
  });
});

describe('merge — khôi phục persisted không cần tăng version', () => {
  it('agentTools + forceEmulatedTools từ storage đè lên default', () => {
    const { merge } = useAppStore.persist.getOptions() as PersistOptions;
    expect(merge).toBeTypeOf('function');
    const merged = merge!(
      { settings: { agentTools: false, forceEmulatedTools: true } },
      useAppStore.getState(),
    );
    expect(merged.settings?.agentTools).toBe(false);
    expect(merged.settings?.forceEmulatedTools).toBe(true);
  });

  it('storage cũ không có khoá mới thì giữ default hiện tại', () => {
    const { merge } = useAppStore.persist.getOptions() as PersistOptions;
    const merged = merge!({ settings: {} }, useAppStore.getState());
    expect(typeof merged.settings?.agentTools).toBe('boolean');
    expect(typeof merged.settings?.forceEmulatedTools).toBe('boolean');
  });

  it('perf.throttleMs user từng đặt vẫn thắng mặc định mới', () => {
    const { merge } = useAppStore.persist.getOptions() as PersistOptions;
    const merged = merge!(
      { settings: { perf: { throttleMs: 250 } } },
      useAppStore.getState(),
    );
    expect(merged.settings?.perf).toMatchObject({ throttleMs: 250 });
  });
});

describe('default throttleMs', () => {
  it('phiên mới (chưa có storage) bắt đầu ở 50ms để token lên sớm hơn', () => {
    expect(useAppStore.getState().settings.perf.throttleMs).toBe(50);
  });

  it('version persist vẫn là 2 — thêm field optional không cần migrate', () => {
    const { version } = useAppStore.persist.getOptions() as PersistOptions;
    expect(version).toBe(2);
  });
});
