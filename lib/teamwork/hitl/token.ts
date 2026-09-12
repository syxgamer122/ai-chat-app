/**
 * Cryptographic HMAC-SHA256 Interrupt Token implementation.
 * Provides time-bounded, tamper-proof tokens securing approval authorizations.
 */

import crypto from 'node:crypto';
import type { HitlInterruptToken } from './types';

export class TokenVerificationError extends Error {
  constructor(message: string, public readonly code: 'EXPIRED' | 'TAMPERED' | 'INVALID_FORMAT' | 'PAYLOAD_MISMATCH') {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export class InterruptTokenManager {
  private readonly secret: Buffer;

  constructor(secret?: string | Buffer) {
    if (!secret) {
      this.secret = crypto.randomBytes(32);
    } else if (typeof secret === 'string') {
      this.secret = Buffer.from(secret, 'utf8');
    } else {
      this.secret = secret;
    }
  }

  /**
   * Computes a deterministic SHA-256 hash of any JSON-serializable payload.
   * Object keys are recursively sorted so key order does not alter the hash.
   */
  public hashPayload(payload: unknown): string {
    const canonicalJson = this.canonicalStringify(payload);
    return crypto.createHash('sha256').update(canonicalJson).digest('hex');
  }

  /**
   * Generates a signed cryptographic interrupt token for a pending approval request.
   */
  public createToken(requestId: string, payload: unknown, ttlMs: number = 15 * 60 * 1000, nowMs: number = Date.now()): HitlInterruptToken {
    if (!requestId || typeof requestId !== 'string') {
      throw new Error('requestId must be a non-empty string');
    }

    const issuedAt = nowMs;
    const expiresAt = issuedAt + Math.max(1000, ttlMs);
    const payloadHash = this.hashPayload(payload);

    const messageToSign = `${requestId}:${issuedAt}:${expiresAt}:${payloadHash}`;
    const signature = crypto.createHmac('sha256', this.secret).update(messageToSign).digest('hex');

    const tokenString = `hitl_v1.${Buffer.from(requestId, 'utf8').toString('base64url')}.${issuedAt}.${expiresAt}.${payloadHash}.${signature}`;

    return {
      token: tokenString,
      requestId,
      payloadHash,
      issuedAt,
      expiresAt,
      signature,
    };
  }

  /**
   * Verifies an interrupt token string against the secret, expiration, and optional payload.
   */
  public verifyToken(
    tokenString: string,
    currentPayload?: unknown,
    nowMs: number = Date.now()
  ): { valid: boolean; reason?: string; tokenData?: HitlInterruptToken } {
    if (!tokenString || typeof tokenString !== 'string') {
      return { valid: false, reason: 'Invalid token: string required' };
    }

    const parts = tokenString.split('.');
    if (parts.length !== 6 || parts[0] !== 'hitl_v1') {
      return { valid: false, reason: 'Invalid token format: header or segment count mismatch' };
    }

    const [, rawRequestIdB64, rawIssuedAt, rawExpiresAt, payloadHash, signature] = parts;

    let requestId: string;
    try {
      requestId = Buffer.from(rawRequestIdB64, 'base64url').toString('utf8');
    } catch {
      return { valid: false, reason: 'Invalid token format: cannot decode requestId' };
    }

    const issuedAt = Number(rawIssuedAt);
    const expiresAt = Number(rawExpiresAt);

    if (isNaN(issuedAt) || isNaN(expiresAt)) {
      return { valid: false, reason: 'Invalid token format: timestamps must be numeric' };
    }

    // Verify HMAC signature using timing-safe comparison
    const expectedMessage = `${requestId}:${issuedAt}:${expiresAt}:${payloadHash}`;
    const expectedSignature = crypto.createHmac('sha256', this.secret).update(expectedMessage).digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedSigBuffer = Buffer.from(expectedSignature, 'hex');

    if (sigBuffer.length !== expectedSigBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedSigBuffer)) {
      return { valid: false, reason: 'Signature verification failed: token has been tampered with' };
    }

    // Verify expiration boundary
    if (nowMs > expiresAt) {
      return {
        valid: false,
        reason: `Token expired at ${new Date(expiresAt).toISOString()} (current time: ${new Date(nowMs).toISOString()})`,
        tokenData: { token: tokenString, requestId, payloadHash, issuedAt, expiresAt, signature },
      };
    }

    // If a payload was provided for verification, verify hash matches
    if (currentPayload !== undefined) {
      const currentHash = this.hashPayload(currentPayload);
      if (currentHash !== payloadHash) {
        return {
          valid: false,
          reason: 'Payload hash mismatch: operation payload has been modified since token creation',
          tokenData: { token: tokenString, requestId, payloadHash, issuedAt, expiresAt, signature },
        };
      }
    }

    return {
      valid: true,
      tokenData: {
        token: tokenString,
        requestId,
        payloadHash,
        issuedAt,
        expiresAt,
        signature,
      },
    };
  }

  /**
   * Sorts object keys recursively to produce deterministic JSON.
   */
  private canonicalStringify(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') {
      return JSON.stringify(obj) ?? '';
    }

    if (Array.isArray(obj)) {
      return '[' + obj.map((item) => this.canonicalStringify(item)).join(',') + ']';
    }

    const keys = Object.keys(obj as Record<string, unknown>).sort();
    const entries = keys.map((key) => {
      const val = (obj as Record<string, unknown>)[key];
      return JSON.stringify(key) + ':' + this.canonicalStringify(val);
    });

    return '{' + entries.join(',') + '}';
  }
}

// Global default token manager instance with secure process secret
const defaultTokenManager = new InterruptTokenManager();

export function createInterruptToken(
  requestId: string,
  payload: unknown,
  ttlMs?: number,
  secret?: string
): HitlInterruptToken {
  const manager = secret ? new InterruptTokenManager(secret) : defaultTokenManager;
  return manager.createToken(requestId, payload, ttlMs);
}

export function verifyInterruptToken(
  tokenString: string,
  currentPayload?: unknown,
  secret?: string,
  nowMs?: number
): { valid: boolean; reason?: string; tokenData?: HitlInterruptToken } {
  const manager = secret ? new InterruptTokenManager(secret) : defaultTokenManager;
  return manager.verifyToken(tokenString, currentPayload, nowMs);
}
