'use client';

import { useEffect, useRef, useState, type ElementType } from 'react';
import { Brain, ChevronDown, Lightbulb, Rocket, Sparkles } from 'lucide-react';
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '@/lib/provider-url';

const LEVELS: {
  key: ThinkingLevel;
  label: string;
  icon: ElementType;
  color: string;
  description: string;
}[] = [
  { key: 'low', label: 'Thấp', icon: Lightbulb, color: 'text-blue-600', description: 'Suy luận nhẹ cho câu hỏi đơn giản' },
  { key: 'medium', label: 'Trung bình', icon: Brain, color: 'text-purple-600', description: 'Cân bằng tốc độ và độ sâu' },
  { key: 'high', label: 'Cao', icon: Sparkles, color: 'text-amber-600', description: 'Phân tích sâu, chậm hơn' },
  { key: 'max', label: 'Tối đa', icon: Rocket, color: 'text-rose-600', description: 'Suy luận tối đa, tốn nhiều token nhất' },
];

interface ThinkingSliderProps {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
  disabled?: boolean;
}

export function ThinkingSlider({ value, onChange, disabled }: ThinkingSliderProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Đóng dropdown khi click ra ngoài.
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const current = LEVELS.find((l) => l.key === value)
    ?? LEVELS.find((l) => l.key === DEFAULT_THINKING_LEVEL)!;
  const CurrentIcon = current.icon;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-label={`Mức suy luận: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Mức độ suy luận (chỉ có tác dụng trên crax)"
        className={`flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors hover:bg-zinc-200/70 disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? 'bg-zinc-200/70' : ''
        } ${current.color}`}
      >
        <CurrentIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown
          className={`h-3 w-3 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div role="menu" className="surface-panel absolute bottom-full left-0 z-40 mb-2 w-60 animate-slide-up overflow-hidden p-1.5">
          <div className="border-b border-zinc-200 px-2.5 pb-1.5 pt-1">
            <p className="text-xs font-semibold text-zinc-800">Mức độ suy luận</p>
            <p className="text-[11px] text-zinc-500">Điều khiển độ sâu phân tích của AI</p>
          </div>
          <div className="mt-1 space-y-0.5">
            {LEVELS.map((level) => {
              const Icon = level.icon;
              const isActive = value === level.key;
              return (
                <button
                  key={level.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => {
                    onChange(level.key);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isActive ? 'bg-zinc-200/80' : 'hover:bg-zinc-100'
                  }`}
                >
                  <Icon className={`h-4 w-4 shrink-0 ${isActive ? level.color : 'text-zinc-500'}`} />
                  <div className="min-w-0 flex-1">
                    <span className={`text-xs font-medium ${isActive ? level.color : 'text-zinc-800'}`}>
                      {level.label}
                    </span>
                    <p className="mt-0.5 truncate text-[11px] leading-tight text-zinc-500">
                      {level.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
