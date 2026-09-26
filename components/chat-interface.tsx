'use client';

import { useMemo } from 'react';
import { ApprovalQueue } from '@/lib/approval-queue';
import { recordAuditLog } from '@/lib/audit-log';
import { isToolDenied, TOOL_CATEGORY_MAP, TOOL_CATEGORY_LABELS } from '@/lib/tool-catalog';
import { isVyenDesktop } from '@/lib/desktop-bridge';
import { ToolRunner } from '@/core/agent-runtime/tool-runner';
import { useAgentRuntime } from '@/react/use-agent-runtime';
import { useApprovalBridge } from '@/react/use-approval-bridge';
import { useStreamingText } from '@/react/use-streaming-text';
import { StreamBubble } from '@/components/chat/stream-bubble';
import { useChatOrchestration } from '@/react/use-chat-orchestration';

import { StatusLine } from '@/components/chat/status-line';
import { MessageList } from '@/components/chat/message-list';
import { Composer } from '@/components/composer';
import { AgentHud } from '@/components/hud/agent-hud';
import { DiffConfirm } from '@/components/diff-confirm';
import { ShellConfirm } from '@/components/shell-confirm';
import { McpToolApprovalDialog } from '@/components/mcp/tool-approval-dialog';
import { StagingPanel } from '@/components/staging-panel';
import { ToolsPanel } from '@/components/tools-panel';
import { RecipesPanel } from '@/components/recipes/recipes-panel';
import { ToastHost } from '@/components/toast';
import { WorkspaceCheckpointBar } from '@/components/workspace-checkpoints';
import { PlanPanel } from '@/components/plan-panel';
import { stagingCount } from '@/lib/staging';
import { shouldShowThinkingControl } from '@/lib/reasoning-capability';
import { X } from 'lucide-react';

/**
 * Funnel dispatch kiểm tra deny policy và chuyển giao thực thi cho ToolRunner (Tầng 1).
 */
export async function executeClientToolGate(
  toolCall: { toolName: string; args?: unknown },
  toolPermissions: Record<string, string>,
  toolRunner: ToolRunner,
): Promise<string> {
  /* Quyền "Chặn" per-tool & category: kiểm tra TRƯỚC mọi nhánh thực thi
     để không modal nào hiện lên khi bị deny. Trả về đúng "denied by policy" */
  if (isToolDenied(toolCall.toolName, toolPermissions)) {
    const category = TOOL_CATEGORY_MAP[toolCall.toolName];
    return JSON.stringify({
      error:
        `Tool "${toolCall.toolName}" is denied by policy: nhóm ` +
        `"${category ? TOOL_CATEGORY_LABELS[category]?.label ?? String(category) : 'MCP'}" đang bị đặt quyền ` +
        'Chặn. Hãy báo người dùng và chờ họ đổi quyền nếu cần dùng lại.',
      denied: true,
    });
  }

  const isDesktop = isVyenDesktop();
  const desktopOnly = new Set([
    'shell_run', 'git_status', 'git_diff', 'git_log', 'git_add', 'git_commit', 'bg_run', 'bg_status', 'bg_stop',
  ]);
  if (desktopOnly.has(toolCall.toolName) && !isDesktop) {
    return JSON.stringify({
      error: 'Tool này chỉ khả dụng trong Vyen desktop (Electron). Hãy chạy app bằng npm run app:dev / app:prod.',
    });
  }

  switch (toolCall.toolName) {
    default:
      return await toolRunner.executeTool(toolCall.toolName, (toolCall.args ?? {}) as Record<string, unknown>);
  }
}

export default function ChatInterface() {
  const orch = useChatOrchestration();

  // Layer 2: useApprovalBridge điều phối hàng đợi phê duyệt modal
  const {
    diffState,
    shellState,
    requestDiffApproval: showDiffModal,
    requestShellApproval: showShellModal,
    closeApproval: closeDiffModal,
    abortAll,
    approvalQueue,
  } = orch.approvalBridge;
  const closeShellModal = closeDiffModal;

  // Layer 2: useAgentRuntime điều phối Web Locks đa tab
  const { isLeader, tabMode, isLeaderFrozen, forceStealLock, startTurn, stopTurn } = orch.agentRuntime;

  // Layer 2: useStreamingText buffer 60fps RAF điều tiết stream token
  const { displayText: streamText, displayReasoning: streamReasoning } = useStreamingText({
    rawText: orch.streamingContent,
    rawReasoning: orch.streamingReasoning,
    isStreaming: orch.isLoading,
  });

  // Layer 1: ToolRunner thực thi công cụ an toàn CWD jail + TOCTOU
  const toolRunner = useMemo(
    () =>
      new ToolRunner({
        chatId: orch.chatKey,
        activeLeafId: orch.activeLeafId ?? undefined,
        workspaceRoot: orch.workspaceRoot ?? undefined,
        approvalPolicy: orch.approvalPolicy,
        toolPermissions: orch.toolPermissions,
        recordAuditLog,
      }),
    [orch.chatKey, orch.activeLeafId, orch.workspaceRoot, orch.approvalPolicy, orch.toolPermissions],
  );

  const handleStop = () => {
    stopTurn();
    abortAll(false);
    orch.handleStop();
  };

  return (
    <div {...orch.swipeHandlers} className="flex h-full flex-col overflow-hidden bg-transparent touch-pan-y">
      {!isLeader && (
        <div data-testid="observer-banner" className="bg-amber-950/40 border-b border-amber-800/40 px-3 py-1.5 text-center text-xs font-mono text-amber-300 flex items-center justify-center gap-2">
          <span>{isLeaderFrozen ? 'Tab chính (Leader) bị đóng băng ở nền.' : `Tab đang ở chế độ Chỉ đọc (Observer — TabRuntimeMode: ${tabMode}).`}</span>
          {isLeaderFrozen && (
            <button type="button" onClick={forceStealLock} className="px-2 py-0.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-[10px] font-semibold transition-colors">
              Chiếm quyền điều khiển
            </button>
          )}
        </div>
      )}

      <StatusLine
        onOpenSidebar={orch.onOpenSidebar}
        sidebarCollapsed={orch.isSidebarCollapsed}
        models={orch.MODELS}
        model={orch.model}
        agentMode={orch.agentMode}
        onToggleAgentMode={orch.onToggleAgentMode}
        agentModeDisabled={orch.isLoading}
        workspace={orch.workspace ? { ...orch.workspace, branch: orch.gitBranch } : orch.workspace}
        ctxUsed={orch.contextUsage?.tokens}
        ctxMax={orch.contextUsage?.max}
        thinkingLevel={shouldShowThinkingControl(orch.modelReasoningCap) ? orch.thinkingLevel : undefined}
        thinkingSupportedLevels={orch.modelReasoningCap ? orch.modelReasoningCap.efforts : null}
        onThinkingLevelChange={orch.handleThinkingLevelChange}
        thinkingDisabled={orch.isLoading}
        thinkingMandatory={orch.modelReasoningCap?.mandatory ?? false}
        run={{ streaming: orch.isLoading, webBusy: orch.webBusy }}
        hasMessages={orch.hasMessages}
        canCompact={orch.canCompactNow}
        compactBusy={orch.compactBusy}
        onCompact={orch.onCompact}
        currentChatId={orch.currentChatId}
        confirmClear={orch.confirmClear}
        onSetConfirmClear={orch.setConfirmClear}
        onDeleteChat={orch.deleteChat}
      />

      {orch.swipeDirection && (
        <div
          className={[
            'pointer-events-none fixed top-1/2 z-50 -translate-y-1/2 rounded-full border border-border-hairline bg-panel-bg px-3.5 py-1.5 font-mono text-xs text-text-primary animate-pop-in',
            orch.swipeDirection === 'left' ? 'right-4' : 'left-4',
          ].join(' ')}
          aria-live="polite"
        >
          {orch.swipeDirection === 'left' ? 'Nhánh tiếp theo →' : '← Nhánh trước'}
        </div>
      )}

      <div className="relative flex-1 min-h-0 flex flex-col">
        <MessageList
          chatId={orch.chatKey}
          messages={orch.messages}
          compaction={orch.activeCompaction}
          branchInfoByMessageId={orch.branchInfoByMessageId}
          isLoading={orch.isLoading}
          lastMessageId={orch.lastMessageId}
          editingId={orch.editingId}
          copiedId={orch.copiedId}
          draft={orch.draft}
          isTouchDevice={orch.isTouchDevice}
          sendOnEnter={orch.sendOnEnter}
          throttleMs={orch.throttleMs}
          error={orch.error}
          isAtBottom={orch.isAtBottom}
          isAtBottomRef={orch.isAtBottomRef}
          pin={orch.pin}
          scrollRef={orch.scrollRef}
          onScroll={orch.onScroll}
          onScrollToBottom={orch.scrollToBottom}
          onCopy={orch.copyMessage}
          onRegenerate={orch.handleRegenerate}
          onSwitchBranch={orch.handleSwitchBranch}
          onStartEdit={orch.startEdit}
          onCancelEdit={orch.cancelEdit}
          onSaveEdit={orch.saveEdit}
          onDraftChange={orch.setDraft}
          onSelectSuggestion={orch.onSelectSuggestion}
          onReload={() =>
            orch.lastMessageId && orch.handleRegenerate(orch.lastMessageId)}
          onContinueGenerating={orch.continueGenerating}
        />

        {/* Layer 3: StreamBubble hiển thị streaming độc lập ngoài TanStack Virtualizer */}
        {orch.isLoading && isLeader && (
          <StreamBubble
            content={streamText}
            reasoning={streamReasoning}
            isStreaming={orch.isLoading}
            onStop={handleStop}
          />
        )}
      </div>

      <aside aria-label="Trạng thái phiên làm việc" className="w-full flex-none">
        {orch.workspaceReconnectRequired && !orch.dismissedReconnect && (
          <div className="mx-auto mb-2 w-full max-w-thread px-4">
            <div className="flex items-center justify-between gap-3 rounded-none border border-border-hairline bg-surface-raised px-3.5 py-2 text-xs">
              <span className="text-text-muted truncate">
                Phiên này từng dùng workspace <strong className="text-text-primary font-mono font-medium">{orch.workspace?.name}</strong>. Bạn có muốn kết nối lại để agent truy cập file?
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={orch.reconnectWorkspace}
                  className="bg-accent-steel hover:bg-accent-steel/80 text-background px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer"
                >
                  Kết nối lại
                </button>
                <button
                  type="button"
                  onClick={() => orch.setDismissedReconnect(true)}
                  className="text-text-muted hover:text-text-primary px-1.5 py-1 text-[11px] transition-colors cursor-pointer"
                >
                  Bỏ qua
                </button>
              </div>
            </div>
          </div>
        )}

        <WorkspaceCheckpointBar chatId={orch.currentChatId} busy={orch.isLoading} onNotice={orch.showNotice} />

        {orch.plan && !orch.planHidden && (
          <PlanPanel plan={orch.plan} onHide={() => orch.setPlanHidden(true)} canApprove={orch.agentMode === 'plan' && !orch.isLoading} onApprove={orch.handleApprovePlan} />
        )}

        {orch.hintsChip && (
          <div className="mx-auto mb-2 w-full max-w-thread px-4">
            <div className="rounded-none border border-border-hairline bg-[#1b2430] font-mono text-[11.5px] text-text-muted">
              <button
                type="button"
                onClick={() => orch.setShowHints((v) => !v)}
                aria-expanded={orch.showHints}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#6a9fcc]"
              >
                <span className="text-accent-steel">hints loaded</span>
                <span className="truncate">{orch.hintsChip.file}</span>
                <span className="ml-auto flex-none text-[10.5px] text-[#5c6470]">{orch.showHints ? 'thu gọn' : 'xem nội dung'}</span>
              </button>
              {orch.showHints && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border-hairline bg-[#12181f] px-3 py-2 text-[11px] leading-relaxed">
                  {orch.hintsChip.content}
                </pre>
              )}
            </div>
          </div>
        )}

        {orch.activeRecallPack && orch.activeRecallPack.items.length > 0 && (
          <div className="mx-auto mb-2 w-full max-w-thread px-4">
            <div className="flex items-center justify-between gap-2 rounded-none border border-border-hairline bg-surface-raised px-3 py-1.5 text-xs text-text-primary">
              <button
                type="button"
                onClick={() => orch.setShowRecalledDetail((v) => !v)}
                className="flex items-center gap-1.5 font-medium hover:underline text-[12px] text-text-primary"
              >
                <span>🧠 Đã nhớ {orch.activeRecallPack.items.length} ghi chú</span>
                <span className="text-[10px] text-accent-steel">({orch.showRecalledDetail ? 'thu gọn' : 'xem chi tiết'})</span>
              </button>
              <button
                type="button"
                onClick={() => orch.setActiveRecallPack(null)}
                className="rounded-none p-0.5 text-text-muted hover:text-text-primary"
                aria-label="Đóng thông báo ghi nhớ"
              >
                <X size={13} />
              </button>
            </div>

            {orch.showRecalledDetail && (
              <div className="mt-1.5 rounded-none border border-border-hairline bg-panel-bg p-2.5 text-xs">
                <div className="mb-1.5 text-[11px] font-semibold text-text-primary">
                  Ghi chú đã nạp vào ngữ cảnh ({orch.activeRecallPack.budget.usedTokens}/{orch.activeRecallPack.budget.limitTokens} tokens):
                </div>
                <ul className="space-y-1.5">
                  {orch.activeRecallPack.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-1.5 text-[11px] text-text-primary">
                      <span className="text-accent-steel font-bold">•</span>
                      <span className="flex-1 leading-relaxed">{item.text}</span>
                      <span className="shrink-0 text-[10px] text-text-muted">[{item.why}]</span>
                    </li>
                  ))}
                </ul>
                {orch.activeRecallPack.budget.droppedIds.length > 0 && (
                  <div className="mt-1.5 border-t border-border-hairline pt-1 text-[10px] text-text-muted italic">
                    Đã cắt {orch.activeRecallPack.budget.droppedIds.length} ghi chú do giới hạn ngân sách token.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </aside>

      <Composer
        chatId={orch.chatKey}
        onSubmit={async (text, atts) => {
          startTurn();
          return await orch.onSubmit(text, atts);
        }}
        isStreaming={orch.isLoading}
        onStop={handleStop}
        models={orch.MODELS}
        model={orch.model}
        onModelChange={orch.handleModelChange}
        modelSelectorDisabled={orch.isLoading}
        modelProviderId={orch.activeProviderId}
        modelCatalogBuiltin={!orch.activeProvider?.models?.length}
        modelFavorites={orch.modelFavorites}
        modelRecents={orch.recentModels}
        onToggleModelFavorite={orch.handleToggleModelFavorite}
        attachments={orch.composerAttachments}
        onAddFiles={orch.addFiles}
        slashPrompts={orch.insertPrompts}
        onApplySlashPrompt={orch.handleApplySlashPrompt}
        onRemoveAttachment={orch.handleRemoveAttachmentById}
        webSearch={orch.webSearchEnabled}
        onToggleWebSearch={orch.onToggleWebSearch}
        agentMode={orch.agentMode}
        onToggleAgentMode={orch.onToggleAgentMode}
        autoPilot={orch.autoPilot}
        approvalPolicy={orch.approvalPolicy}
        onCycleAutoPilot={orch.onCycleAutoPilot}
        stagedFileCount={orch.stagingVersion >= 0 ? stagingCount(orch.stagingRef.current) : 0}
        onOpenStaging={orch.onOpenStaging}
        onOpenToolsPanel={orch.onOpenToolsPanel}
        onOpenRecipes={() => orch.setRecipesPanelOpen(true)}
        webBusy={orch.webBusy}
        workspace={orch.workspace}
        onPickWorkspace={orch.pickFolder}
        onDisconnectWorkspace={orch.disconnectFolder}
        sendOnEnter={orch.sendOnEnter}
        isTouchDevice={orch.isTouchDevice}
        canContinue={orch.canContinue}
        goalLoopActive={orch.goalLoop?.status === 'active'}
        goalLoopInfo={orch.goalLoop?.status === 'active' ? `${orch.goalLoop.iterations + 1}/${orch.goalLoop.maxIterations}` : undefined}
        onGoalLoopClick={orch.handleGoalLoopClick}
        onContinue={orch.continueGenerating}
        composerApiRef={orch.composerApiRef}
        onTakeBackQueued={orch.takeBackQueued}
      />

      {/* Agent Telemetry HUD */}
      <AgentHud className="mx-auto w-full max-w-thread" />

      {/* Phê duyệt an toàn */}
      <DiffConfirm state={diffState} onClose={closeDiffModal} />
      <ShellConfirm state={shellState} onClose={closeShellModal} />
      <McpToolApprovalDialog />

      {orch.stagingPanelOpen && (
        <StagingPanel
          store={orch.stagingRef.current}
          onClose={() => orch.setStagingPanelOpen(false)}
          onApplyAll={orch.applyAllStaged}
          onRejectFile={orch.rejectStagedFile}
          onRejectAll={orch.rejectAllStaged}
        />
      )}

      {orch.toolsPanelOpen && (
        <ToolsPanel open={orch.toolsPanelOpen} onClose={() => orch.setToolsPanelOpen(false)} />
      )}

      <RecipesPanel
        open={orch.recipesPanelOpen}
        onClose={() => orch.setRecipesPanelOpen(false)}
        onRun={orch.startRecipeRun}
      />

      <ToastHost />
    </div>
  );
}
