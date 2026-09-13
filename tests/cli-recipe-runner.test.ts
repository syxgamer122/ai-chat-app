import { describe, expect, it } from 'vitest';
import { parseRecipeRunArgv } from '@/lib/cli/recipe-runner';
import { resolveDispatch, COMMANDS } from '@/lib/cli/cli-surface';

describe('cli recipe-runner — parseRecipeRunArgv', () => {
  it('đủ cờ cơ bản', () => {
    const r = parseRecipeRunArgv(['--recipe', 'fix-tests.yaml', '--params', 'path=src']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.recipePath).toBe('fix-tests.yaml');
      expect(r.args.params).toEqual({ path: 'src' });
      expect(r.args.output).toBe('text');
      expect(r.args.noSession).toBe(false);
    }
  });

  it('--recipe=<file>, --params lặp + phân cách phẩy, --output json, --no-session', () => {
    const r = parseRecipeRunArgv([
      '--recipe=lint.yaml',
      '--params', 'a=1,b=x y',
      '--params', 'c=true',
      '--output=json',
      '--no-session',
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.recipePath).toBe('lint.yaml');
      expect(r.args.params).toEqual({ a: '1', b: 'x y', c: 'true' });
      expect(r.args.output).toBe('json');
      expect(r.args.noSession).toBe(true);
    }
  });

  it('đường dẫn positional không có cờ', () => {
    const r = parseRecipeRunArgv(['fix-tests.yaml']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.recipePath).toBe('fix-tests.yaml');
  });

  it('thiếu recipe → lỗi có ví dụ; cờ lạ → lỗi; --output rác → lỗi', () => {
    expect(parseRecipeRunArgv([]).ok).toBe(false);
    expect(parseRecipeRunArgv(['--wat']).ok).toBe(false);
    expect(parseRecipeRunArgv(['--recipe', 'a.yaml', '--output', 'xml']).ok).toBe(false);
    expect(parseRecipeRunArgv(['a.yaml', 'thừa']).ok).toBe(false);
  });

  it('--model đè model của recipe', () => {
    const r = parseRecipeRunArgv(['--recipe', 'a.yaml', '--model', 'qwen3.5-flash']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.model).toBe('qwen3.5-flash');
  });
});

describe('cli dispatch — run --recipe đi vào recipe runner', () => {
  it("'run' + --recipe → lệnh recipe (không rơi vào REPL)", () => {
    const res = resolveDispatch(['run', '--recipe', 'fix-tests.yaml', '--params', 'path=src']);
    expect(res.branch).toBe('command');
    expect(res.command?.name).toBe('recipe');
  });

  it("'run' không có --recipe vẫn là REPL (giữ compat)", () => {
    const res = resolveDispatch(['run']);
    expect(res.command?.name).toBe('cli');
  });

  it("'recipe' là lệnh nhóm agent — dispatch ngay ở nhánh đầu", () => {
    const res = resolveDispatch(['recipe', 'list']);
    expect(res.branch).toBe('command');
    expect(res.command?.name).toBe('recipe');
  });

  it('registry có mô tả tiếng Việt cho help', () => {
    expect(COMMANDS.recipe.description.length).toBeGreaterThan(10);
  });
});
