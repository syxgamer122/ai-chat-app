/**
 * tests/secure-keyring-vault.test.ts
 *
 * Kiểm tra Hardware-Backed Secret Storage & Web Crypto AES-GCM Vault (Sprint 6.3).
 * Đảm bảo mã hóa an toàn zero-dependency cho BYOK Secrets (OpenAI/Anthropic/Google).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { WebCryptoVault } from '../lib/secure-storage/web-crypto-vault';
import { KeyringBridge } from '../lib/secure-storage/keyring-bridge';

describe('=== RUNNING SECURE KEYRING & HARDWARE STORAGE TESTS (PHASE 6 SPRINT 6.3) ===', () => {
  it('1. WebCryptoVault: Mã hoá AES-GCM và giải mã chính xác', async () => {
    const vault = new WebCryptoVault();
    assert.equal(vault.isAvailable(), true);

    const secretKey = 'test_openai_api_key';
    const secretValue = 'sk-proj-super-secret-1234567890abcdef';

    // Lưu bí danh
    const saved = await vault.setSecret(secretKey, secretValue, 'custom-passphrase');
    assert.equal(saved, true);

    // Giải mã bí danh
    const retrieved = await vault.getSecret(secretKey, 'custom-passphrase');
    assert.equal(retrieved, secretValue);

    // Xóa bí danh
    const deleted = await vault.deleteSecret(secretKey);
    assert.equal(deleted, true);

    const afterDelete = await vault.getSecret(secretKey, 'custom-passphrase');
    assert.equal(afterDelete, null);
  });

  it('2. WebCryptoVault: Thất bại khi giải mã với passphrase sai', async () => {
    const vault = new WebCryptoVault();
    const secretKey = 'test_anthropic_api_key';
    const secretValue = 'sk-ant-api03-abcdef';

    await vault.setSecret(secretKey, secretValue, 'correct-passphrase');

    // Cố giải mã bằng passphrase sai
    const failed = await vault.getSecret(secretKey, 'wrong-passphrase');
    assert.equal(failed, null, 'Phải trả về null khi passphrase sai');
  });

  it('3. KeyringBridge: Điều phối lưu và nạp secret qua fallback an toàn', async () => {
    const bridge = new KeyringBridge();
    const key = 'test_provider_key';
    const val = 'sk-test-value-xyz';

    const saved = await bridge.setSecret(key, val);
    assert.equal(saved, true);

    const retrieved = await bridge.getSecret(key);
    assert.equal(retrieved, val);

    await bridge.deleteSecret(key);
    const afterDelete = await bridge.getSecret(key);
    assert.equal(afterDelete, null);
  });
});
