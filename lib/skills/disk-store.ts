/**
 * Store client cho disk skills (P0-3): kết quả quét .vyen/skills + ~/.vyen/skills.
 * Nằm ngoài component để submitTurn / handleClientToolCall đọc qua getState()
 * (không stale closure, không mutate ref trong callback — rule immutability).
 */

import { create } from 'zustand';
import type { DiskSkillEntry } from '@/lib/skills/disk';

interface DiskSkillsState {
  entries: DiskSkillEntry[];
  setEntries: (entries: DiskSkillEntry[]) => void;
}

export const useDiskSkillsStore = create<DiskSkillsState>()((set) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
}));
