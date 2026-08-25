import { describe, expect, it } from 'vitest';
import { restateUpstreamStatus, STATUS_RESTATE_RULES } from '@/lib/upstream-status-rules';

describe('restateUpstreamStatus — sửa nhãn lỗi sai của gateway', () => {
  it('403 kèm chữ quota → 429 (retryable, đổi key là đúng đường)', () => {
    const r = restateUpstreamStatus(403, '{"error":"quota exceeded for this token"}');
    expect(r.status).toBe(429);
    expect(r.reason).toContain('quota');
  });

  it('400 kèm 额度不足 (New API tiếng Trung) → 429', () => {
    const r = restateUpstreamStatus(400, '当前令牌额度不足');
    expect(r.status).toBe(429);
  });

  it('500 kèm rate-limit text → 429', () => {
    const r = restateUpstreamStatus(500, 'Error: rate limit reached, slow down');
    expect(r.status).toBe(429);
  });

  it('403 kèm invalid api key → 401 (cho key health quarantine)', () => {
    const r = restateUpstreamStatus(403, 'Invalid API key provided');
    expect(r.status).toBe(401);
  });
});

describe('restateUpstreamStatus — các trường hợp KHÔNG được đụng vào', () => {
  it('403 Cloudflare block thật → giữ nguyên 403', () => {
    const r = restateUpstreamStatus(
      403,
      'quota error — Attention Required! | Cloudflare',
    );
    expect(r.status).toBe(403);
    expect(r.reason).toBeUndefined();
  });

  it('status không nằm trong from[] → bỏ qua rule', () => {
    expect(restateUpstreamStatus(200, 'quota exceeded').status).toBe(200);
    expect(restateUpstreamStatus(413, 'rate limit hit').status).toBe(413);
  });

  it('body rỗng/không khớp → nguyên trạng', () => {
    expect(restateUpstreamStatus(403, '').status).toBe(403);
    expect(restateUpstreamStatus(403, 'forbidden resource').status).toBe(403);
    expect(restateUpstreamStatus(undefined, 'quota').status).toBeUndefined();
  });

  it('overflow/safety body không bị rule nào nuốt mất', () => {
    // "prompt is too long" không chứa marker quota/ratelimit/auth.
    expect(restateUpstreamStatus(400, 'prompt is too long: 213k tokens > 200000').status).toBe(400);
  });

  it('bảng rule bảo thủ: mỗi rule đều có unless chống WAF hoặc không cần', () => {
    for (const rule of STATUS_RESTATE_RULES) {
      expect(rule.to).not.toBe(rule.from[0]);
      expect(rule.reason).toBeTruthy();
    }
  });
});
