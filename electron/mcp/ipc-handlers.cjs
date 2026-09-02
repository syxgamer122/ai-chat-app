'use strict';

/**
 * MCP IPC Handlers - Register mcp:* channels cho Electron.
 *
 * Pattern giống ipc.cjs: handler() wrapper, Zod validation, audit log.
 *
 * Hai bất biến quan trọng:
 *  1. MỌI lời hứa chờ con người (approval) PHẢI có timeout — nếu không, một
 *     tool call bị bỏ quên sẽ treo vòng lặp agent mãi mãi.
 *  2. Event gửi sang renderer PHẢI broadcast mọi cửa sổ — cửa sổ không focus
 *     mà vẫn là nơi duy nhất nhận event thì cũng vô nghĩa như không gửi.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { McpManager } = require('./manager.cjs');
const { matchesAutoApprove } = require('./manager.cjs');
const {
  McpAddServerPayload,
  McpRemoveServerPayload,
  McpCallToolPayload,
  McpResolveApprovalPayload,
  McpUpdateConfigPayload,
  McpPolicyFileSchema,
  ServerIdSchema,
} = require('./types.cjs');

/** Chờ người dùng duyệt tối đa bao lâu trước khi tự từ chối (ms). */
const APPROVAL_TIMEOUT_MS = 120_000;

let manager = null;
let auditLog = () => {};
let configPath = null;
let policyPath = null;

/* ------------------------------------------------------------------ */
/* Approval Manager                                                    */
/* ------------------------------------------------------------------ */

/** @type {Map<string, import('./types.cjs').PendingToolApproval>} */
const pendingApprovals = new Map();

/** @type {Map<string, 'always_allow' | 'always_deny'>} */
const approvalPolicies = new Map(); // key: "serverId:toolName"

/**
 * Tạo yêu cầu duyệt và chờ quyết định.
 * Hết APPROVAL_TIMEOUT_MS mà không ai trả lời → tự deny_once để tool call
 * không treo vĩnh viễn.
 * @returns {Promise<import('./types.cjs').PermissionDecision>}
 */
function createApproval(serverId, toolName, args) {
  const id = randomUUID();
  const createdAt = Date.now();

  return new Promise((resolve) => {
    let timer = null;

    const settle = (decision) => {
      if (timer) clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(decision);
    };

    timer = setTimeout(() => {
      auditLog(`MCP approval timeout: ${serverId}/${toolName} → tự từ chối`);
      broadcast('mcp:approval-resolved', { id, decision: 'deny_once', timedOut: true });
      settle('deny_once');
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(id, { id, serverId, toolName, args, createdAt, settle });

    broadcast('mcp:approval-requested', {
      id,
      serverId,
      toolName,
      arguments: args,
      createdAt,
      expiresAt: createdAt + APPROVAL_TIMEOUT_MS,
    });
  });
}

function resolveApproval(approvalId, decision) {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) return false;

  // Luôn persist trước khi settle: chính sách "luôn cho phép" phải có hiệu
  // lực ngay cả khi renderer resolve trễ vài mili-giây.
  if (decision === 'always_allow' || decision === 'always_deny') {
    approvalPolicies.set(`${pending.serverId}:${pending.toolName}`, decision);
    persistPolicies();
  }

  broadcast('mcp:approval-resolved', { id: approvalId, decision });
  pending.settle(decision);
  return true;
}

/** @returns {'always_allow' | 'always_deny' | null} */
function checkPolicy(serverId, toolName) {
  return approvalPolicies.get(`${serverId}:${toolName}`) ?? null;
}

/** Gửi event tới MỌI cửa sổ còn sống (không chỉ cửa sổ đang focus). */
function broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  } catch {
    // Không trong Electron (test) — bỏ qua.
  }
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

/** Migration từ thời KODA: file mới chưa có thì chép từ file tên cũ sang. */
function migrateLegacyFile(newPath) {
  const legacy = newPath.replace(/vyen-/, 'koda-');
  if (!fs.existsSync(newPath) && fs.existsSync(legacy)) {
    try {
      fs.copyFileSync(legacy, newPath);
    } catch {}
  }
}

function loadConfigs(userDataDir) {
  configPath = path.join(userDataDir, 'vyen-mcp-configs.json');
  policyPath = path.join(userDataDir, 'vyen-mcp-policies.json');
  migrateLegacyFile(configPath);
  migrateLegacyFile(policyPath);
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function persistConfigs() {
  if (!configPath || !manager) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify(manager.getConfigs(), null, 2));
  } catch (e) {
    auditLog(`MCP persist configs failed: ${String(e?.message ?? e)}`);
  }
}

function loadPolicies() {
  if (!policyPath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    // Validate: file có thể bị sửa tay hoặc ghi bởi bản cũ — giá trị lạ sẽ
    // biến thành quyết định lạ trong luồng duyệt.
    const parsed = McpPolicyFileSchema.safeParse(raw);
    if (!parsed.success) {
      auditLog('MCP policies file không hợp lệ — bỏ qua.');
      return;
    }
    for (const [key, value] of Object.entries(parsed.data)) {
      approvalPolicies.set(key, value);
    }
  } catch {
    // File chưa có — policies rỗng.
  }
}

function persistPolicies() {
  if (!policyPath) return;
  try {
    fs.writeFileSync(policyPath, JSON.stringify(Object.fromEntries(approvalPolicies), null, 2));
  } catch (e) {
    auditLog(`MCP persist policies failed: ${String(e?.message ?? e)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Handler Wrapper                                                     */
/* ------------------------------------------------------------------ */

function handler(fn) {
  return async (_event, payload) => {
    try {
      if (!manager) throw new Error('MCP chưa khởi tạo.');
      return await fn(payload ?? {});
    } catch (e) {
      const msg = String(e?.message ?? e);
      auditLog(`MCP IPC error: ${msg.slice(0, 200)}`);
      throw new Error(msg);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Register                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ userDataDir: string, audit: (line: string) => void }} opts
 */
async function register(ipcMain, opts) {
  auditLog = opts.audit ?? (() => {});

  const savedConfigs = loadConfigs(opts.userDataDir);
  loadPolicies();

  manager = new McpManager();
  manager.on('server-status', (status) => broadcast('mcp:server-status', status));

  const on = (channel, fn) => ipcMain.handle(channel, handler(fn));

  /* ---- Server Management ---- */

  on('mcp:list-servers', () => manager.getStatuses());

  on('mcp:add-server', async (payload) => {
    const config = McpAddServerPayload.parse(payload);
    await manager.addServer(config);
    persistConfigs();
    auditLog(`MCP add server: ${config.name} (${config.transport})`);
    return manager.getServer(config.id);
  });

  on('mcp:remove-server', async (payload) => {
    const { id } = McpRemoveServerPayload.parse(payload);
    await manager.removeServer(id);
    persistConfigs();
    auditLog(`MCP remove server: ${id}`);
    return { ok: true };
  });

  on('mcp:reconnect', async (payload) => {
    const id = ServerIdSchema.parse(payload?.id);
    const entry = await manager.reconnect(id);
    auditLog(`MCP reconnect: ${id} → ${entry.status}`);
    return {
      id,
      status: entry.status,
      error: entry.error ?? undefined,
      toolCount: entry.tools.length,
    };
  });

  on('mcp:update-config', async (payload) => {
    const { servers } = McpUpdateConfigPayload.parse(payload);
    // Thay toàn bộ: gỡ hết server cũ rồi nạp lại từ cấu hình mới. Cố tình
    // KHÔNG dọn dẹp từng phần — diff từng server dễ để lại entry mồ côi khi
    // id thay đổi, và số lượng server thực tế luôn nhỏ (trần 50).
    for (const cfg of manager.getConfigs()) {
      await manager.removeServer(cfg.id);
    }
    for (const cfg of servers) {
      await manager.addServer(cfg);
    }
    persistConfigs();
    auditLog(`MCP update config: ${servers.length} servers`);
    return { ok: true };
  });

  /* ---- Tools ---- */

  on('mcp:list-tools', () => manager.listTools());

  on('mcp:call-tool', async (payload) => {
    const { serverId, toolName, arguments: args } = McpCallToolPayload.parse(payload);

    const policy = checkPolicy(serverId, toolName);
    if (policy === 'always_deny') {
      return {
        isError: true,
        denied: true,
        content: [{ type: 'text', text: `Tool "${toolName}" bị chặn bởi chính sách đã lưu.` }],
      };
    }

    const server = manager.getServer(serverId);
    if (!server) throw new Error(`Server "${serverId}" không tồn tại.`);

    if (policy !== 'always_allow' && !manager.isAutoApproved(serverId, toolName)) {
      const decision = await createApproval(serverId, toolName, args);
      if (decision === 'deny_once' || decision === 'always_deny') {
        return {
          isError: true,
          denied: true,
          content: [{ type: 'text', text: `Người dùng từ chối gọi tool "${toolName}".` }],
        };
      }
    }

    auditLog(`MCP call tool: ${serverId}/${toolName}`);
    const result = await manager.callTool(serverId, toolName, args);
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      isError: result?.isError === true,
    };
  });

  /* ---- Approval ---- */

  on('mcp:resolve-approval', (payload) => {
    const { approvalId, decision } = McpResolveApprovalPayload.parse(payload);
    if (!resolveApproval(approvalId, decision)) {
      throw new Error(`Yêu cầu duyệt "${approvalId}" không tồn tại hoặc đã hết hạn.`);
    }
    auditLog(`MCP approval resolved: ${approvalId} → ${decision}`);
    return { ok: true };
  });

  on('mcp:get-pending-approvals', () =>
    Array.from(pendingApprovals.values()).map((a) => ({
      id: a.id,
      serverId: a.serverId,
      toolName: a.toolName,
      arguments: a.args,
      createdAt: a.createdAt,
    })),
  );

  /* ---- Status ---- */

  on('mcp:get-status', () => ({
    servers: manager.getStatuses(),
    tools: manager.listTools().length,
  }));

  /* Đăng ký channel XONG mới nối server: renderer có thể gọi list-servers
     ngay khi cửa sổ vừa lên, trong lúc connect (đặc biệt là stdio spawn)
     vẫn đang chạy — nếu đợi connect xong mới đăng ký thì mọi lệnh gọi sớm
     đều văng "No handler registered". */
  await manager.init(savedConfigs);

  auditLog(`MCP initialized: ${savedConfigs.length} saved servers`);
}

/**
 * Shutdown MCP manager (gọi khi app quit).
 */
async function shutdown() {
  if (manager) {
    // Hủy mọi lời hứa đang chờ duyệt — nếu không, promise treo giữ nguyên
    // stack của tool call tới lúc process thoát.
    for (const pending of pendingApprovals.values()) pending.settle('deny_once');
    pendingApprovals.clear();

    await manager.shutdown();
    manager = null;
  }
}

module.exports = { register, shutdown, APPROVAL_TIMEOUT_MS };
