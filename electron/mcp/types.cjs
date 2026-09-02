'use strict';

/**
 * MCP Types & Zod Schemas cho Vyen.
 *
 * Shared giữa electron/mcp/ modules. Zod v3 compatible.
 *
 * Quy ước quan trọng: `id` là một phần của tên tool mà model nhìn thấy
 * (`mcp__<id>__<tool>`), nên bị khoá vào tập ký tự an toàn cho function
 * name của gateway ([A-Za-z0-9_-]). Không khoá ở đây thì tên tool sinh ra
 * có thể chứa ký tự khiến gateway từ chối toàn bộ request `tools`.
 */

const { z } = require('zod');

/* ------------------------------------------------------------------ */
/* Server Config Schema                                                */
/* ------------------------------------------------------------------ */

/** Id server: an toàn khi nhúng vào tên tool + tên file cấu hình. */
const ServerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Id server chỉ được chứa chữ, số, gạch ngang và gạch dưới.');

/**
 * Trần timeout cho MỘT lần gọi tool (giây). MCP không định nghĩa timeout
 * mặc định; SDK dùng 60s. Để người dùng nới lên 10 phút cho tool chậm
 * (chạy test suite, crawl...) nhưng vẫn có trần để không treo vòng lặp
 * agent mãi mãi.
 */
const TimeoutSecsSchema = z.number().int().min(1).max(600).optional();

const commonFields = {
  id: ServerIdSchema,
  name: z.string().min(1).max(200),
  /**
   * Danh sách tool được tự động duyệt. '*' = tất cả; 'prefix*' = theo tiền tố;
   * còn lại so khớp chính xác. Rỗng → mọi tool đều phải xin phép.
   */
  autoApprove: z.array(z.string().max(200)).default([]),
  /** Timeout mỗi lần gọi tool, giây. Mặc định 60 (khớp DEFAULT_REQUEST_TIMEOUT_MSEC của SDK). */
  timeoutSecs: TimeoutSecsSchema,
};

const McpStdioConfigSchema = z.object({
  ...commonFields,
  transport: z.literal('stdio'),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(50).default([]),
  /**
   * Biến môi trường BỔ SUNG cho process con. Không bao giờ tự động kế thừa
   * toàn bộ process.env của Electron (sẽ lộ secret máy user cho MCP server);
   * manager chỉ gộp lên trên tập an toàn của SDK.
   */
  env: z.record(z.string(), z.string()).optional(),
  /** Thư mục làm việc của process con. Bỏ trống → kế thừa cwd của app. */
  cwd: z.string().min(1).max(1000).optional(),
});

/**
 * HTTP+SSE (transport cũ của MCP). Đã bị Streamable HTTP thay thế từ
 * spec 2025-06-18 nhưng vẫn còn rất nhiều server công cộng chạy nó, nên
 * Vyen hỗ trợ để không rơi vào tình trạng "server này không kết nối được".
 */
const McpSseConfigSchema = z.object({
  ...commonFields,
  transport: z.literal('sse'),
  url: z.string().url().max(1000),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpStreamableHttpConfigSchema = z.object({
  ...commonFields,
  transport: z.literal('streamable-http'),
  url: z.string().url().max(1000),
  headers: z.record(z.string(), z.string()).optional(),
});

const McpServerConfigSchema = z.discriminatedUnion('transport', [
  McpStdioConfigSchema,
  McpSseConfigSchema,
  McpStreamableHttpConfigSchema,
]);

/* ------------------------------------------------------------------ */
/* IPC Payload Schemas                                                 */
/* ------------------------------------------------------------------ */

const McpAddServerPayload = McpServerConfigSchema;

const McpRemoveServerPayload = z.object({
  id: ServerIdSchema,
});

const McpCallToolPayload = z.object({
  serverId: ServerIdSchema,
  toolName: z.string().min(1).max(200),
  arguments: z.record(z.unknown()).default({}),
});

const PermissionDecisionSchema = z.enum([
  'allow_once',
  'always_allow',
  'deny_once',
  'always_deny',
]);

const McpResolveApprovalPayload = z.object({
  approvalId: z.string().uuid(),
  decision: PermissionDecisionSchema,
});

const McpUpdateConfigPayload = z.object({
  servers: z.array(McpServerConfigSchema).max(50),
});

/**
 * File policy lưu dưới dạng {"<serverId>:<toolName>": "<decision>"}.
 * Chỉ 2 giá trị "nhớ lâu" được persist; 2 giá trị once-only không bao giờ
 * ghi xuống đĩa. Validate khi đọc để file bị sửa tay không làm hỏng luồng.
 */
const McpPolicyFileSchema = z.record(
  z.string().max(300),
  z.enum(['always_allow', 'always_deny']),
);

/* ------------------------------------------------------------------ */
/* Runtime Types                                                       */
/* ------------------------------------------------------------------ */

/**
 * @typedef {z.infer<typeof McpServerConfigSchema>} McpServerConfig
 * @typedef {z.infer<typeof McpCallToolPayload>} McpCallToolPayload
 * @typedef {z.infer<typeof PermissionDecisionSchema>} PermissionDecision
 */

/**
 * @typedef {Object} PendingToolApproval
 * @property {string} id - UUID
 * @property {string} serverId
 * @property {string} toolName
 * @property {Record<string, unknown>} args
 * @property {number} createdAt - epoch ms, để UI đếm ngược thời gian chờ
 * @property {(decision: PermissionDecision) => void} settle - resolve + dọn timeout
 */

/**
 * @typedef {Object} McpToolInfo
 * @property {string} name
 * @property {string} description
 * @property {Record<string, unknown>} inputSchema - JSON Schema
 * @property {string} serverId
 * @property {string} serverName
 */

/**
 * @typedef {Object} ServerStatus
 * @property {string} id
 * @property {string} name
 * @property {'connected' | 'connecting' | 'disconnected' | 'error'} status
 * @property {string} [error]
 * @property {number} toolCount
 * @property {string} [serverVersion] - Implementation do server trả qua initialize
 */

module.exports = {
  ServerIdSchema,
  McpServerConfigSchema,
  McpStdioConfigSchema,
  McpSseConfigSchema,
  McpStreamableHttpConfigSchema,
  McpAddServerPayload,
  McpRemoveServerPayload,
  McpCallToolPayload,
  McpResolveApprovalPayload,
  McpUpdateConfigPayload,
  PermissionDecisionSchema,
  McpPolicyFileSchema,
};
