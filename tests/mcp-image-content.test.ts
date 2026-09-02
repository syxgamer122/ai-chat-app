/**
 * Tests cho MCP image-content — lớp biến khối ảnh trong tool-result MCP
 * thành bản mô tả text, trước khi mcpContentToText ghép cho model.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  hasMcpImages,
  describeMcpImageBlocks,
  DEFAULT_MAX_MCP_IMAGES,
  type McpImageDescriber,
} from '../lib/mcp/image-content';
import type { McpContentBlock } from '../lib/mcp/tool-mapper';

/** Describer giả luôn thành công — ghi lại cặp đối số để kiểm tra data URL. */
function okDescriber(log?: Array<{ dataUrl: string; mimeType: string }>): McpImageDescriber {
  return async (dataUrl, mimeType) => {
    log?.push({ dataUrl, mimeType });
    return `mô tả của ${mimeType}`;
  };
}

const png = (data = 'AAAA'): McpContentBlock => ({ type: 'image', data, mimeType: 'image/png' });

describe('hasMcpImages', () => {
  it('true khi có khối image hợp lệ', () => {
    expect(hasMcpImages([{ type: 'text', text: 'ok' }, png()])).toBe(true);
  });

  it('false với image thiếu data hoặc mimeType', () => {
    expect(hasMcpImages([{ type: 'image', mimeType: 'image/png' }])).toBe(false);
    expect(hasMcpImages([{ type: 'image', data: 'AAAA' }])).toBe(false);
    // data rỗng chuỗi cũng coi như không mô tả được.
    expect(hasMcpImages([{ type: 'image', data: '', mimeType: 'image/png' }])).toBe(false);
    // mimeType rỗng chuỗi — đường kiểm tra thứ hai của imageFields.
    expect(hasMcpImages([{ type: 'image', data: 'AAAA', mimeType: '' }])).toBe(false);
  });

  it('false với content không có ảnh / rỗng / null', () => {
    expect(hasMcpImages([{ type: 'text', text: 'hi' }])).toBe(false);
    expect(hasMcpImages([])).toBe(false);
    expect(hasMcpImages(null as never)).toBe(false);
    expect(hasMcpImages(undefined as never)).toBe(false);
  });
});

describe('describeMcpImageBlocks', () => {
  it('trả lại đúng tham chiếu mảng khi không có ảnh nào', async () => {
    const content: McpContentBlock[] = [{ type: 'text', text: 'chỉ text' }];
    const describe = vi.fn(okDescriber());
    const out = await describeMcpImageBlocks(content, describe);
    expect(out).toBe(content);
    expect(describe).not.toHaveBeenCalled();
  });

  it('thay khối image bằng khối text đúng vị trí, giữ thứ tự', async () => {
    const content: McpContentBlock[] = [
      { type: 'text', text: 'trước' },
      png('QQ=='),
      { type: 'text', text: 'giữa' },
      { type: 'image', data: 'Qg==', mimeType: 'image/jpeg' },
      { type: 'text', text: 'sau' },
    ];
    const out = await describeMcpImageBlocks(content, okDescriber());
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ type: 'text', text: 'trước' });
    expect(out[1]).toEqual({ type: 'text', text: '[ảnh MCP image/png]: mô tả của image/png' });
    expect(out[2]).toEqual({ type: 'text', text: 'giữa' });
    expect(out[3]).toEqual({ type: 'text', text: '[ảnh MCP image/jpeg]: mô tả của image/jpeg' });
    expect(out[4]).toEqual({ type: 'text', text: 'sau' });
  });

  it('describe throw → khối text ghi lỗi, không ném ra ngoài', async () => {
    const content: McpContentBlock[] = [png('QQ==')];
    const describe = async () => {
      throw new Error('Gemini 502');
    };
    const out = await describeMcpImageBlocks(content, describe);
    expect(out[0]).toEqual({
      type: 'text',
      text: '[ảnh MCP image/png: mô tả thất bại — Gemini 502]',
    });
  });

  it('describe reject với giá trị không phải Error → vẫn ra khối lỗi an toàn', async () => {
    const describe = async () => Promise.reject('boom string');
    const out = await describeMcpImageBlocks([png()], describe);
    expect(out[0].type).toBe('text');
    expect(out[0].text).toContain('mô tả thất bại — boom string');
  });

  it('describe ném sync (không trả Promise) → vẫn không thoát ra ngoài', async () => {
    const describe = ((_dataUrl: string, _mimeType: string) => {
      throw new Error('sync boom');
    }) as unknown as McpImageDescriber;
    const out = await describeMcpImageBlocks([png('QQ=='), { type: 'text', text: 'ok' }], describe);
    expect(out[0]).toEqual({
      type: 'text',
      text: '[ảnh MCP image/png: mô tả thất bại — sync boom]',
    });
    // Khối khác không bị ảnh hưởng.
    expect(out[1]).toEqual({ type: 'text', text: 'ok' });
  });

  it('vượt maxImages → ảnh dư giữ nguyên type image', async () => {
    const content: McpContentBlock[] = [
      png('MQ=='),
      png('Mg=='),
      png('Mw=='),
    ];
    const describe = vi.fn(okDescriber());
    const out = await describeMcpImageBlocks(content, describe, { maxImages: 2 });
    expect(describe).toHaveBeenCalledTimes(2);
    expect(out[0].type).toBe('text');
    expect(out[1].type).toBe('text');
    // Ảnh thứ 3 vượt trần: giữ nguyên image block để tầng trên quyết.
    expect(out[2]).toEqual({ type: 'image', data: 'Mw==', mimeType: 'image/png' });
  });

  it('maxImages mặc định là 4', async () => {
    expect(DEFAULT_MAX_MCP_IMAGES).toBe(4);
    const content = Array.from({ length: 6 }, (_, i) => png(`${i}`));
    const describe = vi.fn(okDescriber());
    const out = await describeMcpImageBlocks(content, describe);
    expect(describe).toHaveBeenCalledTimes(4);
    expect(out.filter((b) => b.type === 'text')).toHaveLength(4);
    expect(out.filter((b) => b.type === 'image')).toHaveLength(2);
  });

  it('image thiếu data/mimeType → giữ nguyên khối, không tốn lượt describe', async () => {
    const broken: McpContentBlock = { type: 'image', mimeType: 'image/png' };
    const content: McpContentBlock[] = [broken, png('QQ==')];
    const describe = vi.fn(okDescriber());
    const out = await describeMcpImageBlocks(content, describe);
    expect(describe).toHaveBeenCalledTimes(1);
    // Khối hỏng giữ nguyên tham chiếu, không đếm vào trần maxImages.
    expect(out[0]).toBe(broken);
    expect(out[1].type).toBe('text');
  });

  it('khối text/resource lẫn trong giữ nguyên nguyên văn', async () => {
    const resource: McpContentBlock = {
      type: 'resource',
      resource: { uri: 'file:///a.txt', text: 'nội dung resource' },
    };
    const text: McpContentBlock = { type: 'text', text: 'ghi chú' };
    const out = await describeMcpImageBlocks([text, png('QQ=='), resource], okDescriber());
    expect(out[0]).toBe(text);
    expect(out[2]).toBe(resource);
  });

  it('build data URL đúng định dạng cho describer', async () => {
    const log: Array<{ dataUrl: string; mimeType: string }> = [];
    await describeMcpImageBlocks(
      [png('QUJD'), { type: 'image', data: 'WFla', mimeType: 'image/webp' }],
      okDescriber(log),
    );
    expect(log).toEqual([
      { dataUrl: 'data:image/png;base64,QUJD', mimeType: 'image/png' },
      { dataUrl: 'data:image/webp;base64,WFla', mimeType: 'image/webp' },
    ]);
  });

  it('không tạo mảng mới khi content rỗng hoặc null', async () => {
    const empty: McpContentBlock[] = [];
    expect(await describeMcpImageBlocks(empty, okDescriber())).toBe(empty);
    expect(await describeMcpImageBlocks(null as never, okDescriber())).toEqual([]);
  });

  it('mô tả song song — gọi describe cho mọi ảnh trước khi await xong', async () => {
    let inFlight = 0;
    let peak = 0;
    const describe: McpImageDescriber = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return 'xong';
    };
    const content = [png('MQ=='), png('Mg=='), png('Mw==')];
    const out = await describeMcpImageBlocks(content, describe);
    expect(peak).toBe(3);
    expect(out.every((b) => b.type === 'text')).toBe(true);
  });
});
