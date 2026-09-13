/**
 * Quản lý phiên làm việc CLI (Goose P2-8).
 *
 * Lưu trữ phiên hội thoại trong .vyen/sessions/ (workspace) và ~/.vyen/sessions/ (global).
 * Hỗ trợ lưu lịch sử, đổi tên, liệt kê và resume (-r, --name).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CoreMessage } from 'ai';
import { foldText } from '../search-utils';

export interface CliSessionData {
  id: string;
  name: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  history: CoreMessage[];
}

export function getSessionDir(workspaceRoot: string): string {
  return path.resolve(workspaceRoot, '.vyen', 'sessions');
}

export function getGlobalSessionDir(): string {
  const home = os.homedir();
  return path.resolve(home, '.vyen', 'sessions');
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function saveCliSession(workspaceRoot: string, session: CliSessionData): void {
  const dir = getSessionDir(workspaceRoot);
  ensureDir(dir);
  const filePath = path.join(dir, `${session.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
}

export function listCliSessions(workspaceRoot: string): CliSessionData[] {
  const dir = getSessionDir(workspaceRoot);
  const sessions: CliSessionData[] = [];
  const scannedIds = new Set<string>();

  const scanDir = (targetDir: string) => {
    if (!fs.existsSync(targetDir)) return;
    try {
      const files = fs.readdirSync(targetDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const id = f.replace(/\.json$/, '');
        if (scannedIds.has(id)) continue;
        try {
          const raw = fs.readFileSync(path.join(targetDir, f), 'utf8');
          const data = JSON.parse(raw) as CliSessionData;
          if (data && data.id) {
            sessions.push(data);
            scannedIds.add(data.id);
          }
        } catch {
          // Bỏ qua file hỏng
        }
      }
    } catch {
      // Không đọc được thư mục
    }
  };

  scanDir(dir);
  scanDir(getGlobalSessionDir());

  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return sessions;
}

export function getLatestCliSession(workspaceRoot: string): CliSessionData | null {
  const sessions = listCliSessions(workspaceRoot);
  return sessions[0] ?? null;
}

export function loadCliSession(workspaceRoot: string, idOrName: string): CliSessionData | null {
  const sessions = listCliSessions(workspaceRoot);
  const trimmed = idOrName.trim();
  if (!trimmed) return null;

  // 1. So khớp ID chính xác
  const exact = sessions.find((s) => s.id === trimmed);
  if (exact) return exact;

  // 2. So khớp theo tên không dấu / case-insensitive
  const foldedQuery = foldText(trimmed);
  const matched = sessions.find((s) => foldText(s.name || '').includes(foldedQuery));
  if (matched) return matched;

  return null;
}

export function renameCliSession(workspaceRoot: string, id: string, newName: string): boolean {
  const session = loadCliSession(workspaceRoot, id);
  if (!session) return false;
  session.name = newName.trim();
  session.updatedAt = Date.now();
  saveCliSession(workspaceRoot, session);
  return true;
}
