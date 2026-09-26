'use client';

/**
 * McpToolGrantsPanel — Quản trị quyền MCP động, TTL và tự động phát hiện Schema Drift.
 */

import { useState, useEffect } from 'react';
import { db } from '@/lib/db';
import { ShieldCheck, ShieldAlert, Trash2, RefreshCw, Clock, Key } from 'lucide-react';

export const MAX_GRANT_TTL_MS = 60 * 60 * 1000; // Trần cứng 60 phút (Red Team blind spot 3)

export interface McpGrantRecord {
  toolName: string;
  serverId: string;
  serverPid?: number;
  schemaHash: string;
  grantedAt: number;
  expiresAt: number;
  mode: 'always_allow' | 'always_deny';
  status: 'ACTIVE' | 'SCHEMA_MUTATED' | 'EXPIRED';
}

export function McpToolGrantsPanel() {
  const [grants, setGrants] = useState<McpGrantRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const loadGrants = async () => {
    setLoading(true);
    try {
      // Đọc từ Dexie kv table
      const stored = await db.kv.get('mcp:tool-grants');
      if (stored && Array.isArray(stored.value)) {
        const now = Date.now();
        const normalized: McpGrantRecord[] = (stored.value as McpGrantRecord[]).map((g) => {
          const hardCap = (g.grantedAt || now) + MAX_GRANT_TTL_MS;
          const cappedExpires = Math.min(g.expiresAt || hardCap, hardCap);
          const isExpired = now >= cappedExpires;
          return {
            ...g,
            expiresAt: cappedExpires,
            status: isExpired ? 'EXPIRED' : g.status,
          };
        });
        setGrants(normalized);
      } else {
        setGrants([]);
      }
    } catch (err) {
      console.error('Failed to load MCP grants:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadGrants();
  }, []);

  const handleRevoke = async (toolName: string, serverId: string) => {
    const next = grants.filter((g) => !(g.toolName === toolName && g.serverId === serverId));
    setGrants(next);
    await db.kv.put({ key: 'mcp:tool-grants', value: next });
  };

  const handleRevokeAll = async () => {
    setGrants([]);
    await db.kv.put({ key: 'mcp:tool-grants', value: [] });
  };

  return (
    <div className="border border-border-hairline bg-surface-raised p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Key size={14} className="text-status-info" />
          <h4 className="text-xs font-semibold text-text-primary">Quyền MCP Động &amp; Schema Governance</h4>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={loadGrants}
            className="p-1 text-text-muted hover:text-text-primary rounded hover:bg-surface"
            title="Làm mới"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          {grants.length > 0 && (
            <button
              onClick={handleRevokeAll}
              className="px-2 py-0.5 text-[10px] text-status-error hover:bg-status-error/10 border border-status-error/30 rounded font-medium transition-colors"
            >
              Thu hồi tất cả
            </button>
          )}
        </div>
      </div>

      <p className="text-[11px] text-text-muted mb-3 leading-relaxed">
        Quản lý các quyền công cụ Model Context Protocol được cấp phép vĩnh viễn hoặc có thời hạn. Hệ thống tự động vô hiệu hóa quyền nếu cấu trúc công cụ (Schema) bị thay đổi nhằm chống tấn công Dynamic Tool Poisoning.
      </p>

      {grants.length === 0 ? (
        <div className="text-center py-4 text-xs text-text-muted bg-surface/50 border border-border-hairline rounded">
          Chưa có công cụ MCP nào được lưu quyền tự động. Mọi công cụ sẽ yêu cầu phê duyệt thủ công.
        </div>
      ) : (
        <div className="space-y-1.5">
          {grants.map((grant) => {
            const isMutated = grant.status === 'SCHEMA_MUTATED';
            const isExpired = grant.status === 'EXPIRED' || Date.now() >= grant.expiresAt;
            const remainingMins = Math.max(0, Math.round((grant.expiresAt - Date.now()) / 60000));
            const isInvalid = isMutated || isExpired;

            return (
              <div
                key={`${grant.serverId}:${grant.toolName}`}
                className={`flex items-center justify-between p-2 rounded text-xs border ${
                  isInvalid ? 'border-status-error/40 bg-status-error/5' : 'border-border-hairline bg-surface'
                }`}
              >
                <div className="flex items-center gap-2">
                  {isInvalid ? (
                    <ShieldAlert size={14} className="text-status-error shrink-0" />
                  ) : (
                    <ShieldCheck size={14} className="text-status-success shrink-0" />
                  )}
                  <div>
                    <div className="font-mono font-medium text-text-primary">
                      {grant.serverId}/{grant.toolName}
                    </div>
                    <div className="text-[10px] text-text-muted flex items-center gap-2 mt-0.5">
                      <span>Hash: {grant.schemaHash.slice(0, 8)}…</span>
                      {isMutated ? (
                        <span className="text-status-error font-medium">SCHEMA MUTATED — BỊ VÔ HIỆU HÓA</span>
                      ) : isExpired ? (
                        <span className="text-status-warning font-medium">HẾT HẠN (MAX 60M TTL)</span>
                      ) : (
                        <span className="flex items-center gap-1">
                          <Clock size={10} /> Còn {remainingMins}p
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => handleRevoke(grant.toolName, grant.serverId)}
                  className="p-1 text-text-muted hover:text-status-error transition-colors"
                  title="Thu hồi quyền này"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
