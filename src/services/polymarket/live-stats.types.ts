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
 * Player stat structure
 */
export interface PlayerStat {
  player_id: number;
  player_first_name: string;
  player_last_name: string;
  player_position: string | null;
  team_id: number | null;
  team_abbreviation: string | null;
  team_name: string | null;
  is_home: boolean;
  min: string | null;
  fgm: number | null;
  fga: number | null;
  fg_pct: number | null;
  fg3m: number | null;
  fg3a: number | null;
  fg3_pct: number | null;
  ftm: number | null;
  fta: number | null;
  ft_pct: number | null;
  oreb: number | null;
  dreb: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnover: number | null;
  pf: number | null;
  pts: number | null;
  sport: string | null;
  sport_stats: any; // JSONB - sport-specific stats
  stats_updated_at: Date;
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
  playerStats?: PlayerStat[]; // Optional player stats
}
