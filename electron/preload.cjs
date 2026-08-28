/*
 * Preload — cầu nối duy nhất giữa renderer (app) và main process.
 * Mọi op đều là ipcRenderer.invoke tới channel 'koda:*' đã đăng ký trong
 * ipc.cjs (path-guard + zod ở phía main). Không expose require/node globals.
 */
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload ?? {});

contextBridge.exposeInMainWorld('koda', {
  desktop: true,
  platform: process.platform,
  electron: process.versions.electron,

  workspace: {
    get: () => invoke('koda:workspace-get'),
    select: () => invoke('koda:workspace-select'),
    set: (path) => invoke('koda:workspace-set', { path }),
    clear: () => invoke('koda:workspace-clear'),
  },

  fs: {
    list: (relPath = '') => invoke('koda:fs-list', { relPath }),
    read: (relPath) => invoke('koda:fs-read', { relPath }),
    readImage: (relPath) => invoke('koda:fs-read-image', { relPath }),
    write: (relPath, content) => invoke('koda:fs-write', { relPath, content }),
    delete: (relPath) => invoke('koda:fs-delete', { relPath }),
    stat: (relPath) => invoke('koda:fs-stat', { relPath }),
    search: (opts) => invoke('koda:fs-search', opts),
  },

  shell: {
    run: (opts) => invoke('koda:shell-run', opts),
  },

  git: {
    status: () => invoke('koda:git-status'),
    diff: (opts) => invoke('koda:git-diff', opts),
    log: (opts) => invoke('koda:git-log', opts),
    add: (relPaths) => invoke('koda:git-add', { relPaths }),
    commit: (message) => invoke('koda:git-commit', { message }),
  },
});
