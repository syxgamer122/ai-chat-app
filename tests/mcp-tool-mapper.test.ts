/**
 * Tests cho MCP tool-mapper — lớp quyết định model nhìn thấy tool MCP như thế nào.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  jsonSchemaToZod,
  mcpContentToText,
  mcpParameters,
  mcpToolKey,
  isMcpToolKey,
  formatMcpResultForModel,
  mapMcpTools,
  MAX_MCP_TOOLS,
  type McpToolInfo,
} from '../lib/mcp/tool-mapper';
import { TOOL_RESULT_MAX_CHARS } from '../lib/tool-limits';

describe('jsonSchemaToZod', () => {
  it('converts string schema', () => {
    const schema = { type: 'string', description: 'A name' };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse('hello')).toBe('hello');
    expect(() => zod.parse(123)).toThrow();
  });

  it('converts string with min/max length', () => {
    const schema = { type: 'string', minLength: 2, maxLength: 10 };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse('hello')).toBe('hello');
    expect(() => zod.parse('a')).toThrow();
    expect(() => zod.parse('a'.repeat(11))).toThrow();
  });

  it('converts string enum', () => {
    const schema = { type: 'string', enum: ['add', 'sub', 'mul'] };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse('add')).toBe('add');
    expect(() => zod.parse('div')).toThrow();
  });

  it('converts enum declared without a type', () => {
    const zod = jsonSchemaToZod({ enum: ['on', 'off'] });
    expect(zod.parse('on')).toBe('on');
    expect(() => zod.parse('maybe')).toThrow();
  });

  it('converts number schema', () => {
    const schema = { type: 'number', minimum: 0, maximum: 100 };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse(50)).toBe(50);
    expect(() => zod.parse(-1)).toThrow();
    expect(() => zod.parse(101)).toThrow();
  });

  it('converts integer schema', () => {
    const zod = jsonSchemaToZod({ type: 'integer' });
    expect(zod.parse(42)).toBe(42);
    expect(() => zod.parse(3.14)).toThrow();
  });

  it('converts boolean schema', () => {
    const zod = jsonSchemaToZod({ type: 'boolean' });
    expect(zod.parse(true)).toBe(true);
    expect(() => zod.parse('true')).toThrow();
  });

  it('converts array schema with item types', () => {
    const zod = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(zod.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => zod.parse([1, 2])).toThrow();
  });

  it('converts object schema with required fields', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ name: 'Alice' })).toEqual({ name: 'Alice', age: undefined });
    expect(() => zod.parse({})).toThrow();
  });

  it('resolves local $ref against $defs', () => {
    const schema = {
      $defs: { Name: { type: 'string', minLength: 3 } },
      type: 'object',
      properties: { first: { $ref: '#/$defs/Name' } },
      required: ['first'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ first: 'Ann' })).toEqual({ first: 'Ann' });
    expect(() => zod.parse({ first: 'ab' })).toThrow();
  });

  it('merges allOf branches into one object', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 });
    expect(() => zod.parse({ b: 1 })).toThrow();
  });

  it('treats anyOf with null as nullable', () => {
    const zod = jsonSchemaToZod({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    expect(zod.parse('x')).toBe('x');
    expect(zod.parse(null)).toBe(null);
  });

  it('honours nullable: true', () => {
    const zod = jsonSchemaToZod({ type: 'number', nullable: true });
    expect(zod.parse(null)).toBe(null);
    expect(zod.parse(7)).toBe(7);
  });

  it('falls back to z.any() for unknown types', () => {
    const zod = jsonSchemaToZod({ type: 'foobar' });
    expect(zod.parse('anything')).toBe('anything');
    expect(zod.parse(123)).toBe(123);
  });

  it('handles empty/invalid schema', () => {
    expect(jsonSchemaToZod({}).parse('x')).toBe('x');
    expect(jsonSchemaToZod(null as never).parse('x')).toBe('x');
  });

  it('does not blow the stack on self-referencing schema', () => {
    const schema: Record<string, unknown> = { type: 'object', properties: {} };
    schema.properties = { child: schema };
    const zod = jsonSchemaToZod(schema);
    // Đệ quy bị chặn theo độ sâu — trả về object thay vì tràn stack.
    expect(() => zod.parse({ child: {} })).not.toThrow();
  });
});

describe('mcpParameters', () => {
  it('always yields a ZodObject for object schemas', () => {
    const params = mcpParameters({ type: 'object', properties: { q: { type: 'string' } } });
    expect(params._def.typeName).toBe('ZodObject');
  });

  it('yields an empty object for property-less schemas', () => {
    const params = mcpParameters({ type: 'object' });
    expect(params._def.typeName).toBe('ZodObject');
    expect(params.parse({})).toEqual({});
  });

  it('wraps a mistyped root schema instead of failing', () => {
    const params = mcpParameters({ type: 'string' });
    expect(params.parse({ value: 'x' })).toEqual({ value: 'x' });
  });
});

describe('mcpToolKey', () => {
  it('uses the mcp__server__tool convention', () => {
    expect(mcpToolKey('files', 'read_file')).toBe('mcp__files__read_file');
  });

  it('is recognised by isMcpToolKey', () => {
    expect(isMcpToolKey(mcpToolKey('files', 'read_file'))).toBe(true);
    expect(isMcpToolKey('fs_read')).toBe(false);
    expect(isMcpToolKey('mcpfoo')).toBe(false);
  });

  it('sanitises characters that gateways reject', () => {
    const key = mcpToolKey('my server', 'read file/v2');
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key).toBe('mcp__my_server__read_file_v2');
  });

  it('never exceeds the 64-char gateway limit', () => {
    const key = mcpToolKey('a'.repeat(50), 'b'.repeat(50));
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic and collision-resistant after truncation', () => {
    const long = mcpToolKey('srv', 'x'.repeat(80));
    const same = mcpToolKey('srv', 'x'.repeat(80));
    const other = mcpToolKey('srv', 'x'.repeat(79) + 'y');
    expect(long).toBe(same);
    expect(long).not.toBe(other);
  });

  it('handles unicode tool names', () => {
    const key = mcpToolKey('srv', 'đọc tệp');
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('mcpContentToText', () => {
  it('extracts text content', () => {
    expect(mcpContentToText([{ type: 'text', text: 'Hello world' }])).toBe('Hello world');
  });

  it('joins multiple text items', () => {
    expect(
      mcpContentToText([
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' },
      ]),
    ).toBe('Line 1\nLine 2');
  });

  it('extracts embedded resource text', () => {
    const text = mcpContentToText([
      { type: 'resource', resource: { uri: 'file:///a.txt', text: 'content' } },
    ]);
    expect(text).toBe('content');
  });

  it('annotates binary and image content instead of dropping it silently', () => {
    expect(mcpContentToText([{ type: 'resource', resource: { uri: 'file:///a', blob: 'AA==' } }]))
      .toContain('file:///a');
    expect(mcpContentToText([{ type: 'image', mimeType: 'image/png', data: 'AA==' }]))
      .toContain('image/png');
  });

  it('returns empty string for empty content', () => {
    expect(mcpContentToText([])).toBe('');
  });
});

describe('formatMcpResultForModel', () => {
  it('returns plain text on success', () => {
    expect(
      formatMcpResultForModel({ content: [{ type: 'text', text: 'ok' }] }, 'mcp__a__b'),
    ).toBe('ok');
  });

  it('surfaces tool-reported errors as JSON error shape', () => {
    const out = formatMcpResultForModel(
      { content: [{ type: 'text', text: 'ENOENT' }], isError: true },
      'mcp__a__b',
    );
    expect(JSON.parse(out)).toEqual({ error: 'ENOENT' });
  });

  it('marks denial so the model stops retrying', () => {
    const out = formatMcpResultForModel(
      { content: [], denied: true },
      'mcp__a__b',
    );
    const parsed = JSON.parse(out);
    expect(parsed.denied).toBe(true);
    expect(parsed.error).toContain('mcp__a__b');
  });

  it('caps oversized results with the shared tool-result ceiling', () => {
    const out = formatMcpResultForModel(
      { content: [{ type: 'text', text: 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2) }] },
      'mcp__a__b',
    );
    expect(out.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 200);
    expect(out).toContain('đã cắt bớt');
  });
});

describe('mapMcpTools', () => {
  const baseTool: McpToolInfo = {
    name: 'read_file',
    description: 'Read a file from disk',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    serverId: 'files',
    serverName: 'Files',
  };

  it('builds declaration-only tools keyed by mcpToolKey', () => {
    const { defs, keys, index } = mapMcpTools([baseTool]);
    expect(keys.has('mcp__files__read_file')).toBe(true);
    expect(defs['mcp__files__read_file'].description).toContain('Files');
    expect(defs['mcp__files__read_file'].description).toContain('Read a file from disk');
    // Không có execute: server không có đường gọi MCP (chạy trong Electron main).
    expect(defs['mcp__files__read_file'].execute).toBeUndefined();
    expect(index.get('mcp__files__read_file')).toEqual({
      serverId: 'files',
      toolName: 'read_file',
    });
  });

  it('parses arguments through the generated schema', () => {
    const { defs } = mapMcpTools([baseTool]);
    // `parameters` được AI SDK gõ lỏng (ToolParameters) — ép về Zod để parse.
    const schema = defs['mcp__files__read_file'].parameters as unknown as z.ZodTypeAny;
    expect(schema.parse({ path: '/tmp/a' })).toEqual({ path: '/tmp/a' });
    expect(() => schema.parse({})).toThrow();
  });

  it('skips duplicates deterministically (first wins)', () => {
    const { keys, index, skipped } = mapMcpTools([baseTool, { ...baseTool, serverName: 'Other' }]);
    expect(keys.size).toBe(1);
    expect(index.get('mcp__files__read_file')).toEqual({
      serverId: 'files',
      toolName: 'read_file',
    });
    expect(skipped).toBe(1);
  });

  it('enforces the tool ceiling', () => {
    const many = Array.from({ length: MAX_MCP_TOOLS + 5 }, (_, i) => ({
      ...baseTool,
      name: `tool_${i}`,
    }));
    const { keys, skipped } = mapMcpTools(many);
    expect(keys.size).toBe(MAX_MCP_TOOLS);
    expect(skipped).toBe(5);
  });

  it('skips malformed entries instead of throwing', () => {
    const { keys, skipped } = mapMcpTools([
      { ...baseTool, name: '' },
      { ...baseTool, serverId: '' },
      baseTool,
    ] as McpToolInfo[]);
    expect(keys.size).toBe(1);
    expect(skipped).toBe(2);
  });

  it('returns an empty set for no tools', () => {
    const { keys, defs, index } = mapMcpTools([]);
    expect(keys.size).toBe(0);
    expect(Object.keys(defs).length).toBe(0);
    expect(index.size).toBe(0);
  });
});
