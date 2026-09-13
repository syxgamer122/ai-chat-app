/**
 * HUD Store — Quản lý trạng thái telemetry live cho các lane (Oh My Hermes port).
 *
 * Mỗi lane đại diện cho một luồng thực thi: main conversation, subagent relay, fanout unit,
 * hoặc orchestrator cell.
 *
 * Nguyên tắc:
 * - Hiển thị model:effort, turn, tokens, cost, elapsed, evidence.
 * - Cost chỉ hiển thị khi có giá xác nhận từ contract; nếu thiếu giá trả 'unknown', TUYỆT ĐỐI không $0.
 * - parallelShots: ghi nhận số lượng tool read-only chạy song song theo lô.
 */

import { create } from 'zustand';
import type { CategoryId } from '@/lib/routing/categories';
import type { Effort } from '@/lib/model-contracts';
import type { EvidenceLevel } from '@/lib/evidence';
import { calculateModelCost } from '@/lib/model-contracts';

export type LaneKind = 'main' | 'subagent' | 'unit' | 'orchestrator-cell';

export interface HudLane {
  laneId: string;
  kind: LaneKind;
  category: CategoryId;
  model: string;
  effort: Effort;
  turn: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokensIn?: number;
  costUsd: number | 'unknown';
  elapsedSec: number;
  evidence: EvidenceLevel;
  parallelShots?: number;
  updatedAt: number;
}

interface HudState {
  lanes: Record<string, HudLane>;
  activeLaneId: string | null;
  upsertLane: (lane: Partial<HudLane> & { laneId: string }) => void;
  updateTelemetry: (
    laneId: string,
    usage: { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number },
    elapsedSec?: number,
  ) => void;
  recordParallelShot: (laneId: string, shotCount: number) => void;
  updateEvidence: (laneId: string, evidence: EvidenceLevel) => void;
  incrementTurn: (laneId: string) => void;
  removeLane: (laneId: string) => void;
  clearLanes: () => void;
  setActiveLane: (laneId: string | null) => void;
}

export const useHudStore = create<HudState>((set, get) => ({
  lanes: {},
  activeLaneId: null,

  upsertLane: (input) => {
    set((state) => {
      const existing = state.lanes[input.laneId];
      const model = input.model ?? existing?.model ?? 'gpt-5-6-sol';
      const effort = input.effort ?? existing?.effort ?? 'medium';
      const category = input.category ?? existing?.category ?? 'capable';
      const kind = input.kind ?? existing?.kind ?? 'main';
      const turn = input.turn ?? existing?.turn ?? 0;
      const tokensIn = input.tokensIn ?? existing?.tokensIn ?? 0;
      const tokensOut = input.tokensOut ?? existing?.tokensOut ?? 0;
      const cachedTokensIn = input.cachedTokensIn ?? existing?.cachedTokensIn ?? 0;
      const elapsedSec = input.elapsedSec ?? existing?.elapsedSec ?? 0;
      const evidence = input.evidence ?? existing?.evidence ?? 'prepared';
      const parallelShots = input.parallelShots ?? existing?.parallelShots ?? 0;

      // Tính cost từ tokens
      const costUsd =
        input.costUsd !== undefined
          ? input.costUsd
          : calculateModelCost(model, {
              promptTokens: tokensIn,
              completionTokens: tokensOut,
              cachedPromptTokens: cachedTokensIn,
            });

      const updated: HudLane = {
        laneId: input.laneId,
        kind,
        category,
        model,
        effort,
        turn,
        tokensIn,
        tokensOut,
        cachedTokensIn,
        costUsd,
        elapsedSec,
        evidence,
        parallelShots,
        updatedAt: Date.now(),
      };

      return {
        lanes: { ...state.lanes, [input.laneId]: updated },
        activeLaneId: state.activeLaneId ?? input.laneId,
      };
    });
  },

  updateTelemetry: (laneId, usage, elapsedSec) => {
    set((state) => {
      const lane = state.lanes[laneId];
      if (!lane) return state;

      const pTokens = usage.promptTokens ?? 0;
      const cTokens = usage.completionTokens ?? 0;
      const cachedTokens = usage.cachedPromptTokens ?? 0;

      const tokensIn = lane.tokensIn + pTokens;
      const tokensOut = lane.tokensOut + cTokens;
      const cachedTokensIn = (lane.cachedTokensIn ?? 0) + cachedTokens;

      const costUsd = calculateModelCost(lane.model, {
        promptTokens: tokensIn,
        completionTokens: tokensOut,
        cachedPromptTokens: cachedTokensIn,
      });

      const updated: HudLane = {
        ...lane,
        tokensIn,
        tokensOut,
        cachedTokensIn,
        costUsd,
        elapsedSec: elapsedSec !== undefined ? elapsedSec : lane.elapsedSec,
        updatedAt: Date.now(),
      };

      return {
        lanes: { ...state.lanes, [laneId]: updated },
      };
    });
  },

  recordParallelShot: (laneId, shotCount) => {
    set((state) => {
      const lane = state.lanes[laneId];
      if (!lane) return state;
      return {
        lanes: {
          ...state.lanes,
          [laneId]: {
            ...lane,
            parallelShots: (lane.parallelShots ?? 0) + Math.max(1, shotCount),
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  updateEvidence: (laneId, evidence) => {
    set((state) => {
      const lane = state.lanes[laneId];
      if (!lane) return state;
      return {
        lanes: {
          ...state.lanes,
          [laneId]: { ...lane, evidence, updatedAt: Date.now() },
        },
      };
    });
  },

  incrementTurn: (laneId) => {
    set((state) => {
      const lane = state.lanes[laneId];
      if (!lane) return state;
      return {
        lanes: {
          ...state.lanes,
          [laneId]: { ...lane, turn: lane.turn + 1, updatedAt: Date.now() },
        },
      };
    });
  },

  removeLane: (laneId) => {
    set((state) => {
      const next = { ...state.lanes };
      delete next[laneId];
      const nextActive = state.activeLaneId === laneId ? Object.keys(next)[0] ?? null : state.activeLaneId;
      return { lanes: next, activeLaneId: nextActive };
    });
  },

  clearLanes: () => {
    set({ lanes: {}, activeLaneId: null });
  },

  setActiveLane: (laneId) => {
    set({ activeLaneId: laneId });
  },
}));
