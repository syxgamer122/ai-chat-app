import { describe, expect, it } from 'vitest';
import {
  parseSkillFile,
  scanDiskSkills,
  buildDiskSkillIndexBlock,
  pickHintsContent,
  buildHintsBlock,
  scaffoldSkillFile,
  DISK_SKILL_LIMITS,
  HINTS_FILE_CANDIDATES,
  type DiskSkillAdapters,
} from '@/lib/skills/disk';

const SKILL_MD = [
  '---',
  'name: deploy-flow',
  'description: Quy trình deploy production an toàn',
  'version: 2.1.0',
  'allowed_tools:',
  '  - shell_run',
  '  - git_commit',
  '---',
  '',
  '# Deploy',
  '',
  'Bước 1: chạy test. Bước 2: bump version. Bước 3: tag + push.',
].join('\n');

describe('skills/disk — parseSkillFile', () => {
  it('parse front-matter + body đầy đủ', () => {
    const r = parseSkillFile(SKILL_MD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('deploy-flow');
      expect(r.skill.description).toContain('deploy production');
      expect(r.skill.version).toBe('2.1.0');
      expect(r.skill.allowedTools).toEqual(['shell_run', 'git_commit']);
      expect(r.skill.body).toContain('Bước 1');
    }
  });

  it('thiếu front-matter / không khép → lỗi rõ', () => {
    expect(parseSkillFile('# Chỉ có body').ok).toBe(false);
    expect(parseSkillFile('---\nname: x\n# thiếu khép').ok).toBe(false);
  });

  it('thiếu name/description hoặc name sai định dạng → lỗi', () => {
    expect(parseSkillFile('---\ndescription: d\n---\nbody').ok).toBe(false);
    expect(parseSkillFile('---\nname: x\n---\nbody').ok).toBe(false);
    expect(parseSkillFile('---\nname: "1 bad name!"\ndescription: d\n---\nbody').ok).toBe(false);
  });

  it('CRLF được chuẩn hoá', () => {
    const crlf = SKILL_MD.replace(/\n/g, '\r\n');
    expect(parseSkillFile(crlf).ok).toBe(true);
  });

  it('version/allowed_tools thiếu → optional, không lỗi', () => {
    const r = parseSkillFile('---\nname: simple\ndescription: d\n---\nbody');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.version).toBeUndefined();
      expect(r.skill.allowedTools).toBeUndefined();
    }
  });
});

describe('skills/disk — scanDiskSkills', () => {
  const adapters = (over: Partial<DiskSkillAdapters> = {}): DiskSkillAdapters => ({
    listWorkspaceSkillDirs: async () => ['deploy-flow', 'broken'],
    readWorkspaceSkill: async (d) => (d === 'broken' ? 'không có front-matter' : SKILL_MD),
    listGlobalSkillDirs: async () => ['shared-skill'],
    readGlobalSkill: async () =>
      '---\nname: shared-skill\ndescription: dùng chung mọi dự án\n---\nbody',
    ...over,
  });

  it('gom skill workspace + global, lỗi file hỏng không chặn phần còn lại', async () => {
    const { entries, errors } = await scanDiskSkills(adapters());
    expect(entries.map((e) => `${e.source}:${e.name}`).sort()).toEqual([
      'global:shared-skill',
      'workspace:deploy-flow',
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.source).toContain('broken');
  });

  it('trùng tên giữa workspace và global → workspace thắng', async () => {
    const { entries } = await scanDiskSkills(
      adapters({
        listGlobalSkillDirs: async () => ['deploy-flow'],
        readGlobalSkill: async () =>
          '---\nname: deploy-flow\ndescription: bản global\n---\nbody',
      }),
    );
    const names = entries.filter((e) => e.name === 'deploy-flow');
    expect(names).toHaveLength(1);
    expect(names[0]!.source).toBe('workspace');
  });

  it('không có bridge global / list throw → bỏ qua êm', async () => {
    const { entries, errors } = await scanDiskSkills(
      adapters({
        listWorkspaceSkillDirs: async () => {
          throw new Error('no .vyen');
        },
        listGlobalSkillDirs: undefined,
        readGlobalSkill: undefined,
      }),
    );
    expect(entries).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('dir của workspace mang tiền tố .vyen/skills', async () => {
    const { entries } = await scanDiskSkills(adapters({ listGlobalSkillDirs: undefined, readGlobalSkill: undefined }));
    expect(entries[0]!.dir).toBe('.vyen/skills/deploy-flow');
  });
});

describe('skills/disk — index block (progressive disclosure)', () => {
  it('CHỈ chứa name/mô tả/nguồn — KHÔNG chứa body', async () => {
    const { entries } = await scanDiskSkills({
      listWorkspaceSkillDirs: async () => ['deploy-flow'],
      readWorkspaceSkill: async () => SKILL_MD,
    });
    const block = buildDiskSkillIndexBlock(entries);
    expect(block).toContain('[SKILLS (chỉ mục)]');
    expect(block).toContain('deploy-flow');
    expect(block).toContain('skill_load');
    expect(block).not.toContain('Bước 1'); // body phải VẮNG MẶT
  });

  it('rỗng → chuỗi rỗng', () => {
    expect(buildDiskSkillIndexBlock([])).toBe('');
  });

  it('dấu | trong description bị thay để không phá bảng markdown', () => {
    const block = buildDiskSkillIndexBlock([
      { name: 'a', description: 'dùng khi a|b', source: 'workspace', dir: '.vyen/skills/a' },
    ]);
    expect(block).toContain('dùng khi a/b');
  });
});

describe('skills/disk — hints', () => {
  it('ưu tiên .vyenhints > AGENTS.md > CLAUDE.md > .goosehints', () => {
    expect(HINTS_FILE_CANDIDATES[0]).toBe('.vyenhints');
    const picked = pickHintsContent([
      { file: 'AGENTS.md', content: 'agents' },
      { file: '.vyenhints', content: 'hints thắng' },
    ]);
    expect(picked?.file).toBe('.vyenhints');
  });

  it('bỏ file rỗng, lấy file đầu tiên có nội dung', () => {
    const picked = pickHintsContent([
      { file: '.vyenhints', content: '   ' },
      { file: 'AGENTS.md', content: 'nội dung agents' },
    ]);
    expect(picked?.file).toBe('AGENTS.md');
    expect(picked?.content).toBe('nội dung agents');
  });

  it('trần 8000 ký tự', () => {
    const picked = pickHintsContent([{ file: '.vyenhints', content: 'x'.repeat(10_000) }]);
    expect(picked!.content.length).toBe(DISK_SKILL_LIMITS.hintsChars);
  });

  it('không file nào có nội dung → null', () => {
    expect(pickHintsContent([{ file: '.vyenhints', content: '' }])).toBeNull();
  });

  it('buildHintsBlock có tên file', () => {
    expect(buildHintsBlock({ file: '.vyenhints', content: 'abc' })).toContain('[GỢI Ý DỰ ÁN — .vyenhints]');
  });
});

describe('skills/disk — scaffold', () => {
  it('sinh SKILL.md parse lại được', () => {
    const text = scaffoldSkillFile('my-skill', 'Mô tả skill của tôi');
    const parsed = parseSkillFile(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.skill.name).toBe('my-skill');
      expect(parsed.skill.description).toBe('Mô tả skill của tôi');
    }
  });

  it('description nhiều dòng bị gộp một dòng (YAML an toàn)', () => {
    const text = scaffoldSkillFile('s', 'dòng 1\ndòng 2');
    expect(parseSkillFile(text).ok).toBe(true);
  });
});
