import { describe, expect, it } from 'vitest';
import {
  RecipeSchema,
  RECIPE_SCHEMA_VERSION,
  parseRecipeObject,
  formatRecipeIssues,
  type Recipe,
} from '@/lib/recipes/schema';
import {
  renderTemplate,
  collectTemplateVars,
  parseTemplate,
  coerceParamValue,
} from '@/lib/recipes/render';
import { parseRecipeText, serializeRecipe, detectRecipeFormat } from '@/lib/recipes/parse';
import {
  prepareRecipeRun,
  resolveParameters,
  pickSettings,
  appendUserPromptAnswers,
} from '@/lib/recipes/run';
import { discoverWorkspaceRecipes, type RecipeFsAdapter } from '@/lib/recipes/store';

const BASE: Recipe = {
  version: RECIPE_SCHEMA_VERSION,
  title: 'Fix failing tests',
  description: 'Sửa tới khi npm test pass trong phạm vi thư mục chỉ định.',
};

describe('recipes/schema', () => {
  it('chấp nhận recipe tối giản (title + description + prompt)', () => {
    const r = parseRecipeObject({ ...BASE, prompt: 'Sửa test trong {{ path }}' });
    expect(r.ok).toBe(true);
  });

  it('từ chối khi thiếu cả instructions lẫn prompt', () => {
    const r = parseRecipeObject(BASE);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/instructions|prompt/);
  });

  it('thiếu title hoặc description → lỗi', () => {
    expect(parseRecipeObject({ ...BASE, prompt: 'x', title: '' }).ok).toBe(false);
    expect(parseRecipeObject({ ...BASE, prompt: 'x', description: '' }).ok).toBe(false);
  });

  it('version sai literal bị từ chối', () => {
    const r = parseRecipeObject({ ...BASE, prompt: 'x', version: '0.9.9' });
    expect(r.ok).toBe(false);
  });

  it('select phải có options, default phải nằm trong options', () => {
    const r = parseRecipeObject({
      ...BASE,
      prompt: 'x',
      parameters: [{ key: 'mode', input_type: 'select', requirement: 'optional' }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/options/);

    const r2 = parseRecipeObject({
      ...BASE,
      prompt: 'x',
      parameters: [
        { key: 'mode', input_type: 'select', requirement: 'optional', options: ['a', 'b'], default: 'c' },
      ],
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/default/);
  });

  it('default sai kiểu với input_type bị từ chối', () => {
    const r = parseRecipeObject({
      ...BASE,
      prompt: 'x',
      parameters: [{ key: 'n', input_type: 'number', requirement: 'optional', default: 'nhan' }],
    });
    expect(r.ok).toBe(false);
  });

  it('key tham số trùng → lỗi; sai định dạng key → lỗi', () => {
    expect(
      parseRecipeObject({
        ...BASE,
        prompt: 'x',
        parameters: [
          { key: 'a', input_type: 'string', requirement: 'optional' },
          { key: 'a', input_type: 'string', requirement: 'optional' },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseRecipeObject({
        ...BASE,
        prompt: 'x',
        parameters: [{ key: '1bad', input_type: 'string', requirement: 'optional' }],
      }).ok,
    ).toBe(false);
  });

  it('sub-recipe phải có path HOẶC inline, không được cả hai', () => {
    expect(
      parseRecipeObject({ ...BASE, prompt: 'x', sub_recipes: [{ name: 's1' }] }).ok,
    ).toBe(false);
    expect(
      parseRecipeObject({
        ...BASE,
        prompt: 'x',
        sub_recipes: [{ name: 's1', path: 'a.yaml', inline: BASE }],
      }).ok,
    ).toBe(false);
  });

  it('sub-recipe lồng nhau chứa sub_recipes → từ chối (chống đệ quy)', () => {
    const nested: Recipe = {
      ...BASE,
      prompt: 'x',
      sub_recipes: [{ name: 'inner', path: 'inner.yaml' }],
    };
    const r = parseRecipeObject({
      ...BASE,
      prompt: 'x',
      sub_recipes: [{ name: 'outer', inline: nested }],
    });
    expect(r.ok).toBe(false);
  });

  it('strict: field lạ bị từ chối (chống nhồi rác từ link)', () => {
    const r = parseRecipeObject({ ...BASE, prompt: 'x', evil: 'rm -rf /' });
    expect(r.ok).toBe(false);
  });

  it('formatRecipeIssues có path field', () => {
    const parsed = RecipeSchema.safeParse({ version: '1.0.0' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatRecipeIssues(parsed.error)).toMatch(/title/);
    }
  });
});

describe('recipes/render', () => {
  it('thay {{ param }} (kể cả space trong braces)', () => {
    expect(renderTemplate('Sửa {{path}} ngay', { path: 'src/lib' })).toBe('Sửa src/lib ngay');
    expect(renderTemplate('Sửa {{ path }} ngay', { path: 'src/lib' })).toBe('Sửa src/lib ngay');
  });

  it('thiếu biến → chuỗi rỗng, không throw', () => {
    expect(renderTemplate('a {{ missing }} b', {})).toBe('a  b');
  });

  it('{{ recipe_dir }} thay bằng thư mục recipe', () => {
    expect(renderTemplate('cd {{ recipe_dir }}', { recipe_dir: '.vyen/recipes' })).toBe(
      'cd .vyen/recipes',
    );
  });

  it('{{#if}} giữ khối khi truthy, bỏ khi falsy', () => {
    const t = 'A{{#if verbose}} chi tiết {{/if}}B';
    expect(renderTemplate(t, { verbose: true })).toBe('A chi tiết B');
    expect(renderTemplate(t, { verbose: false })).toBe('AB');
    expect(renderTemplate(t, {})).toBe('AB');
    // string rỗng = falsy, chuỗi khác rỗng = truthy
    expect(renderTemplate(t, { verbose: '' })).toBe('AB');
    expect(renderTemplate(t, { verbose: 'on' })).toBe('A chi tiết B');
  });

  it('if chứa biến bên trong', () => {
    const t = '{{#if path}}scope: {{ path }}{{/if}}';
    expect(renderTemplate(t, { path: 'src' })).toBe('scope: src');
    expect(renderTemplate(t, {})).toBe('');
  });

  it('ESCAPING: giá trị chứa {{ }} / {{#if}} không bị render lại (one-pass)', () => {
    const malicious = '{{ rm -rf }} {{#if x}}pwned{{/if}}';
    expect(renderTemplate('cmd: {{ cmd }}', { cmd: malicious })).toBe(`cmd: ${malicious}`);
  });

  it('parseTemplate: marker ở giữa text không nuốt text trước nó', () => {
    const nodes = parseTemplate('keep {{ a }} then');
    expect(nodes[0]).toEqual({ kind: 'text', text: 'keep ' });
    expect(nodes[1]).toEqual({ kind: 'var', name: 'a' });
    expect(nodes[2]).toEqual({ kind: 'text', text: ' then' });
  });

  it('collectTemplateVars gom cả biến trong if', () => {
    expect(collectTemplateVars('{{ a }} {{#if b}}{{ c }}{{/if}}').sort()).toEqual(['a', 'b', 'c']);
  });

  it('coerceParamValue đúng kiểu VI+EN', () => {
    expect(coerceParamValue('42', 'number')).toBe(42);
    expect(coerceParamValue('abc', 'number')).toBeNull();
    expect(coerceParamValue('có', 'boolean')).toBe(true);
    expect(coerceParamValue('KHÔNG', 'boolean')).toBe(false);
    expect(coerceParamValue('maybe', 'boolean')).toBeNull();
    expect(coerceParamValue(' x ', 'string')).toBe('x');
  });
});

describe('recipes/parse', () => {
  it('parse YAML text', () => {
    const yaml = [
      'version: "1.0.0"',
      'title: T',
      'description: D',
      "prompt: 'lam {{ viec }}'",
    ].join('\n');
    const r = parseRecipeText(yaml);
    expect(r.ok).toBe(true);
    expect(r.recipe?.prompt).toBe('lam {{ viec }}');
    expect(r.format).toBe('yaml');
  });

  it('parse JSON text', () => {
    const r = parseRecipeText(JSON.stringify({ ...BASE, prompt: 'x' }));
    expect(r.ok).toBe(true);
    expect(r.format).toBe('json');
  });

  it('YAML hỏng → lỗi có thông điệp', () => {
    const r = parseRecipeText('a: [1, 2');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/YAML/);
  });

  it('schema sai → lỗi đường dẫn field', () => {
    const r = parseRecipeText('version: "1.0.0"\ntitle: T\ndescription: D');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/instructions|prompt/);
  });

  it('serializeRecipe round-trip yaml + json', () => {
    const recipe: Recipe = { ...BASE, prompt: 'x', parameters: [{ key: 'p', input_type: 'string', requirement: 'required' }] };
    const yaml = serializeRecipe(recipe, 'yaml');
    expect(parseRecipeText(yaml).ok).toBe(true);
    const json = serializeRecipe(recipe, 'json');
    expect(parseRecipeText(json).ok).toBe(true);
    expect(detectRecipeFormat(json)).toBe('json');
  });

  it('text rỗng / vượt trần bị chặn', () => {
    expect(parseRecipeText('   ').ok).toBe(false);
    expect(parseRecipeText('{'.repeat(10) + 'x'.repeat(200_001)).ok).toBe(false);
  });
});

describe('recipes/run — resolveParameters', () => {
  const params = [
    { key: 'req', input_type: 'string' as const, requirement: 'required' as const },
    { key: 'opt', input_type: 'string' as const, requirement: 'optional' as const, default: 'df' },
    { key: 'optEmpty', input_type: 'string' as const, requirement: 'optional' as const },
    { key: 'ask', input_type: 'string' as const, requirement: 'user_prompt' as const },
  ];

  it('required thiếu → missing; có default → dùng default', () => {
    const r = resolveParameters({ parameters: params }, {});
    expect(r.missing).toEqual(['req']);
    expect(r.values.opt).toBe('df');
    expect(r.values.optEmpty).toBe('');
    expect(r.needsPrompt).toEqual(['ask']);
  });

  it('provided đè default', () => {
    const r = resolveParameters({ parameters: params }, { req: 'a', opt: 'user' });
    expect(r.values.req).toBe('a');
    expect(r.values.opt).toBe('user');
    expect(r.missing).toEqual([]);
  });

  it('user_prompt có giá trị thì dùng, không thì chờ hỏi', () => {
    const r = resolveParameters({ parameters: params }, { ask: 'tra loi' });
    expect(r.values.ask).toBe('tra loi');
    expect(r.needsPrompt).toEqual([]);
  });
});

describe('recipes/run — prepareRecipeRun', () => {
  const recipe: Recipe = {
    ...BASE,
    instructions: 'Chỉ sửa trong {{ path }}. {{#if strict}}Chế độ ngặt.{{/if}}',
    prompt: 'Hãy sửa failing tests trong {{ path }}.',
    parameters: [{ key: 'path', input_type: 'string', requirement: 'required' }],
    tools: { deny: ['shell_run'] },
    mcp: ['github'],
    settings: { model: 'qwen3.5-flash', temperature: 0.2 },
    response: { json_schema: { type: 'object', required: ['fixed'], properties: { fixed: { type: 'boolean' } } } },
  };

  it('dựng đủ các mảnh, render template bằng giá trị tham số', () => {
    const prepared = prepareRecipeRun(recipe, { path: 'src' }, { recipeDir: '.vyen/recipes' });
    expect(prepared.systemAppend).toContain('[RECIPE: Fix failing tests]');
    expect(prepared.systemAppend).toContain('Chỉ sửa trong src.');
    expect(prepared.systemAppend).not.toContain('ngặt'); // strict falsy → bỏ khối
    expect(prepared.firstUserMessage).toBe('Hãy sửa failing tests trong src.');
    expect(prepared.toolPolicy).toEqual({ allow: [], deny: ['shell_run'] });
    expect(prepared.mcpServers).toEqual(['github']);
    expect(prepared.settings).toEqual({ model: 'qwen3.5-flash', temperature: 0.2 });
  });

  it('includeStructuredDirective=true móc khối JSON-strict vào systemAppend', () => {
    const prepared = prepareRecipeRun(recipe, { path: 'x', strict: true }, { includeStructuredDirective: true });
    expect(prepared.systemAppend).toContain('[STRUCTURED OUTPUT]');
    expect(prepared.systemAppend).toContain('"fixed"');
    expect(prepared.systemAppend).toContain('Chế độ ngặt.'); // strict truthy
  });

  it('không có prompt → fallback dùng description', () => {
    const noPrompt: Recipe = { ...BASE, instructions: 'làm việc' };
    const prepared = prepareRecipeRun(noPrompt, {});
    expect(prepared.firstUserMessage).toContain('Fix failing tests');
    expect(prepared.firstUserMessage).toContain('Sửa tới khi npm test pass');
  });

  it('pickSettings bỏ field undefined', () => {
    expect(pickSettings({ temperature: 1 })).toEqual({ temperature: 1 });
    expect(pickSettings(undefined)).toEqual({});
  });

  it('appendUserPromptAnswers dán câu trả lời user_prompt', () => {
    const msg = appendUserPromptAnswers('làm đi', { ticket: 'ABC-1', empty: '' });
    expect(msg).toContain('[Tham số]');
    expect(msg).toContain('ticket: ABC-1');
    expect(msg).not.toContain('empty');
  });
});

describe('recipes/store — discoverWorkspaceRecipes', () => {
  it('bỏ qua file lạ, gom recipe hợp lệ, gom lỗi file hỏng', async () => {
    const good = serializeRecipe({ ...BASE, prompt: 'x' }, 'yaml');
    const adapter: RecipeFsAdapter = {
      listRecipeFiles: async () => ['a.yaml', 'b.json', 'c.txt', 'bad.yaml'],
      readText: async (p) => (p === 'bad.yaml' ? '::: not yaml [' : p === 'a.yaml' ? good : JSON.stringify({ ...BASE, prompt: 'y' })),
    };
    const { recipes, errors } = await discoverWorkspaceRecipes(adapter);
    expect(recipes.map((r) => r.path).sort()).toEqual(['a.yaml', 'b.json']);
    expect(errors.map((e) => e.path)).toEqual(['bad.yaml']);
  });

  it('adapter list throw → rỗng im lặng (không có thư mục .vyen)', async () => {
    const adapter: RecipeFsAdapter = {
      listRecipeFiles: async () => {
        throw new Error('no dir');
      },
      readText: async () => '',
    };
    const { recipes, errors } = await discoverWorkspaceRecipes(adapter);
    expect(recipes).toEqual([]);
    expect(errors).toEqual([]);
  });
});
