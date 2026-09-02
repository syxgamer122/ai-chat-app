/*
 * Preload — cầu nối duy nhất giữa renderer (app) và main process.
 * Mọi op đều là ipcRenderer.invoke tới channel 'vyen:*' đã đăng ký trong
 * ipc.cjs (path-guard + zod ở phía main). Không expose require/node globals.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload ?? {});

/**
 * Subscribe một event một chiều từ main process.
 * Gỡ đăng ký bằng removeListener trên CHÍNH listener đã tạo — removeAllListeners
 * sẽ gỡ nhầm listener của component khác đang nghe cùng channel.
 */
const onEvent = (channel, callback) => {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('vyen', {
  desktop: true,
  platform: process.platform,
  electron: process.versions.electron,

  workspace: {
    get: () => invoke('vyen:workspace-get'),
    select: () => invoke('vyen:workspace-select'),
    set: (path) => invoke('vyen:workspace-set', { path }),
    clear: () => invoke('vyen:workspace-clear'),
  },

  fs: {
    list: (relPath = '') => invoke('vyen:fs-list', { relPath }),
    read: (relPath) => invoke('vyen:fs-read', { relPath }),
    readImage: (relPath) => invoke('vyen:fs-read-image', { relPath }),
    write: (relPath, content) => invoke('vyen:fs-write', { relPath, content }),
    delete: (relPath) => invoke('vyen:fs-delete', { relPath }),
    stat: (relPath) => invoke('vyen:fs-stat', { relPath }),
    search: (opts) => invoke('vyen:fs-search', opts),
  },

  shell: {
    run: (opts) => invoke('vyen:shell-run', opts),
  },

  git: {
    status: () => invoke('vyen:git-status'),
    diff: (opts) => invoke('vyen:git-diff', opts),
    log: (opts) => invoke('vyen:git-log', opts),
    add: (relPaths) => invoke('vyen:git-add', { relPaths }),
    commit: (message) => invoke('vyen:git-commit', { message }),
  },

  mcp: {
    listServers: () => invoke('mcp:list-servers'),
    addServer: (config) => invoke('mcp:add-server', config),
    removeServer: (id) => invoke('mcp:remove-server', { id }),
    reconnect: (id) => invoke('mcp:reconnect', { id }),
    updateConfig: (servers) => invoke('mcp:update-config', { servers }),
    listTools: () => invoke('mcp:list-tools'),
    callTool: (serverId, toolName, args) =>
      invoke('mcp:call-tool', { serverId, toolName, arguments: args }),
    resolveApproval: (approvalId, decision) =>
      invoke('mcp:resolve-approval', { approvalId, decision }),
    getPendingApprovals: () => invoke('mcp:get-pending-approvals'),
    getStatus: () => invoke('mcp:get-status'),
    /**
     * Đăng ký lắng nghe event một chiều từ main.
     * Trả về hàm gỡ đăng ký gỡ ĐÚNG listener của callback này — dùng
     * removeAllListeners ở đây sẽ xoá luôn listener của component khác.
     */
    onApprovalRequested: (callback) => onEvent('mcp:approval-requested', callback),
    onApprovalResolved: (callback) => onEvent('mcp:approval-resolved', callback),
    onServerStatus: (callback) => onEvent('mcp:server-status', callback),
  },
});
