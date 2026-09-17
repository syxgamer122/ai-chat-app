/**
 * Disk Skills (chuẩn SKILL.md) + project hints (.vyenhints) —
 * PROGRESSIVE DISCLOSURE: system prompt chỉ chứa BẢNG CHỈ MỤC
 * (name + description + path); nội dung SKILL.md chỉ vào context khi model
 * gọi tool skill_load. Giữ token thấp — đừng nhồi body skill vào prompt.
 *
 * Thuần function: fs (workspace + ~/.vyen/skills) được inject qua adapter.
 */

import { parse as parseYaml } from 'yaml';

export const DISK_SKILL_LIMITS = {
  nameChars: 60,
  descriptionChars: 400,
  versionChars: 30,
  /** Trần bảng chỉ mục gửi lên mỗi lượt. */
  maxIndexEntries: 30,
  /** Trần nội dung SKILL.md trả về từ skill_load. */
  bodyChars: 24_000,
  /** Trần hints nạp tự động vào system prompt. */
  hintsChars: 8_000,
} as const;

export interface DiskSkillEntry {
  name: string;
  description: string;
  version?: string;
  /** Tool được phép dùng khi skill active (chỉ metadata hiển thị). */
  allowedTools?: string[];
  source: 'workspace' | 'global';
  /** Đường dẫn tương đối (workspace: `.vyen/skills/<name>`) hoặc tên thư mục (global). */
  dir: string;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  version?: string;
  allowedTools?: string[];
  body: string;
}

export type SkillParseResult =
  | { ok: true; skill: ParsedSkillFile }
  | { ok: false; error: string };

/**
 * Parse file SKILL.md: front-matter YAML giữa hai dòng `---` + phần body.
 * Thiếu name/description → lỗi (skill không thể index).
 */
export function parseSkillFile(text: string): SkillParseResult {
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) {
    return { ok: false, error: 'Thiếu front-matter YAML (file phải bắt đầu bằng dòng ---).' };
  }
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) {
    return { ok: false, error: 'Front-matter không khép lại (thiếu dòng --- thứ hai).' };
  }
  const frontRaw = normalized.slice(3, end).replace(/^\n/, '');
  const body = normalized.slice(end + 4).replace(/^\n+/, '');

  let front: unknown;
  try {
    front = parseYaml(frontRaw);
  } catch (err) {
    return { ok: false, error: `Front-matter YAML hỏng: ${err instanceof Error ? err.message : String(err)}` };
  }
  const rec = (front ?? {}) as Record<string, unknown>;
  const name = typeof rec.name === 'string' ? rec.name.trim() : '';
  const description = typeof rec.description === 'string' ? rec.description.trim() : '';
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(name) || name.length > DISK_SKILL_LIMITS.nameChars) {
    return { ok: false, error: 'name: chỉ chữ-số-._- , tối đa 60 ký tự, không bắt đầu bằng dấu.' };
  }
  if (!description || description.length > DISK_SKILL_LIMITS.descriptionChars) {
    return { ok: false, error: 'description: bắt buộc, tối đa 400 ký tự.' };
  }
  return {
    ok: true,
    skill: {
      name,
      description,
      ...(typeof rec.version === 'string' && rec.version.trim()
        ? { version: rec.version.trim().slice(0, DISK_SKILL_LIMITS.versionChars) }
        : {}),
      ...(Array.isArray(rec.allowed_tools)
        ? {
            allowedTools: rec.allowed_tools
              .filter((t): t is string => typeof t === 'string')
              .slice(0, 20),
          }
        : {}),
      body: body.slice(0, DISK_SKILL_LIMITS.bodyChars),
    },
  };
}

/* ----------------------- discovery (adapter-injected) ----------------------- */

export interface DiskSkillAdapters {
  /** Liệt kê thư mục con của `.vyen/skills` trong workspace (tên, chưa có path). */
  listWorkspaceSkillDirs(): Promise<string[]>;
  /** Đọc SKILL.md trong một thư mục skill của workspace. */
  readWorkspaceSkill(dirName: string): Promise<string>;
  /** Bridge desktop: liệt kê skill toàn cục ~/.vyen/skills (tên thư mục). */
  listGlobalSkillDirs?: () => Promise<string[]>;
  /** Bridge desktop: đọc SKILL.md skill toàn cục theo tên. */
  readGlobalSkill?: (name: string) => Promise<string>;
}

export interface DiskSkillScan {
  entries: DiskSkillEntry[];
  errors: Array<{ source: string; error: string }>;
}

/**
 * Quét skills từ workspace + global (nếu có bridge), parse front-matter để
 * lấy index. File hỏng → errors, không chặn phần còn lại.
 */
export async function scanDiskSkills(adapters: DiskSkillAdapters): Promise<DiskSkillScan> {
  const entries: DiskSkillEntry[] = [];
  const errors: Array<{ source: string; error: string }> = [];

  const pushFrom = async (
    source: 'workspace' | 'global',
    dirs: string[],
    read: (dirName: string) => Promise<string>,
    dirOf: (dirName: string) => string,
  ) => {
    for (const dirName of dirs.slice(0, DISK_SKILL_LIMITS.maxIndexEntries)) {
      try {
        const parsed = parseSkillFile(await read(dirName));
        if (!parsed.ok) {
          errors.push({ source: `${source}:${dirName}`, error: parsed.error });
          continue;
        }
        entries.push({
          name: parsed.skill.name,
          description: parsed.skill.description,
          ...(parsed.skill.version ? { version: parsed.skill.version } : {}),
          ...(parsed.skill.allowedTools ? { allowedTools: parsed.skill.allowedTools } : {}),
          source,
          dir: dirOf(dirName),
        });
      } catch (err) {
        errors.push({ source: `${source}:${dirName}`, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  try {
    await pushFrom(
      'workspace',
      await adapters.listWorkspaceSkillDirs(),
      adapters.readWorkspaceSkill,
      (d) => `.vyen/skills/${d}`,
    );
  } catch {
    /* không có .vyen/skills — bình thường */
  }
  if (adapters.listGlobalSkillDirs && adapters.readGlobalSkill) {
    try {
      await pushFrom('global', await adapters.listGlobalSkillDirs(), adapters.readGlobalSkill, (d) => d);
    } catch {
      /* bridge cũ không có lệnh — bỏ qua */
    }
  }

  /* Trùng tên giữa workspace và global: workspace THẮNG (gần dự án hơn).
     Duyệt ngược để entry sau (global) không ghi đè entry trước (workspace). */
  const byName = new Map<string, DiskSkillEntry>();
  for (const entry of [...entries].reverse()) byName.set(entry.name, entry);
  return { entries: [...byName.values()].slice(0, DISK_SKILL_LIMITS.maxIndexEntries), errors };
}

/**
 * Bảng chỉ mục cho system prompt — CHỈ name/description/path + chỉ dẫn gọi
 * skill_load. Nội dung KHÔNG nằm ở đây (progressive disclosure).
 */
export function buildDiskSkillIndexBlock(entries: readonly DiskSkillEntry[]): string {
  if (!entries.length) return '';
  const lines = [
    '[SKILLS (chỉ mục)] Các kỹ năng dưới dạng file SKILL.md trong máy người dùng.',
    'Muốn DÙNG kỹ năng nào: gọi skill_load với name — nội dung đầy đủ sẽ được trả về.',
    '| name | mô tả | nguồn |',
    '| --- | --- | --- |',
    ...entries.map((e) => `| ${e.name} | ${e.description.replace(/\|/g, '/').slice(0, 120)} | ${e.source === 'workspace' ? 'workspace' : 'toàn cục'} |`),
  ];
  return lines.join('\n');
}

/* ------------------------------ .vyenhints ------------------------------ */

/**
 * Chỉ dùng hints của Vyen (`.vyenhints`) và chuẩn chung `AGENTS.md`.
 * Đã bỏ các file hints của công cụ khác: chúng khiến dự án mang cấu hình
 * của công cụ khác thay vì của Vyen.
 */
export const HINTS_FILE_CANDIDATES = ['.vyenhints', 'AGENTS.md'] as const;

/** Chọn file hints đầu tiên CÓ nội dung theo thứ tự ưu tiên. */
export function pickHintsContent(
  readCandidates: ReadonlyArray<{ file: string; content: string }>,
): { file: string; content: string } | null {
  for (const file of HINTS_FILE_CANDIDATES) {
    const hit = readCandidates.find((c) => c.file === file && c.content.trim().length > 0);
    if (hit) {
      return { file, content: hit.content.trim().slice(0, DISK_SKILL_LIMITS.hintsChars) };
    }
  }
  return null;
}

/** Khối hints chèn system prompt (đã cắt trần). */
export function buildHintsBlock(hints: { file: string; content: string }): string {
  return `[GỢI Ý DỰ ÁN — ${hints.file}]\n${hints.content}`;
}

/** Scaffold SKILL.md mới (nút "Tạo skill mới" trong Settings). */
export function scaffoldSkillFile(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n/g, ' ').slice(0, DISK_SKILL_LIMITS.descriptionChars)}`,
    'version: 1.0.0',
    '---',
    '',
    '# ' + name,
    '',
    'Mô tả cách thực hiện kỹ năng này theo từng bước. Nội dung chỉ được nạp',
    'vào context khi agent gọi skill_load, nên hãy viết đầy đủ và cụ thể:',
    'các bước, ràng buộc, lệnh cần chạy, lỗi thường gặp.',
    '',
  ].join('\n');
}
