'use client';

/**
 * AuditViewerDialog — Giao diện trực quan hóa và kiểm tra toàn vẹn nhật ký kiểm toán (Tamper-Evident Hash Chain).
 */

import { useState, useEffect, useMemo } from 'react';
import { db, StoredAuditLogEntry } from '@/lib/db';
import { verifyChain, ChainVerificationResult } from '@/lib/audit-log';
import { Z_CLASS } from '@/lib/ui-z';
import { ShieldCheck, ShieldAlert, AlertTriangle, RefreshCw, X, Search, Link2, CheckCircle2, Lock } from 'lucide-react';

export type AuditVerificationState =
  | { status: 'IDLE' }
  | { status: 'VERIFYING'; progress: number }
  | { status: 'VALID'; totalRecords: number; headSeq: number; anchorVerified: boolean }
  | { status: 'PARTIAL_PRUNED'; prunedBeforeSeq: number; headSeq: number; anchorVerified: boolean }
  | { status: 'TAMPERED'; brokenSeq: number; expectedHash?: string; actualHash?: string; reason?: string }
  | { status: 'ANCHOR_MISMATCH'; memoryHeadHash: string; diskAnchorHash: string };

export interface AuditViewerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  chatIdFilter?: string;
}

export function AuditViewerDialog({ isOpen, onClose, chatIdFilter }: AuditViewerDialogProps) {
  const [logs, setLogs] = useState<StoredAuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterAction, setFilterAction] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [verifyState, setVerifyState] = useState<AuditVerificationState>({ status: 'IDLE' });

  // Nạp 150 bản ghi gần nhất từ IndexedDB
  const fetchLogs = async () => {
    setLoading(true);
    try {
      const records = await db.auditLogs.orderBy('seq').reverse().limit(150).toArray();
      setLogs(records);
    } catch (err) {
      console.error('Failed to load audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
      setVerifyState({ status: 'IDLE' });
    }
  }, [isOpen]);

  // Luồng xác thực không chặn Main Thread
  const handleVerifyChain = async () => {
    setVerifyState({ status: 'VERIFYING', progress: 10 });

    try {
      // Cho phép UI render spinner
      await new Promise((r) => setTimeout(r, 50));

      const allRecords = await db.auditLogs.orderBy('seq').toArray();
      setVerifyState({ status: 'VERIFYING', progress: 50 });

      const result: ChainVerificationResult = await verifyChain(allRecords);
      setVerifyState({ status: 'VERIFYING', progress: 85 });

      // So khớp với disk anchor nếu có desktop bridge
      let diskAnchorVerified = false;
      try {
        const bridge = (window as unknown as { vyenBridge?: { audit?: { getAnchor?: () => Promise<{ headHash: string } | null> } } }).vyenBridge;
        if (bridge?.audit?.getAnchor) {
          const anchor = await bridge.audit.getAnchor();
          if (anchor && allRecords.length > 0) {
            const head = allRecords[allRecords.length - 1];
            if (anchor.headHash !== head.hash) {
              setVerifyState({
                status: 'ANCHOR_MISMATCH',
                memoryHeadHash: head.hash,
                diskAnchorHash: anchor.headHash,
              });
              return;
            }
            diskAnchorVerified = true;
          }
        }
      } catch {
        // Môi trường browser web thuần
      }

      if (!result.valid) {
        setVerifyState({
          status: 'TAMPERED',
          brokenSeq: result.brokenSeq ?? 0,
          reason: result.reason,
        });
        return;
      }

      const headSeq = allRecords.length > 0 ? allRecords[allRecords.length - 1].seq : 0;
      if (result.partialChain) {
        setVerifyState({
          status: 'PARTIAL_PRUNED',
          prunedBeforeSeq: result.prunedBeforeSeq ?? 1,
          headSeq,
          anchorVerified: diskAnchorVerified,
        });
      } else {
        setVerifyState({
          status: 'VALID',
          totalRecords: result.totalChecked,
          headSeq,
          anchorVerified: diskAnchorVerified,
        });
      }
    } catch (err) {
      setVerifyState({
        status: 'TAMPERED',
        brokenSeq: 0,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (chatIdFilter && log.chatId && log.chatId !== chatIdFilter) return false;
      if (filterAction !== 'all' && log.action !== filterAction) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matchTool = log.tool?.toLowerCase().includes(q);
        const matchTarget = log.target?.toLowerCase().includes(q);
        const matchHash = log.hash?.toLowerCase().includes(q);
        if (!matchTool && !matchTarget && !matchHash) return false;
      }
      return true;
    });
  }, [logs, chatIdFilter, filterAction, searchQuery]);

  if (!isOpen) return null;

  return (
    <div className={`fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 ${Z_CLASS.navigation}`}>
      <div className="bg-surface-raised border border-border-hairline rounded-lg w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-hairline bg-surface-subtle">
          <div className="flex items-center gap-2">
            <Lock size={16} className="text-status-info" />
            <h2 className="text-sm font-semibold text-text-primary">Nhật Ký Kiểm Toán Toàn Vẹn (Tamper-Evident Audit Chain)</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary rounded hover:bg-surface transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Verification Status Banner */}
        <div className="p-3 border-b border-border-hairline bg-surface">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs">
              {verifyState.status === 'IDLE' && (
                <span className="text-text-muted flex items-center gap-1.5">
                  <ShieldCheck size={14} /> Chưa chạy kiểm tra toàn vẹn chuỗi hash.
                </span>
              )}
              {verifyState.status === 'VERIFYING' && (
                <span className="text-status-info flex items-center gap-1.5 animate-pulse">
                  <RefreshCw size={14} className="animate-spin" /> Đang kiểm tra mã băm SHA-256 ({verifyState.progress}%)…
                </span>
              )}
              {verifyState.status === 'VALID' && (
                <span className="text-status-success font-medium flex items-center gap-1.5">
                  <CheckCircle2 size={14} /> Chuỗi băm hợp lệ tuyệt đối (100% {verifyState.totalRecords} bản ghi từ genesis tới seq #{verifyState.headSeq}).
                </span>
              )}
              {verifyState.status === 'PARTIAL_PRUNED' && (
                <span className="text-status-warning font-medium flex items-center gap-1.5">
                  <AlertTriangle size={14} /> Chuỗi hợp lệ (đã dọn bớt trước seq #{verifyState.prunedBeforeSeq}; phần còn lại tới seq #{verifyState.headSeq} nguyên vẹn).
                </span>
              )}
              {verifyState.status === 'TAMPERED' && (
                <span className="text-status-error font-semibold flex items-center gap-1.5">
                  <ShieldAlert size={14} /> PHÁT HIỆN CAN THIỆP TẠI SEQ #{verifyState.brokenSeq}! {verifyState.reason}
                </span>
              )}
              {verifyState.status === 'ANCHOR_MISMATCH' && (
                <span className="text-status-error font-semibold flex items-center gap-1.5">
                  <ShieldAlert size={14} /> LỆCH ANCHOR ĐĨA NGOÀI WORKSPACE! Hash bộ nhớ khác hash đĩa.
                </span>
              )}
            </div>

            <button
              onClick={handleVerifyChain}
              disabled={verifyState.status === 'VERIFYING'}
              className="px-3 py-1 bg-primary text-primary-foreground text-xs font-medium rounded hover:bg-primary/90 flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={verifyState.status === 'VERIFYING' ? 'animate-spin' : ''} />
              Xác Minh Toàn Vẹn
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 p-3 border-b border-border-hairline bg-surface-subtle text-xs">
          <div className="relative flex-1">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              placeholder="Tìm theo tool, file đích hoặc mã hash…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="field w-full pl-7 py-1 text-xs"
            />
          </div>
          <select
            value={filterAction}
            onChange={(e) => setFilterAction(e.target.value)}
            className="field py-1 text-xs"
          >
            <option value="all">Tất cả hành động</option>
            <option value="fs_write">fs_write</option>
            <option value="fs_edit">fs_edit</option>
            <option value="shell_run">shell_run</option>
            <option value="code_patch">code_patch</option>
            <option value="mcp_call">mcp_call</option>
          </select>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto p-2">
          {loading ? (
            <div className="text-center py-10 text-xs text-text-muted">Đang nạp nhật ký kiểm toán…</div>
          ) : filteredLogs.length === 0 ? (
            <div className="text-center py-10 text-xs text-text-muted">Không tìm thấy bản ghi kiểm toán nào phù hợp.</div>
          ) : (
            <table className="w-full text-[11px] text-left border-collapse">
              <thead>
                <tr className="border-b border-border-hairline text-text-muted font-medium">
                  <th className="py-1.5 px-2 w-12">Seq</th>
                  <th className="py-1.5 px-2 w-28">Thời gian</th>
                  <th className="py-1.5 px-2 w-20">Hành động</th>
                  <th className="py-1.5 px-2 w-20">Quyết định</th>
                  <th className="py-1.5 px-2">Chi tiết / Mục tiêu</th>
                  <th className="py-1.5 px-2 w-32">Cryptographic Link</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-hairline">
                {filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-surface transition-colors font-mono">
                    <td className="py-1.5 px-2 text-text-muted">#{log.seq}</td>
                    <td className="py-1.5 px-2 text-text-muted">
                      {new Date(log.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className="py-1.5 px-2 font-sans font-medium text-text-primary">{log.action}</td>
                    <td className="py-1.5 px-2">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-sans font-medium ${
                          log.decision === 'approved'
                            ? 'bg-status-success/15 text-status-success'
                            : log.decision === 'blocked'
                              ? 'bg-status-error/15 text-status-error'
                              : 'bg-status-warning/15 text-status-warning'
                        }`}
                      >
                        {log.decision}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 truncate max-w-xs font-sans text-text-muted" title={log.target || log.tool}>
                      {log.target || log.tool}
                    </td>
                    <td className="py-1.5 px-2 text-[10px] text-text-muted">
                      <div className="flex items-center gap-1" title={`hash: ${log.hash}\nprev: ${log.prevHash || 'genesis'}`}>
                        <Link2 size={10} className="text-status-info shrink-0" />
                        <span className="truncate">{log.hash.slice(0, 8)}…</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
