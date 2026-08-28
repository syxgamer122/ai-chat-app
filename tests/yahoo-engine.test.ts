/**
 * Engine Yahoo — dự phòng KHÔNG cần API key.
 *
 * Vì sao thêm: khi IP bị DuckDuckGo gắn cờ, mọi endpoint DDG trả 202 rỗng.
 * Đo thực tế cùng thời điểm cho thấy Yahoo vẫn phục vụ (kể cả truy vấn tiếng
 * Việt). Mojeek/Startpage/Brave đều trả trang chặn nên KHÔNG đưa vào — chỉ
 * giữ engine đã kiểm chứng chạy được.
 *
 * HTML mẫu dưới đây rút gọn từ phản hồi THẬT của search.yahoo.com.
 */

import { describe, expect, it } from 'vitest';
import { decodeHtmlEntities, parseYahoo, unwrapYahooRedirect } from '@/lib/web-extract';

const YAHOO_SAMPLE =
  '<div class="nav">bo qua</div>' +
  '<ol class="reg searchCenterMiddle">' +
  '<li><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=Awr/RU=https%3a%2f%2fvnexpress.net%2fthoi-tiet/RK=2/RS=abc">' +
  'Th&#7901;i ti&#7871;t H&agrave; N&#7897;i</a></div>' +
  '<div class="compText aAbs"><p class="fc"> M&ocirc; t&#7843; ng&#7855;n. </p></div></li>' +
  '<li><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=Awr/RU=https%3a%2f%2f24h.com.vn%2fbong-da/RK=2/RS=xyz">' +
  'Tin b&oacute;ng &#273;&aacute;</a></div>' +
  '<div class="compText"><p> Ket qua moi nhat. </p></div></li>' +
  '</ol><div class="searchRightTop">quang cao</div>';

describe('unwrapYahooRedirect', () => {
  it('gỡ lớp bọc /RU=<encoded> về URL thật', () => {
    expect(
      unwrapYahooRedirect(
        'https://r.search.yahoo.com/_ylt=Aw/RU=https%3a%2f%2fexample.com%2fa%3fx%3d1/RK=2/RS=z',
      ),
    ).toBe('https://example.com/a?x=1');
  });

  it('URL thường đi qua nguyên vẹn', () => {
    expect(unwrapYahooRedirect('https://example.com/plain')).toBe('https://example.com/plain');
  });

  it('không ném với chuỗi hỏng', () => {
    expect(() => unwrapYahooRedirect('/RU=%%%/RK=')).not.toThrow();
  });
});

describe('parseYahoo', () => {
  it('trích đủ title + url + snippet', () => {
    const hits = parseYahoo(YAHOO_SAMPLE);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      title: 'Thời tiết Hà Nội',
      url: 'https://vnexpress.net/thoi-tiet',
      snippet: 'Mô tả ngắn.',
    });
    expect(hits[1].url).toBe('https://24h.com.vn/bong-da');
  });

  it('bỏ link nội bộ của Yahoo (điều hướng, mail)', () => {
    const html =
      '<ol class="reg searchCenterMiddle">' +
      '<li><a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fus.mail.yahoo.com%2f/RK=1/RS=a">Mail</a></li>' +
      '<li><a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2freal.example%2fp/RK=1/RS=b">Thật</a></li>' +
      '</ol>';
    const hits = parseYahoo(html);
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe('https://real.example/p');
  });

  it('chỉ lấy vùng kết quả, bỏ khối quảng cáo bên phải', () => {
    const html =
      '<ol class="reg searchCenterMiddle">' +
      '<li><a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fok.example%2f/RK=1/RS=a">OK</a></li>' +
      '</ol><div class="searchRightTop">' +
      '<a href="https://r.search.yahoo.com/x/RU=https%3a%2f%2fads.example%2f/RK=1/RS=b">Ads</a></div>';
    const hits = parseYahoo(html);
    expect(hits.every((h) => !h.url.includes('ads.example'))).toBe(true);
  });

  it('HTML rỗng / không phải Yahoo → mảng rỗng, không ném', () => {
    expect(parseYahoo('')).toEqual([]);
    expect(parseYahoo('<html><body>nothing</body></html>')).toEqual([]);
  });
});

describe('entity có dấu (Yahoo mã hoá tên tiếng Việt kiểu H&agrave;)', () => {
  it('giải mã nguyên âm Latin có dấu', () => {
    expect(decodeHtmlEntities('H&agrave; N&#7897;i')).toBe('Hà Nội');
    expect(decodeHtmlEntities('b&oacute;ng &#273;&aacute;')).toBe('bóng đá');
  });

  it('phân biệt hoa/thường — &Agrave; không thành &agrave;', () => {
    expect(decodeHtmlEntities('&Agrave;')).toBe('À');
    expect(decodeHtmlEntities('&agrave;')).toBe('à');
  });

  it('entity lạ giữ nguyên, không nuốt mất chữ', () => {
    expect(decodeHtmlEntities('&khongton;')).toBe('&khongton;');
  });
});
