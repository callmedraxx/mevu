/**
 * Live Stats Types
 * Types for the live stats widget endpoint
 */

import { FrontendTeam } from './frontend-game.transformer';

/**
 * Period scores structure
 * Keys are normalized period identifiers (q1, q2, q3, q4, p1, p2, p3, 1h, 2h, ot)
 */
export interface PeriodScores {
  [periodKey: string]: {
    home: number;
    away: number;
  };
}

/**
 * Final score structure
 */
export interface FinalScore {
  home: number;
  away: number;
}

/**
 * Live stats response structure
 */
export interface LiveStats {
  homeTeam: FrontendTeam;
  awayTeam: FrontendTeam;
  periodScores: PeriodScores | null; // null for NS (not started) games
  finalScore: FinalScore | null; // null for NS (not started) games
  currentPeriod: string;
  isLive: boolean;
}
