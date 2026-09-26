/**
 * lib/secure-storage/web-crypto-vault.ts
 *
 * Web Crypto Vault — Lưu trữ bí danh mã hóa AES-GCM 256-bit kết hợp PBKDF2 (100,000 rounds).
 * Hoàn toàn zero-dependency, hoạt động trên cả trình duyệt Web và Node.js test runtime.
 */

import type { SecureKeyringProvider } from './types';

export class WebCryptoVault implements SecureKeyringProvider {
  public readonly providerName = 'web_crypto_aes_gcm';
  private inMemoryStore = new Map<string, string>();
  private masterSalt = new Uint8Array([12, 45, 78, 90, 23, 56, 89, 12, 34, 67, 89, 10, 45, 67, 89, 12]);

  public isAvailable(): boolean {
    return typeof crypto !== 'undefined' && Boolean(crypto.subtle);
  }

  private async deriveKey(passphrase: string): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const rawKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(passphrase),
      { name: 'PBKDF2' },
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.masterSalt,
        iterations: 100_000,
        hash: 'SHA-256',
      },
      rawKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  public async setSecret(key: string, value: string, passphrase = 'vyen-local-vault'): Promise<boolean> {
    try {
      const cryptoKey = await this.deriveKey(passphrase);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        cryptoKey,
        enc.encode(value)
      );

      const payload = JSON.stringify({
        iv: Array.from(iv),
        data: Array.from(new Uint8Array(ciphertext)),
      });

      this.inMemoryStore.set(key, payload);
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`vyen:sec:${key}`, payload);
      }
      return true;
    } catch {
      return false;
    }
  }

  public async getSecret(key: string, passphrase = 'vyen-local-vault'): Promise<string | null> {
    try {
      let payloadStr = this.inMemoryStore.get(key);
      if (!payloadStr && typeof localStorage !== 'undefined') {
        payloadStr = localStorage.getItem(`vyen:sec:${key}`) || undefined;
      }
      if (!payloadStr) return null;

      const { iv, data } = JSON.parse(payloadStr);
      const cryptoKey = await this.deriveKey(passphrase);
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(iv) },
        cryptoKey,
        new Uint8Array(data)
      );

      return new TextDecoder().decode(decrypted);
    } catch {
      return null;
    }
  }

  public async deleteSecret(key: string): Promise<boolean> {
    this.inMemoryStore.delete(key);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`vyen:sec:${key}`);
    }
    return true;
  }
}
