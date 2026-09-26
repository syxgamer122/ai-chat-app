/**
 * lib/secure-storage/keyring-bridge.ts
 *
 * Keyring Bridge — Cung cấp giao diện truy xuất và lưu trữ API Keys an toàn.
 * Hỗ trợ điều phối giữa Desktop Native OS Keyring (DPAPI/Keychain/safeStorage) và WebCryptoVault.
 */

import { WebCryptoVault } from './web-crypto-vault';
import type { SecureKeyringProvider } from './types';

export class KeyringBridge implements SecureKeyringProvider {
  public readonly providerName = 'keyring_bridge';
  private webVault = new WebCryptoVault();

  public isAvailable(): boolean {
    return true;
  }

  public async setSecret(key: string, value: string): Promise<boolean> {
    // 1. Kiểm tra nếu có Desktop Bridge IPC (safeStorage hoặc native keyring)
    if (typeof window !== 'undefined') {
      const bridge = (window as any).vyen;
      if (bridge?.secure?.set) {
        try {
          const res = await bridge.secure.set(key, value);
          if (res?.ok) return true;
        } catch {}
      } else if (bridge?.keyring?.setSecret) {
        try {
          const res = await bridge.keyring.setSecret(key, value);
          if (res) return true;
        } catch {}
      }
    }

    // 2. Fallback về Web Crypto Vault (AES-GCM 256-bit + PBKDF2)
    return this.webVault.setSecret(key, value);
  }

  public async getSecret(key: string): Promise<string | null> {
    // 1. Kiểm tra nếu có Desktop Bridge IPC
    if (typeof window !== 'undefined') {
      const bridge = (window as any).vyen;
      if (bridge?.secure?.get) {
        try {
          const res = await bridge.secure.get(key);
          if (res && res.value !== undefined && res.value !== null) {
            return res.value;
          }
        } catch {}
      } else if (bridge?.keyring?.getSecret) {
        try {
          const val = await bridge.keyring.getSecret(key);
          if (val !== undefined && val !== null) return val;
        } catch {}
      }
    }

    // 2. Fallback về Web Crypto Vault
    return this.webVault.getSecret(key);
  }

  public async deleteSecret(key: string): Promise<boolean> {
    if (typeof window !== 'undefined') {
      const bridge = (window as any).vyen;
      if (bridge?.secure?.delete) {
        try {
          const res = await bridge.secure.delete(key);
          if (res?.ok) return true;
        } catch {}
      } else if (bridge?.keyring?.deleteSecret) {
        try {
          await bridge.keyring.deleteSecret(key);
        } catch {}
      }
    }
    return this.webVault.deleteSecret(key);
  }
}

export const keyringBridge = new KeyringBridge();
