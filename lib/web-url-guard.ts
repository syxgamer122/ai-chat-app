/**
 * Chắn SSRF cho /api/web — route chủ động fetch URL do client đưa lên.
 *
 * Edge case nguy hiểm: request từ server chạm được mạng nội bộ (metadata
 * 169.254.169.254 của cloud, router 192.168.x, dịch vụ dev trên localhost).
 * DNS resolve phía server không kiểm soát được ở runtime serverless nên lớp
 * phòng thủ là: chỉ nhận http/https, CHỈ hostname public (chặn IP private,
 * hostname không có dot, TLD nội bộ), chỉ port mặc định, không credential.
 */

export type UrlCheckResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/** TLD/hostname nội bộ thường gặp trong mạng LAN + môi trường dev. */
const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.localdomain',
];

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return false;
  const octets = parts.map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (metadata cloud!)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::' || h === '::1') return true;
  // Mapped IPv4. Lưu ý WHATWG URL chuẩn hoá [::ffff:127.0.0.1] thành dạng hex
  // '::ffff:7f00:1' nên phải xử lý CẢ hai dạng.
  const mappedDotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (mappedHex) {
    const num =
      ((parseInt(mappedHex[1], 16) << 16) >>> 0) + parseInt(mappedHex[2], 16);
    return isPrivateIPv4(
      `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`,
    );
  }
  const first = h.split(':')[0] ?? '';
  if (/^f[cd]/.test(first)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  return false;
}

/**
 * Kiểm tra URL trước khi fetch phía server. Trả `{ ok: false, error }` thay vì
 * throw để route map thẳng thành response lỗi cho client.
 */
/**
 * Kiểm tra IP đã resolve có nằm trong dải private/internal không.
 * Dùng sau DNS lookup để chặn DNS rebinding: hostname public nhưng DNS
 * trả về IP nội bộ (127.0.0.1, 169.254.x.x, 10.x.x.x, etc.).
 *
 * PERF: Không trả URL object vì caller chỉ cần ok/error. Tránh tạo URL
 * object thừa khi IP hợp lệ (hot path cho mỗi fetch).
 */
export function assertFetchableIp(ip: string): UrlCheckResult {
  if (!ip) return { ok: false, error: 'Không resolve được IP.' };
  if (isPrivateIPv4(ip)) return { ok: false, error: 'DNS resolve về địa chỉ IPv4 riêng.' };
  if (isPrivateIPv6(ip)) return { ok: false, error: 'DNS resolve về địa chỉ IPv6 riêng.' };
  // FIX: Trả URL rỗng thay vì null-as-any để tránh NPE nếu caller truy cập .url
  // khi ok===true. Caller hiện tại chỉ check !ok nên an toàn, nhưng phòng ngừa.
  return { ok: true, url: '' as unknown as URL };
}

export function assertFetchableUrl(raw: string): UrlCheckResult {
  const trimmed = (raw ?? '').trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: 'URL không hợp lệ.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Chấp nhận chỉ http/https, nhận được "${url.protocol}".` };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, error: 'URL thiếu hostname.' };

  // Hostname không có dot = tên nội bộ hoặc IP viết dạng thập phân/hex gây mã
  // hoá (vd https://2130706433 == 127.0.0.1). Site public luôn có dot.
  if (!host.includes('.') && !host.includes(':')) {
    return { ok: false, error: 'Hostname không hợp lệ (thiếu dấu chấm).' };
  }

  if (LOCAL_HOSTNAMES.has(host) || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, error: 'Không fetch được địa chỉ nội bộ.' };
  }

  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return { ok: false, error: 'Không fetch được địa chỉ nằm trong dải IP riêng.' };
  }

  // Port khác mặc định → hay là dịch vụ admin/dev trên host lạ; chặn sớm.
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  if (url.port && url.port !== defaultPort) {
    return { ok: false, error: `Port ${url.port} không được phép — chỉ dùng port mặc định.` };
  }

  if (url.username || url.password) {
    return { ok: false, error: 'URL chứa thông tin đăng nhập.' };
  }

  return { ok: true, url };
}
