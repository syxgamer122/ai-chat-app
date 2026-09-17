import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveModelOption, buildPickerSections, type ModelOption } from '@/lib/model-meta';
import { detectMediaKind, isRetiredMediaOption } from '@/lib/media-models';

const SELECTOR_PATH = path.resolve(__dirname, '../components/model-selector.tsx');
const source = fs.readFileSync(SELECTOR_PATH, 'utf8');

describe('model picker filters retired generation models', () => {
  it('selectable list and persisted selection both go through the shared classifier', () => {
    expect(source).toContain('models.filter((m) => !isRetiredMediaOption(m))');
    expect(source).toContain('Boolean(current && isRetiredMediaOption(current))');
    expect(source).toMatch(/buildPickerSections\(selectableModels, \{/);
  });

  it('favorites, recents and search all flow through the filtered sections', () => {
    expect(source).toMatch(
      /\[selectableModels, favorites, recents, value, providerId, builtinCatalog, query\]/,
    );
    expect(source).not.toMatch(/buildPickerSections\(models\b/);
    expect(source).toMatch(/\{selectableModels\.length\} model/);
  });

  it('persisted generation selection prompts for a coding/chat model instead of sending', () => {
    expect(source).toContain("retiredSelection ? 'Chọn model lập trình/chat' : current?.label ?? 'Model'");
    expect(source).toContain('aria-label={`Model: ${selectionLabel}`}');
  });

  it('does not render media icons for image/video rows in the picker or trigger', () => {
    expect(source).not.toContain('ImageIcon');
    expect(source).not.toContain('Clapperboard');
  });
});

describe('retired option pipeline — persisted catalog to picker sections', () => {
  const providerCatalog: Array<Parameters<typeof deriveModelOption>[0]> = [
    { id: 'qwen-image-3.0-pro', name: 'Qwen Image 3.0 Pro', contextLength: 8_000 },
    { id: 'qwen-video' },
    { id: 'mdl-7712', name: 'Tạo ảnh nhanh · flux' },
    { id: 'qwen3-vl-plus', contextLength: 8_000 },
    { id: 'qwen-coder', name: 'Qwen Coder', contextLength: 8_000 },
  ];

  it('deriveModelOption keeps classifying provider catalog entries for persisted selections', () => {
    expect(providerCatalog.map((m) => deriveModelOption(m).media)).toEqual([
      'image',
      'video',
      'image',
      undefined,
      undefined,
    ]);
  });

  it('the filter drops generation models but keeps vision/chat coding models', () => {
    const options = providerCatalog.map((m) => deriveModelOption(m));
    expect(options.filter((m) => !isRetiredMediaOption(m)).map((m) => m.id)).toEqual([
      'qwen3-vl-plus',
      'qwen-coder',
    ]);
  });

  it('sections built from the filtered list hide retired favorites, recents and search hits', () => {
    const options: ModelOption[] = [
      { id: 'gpt-4o', label: 'GPT-4o', ctx: 128_000, caps: ['vision', 'pdf'] },
      { id: 'qwen-coder', label: 'Qwen Coder', ctx: 8_000 },
      ...providerCatalog.map(deriveModelOption),
    ];
    const sections = buildPickerSections(
      options.filter((m) => !isRetiredMediaOption(m)),
      {
        providerId: 'p1',
        favorites: [{ id: 'flux-pro', providerId: 'p1' }],
        recents: [{ id: 'sora-2', providerId: 'p1', ts: 1 }],
        query: 'qwen',
      },
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].items.map((m) => m.id)).toEqual(['qwen-coder', 'qwen3-vl-plus']);
  });

  it('vision exemption matches the route-side classifier', () => {
    expect(detectMediaKind('qwen-image-vl')).toBeUndefined();
    expect(detectMediaKind('image-ocr')).toBeUndefined();
    expect(detectMediaKind('flux-pro')).toBe('image');
    expect(detectMediaKind('wan2.5-t2v')).toBe('video');
  });
});
