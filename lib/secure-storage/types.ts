/**
 * lib/secure-storage/types.ts
 *
 * Định nghĩa hợp đồng lưu trữ bí danh an toàn (Hardware-Backed Secret Storage).
 */

export interface SecureKeyringProvider {
  readonly providerName: string;
  isAvailable(): boolean;
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<boolean>;
  deleteSecret(key: string): Promise<boolean>;
}
