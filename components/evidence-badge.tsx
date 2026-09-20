'use client';

import React from 'react';
import { describeEvidence, type EvidenceLevel } from '@/lib/evidence';
import { CheckCircle2, Play, AlertTriangle, XCircle, Circle } from 'lucide-react';

interface EvidenceBadgeProps {
  level?: EvidenceLevel | string;
  className?: string;
  size?: 'sm' | 'md';
}

const variantStyles: Record<string, string> = {
  default: 'border-border-hairline bg-surface-raised text-text-muted',
  running: 'border-accent-steel/40 bg-[#6a9fcc]/10 text-accent-steel animate-pulse',
  warning: 'border-status-warning/40 bg-[#e8993a]/10 text-status-warning',
  success: 'border-status-success/40 bg-[#5db87a]/10 text-status-success font-semibold',
  danger: 'border-status-error/40 bg-[#e8704f]/10 text-status-error',
};

export function EvidenceBadge({ level = 'prepared', className = '', size = 'sm' }: EvidenceBadgeProps) {
  const safeLevel: EvidenceLevel =
    level === 'prepared' ||
    level === 'running' ||
    level === 'reported_done' ||
    level === 'verified' ||
    level === 'blocked' ||
    level === 'failed'
      ? level
      : 'prepared';

  const info = describeEvidence(safeLevel);
  const colorClass = variantStyles[info.variant] ?? variantStyles.default;
  const sizeClass = size === 'sm' ? 'text-[10.5px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-none border font-mono ${colorClass} ${sizeClass} ${className}`}
      title={`Evidence status: ${info.badgeText}`}
    >
      {safeLevel === 'verified' && <CheckCircle2 className="h-3 w-3 flex-shrink-0" />}
      {safeLevel === 'running' && <Play className="h-3 w-3 flex-shrink-0" />}
      {safeLevel === 'reported_done' && <AlertTriangle className="h-3 w-3 flex-shrink-0" />}
      {safeLevel === 'prepared' && <Circle className="h-2.5 w-2.5 flex-shrink-0 text-text-muted" />}
      {(safeLevel === 'blocked' || safeLevel === 'failed') && <XCircle className="h-3 w-3 flex-shrink-0" />}
      <span>{info.badgeText}</span>
    </span>
  );
}
