import { describe, expect, it } from 'vitest';
import { acquireUpstreamSlot, sharedFreeBudget } from '@/lib/upstream-queue';

const CRAX = 'https://gpt.crax.lol/v1';
const KILGORE = 'https://kilgoreai.freesrv.com/v1';

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => (t += ms),
  };
}

describe('upstream-queue — ngân sách gateway free dùng chung', () => {
  it('nhận diện host free, bỏ qua provider thường', () => {
    expect(sharedFreeBudget(CRAX)).not.toBeNull();
    expect(sharedFreeBudget(KILGORE)).not.toBeNull();
    expect(sharedFreeBudget('https://api.openai.com/v1')).toBeNull();
    expect(sharedFreeBudget(undefined)).toBeNull();
    expect(sharedFreeBudget('url rác')).toBeNull();
  });

  it('crax: quá 4 lượt/10s thì phải chờ, nhưng vẫn OK khi chờ đủ', async () => {
    const clock = fakeClock();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms + 20); // đồng hồ tiến đúng thời gian chờ
    };
    // 4 lượt đầu ăn ngay
    for (let i = 0; i < 4; i++) {
      expect((await acquireUpstreamSlot(CRAX, 12_000, clock.now, sleep)).ok).toBe(true);
    }
    // lượt 5 trong cùng 10s: phải chờ tới khi lượt đầu hết hiệu lực cửa sổ 10s
    const r = await acquireUpstreamSlot(CRAX, 12_000, clock.now, sleep);
    expect(r.ok).toBe(true); // deadline còn dài → chấp nhận chờ
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it('trả retry-after khi thời gian chờ vượt deadline', async () => {
    const clock = fakeClock();
    const sleep = async () => {};
    for (let i = 0; i < 4; i++) await acquireUpstreamSlot(CRAX, 12_000, clock.now, sleep);
    // lượt 5 với waitMs = 0 → từ chối ngay, gợi ý chờ ~10s
    const r = await acquireUpstreamSlot(CRAX, 0, clock.now, sleep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(0);
  });

  it('trần 18 lượt/phút: chờ cửa sổ 60s khi đã đầy', async () => {
    const clock = fakeClock();
    const sleep = async () => {
      clock.advance(3_500); // mỗi lần chờ, đồng hồ tiến 3.5s
    };
    let ok = 0;
    let rejected = false;
    for (let i = 0; i < 30; i++) {
      const r = await acquireUpstreamSlot(CRAX, 20, clock.now, sleep);
      if (r.ok) ok++;
      else {
        rejected = true;
        break;
      }
    }
    expect(ok).toBeLessThanOrEqual(18);
    expect(rejected).toBe(true);
  });

  it('provider ngoài danh sách không bị xếp hàng', async () => {
    const clock = fakeClock();
    const sleep = async () => {
      throw new Error('không được sleep');
    };
    for (let i = 0; i < 50; i++) {
      expect((await acquireUpstreamSlot('https://api.openai.com/v1', 0, clock.now, sleep)).ok).toBe(true);
    }
  });
});
