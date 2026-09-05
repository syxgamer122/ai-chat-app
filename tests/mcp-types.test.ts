/**
 * Tests cho MCP types & Zod schemas.
 */
import { describe, it, expect } from 'vitest';
import {
  McpServerConfigSchema,
  McpCallToolPayload,
  McpResolveApprovalPayload,
} from '../lib/mcp/types.cjs';

describe('McpServerConfigSchema', () => {
  it('validates stdio config', () => {
    const config = {
      id: 'fs-server',
      name: 'Filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      autoApprove: ['read_file', 'list_directory'],
    };
    const result = McpServerConfigSchema.parse(config);
    expect(result.transport).toBe('stdio');
    expect(result.id).toBe('fs-server');
  });

  it('validates streamable-http config', () => {
    const config = {
      id: 'remote-server',
      name: 'Remote MCP',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    };
    const result = McpServerConfigSchema.parse(config);
    expect(result.transport).toBe('streamable-http');
  });

  it('rejects invalid transport', () => {
    expect(() => McpServerConfigSchema.parse({
      id: 'x',
      name: 'X',
      transport: 'websocket',
    })).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => McpServerConfigSchema.parse({
      id: 'x',
      transport: 'stdio',
    })).toThrow();
  });
});

describe('McpCallToolPayload', () => {
  it('validates tool call payload', () => {
    const payload = {
      serverId: 'fs-server',
      toolName: 'read_file',
      arguments: { path: '/tmp/test.txt' },
    };
    const result = McpCallToolPayload.parse(payload);
    expect(result.toolName).toBe('read_file');
  });

  it('defaults arguments to empty object', () => {
    const result = McpCallToolPayload.parse({
      serverId: 'x',
      toolName: 'ping',
    });
    expect(result.arguments).toEqual({});
  });
});

describe('McpResolveApprovalPayload', () => {
  it('validates approval resolution', () => {
    const payload = {
      approvalId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'allow_once',
    };
    const result = McpResolveApprovalPayload.parse(payload);
    expect(result.decision).toBe('allow_once');
  });

  it('rejects invalid decision', () => {
    expect(() => McpResolveApprovalPayload.parse({
      approvalId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'maybe',
    })).toThrow();
  });

  it('rejects invalid UUID', () => {
    expect(() => McpResolveApprovalPayload.parse({
      approvalId: 'not-a-uuid',
      decision: 'allow_once',
    })).toThrow();
  });
});
