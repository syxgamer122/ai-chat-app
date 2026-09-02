'use strict';

/**
 * MCP Client Manager - Quản lý pool MCP clients.
 *
 * Responsibilities:
 * - Connect/disconnect MCP servers (stdio + sse + streamable-http)
 * - List tools từ tất cả connected servers (theo đuôi nextCursor của spec)
 * - Call tool trên specific server (có timeout + chuẩn hoá isError)
 * - Auto-reconnect với exponential backoff (có trần số lần)
 * - Graceful shutdown
 *
 * ESM-only MCP SDK được load qua dynamic import().
 */

const { EventEmitter } = require('node:events');

// Dynamic imports - cached sau lần đầu
let sdkClient = null;
let sdkStdio = null;
let sdkStdioEnv = null;
let sdkSse = null;
let sdkStreamableHttp = null;
let sdkToolListChangedSchema = null;
let importError = null;

/**
 * Load MCP SDK modules (ESM-only, cần dynamic import).
 * Cache kết quả để tránh import lại nhiều lần.
 */
async function loadSdk() {
  if (sdkClient) return true;
  if (importError) throw importError;

  try {
    const clientMod = await import('@modelcontextprotocol/sdk/client/index.js');
    const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const typesMod = await import('@modelcontextprotocol/sdk/types.js');

    sdkClient = clientMod.Client;
    sdkStdio = stdioMod.StdioClientTransport;
    // Dùng để subscribe tools/list_changed (spec MCP): server có quyền thêm/bớt
    // tool trong lúc đang kết nối.
    sdkToolListChangedSchema = typesMod.ToolListChangedNotificationSchema;
    // Tập env tối thiểu an toàn của SDK — dùng làm GỐC thay vì process.env
    // đầy đủ (kế thừa toàn bộ sẽ lộ secret máy user cho MCP server).
    sdkStdioEnv = stdioMod.getDefaultEnvironment;

    // SSE: transport cũ của spec, vẫn còn nhiều server dùng. Optional.
    try {
      const sseMod = await import('@modelcontextprotocol/sdk/client/sse.js');
      sdkSse = sseMod.SSEClientTransport;
    } catch {
      console.warn('[mcp] SSE transport không khả dụng');
    }

    try {
      const httpMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      sdkStreamableHttp = httpMod.StreamableHTTPClientTransport;
    } catch {
      console.warn('[mcp] StreamableHTTP transport không khả dụng');
    }

    return true;
  } catch (err) {
    importError = err;
    console.error('[mcp] Failed to load MCP SDK:', err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Hằng số                                                             */
/* ------------------------------------------------------------------ */

/** Timeout mặc định cho MỘT lần gọi tool (ms) — khớp DEFAULT_REQUEST_TIMEOUT_MSEC của SDK. */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
/** Trần số lần reconnect liên tiếp trước khi bỏ cuộc (tránh rò rỉ timer vô hạn). */
const MAX_RECONNECT_ATTEMPTS = 5;
/** Trần số tool nhận từ MỘT server — chống server quăng list vô hạn. */
const MAX_TOOLS_PER_SERVER = 200;

/**
 * So khớp tên tool với danh sách pattern autoApprove của server.
 * Ba dạng: '*' (mọi tool), 'prefix*' (theo tiền tố), 'tool' (chính xác).
 * Thuần hàm — test được không cần dựng manager.
 */
function matchesAutoApprove(patterns, toolName) {
  for (const pattern of patterns ?? []) {
    if (pattern === '*') return true;
    if (pattern.endsWith('*') && toolName.startsWith(pattern.slice(0, -1))) return true;
    if (pattern === toolName) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Server Entry                                                        */
/* ------------------------------------------------------------------ */

class ServerEntry {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.transport = null;
    this.status = 'disconnected'; // connected | connecting | disconnected | error
    this.error = null;
    this.tools = [];
    this.serverVersion = null;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    /** Timer debounce cho việc nạp lại tool sau thông báo list_changed. */
    this.toolRefreshTimer = null;
    this.intentionalClose = false;
  }

  /** Timeout gọi tool của server này, ms. */
  get callTimeoutMs() {
    const secs = this.config.timeoutSecs;
    return typeof secs === 'number' ? secs * 1000 : DEFAULT_CALL_TIMEOUT_MS;
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

class McpManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, ServerEntry>} */
    this.servers = new Map();
    this.shuttingDown = false;
  }

  /**
   * Initialize manager - load SDK, restore saved configs.
   * @param {Array<import('./types.cjs').McpServerConfig>} [savedConfigs]
   */
  async init(savedConfigs = []) {
    await loadSdk();

    for (const config of savedConfigs) {
      // Server lỗi khi khởi động không được phép làm gãy cả quá trình boot:
      // giữ entry ở trạng thái 'error' để UI hiện nút thử lại.
      await this.addServer(config);
    }
  }

  /**
   * Add và connect MCP server.
   * @param {import('./types.cjs').McpServerConfig} config
   */
  async addServer(config) {
    if (this.servers.has(config.id)) {
      throw new Error(`Server "${config.id}" đã tồn tại.`);
    }

    const entry = new ServerEntry(config);
    this.servers.set(config.id, entry);

    await this._connect(entry);
    this._emitStatus(entry);
    return entry;
  }

  /**
   * Remove và disconnect server.
   * @param {string} id
   */
  async removeServer(id) {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Server "${id}" không tồn tại.`);

    this._clearReconnect(entry);
    entry.intentionalClose = true;

    await this._disconnect(entry);
    this.servers.delete(id);
  }

  /** Thử kết nối lại bằng tay (nút UI). Trả về entry đã cập nhật. */
  async reconnect(id) {
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Server "${id}" không tồn tại.`);

    this._clearReconnect(entry);
    entry.intentionalClose = false;
    entry.reconnectAttempts = 0;

    await this._disconnect(entry);
    await this._connect(entry);
    this._emitStatus(entry);
    return entry;
  }

  /**
   * List all tools từ connected servers.
   * @returns {Array<import('./types.cjs').McpToolInfo>}
   */
  listTools() {
    const tools = [];
    for (const [id, entry] of this.servers) {
      if (entry.status !== 'connected') continue;
      for (const tool of entry.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
          serverId: id,
          serverName: entry.config.name,
        });
      }
    }
    return tools;
  }

  /**
   * Call tool trên specific server.
   *
   * Trả về ĐÚNG shape của MCP CallToolResult (rút gọn): `{ content, isError }`.
   * Lỗi giao thức (server chết, timeout, tool không tồn tại) NÉM — phân biệt
   * với lỗi NGHIỆP VỤ của tool (isError: true) mà model cần đọc để tự sửa.
   * @param {string} serverId
   * @param {string} toolName
   * @param {Record<string, unknown>} args
   * @returns {Promise<{content: Array<{type: string, text?: string}>, isError: boolean}>}
   */
  async callTool(serverId, toolName, args) {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error(`Server "${serverId}" không tồn tại.`);
    if (entry.status !== 'connected' || !entry.client) {
      throw new Error(`Server "${serverId}" chưa kết nối (status: ${entry.status}).`);
    }

    try {
      const result = await entry.client.callTool(
        { name: toolName, arguments: args ?? {} },
        undefined,
        { timeout: entry.callTimeoutMs },
      );
      return {
        content: Array.isArray(result?.content) ? result.content : [],
        isError: result?.isError === true,
      };
    } catch (err) {
      // Transport chết giữa chừng: hạ trạng thái để UI/agent không tin vào
      // một kết nối đã mất, rồi ném lỗi rõ ràng cho caller.
      const message = String(err?.message ?? err);
      if (/closed|not connected|connection/i.test(message)) {
        entry.status = 'disconnected';
        entry.error = message;
        this._emitStatus(entry);
        if (!entry.intentionalClose && !this.shuttingDown) this._scheduleReconnect(entry);
      }
      throw new Error(`Gọi tool "${toolName}" trên "${serverId}" thất bại: ${message}`);
    }
  }

  /**
   * Get status của tất cả servers.
   * @returns {Array<import('./types.cjs').ServerStatus>}
   */
  getStatuses() {
    const statuses = [];
    for (const [id, entry] of this.servers) {
      statuses.push({
        id,
        name: entry.config.name,
        status: entry.status,
        error: entry.error,
        toolCount: entry.tools.length,
        serverVersion: entry.serverVersion ?? undefined,
      });
    }
    return statuses;
  }

  /** Trạng thái + cấu hình của MỘT server (UI cần cả hai). */
  getServer(id) {
    const entry = this.servers.get(id);
    if (!entry) return null;
    return {
      id,
      name: entry.config.name,
      transport: entry.config.transport,
      status: entry.status,
      error: entry.error,
      toolCount: entry.tools.length,
      serverVersion: entry.serverVersion ?? undefined,
    };
  }

  /**
   * Tool này có nằm trong danh sách tự duyệt của server không?
   * Pattern: '*' = tất cả, 'prefix*' = theo tiền tố, còn lại = chính xác.
   * Đặt ở manager để caller không cần mò vào Map nội bộ.
   */
  isAutoApproved(serverId, toolName) {
    return matchesAutoApprove(this.servers.get(serverId)?.config?.autoApprove, toolName);
  }

  /**
   * Get configs để persist.
   * @returns {Array<import('./types.cjs').McpServerConfig>}
   */
  getConfigs() {
    return Array.from(this.servers.values()).map((e) => e.config);
  }

  /**
   * Shutdown tất cả connections.
   */
  async shutdown() {
    this.shuttingDown = true;
    const promises = [];
    for (const entry of this.servers.values()) {
      this._clearReconnect(entry);
      entry.intentionalClose = true;
      promises.push(this._disconnect(entry));
    }
    await Promise.allSettled(promises);
    this.servers.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Internal                                                           */
  /* ------------------------------------------------------------------ */

  _clearReconnect(entry) {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.toolRefreshTimer) {
      clearTimeout(entry.toolRefreshTimer);
      entry.toolRefreshTimer = null;
    }
  }

  /**
   * Nạp lại danh sách tool sau thông báo list_changed.
   * Gộp (debounce) 250ms: server có thể bắn nhiều thông báo liên tiếp khi
   * khởi động lại từng module, mà mỗi lần refresh là một loạt round-trip.
   */
  _scheduleToolRefresh(entry, transport) {
    if (entry.transport !== transport) return; // thông báo của kết nối cũ
    if (entry.intentionalClose || this.shuttingDown) return;

    if (entry.toolRefreshTimer) clearTimeout(entry.toolRefreshTimer);
    entry.toolRefreshTimer = setTimeout(() => {
      entry.toolRefreshTimer = null;
      void this._refreshTools(entry, transport);
    }, 250);
  }

  async _refreshTools(entry, transport) {
    if (entry.transport !== transport || entry.status !== 'connected' || !entry.client) return;
    try {
      entry.tools = await this._listAllTools(entry, entry.client);
      console.log(`[mcp] Tools refreshed: ${entry.config.name} (${entry.tools.length} tools)`);
      this._emitStatus(entry);
    } catch (err) {
      // Giữ danh sách cũ: refresh thất bại không được làm mất tool đang dùng.
      console.error(`[mcp] Refresh tools failed (${entry.config.name}):`, String(err?.message ?? err));
    }
  }

  async _connect(entry) {
    if (this.shuttingDown) return;

    entry.status = 'connecting';
    entry.error = null;
    this._emitStatus(entry);

    let client = null;
    let transport = null;

    try {
      transport = this._createTransport(entry);

      client = new sdkClient({ name: 'vyen-desktop', version: '1.0.0' });

      // Transport mất kết nối (process con chết, mạng đứt) → hạ trạng thái
      // ngay thay vì giữ 'connected' giả tạo tới lần gọi tool kế tiếp.
      transport.onclose = () => {
        if (entry.intentionalClose || this.shuttingDown) return;
        if (entry.transport !== transport) return; // kết nối cũ đã bị thay thế
        entry.status = 'disconnected';
        entry.error = 'MCP server đã đóng kết nối.';
        entry.tools = [];
        this._emitStatus(entry);
        this._scheduleReconnect(entry);
      };
      transport.onerror = (err) => {
        console.error(`[mcp] Transport error (${entry.config.name}):`, String(err?.message ?? err));
      };

      await client.connect(transport);

      /* tools/list_changed: server báo danh sách tool đổi (vd server sinh tool
         theo cấu hình). Không subscribe thì Vyen giữ danh sách cũ tới khi
         người dùng bấm "Làm mới" — model gọi tool đã bị gỡ và nhận lỗi mơ hồ. */
      if (sdkToolListChangedSchema) {
        try {
          client.setNotificationHandler(sdkToolListChangedSchema, () => {
            this._scheduleToolRefresh(entry, transport);
          });
        } catch {
          // Server/handler không hỗ trợ — bỏ qua, danh sách vẫn đúng lúc connect.
        }
      }

      // tools/list có thể phân trang — SDK KHÔNG tự đi theo nextCursor.
      const tools = await this._listAllTools(entry, client);

      try {
        const version = client.getServerVersion?.();
        entry.serverVersion = version
          ? `${version.name} ${version.version}`.trim()
          : null;
      } catch {
        entry.serverVersion = null;
      }

      entry.client = client;
      entry.transport = transport;
      entry.tools = tools;
      entry.status = 'connected';
      entry.error = null;
      entry.reconnectAttempts = 0;

      this._logStdio(entry, transport);
      console.log(`[mcp] Connected: ${entry.config.name} (${tools.length} tools)`);
      this._emitStatus(entry);
    } catch (err) {
      // Dọn dẹp nửa chừng: client đã connect nhưng listTools lỗi thì vẫn
      // phải đóng, nếu không process con bị bỏ mồ côi.
      try {
        await client?.close();
      } catch {
        // ignore
      }

      entry.client = null;
      entry.transport = null;
      entry.tools = [];
      entry.status = 'error';
      entry.error = String(err?.message ?? err);
      console.error(`[mcp] Connect failed: ${entry.config.name}:`, entry.error);
      this._emitStatus(entry);

      if (!entry.intentionalClose && !this.shuttingDown) {
        this._scheduleReconnect(entry);
      }
    }
  }

  _createTransport(entry) {
    const config = entry.config;

    if (config.transport === 'stdio') {
      return new sdkStdio({
        command: config.command,
        args: config.args ?? [],
        // GỐC là tập env an toàn của SDK (PATH/HOME...), KHÔNG phải process.env
        // đầy đủ — MCP server là process của bên thứ ba, không được nhìn thấy
        // secret của máy hay của Electron.
        env: config.env
          ? { ...(sdkStdioEnv ? sdkStdioEnv() : {}), ...config.env }
          : undefined,
        cwd: config.cwd,
        // 'inherit' (mặc định SDK) đẩy thẳng stderr của server ra console app;
        // pipe để gắn prefix, vừa đọc được vừa không lẫn với log của Vyen.
        stderr: 'pipe',
      });
    }

    if (config.transport === 'sse') {
      if (!sdkSse) throw new Error('SSE transport không khả dụng trong bản MCP SDK này.');
      return new sdkSse(new URL(config.url), {
        requestInit: { headers: config.headers ?? {} },
      });
    }

    if (config.transport === 'streamable-http') {
      if (!sdkStreamableHttp) {
        throw new Error('StreamableHTTP transport không khả dụng trong bản MCP SDK này.');
      }
      return new sdkStreamableHttp(new URL(config.url), {
        requestInit: { headers: config.headers ?? {} },
      });
    }

    throw new Error(`Transport không được hỗ trợ: ${String(config.transport)}`);
  }

  /** Đi theo nextCursor của tools/list tới khi hết trang (spec MCP). */
  async _listAllTools(entry, client) {
    const tools = [];
    let cursor;
    const timeout = entry.callTimeoutMs;

    for (;;) {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
      const batch = Array.isArray(page?.tools) ? page.tools : [];
      for (const tool of batch) {
        if (tools.length >= MAX_TOOLS_PER_SERVER) break;
        tools.push(tool);
      }
      cursor = page?.nextCursor;
      if (!cursor || tools.length >= MAX_TOOLS_PER_SERVER) break;
    }

    return tools;
  }

  /**
   * Gắn prefix vào stderr của process con (chỉ stdio + chỉ khi SDK pipe được).
   * Server hay ghi log khởi động ra đây — là manh mối số 1 khi connect lỗi.
   */
  _logStdio(entry, transport) {
    if (entry.config.transport !== 'stdio') return;
    let stream = null;
    try {
      stream = transport.stderr;
    } catch {
      stream = null;
    }
    if (!stream || typeof stream.on !== 'function') return;

    stream.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) console.log(`[mcp:${entry.config.id}] ${text}`);
    });
  }

  async _disconnect(entry) {
    // Hủy mọi lịch treo trước khi thay transport: timer của kết nối cũ không
    // được phép chạy lên kết nối mới.
    this._clearReconnect(entry);

    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    entry.tools = [];
    entry.status = 'disconnected';

    try {
      await client?.close();
    } catch {
      // Đóng lỗi (process đã chết) không phải lỗi cần báo lên UI.
    }
  }

  _scheduleReconnect(entry) {
    if (entry.intentionalClose || this.shuttingDown) return;
    if (entry.reconnectTimer) return;

    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.status = 'error';
      entry.error =
        entry.error ?? `Kết nối thất bại sau ${MAX_RECONNECT_ATTEMPTS} lần thử — bấm "Thử lại".`;
      this._emitStatus(entry);
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s rồi bỏ cuộc.
    const delay = Math.min(1000 * 2 ** entry.reconnectAttempts, 30_000);
    entry.reconnectAttempts += 1;

    console.log(
      `[mcp] Reconnecting ${entry.config.name} in ${delay}ms (attempt ${entry.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
    );

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      this._connect(entry);
    }, delay);
  }

  _emitStatus(entry) {
    this.emit('server-status', {
      id: entry.config.id,
      name: entry.config.name,
      status: entry.status,
      error: entry.error ?? undefined,
      toolCount: entry.tools.length,
      serverVersion: entry.serverVersion ?? undefined,
    });
  }
}

module.exports = {
  McpManager,
  loadSdk,
  matchesAutoApprove,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_RECONNECT_ATTEMPTS,
};
