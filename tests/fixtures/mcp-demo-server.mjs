/**
 * MCP server mẫu để test TÍCH HỢP THẬT (không mock).
 *
 * Dựng bằng chính SDK mà Koda dùng làm client, nên nếu hai bên nói khác
 * giao thức thì test vỡ ngay ở khởi tạo. File là .mjs vì MCP SDK chỉ có ESM.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'demo-server', version: '2.3.4' },
  { capabilities: { tools: {} } },
);

/**
 * Tool thứ tư chỉ xuất hiện SAU khi client gọi `enable_extra` — dùng để kiểm
 * chứng Koda cósubscribe `tools/list_changed` hay không (nếu không, danh sách
 * tool của Koda sẽ giữ nguyên cũ cho tới khi người dùng bấm làm mới).
 */
let extraEnabled = false;

const EXTRA_TOOL = {
  name: 'extra_tool',
  description: 'Tool chỉ xuất hiện sau list_changed',
  inputSchema: { type: 'object', properties: {} },
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'add',
      description: 'Cộng hai số',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
    {
      name: 'always_fails',
      description: 'Tool luôn báo lỗi nghiệp vụ',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'enable_extra',
      description: 'Thêm một tool rồi bắn thông báo list_changed',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(extraEnabled ? [EXTRA_TOOL] : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'add') {
    return { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] };
  }
  if (name === 'always_fails') {
    // isError = true: tool CHẠY XONG rồi báo thất bại — khác lỗi giao thức.
    return { content: [{ type: 'text', text: 'không tìm thấy file' }], isError: true };
  }
  if (name === 'enable_extra') {
    extraEnabled = true;
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: 'đã bật extra_tool' }] };
  }
  throw new Error(`Tool không tồn tại: ${name}`);
});

await server.connect(new StdioServerTransport());
