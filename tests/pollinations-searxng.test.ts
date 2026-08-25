import { describe, expect, it } from 'vitest';
import { pollinationsImageUrl, pollinationsMarkdown, POLLINATIONS_PROMPT_CHARS } from '@/lib/pollinations';
import { parseSearxngJson, searxngBase } from '@/lib/web-backend';

describe('pollinations', () => {
  it('dựng URL đúng format + encode prompt', () => {
    const url = pollinationsImageUrl('con mèo ngồi trên mái nhà')!;
    expect(url.startsWith('https://image.pollinations.ai/prompt/')).toBe(true);
    expect(url).toContain('width=1024');
    expect(url).toContain('height=1024');
    expect(url).toContain('nologo=true');
    expect(url).toContain(encodeURIComponent('con mèo'));
  });

  it('kích thước bị kẹp trong [256, 2048], seed nguyên vẹn', () => {
    const url = pollinationsImageUrl('x', { width: 9999, height: 10, seed: 42.7 })!;
    expect(url).toContain('width=2048');
    expect(url).toContain('height=256');
    expect(url).toContain('seed=42');
  });

  it('prompt dài hơn trần bị cắt, prompt rỗng → null', () => {
    const long = 'a'.repeat(POLLINATIONS_PROMPT_CHARS + 100);
    const url = pollinationsImageUrl(long)!;
    // decode xong không vượt trần
    expect(decodeURIComponent(url.split('/prompt/')[1].split('?')[0]).length).toBeLessThanOrEqual(
      POLLINATIONS_PROMPT_CHARS,
    );
    expect(pollinationsImageUrl('   ')).toBeNull();
    expect(pollinationsMarkdown('')).toBeNull();
  });

  it('markdown bọc đúng cú pháp ![label](url)', () => {
    const md = pollinationsMarkdown('mèo', 'flux-test')!;
    expect(md.startsWith('\n\n![flux-test](https://image.pollinations.ai/prompt/')).toBe(true);
    expect(md.endsWith(')\n')).toBe(true);
  });
});

describe('searxng helpers', () => {
  it('searxngBase đọc env, bỏ slash đuôi, chặn protocol lạ', () => {
    expect(searxngBase('http://localhost:8888/')).toBe('http://localhost:8888');
    expect(searxngBase('https://search.example.com/searxng///')).toBe(
      'https://search.example.com/searxng',
    );
    expect(searxngBase('ftp://weird')).toBeNull();
    expect(searxngBase('not a url')).toBeNull();
    expect(searxngBase(undefined)).toBeNull();
    expect(searxngBase('  ')).toBeNull();
  });

  it('parseSearxngJson map results[].content → snippet, bỏ rác', () => {
    const json = JSON.stringify({
      results: [
        { title: 'KQ SearXNG', url: 'https://s.com/a', content: 'nội dung' },
        { title: 'no url' },
        { title: '', url: 'https://s.com/b' },
      ],
    });
    const hits = parseSearxngJson(json);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ title: 'KQ SearXNG', url: 'https://s.com/a', snippet: 'nội dung' });
    expect(parseSearxngJson('<html>not json</html>')).toEqual([]);
    expect(parseSearxngJson('{}')).toEqual([]);
  });
});
