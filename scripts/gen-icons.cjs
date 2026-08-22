/* eslint-disable */
// Sinh icon PWA (192/512/maskable-512/180) — vẽ lại thiết kế app/icon.svg.
// Tự encode PNG bằng zlib + CRC32 (không cần thư viện ngoài). Chạy 1 lần rồi xoá.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG encoder ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Hình học ----------
const BG = [0x4f, 0x46, 0xe5];
const WHITE = [0xff, 0xff, 0xff];
const SS = 3; // supersampling 3x

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}
function inCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) <= r;
}
function inTriangle(px, py, a, b, c) {
  const s = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const d1 = s(a, b, [px, py]);
  const d2 = s(b, c, [px, py]);
  const d3 = s(c, a, [px, py]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Vẽ 1 pixel (tọa độ trong [0, size)) — trả về [r,g,b] hoặc null (trong suốt).
 * contentScale: co nội dung (bong bóng + chấm) — 1.0 cho icon thường, ~0.64 cho maskable.
 */
function pixel(x, y, size, contentScale) {
  // Nền: rounded rect rx = 25% (như rx=8 của viewBox 32)
  if (sdRoundRect(x, y, size / 2, size / 2, size / 2, size / 2, size * 0.25) > 0) return null;

  // Hệ toạ độ nội dung: co về quanh tâm
  const cs = contentScale;
  const cx = size / 2;
  const cy = size / 2;
  const px = cx + (x - cx) / cs; // toạ độ nếu vẽ trong khung 32 "ảo"
  const py = cy + (y - cy) / cs;
  const u = (px / size) * 32; // sang hệ viewBox 32
  const v = (py / size) * 32;

  // Bong bóng chat: khung [8,24]x[8,22], bo góc trừ góc dưới-trái (đuôi thay chỗ)
  const bubble =
    sdRoundRect(u, v - 0.4, 16, 15, 8, 7, 4.4) <= 0 || // thân chính (dịch nhẹ để 4 góc tròn đều)
    inTriangle(u, v, [9, 21.4], [9, 25.6], [14.4, 21.9]) || // đuôi trái
    (u >= 8 && u <= 24 && v >= 20.5 && v <= 21.9); // nối đuôi với thân
  if (bubble) {
    // 3 chấm màu nền
    const dots =
      inCircle(u, v, 12, 15, 1.55) ||
      inCircle(u, v, 16, 15, 1.55) ||
      inCircle(u, v, 20, 15, 1.55);
    return dots ? BG : WHITE;
  }
  return BG;
}

function render(size, contentScale) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = pixel(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, contentScale);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            hit++;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (hit > 0) {
        rgba[i] = Math.round(r / hit);
        rgba[i + 1] = Math.round(g / hit);
        rgba[i + 2] = Math.round(b / hit);
        rgba[i + 3] = Math.round((hit / (SS * SS)) * 255);
      } else {
        rgba[i + 3] = 0;
      }
    }
  }
  return rgba;
}

const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

const jobs = [
  ['icon-192.png', 192, 1],
  ['icon-512.png', 512, 1],
  ['maskable-512.png', 512, 0.64], // maskable: nền full-bleed, nội dung nằm trong safe zone
  ['icon-180.png', 180, 1], // apple-touch-icon
];

for (const [name, size, scale] of jobs) {
  fs.writeFileSync(path.join(OUT, name), encodePNG(size, size, render(size, scale)));
  console.log('wrote', name, size + 'x' + size);
}
