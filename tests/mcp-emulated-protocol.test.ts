/**
 * Đường emulated không có kênh tool-call native: toàn bộ schema phải nằm
 * trong text. Tool MCP là tool ĐỘNG (do renderer gửi lên, không có trong
 * registry tĩnh) nên đây là chỗ dễ hỏng nhất — nếu quên truyền
 * `extraToolDocs`, model vẫn thấy tên tool trong danh sách nhưng không biết
 * tham số, rồi gọi sai.
 */
import { describe, it, expect } from 'vitest';
import { buildProtocolHeader } from '../lib/emulated-agent';
import { formatToolProtocolManual } from '../lib/agent-tools';
import { mapMcpTools, mcpToolKey, type McpToolInfo } from '../lib/mcp/tool-mapper';

const mcpTool: McpToolInfo = {
  name: 'read_file',
  description: 'Read a file from disk',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    required: ['path'],
  },
  serverId: 'files',
  serverName: 'Files',
};

describe('formatToolProtocolManual with dynamic tools', () => {
  it('renders MCP tools that are absent from the static registry', () => {
    const { defs, keys } = mapMcpTools([mcpTool]);
    const manual = formatToolProtocolManual(keys, defs);
    const key = mcpToolKey('files', 'read_file');

    expect(manual).toContain(key);
    expect(manual).toContain('Read a file from disk');
    // Chữ ký args phải có để model biết truyền gì.
    expect(manual).toContain('"path": string');
    expect(manual).toContain('"limit"?: number');
  });

  it('still renders built-in tools alongside MCP tools', () => {
    const { defs, keys } = mapMcpTools([mcpTool]);
    const manual = formatToolProtocolManual(['web_search', ...keys], defs);
    expect(manual).toContain('web_search');
    expect(manual).toContain(mcpToolKey('files', 'read_file'));
  });

  it('ignores unknown names instead of emitting empty entries', () => {
    const manual = formatToolProtocolManual(['no_such_tool']);
    expect(manual).toBe('');
  });
});

describe('buildProtocolHeader', () => {
  it('embeds MCP tool docs into the emulated protocol text', () => {
    const { defs, keys } = mapMcpTools([mcpTool]);
    const header = buildProtocolHeader(keys, defs);

    expect(header).toContain('Các công cụ khả dụng');
    expect(header).toContain(mcpToolKey('files', 'read_file'));
    expect(header).toContain('"path": string');
  });

  it('works without dynamic tools (backward compatible)', () => {
    const header = buildProtocolHeader(['web_search']);
    expect(header).toContain('web_search');
    expect(header).not.toContain('mcp__');
  });
});
