/**
 * React Adapter — useApprovalBridge hook (Tầng 2).
 *
 * Nhiệm vụ:
 * 1. Quản lý hàng đợi các modal phê duyệt bảo mật (DiffConfirm, ShellConfirm, McpApproval).
 * 2. Đảm bảo tính độc quyền hiển thị (chỉ một modal tại một thời điểm, không chồng đôi).
 * 3. Tự động liên kết Token Binding với `chatId`, `activeLeafId`, `expectedBaseHash`.
 * 4. Kích hoạt `approvalQueue.abortAll(false)` ngay khi người dùng chuyển nhánh hoặc dừng lượt.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalQueue } from '@/lib/approval-queue';
import { createApprovalToken, consumeApprovalToken, ApprovalToken } from '@/lib/approval-binding';
import type { DiffConfirmState } from '@/components/diff-confirm';
import type { ShellConfirmState } from '@/components/shell-confirm';

export type ApprovalItem =
  | { kind: 'diff'; state: DiffConfirmState }
  | { kind: 'shell'; state: ShellConfirmState };

export interface UseApprovalBridgeOptions {
  chatId: string;
  activeLeafId?: string;
  onAuditLog?: (entry: any) => Promise<unknown> | void;
  onAwaitUser?: () => void;
  onResumeUser?: () => void;
}

export interface UseApprovalBridgeReturn {
  diffState: DiffConfirmState | null;
  shellState: ShellConfirmState | null;
  requestDiffApproval: (
    s: Omit<DiffConfirmState, 'open' | 'resolve'> & {
      toolName?: string;
      existedBefore?: boolean;
      expectedBaseHash?: string;
    },
  ) => Promise<{ approved: boolean; fingerprint: string | null }>;
  consumeDiffApproval: (
    fingerprint: string | null | undefined,
    s: { path: string; oldText: string; newText: string; toolName?: string; expectedBaseHash?: string },
  ) => boolean;
  requestShellApproval: (
    s: Omit<ShellConfirmState, 'open' | 'resolve'>,
    kind?: 'shell' | 'run_code',
  ) => Promise<{ approved: boolean; fingerprint: string | null }>;
  consumeShellApproval: (
    fingerprint: string | null | undefined,
    kind: 'shell' | 'run_code',
    s: { command: string; cwd?: string },
  ) => boolean;
  closeApproval: () => void;
  abortAll: (rejected?: boolean) => void;
  approvalQueue: ApprovalQueue<ApprovalItem>;
}

export function useApprovalBridge({
  chatId,
  activeLeafId,
  onAuditLog,
  onAwaitUser,
  onResumeUser,
}: UseApprovalBridgeOptions): UseApprovalBridgeReturn {
  const [diffState, setDiffState] = useState<DiffConfirmState | null>(null);
  const [shellState, setShellState] = useState<ShellConfirmState | null>(null);

  const activeLeafIdRef = useRef(activeLeafId);
  activeLeafIdRef.current = activeLeafId;

  const onAwaitUserRef = useRef(onAwaitUser);
  onAwaitUserRef.current = onAwaitUser;

  const onResumeUserRef = useRef(onResumeUser);
  onResumeUserRef.current = onResumeUser;

  const [approvalQueue] = useState(
    () =>
      new ApprovalQueue<ApprovalItem>({
        onRequest: () => onAwaitUserRef.current?.(),
        onPresent: (item) => {
          if (!item) {
            setDiffState(null);
            setShellState(null);
            return;
          }
          if (item.kind === 'diff') {
            setShellState(null);
            setDiffState(item.state);
          } else {
            setDiffState(null);
            setShellState(item.state);
          }
        },
        onDrained: () => onResumeUserRef.current?.(),
      }),
  );

  // PR 3: Khi activeLeafId đổi (chuyển nhánh), hủy toàn bộ pending approval để chống race condition
  const prevLeafIdRef = useRef(activeLeafId);
  useEffect(() => {
    if (prevLeafIdRef.current !== undefined && prevLeafIdRef.current !== activeLeafId) {
      approvalQueue.abortAll(false);
    }
    prevLeafIdRef.current = activeLeafId;
  }, [activeLeafId, approvalQueue]);

  // Dọn dẹp queue khi unmount
  useEffect(() => {
    return () => {
      approvalQueue.close();
    };
  }, [approvalQueue]);

  const requestDiffApproval = useCallback(
    (
      s: Omit<DiffConfirmState, 'open' | 'resolve'> & {
        toolName?: string;
        existedBefore?: boolean;
        expectedBaseHash?: string;
      },
    ): Promise<{ approved: boolean; fingerprint: string | null }> => {
      return new Promise((resolve) => {
        const token = createApprovalToken({
          kind: 'diff',
          payload: { path: s.path, oldText: s.oldText, newText: s.newText, toolName: s.toolName },
          chatId,
          activeLeafId: activeLeafIdRef.current,
          expectedBaseHash: s.expectedBaseHash,
        });

        const resolveOnce = (approved: boolean) =>
          resolve({ approved, fingerprint: token?.fingerprint ?? null });

        approvalQueue.request(
          { kind: 'diff', state: { ...s, open: true, resolve: resolveOnce } },
          resolveOnce,
          token ? { kind: 'diff', fingerprint: token.fingerprint } : undefined,
        );
      });
    },
    [approvalQueue, chatId],
  );

  const consumeDiffApproval = useCallback(
    (
      fingerprint: string | null | undefined,
      s: { path: string; oldText: string; newText: string; toolName?: string; expectedBaseHash?: string },
    ): boolean => {
      if (!fingerprint) return false;
      const verdict = consumeApprovalToken(fingerprint, {
        kind: 'diff',
        payload: { path: s.path, oldText: s.oldText, newText: s.newText, toolName: s.toolName },
        chatId,
        activeLeafId: activeLeafIdRef.current,
        expectedBaseHash: s.expectedBaseHash,
      });

      if (verdict.ok) return true;

      onAuditLog?.({
        action: 'rejection',
        tool: s.toolName || 'fs_edit',
        target: s.path,
        decision: 'blocked',
        payload: { path: s.path },
        chatId,
        details: { reason: verdict.reason ?? 'approval_binding_failed' },
      });
      return false;
    },
    [chatId, onAuditLog],
  );

  const requestShellApproval = useCallback(
    (
      s: Omit<ShellConfirmState, 'open' | 'resolve'>,
      kind: 'shell' | 'run_code' = 'shell',
    ): Promise<{ approved: boolean; fingerprint: string | null }> => {
      return new Promise((resolve) => {
        const token = createApprovalToken({
          kind,
          payload: { command: s.command, cwd: s.cwd },
          chatId,
          activeLeafId: activeLeafIdRef.current,
        });

        const resolveOnce = (approved: boolean) =>
          resolve({ approved, fingerprint: token?.fingerprint ?? null });

        approvalQueue.request(
          { kind: 'shell', state: { ...s, open: true, resolve: resolveOnce } },
          resolveOnce,
          token ? { kind: 'shell', fingerprint: token.fingerprint } : undefined,
        );
      });
    },
    [approvalQueue, chatId],
  );

  const consumeShellApproval = useCallback(
    (
      fingerprint: string | null | undefined,
      kind: 'shell' | 'run_code',
      s: { command: string; cwd?: string },
    ): boolean => {
      if (!fingerprint) return false;
      const verdict = consumeApprovalToken(fingerprint, {
        kind,
        payload: { command: s.command, cwd: s.cwd },
        chatId,
        activeLeafId: activeLeafIdRef.current,
      });

      if (verdict.ok) return true;

      onAuditLog?.({
        action: 'rejection',
        tool: kind,
        target: s.command,
        decision: 'blocked',
        payload: s,
        chatId,
        details: { reason: verdict.reason ?? 'approval_binding_failed' },
      });
      return false;
    },
    [chatId, onAuditLog],
  );

  const closeApproval = useCallback(() => {
    approvalQueue.close();
  }, [approvalQueue]);

  const abortAll = useCallback(
    (rejected = false) => {
      approvalQueue.abortAll(rejected);
    },
    [approvalQueue],
  );

  return {
    diffState,
    shellState,
    requestDiffApproval,
    consumeDiffApproval,
    requestShellApproval,
    consumeShellApproval,
    closeApproval,
    abortAll,
    approvalQueue,
  };
}
