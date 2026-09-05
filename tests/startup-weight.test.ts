/**
 * Startup weight & latency — khoá chặt các tối ưu giảm trọng lượng khởi động:
 *
 *  (a) globals.css KHÔNG còn @import render-blocking (font Pixelify + KaTeX).
 *  (b) layout.tsx giữ đúng MỘT nguồn tải Pixelify Sans (<link>) + preconnect.
 *  (c) live-tools: cache TTL 10 phút (hết hạn thì fetch lại) + các tool độc
 *      lập chạy song song qua Promise.all trong gatherLiveContext.
 *  (d) use-web-search: fetchPage các trang chạy song song (Promise.allSettled)
 *      và timeout mạng hạ xuống 8s.
 *  (e) components/effects/index.tsx không còn phụ thuộc framer-motion.
 *
 * Phần (a)(b)(d)(e) dùng source-inspection như tests/design-system.test.ts —
 * hành vi tải là thuộc tính của source nên inspection đủ chặt: thêm lại dòng
 * đã xoá là test đỏ ngay. Phần (c) test hành vi thật với fetch stub + đồng hồ
 * giả (chỉ fake Date để điều khiển TTL, không fake timer để promise chạy vi
 * nhiệm vụ như thật).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fetchRates, fetchWeather, gatherLiveContext } from '@/lib/live-tools';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
}

/* ------------------------------------------------------------------ */
/* (a) + (b): CSS khởi động & nguồn font                               */
/* ------------------------------------------------------------------ */

describe('globals.css — không còn @import render-blocking', () => {
  it('không có dòng @import nào (KaTeX đã chuyển theo chunk KaTeX, font đã có <link>)', () => {
    const css = read('../app/globals.css');
    // @import phải đứng đầu chuỗi statement — khớp theo đầu dòng để không
    // dính phải chữ "@import" nằm trong comment giải thích.
    expect(css).not.toMatch(/^[ \t]*@import/m);
  });

  it('CSS KaTeX đi theo chunk dynamic của rehype-katex trong markdown-renderer', () => {
    const src = read('../components/markdown-renderer.tsx');
    expect(src).toMatch(/import\('katex\/dist\/katex\.min\.css'\)/);
  });
});

describe('layout.tsx — đúng một nguồn Pixelify Sans', () => {
  const layout = read('../app/layout.tsx');

  it('chỉ <link> là nguồn tải Pixelify (không tải kép qua CSS)', () => {
    expect((layout.match(/Pixelify/g) ?? []).length).toBe(1);
    expect(layout).toMatch(/<link[^>]*Pixelify\+Sans[^>]*rel="stylesheet"/);
  });

  it('có preconnect cho cả fonts.googleapis.com và fonts.gstatic.com', () => {
    expect(layout).toMatch(/<link[^>]*rel="preconnect"[^>]*https:\/\/fonts\.googleapis\.com/);
    expect(layout).toMatch(/<link[^>]*rel="preconnect"[^>]*https:\/\/fonts\.gstatic\.com[^>]*crossOrigin/);
  });
});

/* ------------------------------------------------------------------ */
/* (c): live-tools — TTL cache + song song hoá                         */
/* ------------------------------------------------------------------ */

/** fetch stub trả dữ liệu Open-Meteo / er-api giả — đếm mọi URL gọi qua. */
function makeFetchStub() {
  const urls: string[] = [];
  const stub = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('geocoding-api')) {
      return new Response(
        JSON.stringify({
          results: [{ name: 'Testville', country: 'VN', admin1: 'HN', latitude: 21, longitude: 105 }],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/forecast')) {
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 31,
            relative_humidity_2m: 70,
            apparent_temperature: 35,
            weather_code: 1,
            wind_speed_10m: 9,
          },
          daily: {
            time: ['2026-09-04', '2026-09-05'],
            temperature_2m_max: [32, 33],
            temperature_2m_min: [26, 25],
            precipitation_probability_max: [10, 20],
          },
        }),
        { status: 200 },
      );
    }
    if (url.includes('open.er-api.com')) {
      return new Response(
        JSON.stringify({
          time_last_update_utc: 'Fri, 04 Sep 2026 00:00:00 +0000',
          rates: { VND: 26100, EUR: 0.9 },
        }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  });
  return { stub, urls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live-tools — cache TTL 10 phút', () => {
  it('cùng địa điểm hỏi lại trong TTL → không fetch thêm; hết TTL → fetch mới', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { stub, urls } = makeFetchStub();
    vi.stubGlobal('fetch', stub);

    const loc = 'TTL Đồng Hồ Thành Phố';
    const first = await fetchWeather(loc);
    expect(first).toContain('DỮ LIỆU THỜI TIẾT');
    expect(urls.length).toBe(2); // geocoding + forecast

    await fetchWeather(loc);
    expect(urls.length).toBe(2); // trúng cache: 0 request mới

    // Tiến đồng hồ qua ngưỡng 10 phút + 1ms → entry hết hạn, fetch lại.
    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    const after = await fetchWeather(loc);
    expect(after).toContain('DỮ LIỆU THỜI TIẾT');
    expect(urls.length).toBe(4);
  });

  it('fetchRates cũng tuân TTL: trúng cache khi tươi, fetch lại khi hết hạn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { stub, urls } = makeFetchStub();
    vi.stubGlobal('fetch', stub);

    // Xả entry có thể còn từ test trước bằng cách già hoá đồng hồ trước lời gọi đầu.
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);

    const first = await fetchRates();
    expect(first).toContain('TỶ GIÁ HÔM NAY');
    expect(urls.length).toBe(1);

    await fetchRates();
    expect(urls.length).toBe(1); // còn tươi → không fetch

    vi.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await fetchRates();
    expect(urls.length).toBe(2); // hết hạn → fetch mới
  });

  it('HTTP lỗi thì KHÔNG cache null — lần sau vẫn được thử lại', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        urls.push('call');
        return new Response('boom', { status: 500 });
      }),
    );
    expect(await fetchRates()).toBeNull();
    expect(await fetchRates()).toBeNull();
    expect(urls.length).toBe(2); // lỗi không được cache, retry vẫn chạy
  });

  it('vượt ngưỡng ~50 entry thì xả cache — không giữ vô hạn trong phiên dài', async () => {
    const { stub, urls } = makeFetchStub();
    vi.stubGlobal('fetch', stub);

    await fetchWeather('Eviction Base'); // 2 entry đầu tiên
    /* Stub trả CÙNG toạ độ cho mọi địa điểm nên key forecast trùng — mỗi vòng
       chỉ thêm 1 entry geo mới, không phải 2 như hình dung lúc viết nháp.
       Cần >48 vòng mới vượt ngưỡng 50; chạy 60 cho dư cho mọi lần clear
       giữa chừng (clear xóa cả entry forecast, vòng sau fetch lại +1 URL
       nhưng entry đếm không đổi). */
    for (let i = 0; i < 60; i++) {
      await fetchWeather(`Eviction Ward ${i}`);
    }
    const filled = urls.length;

    // Địa điểm đầu đã bị xả theo lượt clear → phải fetch lại chứ không trúng cache.
    await fetchWeather('Eviction Base');
    expect(urls.length).toBeGreaterThan(filled);
  });
});

describe('live-tools — fetch độc lập chạy song song', () => {
  it('gatherLiveContext chạy weather ∥ rates: weather không thể kết thúc trước khi rates bắt đầu', async () => {
    const order: string[] = [];
    let releaseWeather!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWeather = resolve;
    });

    const weather = async () => {
      order.push('weather:start');
      await gate; // chỉ mở khi rates đã start — tuần tự hoá thì test treo
      order.push('weather:end');
      return 'W';
    };
    const rates = async () => {
      order.push('rates:start');
      releaseWeather();
      return 'R';
    };

    const payload = await gatherLiveContext('thời tiết ở Song Song Thành và tỷ giá hôm nay', {
      weather,
      rates,
    });

    expect(payload?.weather).toBe('W');
    expect(payload?.rates).toBe('R');
    expect(order.indexOf('rates:start')).toBeLessThan(order.indexOf('weather:end'));
  });

  it('source giữ Promise.all làm điểm rọi các tool độc lập trong gatherLiveContext', () => {
    const src = read('../lib/live-tools.ts');
    const body = src.slice(src.indexOf('export async function gatherLiveContext'));
    expect(body).toContain('Promise.all(');
  });
});

/* ------------------------------------------------------------------ */
/* (d): use-web-search — trang song song + timeout 8s                  */
/* ------------------------------------------------------------------ */

describe('use-web-search — thu thập web không chặn lâu', () => {
  const src = read('../lib/use-web-search.ts');

  it('các fetchPage chạy song song bằng Promise.allSettled (một trang chết không kéo cả cụm)', () => {
    expect(src).toContain('Promise.allSettled(pageUrls.map((u) => fetchPage(u)))');
  });

  it('timeout search + fetchPage hạ xuống 8s (REQUEST_TIMEOUT_MS)', () => {
    expect(src).toMatch(/REQUEST_TIMEOUT_MS\s*=\s*8_000/);
    expect(src).not.toMatch(/REQUEST_TIMEOUT_MS\s*=\s*15_000/);
  });
});

/* ------------------------------------------------------------------ */
/* (e): effects — sạch framer-motion                                   */
/* ------------------------------------------------------------------ */

describe('components/effects — không còn framer-motion', () => {
  it('file không nhắc framer-motion (thay bằng CSS animation thuần)', () => {
    const src = read('../components/effects/index.tsx');
    expect(src).not.toContain('framer-motion');
  });

  it('useFxEnabled vẫn tôn trọng prefers-reduced-motion qua matchMedia', () => {
    const src = read('../components/effects/index.tsx');
    expect(src).toContain("matchMedia('(prefers-reduced-motion: reduce)')");
  });
});
