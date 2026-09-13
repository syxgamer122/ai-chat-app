import { describe, expect, it } from 'vitest';
import {
  subRecipeToolName,
  SUBRECIPE_BATCH_TOOL,
  SUBRECIPE_SUMMARY_CHARS,
  buildSubRecipeParameters,
  buildSubRecipeToolDescription,
  buildSubRecipeSystemBlock,
  planSubRecipeBatch,
  formatSubRecipeResult,
  buildSubRecipeInstructions,
  resolveSubRecipesAtStart,
  type ResolvedSubRecipe,
} from '@/lib/recipes/subrecipe';
import { serializeRecipe, RECIPE_SCHEMA_VERSION, type Recipe } from '@/lib/recipes';

const SUB_RECIPE: Recipe = {
  version: RECIPE_SCHEMA_VERSION,
  title: 'Chạy lint một file',
  description: 'Lint file chỉ định và trả lỗi.',
  instructions: 'Lint {{ file }} rồi báo lỗi ngắn gọn.',
  parameters: [
    { key: 'file', input_type: 'string', requirement: 'required' },
    { key: 'fix', input_type: 'boolean', requirement: 'optional', default: false },
  ],
};

function resolvedFixture(over: Partial<ResolvedSubRecipe> = {}): ResolvedSubRecipe {
  return {
    name: 'lint_one',
    recipe: SUB_RECIPE,
    mode: 'parallel',
    returnMode: 'summary',
    fixedValues: {},
    ...over,
  };
}

describe('subrecipe — naming + zod mapping', () => {
  it('subRecipeToolName gắn tiền tố đúng chuẩn', () => {
    expect(subRecipeToolName('lint_one')).toBe('subrecipe__lint_one');
    expect(SUBRECIPE_BATCH_TOOL).toBe('subrecipe__batch');
  });

  it('buildSubRecipeParameters: required → bắt buộc, optional → optional, select → enum', () => {
    const schema = buildSubRecipeParameters(SUB_RECIPE.parameters, {}) as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ file: 'a.ts' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // thiếu required
    expect(schema.safeParse({ file: 'a.ts', fix: true }).success).toBe(true);
    expect(schema.safeParse({ file: 'a.ts', fix: 'yes' }).success).toBe(false); // sai kiểu

    const selectRecipe: Recipe = {
      ...SUB_RECIPE,
      parameters: [{ key: 'mode', input_type: 'select', requirement: 'optional', options: ['fast', 'deep'] }],
    };
    const selectSchema = buildSubRecipeParameters(selectRecipe.parameters, {}) as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(selectSchema.safeParse({ mode: 'fast' }).success).toBe(true);
    expect(selectSchema.safeParse({ mode: 'turbo' }).success).toBe(false);
  });

  it('tham số fixed bị LOẠI khỏi schema (model không truyền được)', () => {
    const schema = buildSubRecipeParameters(SUB_RECIPE.parameters, { file: 'locked.ts' }) as {
      safeParse: (v: unknown) => { success: boolean };
      _def: { shape: () => Record<string, unknown> };
    };
    expect(Object.keys(schema._def.shape())).toEqual(['fix']);
  });
});

describe('subrecipe — description + system block', () => {
  it('description nêu title, tham số, giá trị fixed, chế độ trả', () => {
    const d = buildSubRecipeToolDescription(resolvedFixture({ fixedValues: { file: 'x.ts' } }));
    expect(d).toContain('Chạy lint một file');
    expect(d).toContain('fix?');
    expect(d).toContain('file=x.ts');
    expect(d).toContain('tóm tắt ≤ 2000');
  });

  it('system block liệt kê tool + batch + cảnh báo sequential', () => {
    const block = buildSubRecipeSystemBlock([
      resolvedFixture(),
      resolvedFixture({ name: 'test_one', mode: 'sequential' }),
    ]);
    expect(block).toContain('subrecipe__lint_one');
    expect(block).toContain('subrecipe__test_one');
    expect(block).toContain('gọi tuần tự');
    expect(block).toContain(SUBRECIPE_BATCH_TOOL);
  });
});

describe('subrecipe — batch planning', () => {
  const subs = [resolvedFixture(), resolvedFixture({ name: 'test_one' })];

  it('batch hợp lệ giữ thứ tự', () => {
    const plan = planSubRecipeBatch([{ name: 'lint_one' }, { name: 'test_one', args: { x: 1 } }], subs);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.entries.map((e) => e.sub.name)).toEqual(['lint_one', 'test_one']);
      expect(plan.entries[1]!.args).toEqual({ x: 1 });
    }
  });

  it('tên lạ / trùng / rỗng → lỗi', () => {
    expect(planSubRecipeBatch([{ name: 'nope' }], subs).ok).toBe(false);
    expect(planSubRecipeBatch([{ name: 'lint_one' }, { name: 'lint_one' }], subs).ok).toBe(false);
    expect(planSubRecipeBatch([], subs).ok).toBe(false);
  });

  it('args không phải object → coerce rỗng, không lỗi', () => {
    const plan = planSubRecipeBatch([{ name: 'lint_one', args: 'rác' as unknown as Record<string, unknown> }], subs);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.entries[0]!.args).toEqual({});
  });
});

describe('subrecipe — return_mode', () => {
  it('summary cắt ở trần + ghi chú; full giữ nguyên', () => {
    const long = 'x'.repeat(SUBRECIPE_SUMMARY_CHARS + 500);
    const sum = formatSubRecipeResult(long, 'summary');
    expect(sum.length).toBeLessThanOrEqual(SUBRECIPE_SUMMARY_CHARS + 200);
    expect(sum).toContain('đã cắt');
    expect(formatSubRecipeResult(long, 'full')).toBe(long);
    expect(formatSubRecipeResult('ngắn', 'summary')).toBe('ngắn');
  });

  it('buildSubRecipeInstructions: summary móc chỉ dẫn tóm tắt', () => {
    const s = buildSubRecipeInstructions('SYS', 'PROMPT', 'summary');
    expect(s).toContain('SYS');
    expect(s).toContain('PROMPT');
    expect(s).toContain('tóm tắt không quá 2000');
    expect(buildSubRecipeInstructions('SYS', 'PROMPT', 'full')).toContain('đầy đủ');
  });
});

describe('subrecipe — resolve lúc start', () => {
  it('inline parse + default mode/returnMode', async () => {
    const { resolved, errors } = await resolveSubRecipesAtStart(
      [{ name: 'a', inline: SUB_RECIPE }],
      async () => '',
    );
    expect(errors).toEqual([]);
    expect(resolved[0]!.recipe.title).toBe('Chạy lint một file');
    expect(resolved[0]!.mode).toBe('parallel');
    expect(resolved[0]!.returnMode).toBe('summary');
  });

  it('path đọc qua adapter + join baseDir', async () => {
    const readCalls: string[] = [];
    const { resolved, errors } = await resolveSubRecipesAtStart(
      [{ name: 'a', path: 'lint.yaml', return_mode: 'full', values: { file: 'src/x.ts' } }],
      async (p) => {
        readCalls.push(p);
        return serializeRecipe(SUB_RECIPE, 'yaml');
      },
      { baseDir: '.vyen/recipes' },
    );
    expect(errors).toEqual([]);
    expect(readCalls).toEqual(['.vyen/recipes/lint.yaml']);
    expect(resolved[0]!.returnMode).toBe('full');
    expect(resolved[0]!.fixedValues).toEqual({ file: 'src/x.ts' });
  });

  it('sub-recipe chứa sub_recipes → lỗi đệ quy (chặn tầng resolve)', async () => {
    const nested: Recipe = {
      ...SUB_RECIPE,
      sub_recipes: [{ name: 'inner', path: 'inner.yaml' }],
    };
    const { resolved, errors } = await resolveSubRecipesAtStart(
      [{ name: 'a', inline: nested }],
      async () => '',
    );
    // Schema đã cấm ngay từ parse (superRefine) — resolve phải từ chối.
    expect(resolved.length + errors.length).toBe(1);
    expect(errors.length === 1 || resolved.length === 0).toBe(true);
  });

  it('path hỏng / readFile throw → gom lỗi, entry khác vẫn chạy', async () => {
    const { resolved, errors } = await resolveSubRecipesAtStart(
      [
        { name: 'good', inline: SUB_RECIPE },
        { name: 'bad', path: 'gone.yaml' },
      ],
      async (p) => {
        if (p.includes('gone')) throw new Error('ENOENT');
        return serializeRecipe(SUB_RECIPE, 'yaml');
      },
    );
    expect(resolved.map((r) => r.name)).toEqual(['good']);
    expect(errors[0]!.name).toBe('bad');
  });
});
