/**
 * Re-export các hàm Rate Limit & Trích xuất IP an toàn từ lib/security.ts
 */
export {
  checkRateLimit,
  getClientIp,
  normalizeIp,
  verifySameOrigin,
  verifyAccessAuth,
} from './security';
