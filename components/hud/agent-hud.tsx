'use client';

import React from 'react';
import { useHudStore, type HudLane } from '@/lib/hud-store';
import { describeEvidence } from '@/lib/evidence';
import { CATEGORY_DESCRIPTIONS } from '@/lib/routing/categories';
import { Cpu, Zap, Activity, Clock, Coins, CheckCircle2, AlertTriangle, Play, HelpCircle } from 'lucide-react';

interface AgentHudProps {
  className?: string;
}

export function AgentHud({ className = '' }: AgentHudProps) {
  const lanes = useHudStore((s) => s.lanes);
  const laneList = Object.values(lanes);

  if (laneList.length === 0) {
    return null;
  }

  return (
    <div
      aria-label="Agent Telemetry HUD"
      className={`border-b border-border/50 bg-background/90 backdrop-blur-md px-3 py-2 text-xs font-mono text-muted-foreground transition-all duration-200 ${className}`}
    >
      <div className="flex flex-col gap-1.5 max-h-48 overflow-y-auto pr-1">
        {laneList.map((lane) => (
          <HudRow key={lane.laneId} lane={lane} />
        ))}
      </div>
    </div>
  );
}

function HudRow({ lane }: { lane: HudLane }) {
  const catInfo = CATEGORY_DESCRIPTIONS[lane.category] ?? { label: lane.category };
  const evidenceInfo = describeEvidence(lane.evidence);

  const costDisplay =
    lane.costUsd === 'unknown'
      ? 'unknown'
      : `$${lane.costUsd.toFixed(4)}`;

  const evidenceColorMap = {
    default: 'bg-muted text-muted-foreground border-border/60',
    running: 'bg-blue-500/10 text-blue-400 border-blue-500/30 animate-pulse',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    success: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 font-semibold',
    danger: 'bg-red-500/10 text-red-400 border-red-500/30',
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/40 bg-card/40 px-2.5 py-1.5 hover:border-border/80 transition-colors">
      {/* Left: Model, Category, Effort */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex items-center gap-1 font-medium text-foreground">
          <Cpu className="h-3.5 w-3.5 text-primary" />
          <span className="truncate max-w-[120px] sm:max-w-[180px]">{catInfo.label}</span>
        </span>
        <span className="text-muted-foreground/60">/</span>
        <span className="text-muted-foreground">
          {lane.model}:{lane.effort}
        </span>
        {lane.kind !== 'main' && (
          <span className="rounded bg-secondary/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-secondary-foreground">
            {lane.kind}
          </span>
        )}
      </div>

      {/* Center / Right: Telemetry metrics */}
      <div className="flex items-center gap-3 text-[11px]">
        {/* Parallel shot badge */}
        {Boolean(lane.parallelShots && lane.parallelShots > 1) && (
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-amber-400 font-semibold">
            <Zap className="h-3 w-3" />
            parallel shot ×{lane.parallelShots}
          </span>
        )}

        {/* Turn */}
        <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground">
          <Activity className="h-3 w-3" />
          T{lane.turn}
        </span>

        {/* Tokens */}
        <span className="hidden md:inline-flex items-center gap-1 text-muted-foreground">
          <Coins className="h-3 w-3" />
          {lane.tokensIn + lane.tokensOut > 0 ? (
            <span>
              {lane.tokensIn}↓ {lane.tokensOut}↑
            </span>
          ) : (
            '0 tok'
          )}
        </span>

        {/* Cost */}
        <span className="inline-flex items-center gap-1 font-medium">
          <span className={lane.costUsd === 'unknown' ? 'text-muted-foreground italic' : 'text-foreground'}>
            {costDisplay}
          </span>
        </span>

        {/* Elapsed */}
        <span className="hidden sm:inline-flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          {lane.elapsedSec}s
        </span>

        {/* Evidence ladder badge */}
        <span
          className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] ${
            evidenceColorMap[evidenceInfo.variant]
          }`}
        >
          {lane.evidence === 'verified' && <CheckCircle2 className="h-3 w-3" />}
          {lane.evidence === 'running' && <Play className="h-3 w-3" />}
          {lane.evidence === 'reported_done' && <AlertTriangle className="h-3 w-3" />}
          {lane.evidence === 'prepared' && <HelpCircle className="h-3 w-3" />}
          {evidenceInfo.badgeText}
        </span>
      </div>
    </div>
  );
}
