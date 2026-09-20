#!/usr/bin/env node
/**
 * Sắp lại 8 entry mới của TOOL_CATALOG vào ĐÚNG nhóm category.
 *
 * `tests/tool-catalog.test.ts` chốt bất biến: catalog phải nhóm theo thứ tự
 * ALL_TOOL_CATEGORIES rồi tên tăng dần trong nhóm. Chèn ở cuối file là sai vị
 * trí, nên script này bóc khối đã thêm rồi đặt lại từng entry vào đúng chỗ.
 *
 * Chạy một lần; idempotent (lần hai sẽ báo không tìm thấy khối).
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '..', 'lib', 'tool-catalog.ts');
const raw = fs.readFileSync(FILE, 'utf8');
/*
 * File dùng CRLF, nên mọi mốc so khớp theo '\n' đều trượt. Chuẩn hoá về LF để
 * làm việc rồi trả lại CRLF khi ghi — không đổi kiểu xuống dòng của repo.
 */
const USES_CRLF = raw.includes('\r\n');
let src = USES_CRLF ? raw.replace(/\r\n/g, '\n') : raw;

// Mốc mở khối: dùng tiền tố ASCII để tránh phụ thuộc ký tự đặc biệt trong file.
const START = '\n  /*\n   * Zero-Mem (port sarsvankelsion/zero-mem)';
const startIdx = src.indexOf(START);
if (startIdx < 0) {
  console.log('Không tìm thấy khối cần sắp lại — có thể đã chạy rồi.');
  process.exit(0);
}
const startLine = startIdx + 1; // bỏ ký tự \n dẫn đầu, giữ '  /*'
// Khối kết thúc ngay trước `];` đóng TOOL_CATALOG.
const endMarker = '\n];';
const endIdx = src.indexOf(endMarker, startIdx);
if (endIdx < 0) throw new Error('Không tìm thấy điểm kết thúc khối.');

const block = src.slice(startLine, endIdx);
src = src.slice(0, startLine) + src.slice(endIdx + 1); // giữ lại `];`

/** Bóc từng object entry trong khối theo mốc `  {\n    name: '<tên>'`. */
function extractEntry(name) {
  const marker = `    name: '${name}',`;
  const nameIdx = block.indexOf(marker);
  if (nameIdx < 0) throw new Error(`Không thấy entry ${name}`);
  const objStart = block.lastIndexOf('  {', nameIdx);
  const objEnd = block.indexOf('\n  },', nameIdx);
  if (objStart < 0 || objEnd < 0) throw new Error(`Không xác định được biên entry ${name}`);
  return block.slice(objStart, objEnd + 4); // gồm '  },'
}

/** Chèn `text` ngay TRƯỚC mốc `marker` (mốc phải là dòng bắt đầu bằng marker). */
function insertBefore(marker, text) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`Không thấy mốc: ${marker}`);
  src = src.slice(0, i) + text + src.slice(i);
}

/*
 * Thứ tự chèn quan trọng: chèn từ CUỐI file lên ĐẦU để mốc không bị xê dịch
 * (mỗi lần chèn đẩy index của các mốc phía sau).
 */
// memory: zeromem_* đứng sau retrieve_memories ('z' > 'r') → chèn trước `  // plan`
const zeromem = ['zeromem_inspect', 'zeromem_log', 'zeromem_query', 'zeromem_stats']
  .map(extractEntry)
  .join('\n');
insertBefore('  // plan', zeromem + '\n');

// fs_write: code_patch ('c' < 'f') → chèn trước entry fs_edit
insertBefore("    name: 'fs_edit',", extractEntry('code_patch') + '\n');

// fs_read: code_* ('c' < 'f') → chèn trước entry fs_list
const codeRead = ['code_skeleton', 'code_symbols', 'code_verify']
  .map(extractEntry)
  .join('\n');
insertBefore("    name: 'fs_list',", codeRead + '\n');

fs.writeFileSync(FILE, USES_CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Đã sắp lại 8 entry vào đúng nhóm category.');
