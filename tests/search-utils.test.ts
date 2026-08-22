import { describe, expect, it } from 'vitest';
import {
  foldText,
  foldWithMap,
  tokenize,
  parseQueryTerms,
  buildSnippet,
} from '@/lib/search-utils';

describe('search-utils — tiếng Việt', () => {
  it('foldText bỏ dấu nhưng giữ nguyên chữ', () => {
    expect(foldText('Hoa Hậu Việt Nam')).toBe('hoa hau viet nam');
    expect(foldText('ĐÀ NẴNG')).toBe('da nang');
  });

  it('foldWithMap cho offset map khớp sau khi highlight', () => {
    const folded = foldWithMap('Tiếng Việt');
    expect(folded.folded).toBe('tieng viet');
    // Mỗi ký tự nguồn map về offset gốc của nó (an toàn cả surrogate pair)
    expect(folded.map).toHaveLength('Tiếng Việt'.length);
    expect(folded.map[0]).toBe(0);
  });

  it('tokenize cắt token, fold dấu, lọc token 1 ký tự', () => {
    expect(tokenize('Xin chào, thế giới!')).toEqual(['xin', 'chao', 'the', 'gioi']);
    expect(tokenize('a và của')).toEqual(['va', 'cua']);
  });

  it('parseQueryTerms fold dấu query', () => {
    expect(parseQueryTerms('HOA Hậu')).toEqual(['hoa', 'hau']);
  });

  it('buildSnippet tìm từ khóa có dấu trong nội dung không dấu (và ngược lại)', () => {
    const snippet = buildSnippet('Hôm nay thời tiết đẹp quá', ['thoi tiet']);
    expect(snippet).not.toBeNull();
  });
});
