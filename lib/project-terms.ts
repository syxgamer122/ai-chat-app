/**
 * Project Terms Strict Parser & Freshness Checker (Oh My Hermes P2 port).
 *
 * Ràng buộc ngữ pháp nghiêm ngặt (§13):
 * 1. Mã hóa UTF-8 không BOM (từ chối ngay nếu có Byte Order Mark).
 * 2. Kích thước <= 64KB (65536 bytes).
 * 3. Line-ending thuần nhất (chỉ toàn \n hoặc toàn \r\n, cấm lẫn lộn).
 * 4. Preamble cố định: bắt đầu bằng header "# Project Terms" hoặc "# PROJECT_TERMS".
 * 5. Các phân mục: "## domain: <name>".
 * 6. Mỗi thuật ngữ: dòng map "phrase -> canonical" hoặc "phrase: canonical", metadata thụt lề đúng 2 space.
 * 7. SHA-256 tính trên đúng byte nguồn.
 * 8. Freshness suy ra lúc đọc: unchanged | changed | missing | untracked (advisory only, không persist).
 * 9. Parse fail -> fail toàn bộ, không chấp nhận kết quả dở dang.
 */

import crypto from 'crypto';

export type TermFreshness = 'unchanged' | 'changed' | 'missing' | 'untracked';

export interface ProjectTermEntry {
  phrase: string;
  canonical: string;
  domain: string;
  metadata?: Record<string, string>;
}

export interface ProjectTermsFile {
  digest: string; // SHA-256
  domains: string[];
  terms: ProjectTermEntry[];
  freshness: TermFreshness;
  byteLength: number;
}

export interface ParseTermsResult {
  ok: boolean;
  error?: string;
  file?: ProjectTermsFile;
}

const MAX_TERMS_BYTES = 64 * 1024; // 64KB

/**
 * Kiểm tra xem line endings có thuần nhất không (không lẫn lộn CRLF và LF).
 */
function checkHomogeneousLineEndings(content: string): { ok: boolean; reason?: string } {
  const hasCRLF = content.includes('\r\n');
  // Bỏ mọi \r\n đi rồi kiểm tra xem còn \r hay \n đơn lẻ nào không
  const withoutCRLF = content.replace(/\r\n/g, '');
  const hasSoloLF = withoutCRLF.includes('\n');
  const hasSoloCR = withoutCRLF.includes('\r');

  if (hasCRLF && hasSoloLF) {
    return { ok: false, reason: 'Line-ending không thuần nhất (trộn lẫn cả CRLF và LF).' };
  }
  if (hasSoloCR) {
    return { ok: false, reason: 'Line-ending chứa ký tự carriage return đơn lẻ (CR).' };
  }
  return { ok: true };
}

/**
 * Parse nội dung buffer PROJECT_TERMS.md theo chuẩn nghiêm ngặt.
 */
export function parseProjectTerms(
  rawBytes: Buffer | Uint8Array | string,
  options?: { knownDigest?: string },
): ParseTermsResult {
  const buffer = typeof rawBytes === 'string' ? Buffer.from(rawBytes, 'utf8') : Buffer.from(rawBytes);

  // 1. Kiểm tra kích thước <= 64KB
  if (buffer.length > MAX_TERMS_BYTES) {
    return {
      ok: false,
      error: `File PROJECT_TERMS vượt quá kích thước cho phép 64KB (${buffer.length} bytes).`,
    };
  }

  // 2. Kiểm tra BOM (Byte Order Mark: 0xEF, 0xBB, 0xBF)
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return {
      ok: false,
      error: 'File chứa Byte Order Mark (BOM). Yêu cầu mã hóa UTF-8 thuần không BOM.',
    };
  }

  const content = buffer.toString('utf8');

  // 3. Kiểm tra tính thuần nhất của line-ending
  const lineEndingCheck = checkHomogeneousLineEndings(content);
  if (!lineEndingCheck.ok) {
    return { ok: false, error: lineEndingCheck.reason };
  }

  // 4. Phân tách dòng
  const lines = content.split(/\r?\n/);
  if (!lines.length || !lines[0].trim()) {
    return { ok: false, error: 'File PROJECT_TERMS rỗng.' };
  }

  // 5. Kiểm tra preamble cố định
  const firstLine = lines[0].trim();
  if (!/^#\s+(?:Project Terms|PROJECT_TERMS)\b/i.test(firstLine)) {
    return {
      ok: false,
      error: 'Preamble cố định không hợp lệ. Dòng đầu tiên phải là "# Project Terms" hoặc "# PROJECT_TERMS".',
    };
  }

  // 6. Tính SHA-256 digest
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');

  // 7. Parse các domains và terms
  const domains: string[] = [];
  const terms: ProjectTermEntry[] = [];
  let currentDomain = 'general';

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Dòng trống hoặc comment
    if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('>')) {
      continue;
    }

    // Domain header: "## domain: <name>"
    if (trimmed.startsWith('## domain:')) {
      const domainName = trimmed.replace('## domain:', '').trim();
      if (!domainName) {
        return { ok: false, error: `Dòng ${i + 1}: Tên domain không được để trống.` };
      }
      currentDomain = domainName;
      if (!domains.includes(domainName)) {
        domains.push(domainName);
      }
      continue;
    }

    // Header cấp khác không được hỗ trợ
    if (trimmed.startsWith('#')) {
      return { ok: false, error: `Dòng ${i + 1}: Header không hợp lệ. Chỉ chấp nhận "## domain: <tên>".` };
    }

    // Metadata thuộc term trước (bắt buộc thụt đúng 2 spaces)
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (!line.startsWith('  ') || line.startsWith('   ') || line.startsWith('\t')) {
        return { ok: false, error: `Dòng ${i + 1}: Metadata phải thụt lề đúng 2 dấu cách.` };
      }
      if (terms.length === 0 || terms[terms.length - 1].domain !== currentDomain) {
        return { ok: false, error: `Dòng ${i + 1}: Metadata phải nằm ngay sau một thuật ngữ trong cùng domain.` };
      }
      const metaLine = line.trim();
      const metaColonIdx = metaLine.indexOf(':');
      if (metaColonIdx === -1) {
        return { ok: false, error: `Dòng ${i + 1}: Metadata không hợp lệ (thiếu dấu hai chấm key: value).` };
      }
      const key = metaLine.slice(0, metaColonIdx).trim();
      const val = metaLine.slice(metaColonIdx + 1).trim();
      if (!key) {
        return { ok: false, error: `Dòng ${i + 1}: Khóa metadata không được để trống.` };
      }
      const lastTerm = terms[terms.length - 1];
      lastTerm.metadata = lastTerm.metadata || {};
      lastTerm.metadata[key] = val;
      continue;
    }

    // Thuật ngữ: map phrase -> canonical hoặc phrase: canonical
    let phrase = '';
    let canonical = '';

    if (trimmed.includes('->')) {
      const parts = trimmed.replace(/^[-*]\s*/, '').split('->');
      phrase = parts[0]?.trim() || '';
      canonical = parts[1]?.trim() || '';
    } else if (trimmed.includes(':')) {
      const parts = trimmed.replace(/^[-*]\s*/, '').split(':');
      phrase = parts[0]?.trim() || '';
      canonical = parts.slice(1).join(':').trim() || '';
    }

    if (!phrase || !canonical) {
      return {
        ok: false,
        error: `Dòng ${i + 1}: Định dạng thuật ngữ không hợp lệ. Yêu cầu "phrase -> canonical" hoặc "phrase: canonical".`,
      };
    }

    if (!domains.includes(currentDomain)) {
      domains.push(currentDomain);
    }

    terms.push({
      phrase,
      canonical,
      domain: currentDomain,
    });
  }

  // 8. Xác định freshness
  let freshness: TermFreshness = 'untracked';
  if (options?.knownDigest) {
    freshness = checkTermsFreshness(buffer, options.knownDigest);
  } else {
    freshness = 'unchanged';
  }

  return {
    ok: true,
    file: {
      digest,
      domains,
      terms,
      freshness,
      byteLength: buffer.length,
    },
  };
}

/**
 * Kiểm tra tính tươi mới của PROJECT_TERMS (unchanged | changed | missing | untracked).
 * Advisory only, không tự tiện ghi đè database.
 */
export function checkTermsFreshness(
  currentContent: Buffer | Uint8Array | string | ProjectTermsFile | null | undefined,
  baseDigest?: string,
): TermFreshness {
  if (currentContent === null || currentContent === undefined) {
    return 'missing';
  }
  if (!baseDigest) {
    return 'untracked';
  }
  const digest =
    typeof currentContent === 'object' && 'digest' in currentContent
      ? currentContent.digest
      : crypto
          .createHash('sha256')
          .update(
            typeof currentContent === 'string'
              ? Buffer.from(currentContent, 'utf8')
              : Buffer.from(currentContent),
          )
          .digest('hex');

  return digest === baseDigest ? 'unchanged' : 'changed';
}
