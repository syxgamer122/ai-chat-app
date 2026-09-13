import { describe, it, expect } from 'vitest';
import {
  parseSlashCommand,
  normalizeModeParam,
  BUILTIN_SLASH_COMMANDS,
} from '@/lib/slash-commands';

describe('Slash Commands Engine (Goose P2-10)', () => {
  it('định nghĩa đầy đủ 8 lệnh slash built-in chuẩn', () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('mode');
    expect(names).toContain('summarize');
    expect(names).toContain('recipe');
    expect(names).toContain('skills');
    expect(names).toContain('memory');
    expect(names).toContain('tools');
    expect(names).toContain('cost');
  });

  describe('normalizeModeParam', () => {
    it('ánh xạ chính xác các mode hợp lệ', () => {
      expect(normalizeModeParam('auto')).toBe('never');
      expect(normalizeModeParam('never')).toBe('never');
      expect(normalizeModeParam('smart')).toBe('smart');
      expect(normalizeModeParam('approve')).toBe('always');
      expect(normalizeModeParam('always')).toBe('always');
      expect(normalizeModeParam('manual')).toBe('always');
      expect(normalizeModeParam('chat')).toBe('chat_only');
      expect(normalizeModeParam('chat_only')).toBe('chat_only');
      expect(normalizeModeParam('invalid')).toBeNull();
    });
  });

  describe('parseSlashCommand', () => {
    it('parse /plan với mục tiêu', () => {
      const res = parseSlashCommand('/plan tối ưu hóa bundle Next.js');
      expect(res).toEqual({
        kind: 'plan',
        target: 'tối ưu hóa bundle Next.js',
      });
    });

    it('parse /mode sang các chính sách', () => {
      expect(parseSlashCommand('/mode auto')).toEqual({ kind: 'mode', mode: 'never' });
      expect(parseSlashCommand('/mode smart')).toEqual({ kind: 'mode', mode: 'smart' });
      expect(parseSlashCommand('/mode approve')).toEqual({ kind: 'mode', mode: 'always' });
      expect(parseSlashCommand('/mode chat')).toEqual({ kind: 'mode', mode: 'chat_only' });
      expect(parseSlashCommand('/policy auto')).toEqual({ kind: 'mode', mode: 'never' });
    });

    it('parse /summarize và alias /compact', () => {
      expect(parseSlashCommand('/summarize')).toEqual({ kind: 'summarize' });
      expect(parseSlashCommand('/compact')).toEqual({ kind: 'summarize' });
    });

    it('parse /recipe <name>', () => {
      expect(parseSlashCommand('/recipe git-summary')).toEqual({
        kind: 'recipe',
        recipeName: 'git-summary',
      });
    });

    it('parse /skills, /memory, /tools, /cost và các alias', () => {
      expect(parseSlashCommand('/skills')).toEqual({ kind: 'skills' });
      expect(parseSlashCommand('/skill')).toEqual({ kind: 'skills' });
      expect(parseSlashCommand('/memory')).toEqual({ kind: 'memory' });
      expect(parseSlashCommand('/memories')).toEqual({ kind: 'memory' });
      expect(parseSlashCommand('/tools search')).toEqual({ kind: 'tools', query: 'search' });
      expect(parseSlashCommand('/cost')).toEqual({ kind: 'cost' });
      expect(parseSlashCommand('/tokens')).toEqual({ kind: 'cost' });
    });

    it('parse custom slash command theo map người dùng cấu hình', () => {
      const customMappings = {
        lint: 'recipe-fix-lint',
        test: 'recipe-run-tests',
      };

      const res1 = parseSlashCommand('/lint --verbose', customMappings);
      expect(res1).toEqual({
        kind: 'custom_recipe',
        recipeId: 'recipe-fix-lint',
        args: '--verbose',
      });

      const res2 = parseSlashCommand('/test', customMappings);
      expect(res2).toEqual({
        kind: 'custom_recipe',
        recipeId: 'recipe-run-tests',
        args: undefined,
      });
    });

    it('trả về null nếu không bắt đầu bằng /', () => {
      expect(parseSlashCommand('xin chào')).toBeNull();
      expect(parseSlashCommand('')).toBeNull();
    });

    it('trả về unknown nếu lệnh không nằm trong catalog', () => {
      const res = parseSlashCommand('/unknown-cmd foo bar');
      expect(res).toEqual({
        kind: 'unknown',
        command: 'unknown-cmd',
        raw: '/unknown-cmd foo bar',
      });
    });
  });
});
