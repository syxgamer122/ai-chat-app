import { describe, it, expect } from 'vitest';
import {
  tokenizeToolText,
  summarizeSchemaProperties,
  buildToolIndex,
  rankToolsWithBM25,
  searchTools,
  selectActiveTools,
  DEFAULT_CORE_TOOLS,
  ROUTER_DEFAULT_TOP_K,
  type ToolIndexEntry,
} from '@/lib/mcp/tool-router';
import type { McpToolInfo } from '@/lib/mcp/tool-mapper';

describe('Tool Router — Tokenizer & Schemas', () => {
  it('tách từ chính xác với camelCase, snake_case và tiếng Việt có dấu', () => {
    const tokens = tokenizeToolText('mcp__postgres__queryData cho cơ sở dữ liệu PostgreSQL');
    expect(tokens).toContain('mcp');
    expect(tokens).toContain('postgres');
    expect(tokens).toContain('query');
    expect(tokens).toContain('data');
    expect(tokens).toContain('lieu'); // du lieu folded
  });

  it('tóm tắt tham số JSON schema đúng format', () => {
    const schema = {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        issueNumber: { type: 'number' },
        title: { type: 'string' },
      },
      required: ['repo', 'title'],
    };

    const summary = summarizeSchemaProperties(schema);
    expect(summary).toContain('repo: string');
    expect(summary).toContain('title: string');
    expect(summary).toContain('issueNumber?: number');
  });
});

describe('Tool Router — Indexing & BM25 Ranking', () => {
  const nativeDefs = {
    fs_read: { description: 'Đọc nội dung file trong workspace' },
    fs_write: { description: 'Ghi file mới trong workspace' },
    shell_run: { description: 'Chạy lệnh terminal shell trong sandbox' },
    git_status: { description: 'Xem trạng thái thay đổi git' },
  };

  const mcpTools: McpToolInfo[] = [
    {
      name: 'create_issue',
      serverId: 'github',
      serverName: 'GitHub Server',
      description: 'Tạo một issue mới trên GitHub repository',
      inputSchema: {
        type: 'object',
        properties: { repo: { type: 'string' }, title: { type: 'string' } },
        required: ['repo', 'title'],
      },
    },
    {
      name: 'execute_sql',
      serverId: 'postgres',
      serverName: 'PostgreSQL Server',
      description: 'Thực thi câu truy vấn SQL đọc hoặc ghi trong cơ sở dữ liệu PostgreSQL',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
    {
      name: 'list_containers',
      serverId: 'docker',
      serverName: 'Docker Server',
      description: 'Liệt kê các docker container đang chạy hoặc đã dừng',
      inputSchema: {},
    },
  ];

  it('lập chỉ mục đầy đủ native và MCP tools', () => {
    const index = buildToolIndex(nativeDefs, mcpTools);
    expect(index.length).toBe(7);
    expect(index.find((t) => t.name === 'mcp__github__create_issue')).toBeDefined();
    expect(index.find((t) => t.name === 'mcp__postgres__execute_sql')).toBeDefined();
    expect(index.find((t) => t.name === 'fs_read')?.isCore).toBe(true);
  });

  it('xếp hạng BM25 chính xác cho truy vấn tiếng Anh', () => {
    const index = buildToolIndex(nativeDefs, mcpTools);
    const ranked = rankToolsWithBM25(index, 'query postgres sql database');
    expect(ranked[0].entry.name).toBe('mcp__postgres__execute_sql');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('xếp hạng BM25 chính xác cho truy vấn tiếng Việt có dấu', () => {
    const index = buildToolIndex(nativeDefs, mcpTools);
    const ranked = rankToolsWithBM25(index, 'tạo issue trên github cho dự án');
    expect(ranked[0].entry.name).toBe('mcp__github__create_issue');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('searchTools trả về kết quả định dạng chuẩn cho meta-tool', () => {
    const index = buildToolIndex(nativeDefs, mcpTools);
    const results = searchTools(index, 'docker container', 5, ['mcp__docker__list_containers']);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toBe('mcp__docker__list_containers');
    expect(results[0].isLoaded).toBe(true);
  });
});

describe('Tool Router — Dynamic Selection & Scaling (~200 tools)', () => {
  it('không bật router nếu tổng số tool <= threshold', () => {
    const smallIndex: ToolIndexEntry[] = [
      { name: 'fs_read', description: 'Đọc file' },
      { name: 'shell_run', description: 'Chạy lệnh' },
    ];
    const selection = selectActiveTools(smallIndex, 'đọc file');
    expect(selection.isRouted).toBe(false);
    expect(selection.hasMetaTools).toBe(false);
    expect(selection.activeToolNames).toEqual(['fs_read', 'shell_run']);
  });

  it('khi vượt trần (200 tools từ 8 MCP server), router giới hạn đúng topK và giữ đúng tool liên quan', () => {
    // Giả lập 200 MCP tools trên 8 servers
    const servers = ['github', 'gitlab', 'postgres', 'docker', 'jira', 'slack', 's3', 'k8s'];
    const manyMcpTools: McpToolInfo[] = [];

    for (const server of servers) {
      for (let i = 1; i <= 25; i++) {
        manyMcpTools.push({
          serverId: server,
          serverName: `${server} Server`,
          name: `action_${i}`,
          description: `Action number ${i} on ${server} cloud service for devops and management`,
          inputSchema: {},
        });
      }
    }

    // Thêm 1 tool đặc biệt
    manyMcpTools.push({
      serverId: 'postgres',
      serverName: 'PostgreSQL Server',
      name: 'vacuum_analyze_tables',
      description: 'Optimize database performance by running VACUUM ANALYZE on PostgreSQL tables',
      inputSchema: {},
    });

    const nativeDefs = {
      fs_read: { description: 'Đọc file' },
      fs_write: { description: 'Ghi file' },
      fs_edit: { description: 'Sửa file' },
      shell_run: { description: 'Chạy lệnh shell' },
      git_status: { description: 'Git status' },
      plan_create: { description: 'Lập kế hoạch' },
    };

    const index = buildToolIndex(nativeDefs, manyMcpTools);
    expect(index.length).toBeGreaterThan(200);

    // Lựa chọn active tools cho tác vụ tối ưu database
    const selection = selectActiveTools(index, 'hãy tối ưu vacuum postgres database', {
      topK: ROUTER_DEFAULT_TOP_K,
      loadedNames: ['mcp__slack__action_1'],
    });

    expect(selection.isRouted).toBe(true);
    expect(selection.hasMetaTools).toBe(true);
    expect(selection.activeToolNames).toContain('tools_search');
    expect(selection.activeToolNames).toContain('tools_load');

    // Tool được user nạp trước phải luôn có mặt
    expect(selection.activeToolNames).toContain('mcp__slack__action_1');

    // Tool vacuum postgres phải được BM25 đẩy vào top selection
    expect(selection.activeToolNames).toContain('mcp__postgres__vacuum_analyze_tables');

    // Tổng số tool trong activeToolNames phải không vượt quá topK + metaTools
    expect(selection.activeToolNames.length).toBeLessThanOrEqual(ROUTER_DEFAULT_TOP_K + 2);
  });
});
