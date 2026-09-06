'use client';

/*
 * Status line thay cho ChatHeader kiểu web chat: một hàng hairline mang toàn
 * bộ trạng thái run theo ngôn ngữ terminal (DESIGN.md) — model, mode, workspace,
 * ngữ cảnh, trạng thái — và các tác vụ phiên (xuất/nén/xóa) dạng icon.
 * Dữ liệu chỉ đọc từ props mà ChatInterface đã có; không tự tính gì mới.
 */
import React, { memo } from 'react';
import { Menu, Scissors, Trash2 } from 'lucide-react';
import { ModelSelector, type ModelOption } from '@/components/model-selector';
import { ThinkingMenu } from '@/components/thinking-menu';
import { ChatExportMenu } from '@/components/chat-export-menu';
import { computeMeter, fmt, type ContextMeterTone } from '@/components/context-meter';
import type { ModelFavorite, RecentModel } from '@/lib/model-meta';
import type { ThinkingLevel } from '@/lib/provider-url';

interface StatusLineProps {
  onOpenSidebar: () => void;
  sidebarCollapsed: boolean;

  models: ModelOption[];
  model: string;
  onModelChange: (id: string) => void;
  modelSelectorDisabled: boolean;
  /** id provider đang active: Gần đây/Yêu thích của picker scoped theo đây. */
  modelProviderId: string;
  /** true khi danh sách model là catalog built-in (hiện section Đề xuất). */
  modelCatalogBuiltin: boolean;
  modelFavorites: ModelFavorite[];
  modelRecents: RecentModel[];
  onToggleModelFavorite: (id: string) => void;

  agentMode?: 'plan' | 'act';
  onToggleAgentMode?: () => void;
  agentModeDisabled: boolean;

  workspace?: { connected: boolean; name: string | null };

  ctxUsed?: number;
  ctxMax?: number;

  thinkingLevel?: ThinkingLevel;
  thinkingSupportedLevels?: ThinkingLevel[] | null;
  onThinkingLevelChange?: (level: ThinkingLevel) => void;
  thinkingDisabled: boolean;
  /** Model bắt buộc luôn suy luận (metadata reasoning.mandatory). */
  thinkingMandatory?: boolean;

  run: { streaming: boolean; mediaBusy: boolean; webBusy: boolean };

  hasMessages: boolean;
  canCompact?: boolean;
  compactBusy?: boolean;
  onCompact?: () => void;
  currentChatId: string | null;
  confirmClear: boolean;
  onSetConfirmClear: (val: boolean) => void;
  onDeleteChat: () => void;
}

const TONE_TEXT: Record<ContextMeterTone, string> = {
  ok: 'text-[#9fa4ab]',
  warning: 'text-[#e8993a]',
  error: 'text-[#e8704f]',
};

const TONE_BAR: Record<ContextMeterTone, string> = {
  ok: 'bg-[#4b607c]',
  warning: 'bg-[#e8993a]',
  error: 'bg-[#e8704f]',
};

export const StatusLine = memo(function StatusLine({
  onOpenSidebar,
  sidebarCollapsed,
  models,
  model,
  onModelChange,
  modelSelectorDisabled,
  modelProviderId,
  modelCatalogBuiltin,
  modelFavorites,
  modelRecents,
  onToggleModelFavorite,
  agentMode,
  onToggleAgentMode,
  agentModeDisabled,
  workspace,
  ctxUsed,
  ctxMax,
  thinkingLevel,
  thinkingSupportedLevels,
  onThinkingLevelChange,
  thinkingDisabled,
  thinkingMandatory,
  run,
  hasMessages,
  canCompact,
  compactBusy,
  onCompact,
  currentChatId,
  confirmClear,
  onSetConfirmClear,
  onDeleteChat,
}: StatusLineProps) {
  const meter = ctxUsed !== undefined && ctxMax ? computeMeter(ctxUsed, ctxMax) : null;

  const runLabel = run.mediaBusy
    ? 'media'
    : run.webBusy
      ? 'web'
      : run.streaming
        ? 'running'
        : 'idle';
  const runTone = run.mediaBusy || run.webBusy || run.streaming
    ? 'text-[#6a9fcc]'
    : 'text-[#9fa4ab]';

  return (
    <header className="sticky top-0 z-20 flex h-9 min-w-0 flex-shrink-0 items-center gap-1.5 overflow-x-auto no-scrollbar border-b border-[#495059] bg-[#0d1116] px-2 font-mono text-[11.5px] pt-safe-2 md:px-3">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label={sidebarCollapsed ? 'Mở rộng thanh bên' : 'Mở thanh bên'}
        className={`icon-btn-sm flex-none ${sidebarCollapsed ? '' : 'md:hidden'}`}
      >
        <Menu size={15} />
      </button>

      {/* Model — chọn được ngay từ status line, khỏi chiếm chỗ trong composer. */}
      <div className="min-w-0 flex-none max-w-[13rem]">
        <ModelSelector
          models={models}
          value={model}
          onChange={onModelChange}
          disabled={modelSelectorDisabled}
          providerId={modelProviderId}
          builtinCatalog={modelCatalogBuiltin}
          favorites={modelFavorites}
          recents={modelRecents}
          onToggleFavorite={onToggleModelFavorite}
        />
      </div>

      {onToggleAgentMode && (
        <button
          type="button"
          onClick={onToggleAgentMode}
          disabled={agentModeDisabled}
          aria-label={
            agentMode === 'plan' ? 'Chuyển sang ACT mode' : 'Chuyển sang PLAN mode'
          }
          title={
            agentMode === 'plan'
              ? 'PLAN: agent chỉ đọc và hỏi, bấm để cho phép ghi'
              : 'ACT: agent đọc + ghi file, chạy lệnh, bấm để về PLAN'
          }
          className={`flex-none rounded-none px-1.5 py-0.5 uppercase tracking-[0.08em] transition-colors duration-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#6a9fcc] disabled:cursor-not-allowed disabled:opacity-40 ${
            agentMode === 'plan'
              ? 'bg-[#252f3d] text-[#e8993a]'
              : 'text-[#9fa4ab] hover:bg-[#161d27] hover:text-[#ebe7e4]'
          }`}
        >
          {agentMode === 'plan' ? 'plan' : 'act'}
        </button>
      )}

      {workspace && (
        <span
          className="hidden flex-none text-[#9fa4ab] sm:inline"
          title={
            workspace.connected
              ? `Thư mục làm việc: ${workspace.name}`
              : 'Chưa kết nối thư mục làm việc, nút thư mục trong thanh nhập'
          }
        >
          ws:{workspace.connected ? workspace.name : '-'}
        </span>
      )}

      {meter && (
        <div
          className="hidden min-w-0 flex-none items-center gap-1.5 md:flex"
          title={`Ngữ cảnh: ${fmt(ctxUsed!)} / ${fmt(meter.safeMax)} token (${meter.percent}%)`}
        >
          <div className="h-0.5 w-16 bg-[#1c2128]" aria-hidden="true">
            <div
              className={`h-full ${TONE_BAR[meter.tone]}`}
              style={{ width: `${Math.round(meter.fillRatio * 100)}%` }}
            />
          </div>
          <span className={`flex-none text-[10px] tabular-nums ${TONE_TEXT[meter.tone]}`}>
            {fmt(ctxUsed!)} / {fmt(meter.safeMax)}
          </span>
        </div>
      )}

      <div className="flex-1" aria-hidden="true" />

      <span
        className={`flex flex-none items-center gap-1.5 ${runTone}`}
        role="status"
        aria-label={`Trạng thái: ${runLabel}`}
      >
        {run.streaming && <span aria-hidden="true" className="terminal-cursor" />}
        {runLabel}
      </span>

      {thinkingLevel && onThinkingLevelChange && (
        <div className="flex-none">
          <ThinkingMenu
            value={thinkingLevel}
            onChange={onThinkingLevelChange}
            disabled={thinkingDisabled}
            supportedLevels={thinkingSupportedLevels}
            mandatory={thinkingMandatory}
          />
        </div>
      )}

      <ChatExportMenu chatId={currentChatId} />

      {hasMessages && canCompact && onCompact && (
        <button
          type="button"
          onClick={onCompact}
          disabled={compactBusy}
          aria-label={compactBusy ? 'Đang nén hội thoại' : 'Nén hội thoại'}
          title={
            compactBusy
              ? 'Đang nén hội thoại...'
              : 'Nén phần hội thoại cũ thành tóm tắt'
          }
          className="icon-btn-sm flex-none text-[#9fa4ab] hover:text-[#6a9fcc]"
        >
          <Scissors size={13} />
        </button>
      )}

      {hasMessages &&
        (confirmClear ? (
          <div className="flex flex-none items-center gap-1 rounded-none border border-[#495059] bg-[#161d27] p-0.5 font-mono text-[11px]">
            <button
              type="button"
              onClick={onDeleteChat}
              className="rounded-none px-1.5 py-0.5 font-medium text-[#e8704f] transition-colors hover:bg-[#e8704f]/10"
            >
              Xóa
            </button>
            <button
              type="button"
              onClick={() => onSetConfirmClear(false)}
              className="rounded-none px-1.5 py-0.5 text-[#9fa4ab] transition-colors hover:bg-[#252f3d]"
            >
              Hủy
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => onSetConfirmClear(true)}
            aria-label="Xóa cuộc trò chuyện"
            title="Xóa cuộc trò chuyện này"
            className="icon-btn-sm icon-btn-danger flex-none text-[#9fa4ab] hover:text-[#e8704f]"
          >
            <Trash2 size={13} />
          </button>
        ))}
    </header>
  );
});
