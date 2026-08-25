import { describe, expect, it } from 'vitest';
import { assertFetchableUrl } from '@/lib/web-url-guard';

describe('assertFetchableUrl — chắn SSRF cho /api/web', () => {
  const ok = (raw: string) => expect(assertFetchableUrl(raw).ok).toBe(true);
  const blocked = (raw: string) => {
    const r = assertFetchableUrl(raw);
    if (r.ok) throw new Error(`Mong chặn nhưng cho qua: ${raw}`);
    return r;
  };

  it('cho qua URL public chuẩn', () => {
    ok('https://example.com');
    ok('https://example.com/path?q=1#frag');
    ok('http://sub.domain.example.co.uk/x?y=2');
    ok('https://203.0.113.10/'); // TEST-NET-3 chỉ là ví dụ public-style
    ok('https://example.com'); // không port
  });

  it('chặn scheme không phải http/https', () => {
    blocked('ftp://example.com/file');
    blocked('file:///etc/passwd');
    blocked('gopher://example.com');
  });

  it('chặn hostname nội bộ và TLD dev', () => {
    blocked('http://localhost');
    blocked('http://LOCALHOST:80/');
    blocked('http://ip6-localhost');
    blocked('http://myserver.local');
    blocked('http://svc.internal');
    blocked('http://box.lan');
  });

  it('chặn dải IPv4 private/link-local/metadata', () => {
    blocked('http://127.0.0.1');
    blocked('http://127.1.2.3');
    blocked('http://10.0.0.5');
    blocked('http://172.16.0.1');
    blocked('http://172.31.255.255');
    blocked('http://192.168.1.1');
    blocked('http://169.254.169.254'); // metadata AWS/GCP
    blocked('http://100.64.0.1');
    blocked('http://0.0.0.0');
    blocked('http://255.255.255.255');
    // 172.32 ra ngoài dải private → phải được phép.
    ok('http://172.32.0.1');
  });

  it('chặn IPv6 loopback/ULA/link-local và mapped IPv4', () => {
    blocked('http://[::1]/');
    blocked('http://[::]/');
    blocked('http://[fc00::1]/');
    blocked('http://[fd12::1]/');
    blocked('http://[fe80::1]/');
    blocked('http://[::ffff:127.0.0.1]/');
    blocked('http://[::ffff:192.168.0.9]/');
  });

  it('chặn hostname dotless (tên nội bộ / IP dạng thập phân)', () => {
    // https://2130706433 == 127.0.0.1 — thủ thuật SSRF kinh điển.
    blocked('http://2130706433');
    blocked('http://intranet');
  });

  it('chặn port khác mặc định', () => {
    blocked('http://example.com:8080');
    blocked('https://example.com:8443');
    blocked('http://example.com:22');
  });

  it('chặn URL chứa credential', () => {
    blocked('https://user:pass@example.com');
    blocked('https://admin@example.com');
  });

  it('chặn chuỗi rác', () => {
    blocked('');
    blocked('not a url');
    blocked('example.com'); // thiếu scheme
  });
});
