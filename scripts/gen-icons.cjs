// Sinh icon PWA (192/512/maskable-512/180) — vẽ lại thiết kế app/icon.svg.
// Logo Vyen: chữ V bằng 2 nét bo tròn gradient teal→green + 2 node tròn ở đỉnh.
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

// ---------- Hình học (hệ viewBox 32 như icon.svg) ----------
const BG = [0x10, 0x10, 0x13];
const TEAL = [0x0a, 0x7e, 0x8c];
const GREEN = [0x4e, 0xcb, 0x71];
const STROKE_HALF = 1.6; // stroke-width 3.2
const STROKES = [
  [10, 7.5, 16, 24.5], // nét trái của V
  [22, 7.5, 16, 24.5], // nét phải của V
];
const NODES = [
  [10, 7.5, 2.4, TEAL],
  [22, 7.5, 2.4, GREEN],
];
// Trục gradient chéo từ góc trên-trái sang dưới-phải của vùng nét.
const G0 = [8, 7];
const G1 = [24, 25];
const SS = 3; // supersampling 3x

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
function gradColor(u, v) {
  const dx = G1[0] - G0[0];
  const dy = G1[1] - G0[1];
  const len2 = dx * dx + dy * dy;
  let t = ((u - G0[0]) * dx + (v - G0[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [
    TEAL[0] + (GREEN[0] - TEAL[0]) * t,
    TEAL[1] + (GREEN[1] - TEAL[1]) * t,
    TEAL[2] + (GREEN[2] - TEAL[2]) * t,
  ];
}

/**
 * Vẽ 1 pixel (tọa độ trong [0, size)) — trả về [r,g,b] hoặc null (trong suốt).
 * contentScale: co logo về quanh tâm — 1.0 cho icon thường, ~0.64 cho maskable.
 */
function pixel(x, y, size, contentScale) {
  // Nền: rounded rect rx = 25% (như rx=8 của viewBox 32)
  if (sdRoundRect(x, y, size / 2, size / 2, size / 2, size / 2, size * 0.25) > 0) return null;

  const cx = size / 2;
  const cy = size / 2;
  const u = ((cx + (x - cx) / contentScale) / size) * 32;
  const v = ((cy + (y - cy) / contentScale) / size) * 32;

  // 2 node tròn ở đầu 2 tay chéo — màu bookend của gradient
  for (const [nx, ny, nr, color] of NODES) {
    if (Math.hypot(u - nx, v - ny) <= nr) return color;
  }
  // 3 nét K gradient
  for (const [ax, ay, bx, by] of STROKES) {
    if (distToSeg(u, v, ax, ay, bx, by) <= STROKE_HALF) return gradColor(u, v);
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
  ['maskable-512.png', 512, 0.64], // maskable: nền full-bleed, logo nằm trong safe zone
  ['icon-180.png', 180, 1], // apple-touch-icon
];

for (const [name, size, scale] of jobs) {
  fs.writeFileSync(path.join(OUT, name), encodePNG(size, size, render(size, scale)));
  console.log('wrote', name, size + 'x' + size);
}
