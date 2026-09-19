/**
 * Zero-Mem Temporal Hierarchy & Recency Scorer.
 *
 * Implements deterministic temporal recency decay and episodic continuity weighting:
 * - Exponential decay based on elapsed time: w(t) = exp(-ln(2) * (t_now - t) / T_half)
 * - Turn distance discount
 * - Active episode continuity boost: +25% bonus for evidence belonging to the current task episode
 */

import type { ZeroMemEpisode, ZeroMemTrace } from './types';

export const DEFAULT_DECAY_HALF_LIFE_MS = 3_600_000; // 1 hour
export const EPISODE_CONTINUITY_BOOST = 1.25;

export interface TemporalScoreOptions {
  now?: number;
  decayHalfLifeMs?: number;
  currentEpisodeId?: string;
}

export class TemporalHierarchy {
  private episodes: Map<string, ZeroMemEpisode> = new Map();

  registerEpisode(episode: ZeroMemEpisode): void {
    this.episodes.set(episode.id, { ...episode });
  }

  getEpisode(id: string): ZeroMemEpisode | undefined {
    return this.episodes.get(id);
  }

  getAllEpisodes(): ZeroMemEpisode[] {
    return Array.from(this.episodes.values());
  }

  /**
   * Calculate temporal recency score for an event/trace timestamp.
   * Returns a normalized score in [0.0, 1.25].
   */
  computeTemporalScore(
    timestamp: number,
    traceEpisodeId?: string,
    options: TemporalScoreOptions = {},
  ): number {
    const now = options.now ?? Date.now();
    const halfLife = options.decayHalfLifeMs ?? DEFAULT_DECAY_HALF_LIFE_MS;

    const elapsed = Math.max(0, now - timestamp);
    // Exponential half-life decay formula:
    // score = 2 ^ (-elapsed / halfLife) = exp(-ln(2) * elapsed / halfLife)
    const decayScore = Math.pow(0.5, elapsed / halfLife);

    // Apply episodic continuity boost if matching current active episode
    if (options.currentEpisodeId && traceEpisodeId === options.currentEpisodeId) {
      return Math.min(1.25, decayScore * EPISODE_CONTINUITY_BOOST);
    }

    return decayScore;
  }

  /**
   * Sort traces chronologically by timestamp and turnIndex.
   */
  sortTraces(traces: ZeroMemTrace[]): ZeroMemTrace[] {
    return [...traces].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp - b.timestamp;
      }
      return a.turnIndex - b.turnIndex;
    });
  }

  clear(): void {
    this.episodes.clear();
  }
}
