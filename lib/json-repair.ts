/**
 * Sửa JSON hỏng trong đường SSE tạo ảnh/video (port từ prime-agent
 * `packages/ai/src/utils/json-parse.ts`, MIT — Prime Intellect / Mario Zechner,
 * lược bỏ phần partial-parse vì mỗi dòng `data:` của SSE là JSON hoàn chỉnh).
 *
 * Vấn đề: gateway free thỉnh thoảng nhả JSON có control character chưa escape
 * hoặc backslash sai (thường do status text chứa ký tự lạ) — `JSON.parse`
 * ném lỗi và cả dòng event bị DROP IM LẶNG, mất luôn event image/video/url.
 * `repairJson` xử lý đúng 2 dạng hỏng đó mà không đụng nội dung hợp lệ.
 */

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`;
  }
}

/**
 * Sửa chuỗi JSON bằng cách:
 * - escape mọi control character nằm trần bên trong string literal
 * - nhân đôi backslash đứng trước ký tự KHÔNG phải escape hợp lệ
 */
export function repairJson(json: string): string {
  let repaired = '';
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += '\\\\';
        continue;
      }

      if (nextChar === 'u') {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += '\\\\';
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

/**
 * Parse JSON "lỏng": thử parse thường trước (zero-overhead cho dòng sạch),
 * hỏng thì sửa rồi parse lại. Trả null khi thật sự không cứu được — caller
 * giữ hành vi drop như cũ thay vì ném lỗi giữa stream.
 */
export function parseLooseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch (originalError) {
    try {
      return JSON.parse(repairJson(raw));
    } catch {
      // Giữ lỗi gốc để debug dễ hơn — lỗi repair chỉ là hệ quả.
      void originalError;
      return null;
    }
  }
}
