/**
 * Play-by-Play Service
 * Fetches live play-by-play data directly from Ball Don't Lie API
 * 
 * Supported:
 * - US Sports (Play-by-Play): NBA, NFL, NHL, NCAAF, NCAAB
 * - Soccer (Match Events): EPL, La Liga, Serie A, Bundesliga, Ligue 1
 * 
 * NOT Supported:
 * - MLB (no play-by-play endpoint in Ball Don't Lie API)
 */

import axios from 'axios';
import { logger } from '../../config/logger';

const BALLDONTLIE_BASE_URL = 'https://api.balldontlie.io';

/**
 * Get API key from environment
 */
function getApiKey(): string {
  return process.env.BALLDONTLIE_API_KEY || '';
}

/**
 * Sports that support play-by-play (/plays endpoint)
 */
const PLAYS_SPORTS = ['nba', 'nfl', 'nhl', 'ncaaf', 'ncaab', 'wnba'];

/**
 * Soccer leagues that support match events (/match_events endpoint)
 */
const SOCCER_SPORTS = ['epl', 'laliga', 'seriea', 'bundesliga', 'ligue1'];

/**
 * Sport name mapping for API endpoints
 */
const SPORT_API_MAPPING: Record<string, string> = {
  nba: 'nba',
  nfl: 'nfl',
  nhl: 'nhl',
  ncaaf: 'ncaaf',
  ncaab: 'ncaab',
  wnba: 'wnba',
  cfb: 'ncaaf',
  cbb: 'ncaab',
  epl: 'epl',
  laliga: 'laliga',
  lal: 'laliga',
  seriea: 'seriea',
  ser: 'seriea',
  bundesliga: 'bundesliga',
  bund: 'bundesliga',
  ligue1: 'ligue1',
  lig: 'ligue1',
};

/**
 * Normalize sport name to API format
 */
function normalizeSport(sport: string): string | null {
  const normalized = sport.toLowerCase().trim();
  return SPORT_API_MAPPING[normalized] || null;
}

/**
 * Check if sport supports play-by-play
 */
export function supportsPlayByPlay(sport: string): boolean {
  const normalized = normalizeSport(sport);
  if (!normalized) return false;
  return PLAYS_SPORTS.includes(normalized) || SOCCER_SPORTS.includes(normalized);
}

/**
 * Get data type for a sport (plays or events)
 */
export function getPlayByPlayType(sport: string): 'plays' | 'events' | null {
  const normalized = normalizeSport(sport);
  if (!normalized) return null;
  if (PLAYS_SPORTS.includes(normalized)) return 'plays';
  if (SOCCER_SPORTS.includes(normalized)) return 'events';
  return null;
}

// ==================== Response Types ====================

/**
 * Normalized play object for US sports
 * Compatible with frontend PlayByPlayWidget expectations
 */
export interface NormalizedPlay {
  // Required by frontend
  id: string;  // Unique identifier for tracking (frontend uses this for deduplication)
  order: number;
  type: string;
  text: string;
  description?: string; // Alias for text (frontend checks description first)
  homeScore: number;
  awayScore: number;
  period: number;
  periodDisplay: string;
  clock: string;
  time?: string; // Alias for clock (frontend checks time as fallback)
  scoringPlay: boolean;
  // Team info - provide both formats for frontend compatibility
  team?: {
    id?: number;
    name?: string;
    abbreviation?: string;
  };
  // Also keep flat fields for backward compatibility
  teamId?: number;
  teamName?: string;
  teamAbbreviation?: string;
  coordinateX?: number | null;
  coordinateY?: number | null;
  timestamp?: string;
}

/**
 * Normalized event object for soccer
 */
export interface NormalizedEvent {
  id: number;
  eventType: string;
  eventTime: number | null;
  period: number | null;
  teamId?: number | null;
  teamName?: string;
  playerName?: string;
  secondaryPlayerName?: string;
  goalType?: string | null;
  cardType?: string | null;
  description?: string;
}

/**
 * Play-by-play response
 */
export interface PlayByPlayResponse {
  success: boolean;
  sport: string;
  gameId: number;
  dataType: 'plays' | 'events';
  data: NormalizedPlay[] | NormalizedEvent[];
  meta?: {
    totalPlays?: number;
    lastUpdated?: string;
  };
  error?: string;
}

// ==================== US Sports Play-by-Play ====================

/**
 * Fetch play-by-play for NBA game
 */
async function fetchNBAPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/nba/v1/plays`, {
    params: { game_id: gameId },
    headers: { Authorization: apiKey },
  });

  const plays = response.data?.data || [];
  
  return plays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `nba-${gameId}-${play.order || index}`,
    order: play.order || index,
    type: play.type || 'Unknown',
    text: play.text || '',
    description: play.text || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.period || 1,
    periodDisplay: play.period_display || `Q${play.period || 1}`,
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || false,
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name,
      abbreviation: play.team.abbreviation,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name,
    teamAbbreviation: play.team?.abbreviation,
    coordinateX: play.coordinate_x,
    coordinateY: play.coordinate_y,
    timestamp: play.wallclock,
  }));
}

/**
 * Fetch play-by-play for NFL game
 */
async function fetchNFLPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const allPlays: any[] = [];
  let cursor: number | undefined;
  
  // NFL uses pagination
  do {
    const response = await axios.get(`${BALLDONTLIE_BASE_URL}/nfl/v1/plays`, {
      params: { 
        game_id: gameId,
        per_page: 100,
        cursor,
      },
      headers: { Authorization: apiKey },
    });

    const plays = response.data?.data || [];
    allPlays.push(...plays);
    cursor = response.data?.meta?.next_cursor;
  } while (cursor);

  return allPlays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `nfl-${gameId}-${index}`,
    order: index + 1,
    type: play.type_abbreviation || play.type_slug || 'Unknown',
    text: play.description || play.text || '',
    description: play.description || play.text || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.quarter || play.period || 1,
    periodDisplay: play.quarter ? `Q${play.quarter}` : 'Q1',
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || (play.score_value && play.score_value > 0),
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name,
      abbreviation: play.team.abbreviation,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name,
    teamAbbreviation: play.team?.abbreviation,
    timestamp: play.wallclock,
  }));
}

/**
 * Fetch play-by-play for NHL game
 */
async function fetchNHLPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/nhl/v1/plays`, {
    params: { game_id: gameId },
    headers: { Authorization: apiKey },
  });

  const plays = response.data?.data || [];
  
  return plays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `nhl-${gameId}-${play.order || index}`,
    order: play.order || index,
    type: play.type || 'Unknown',
    text: play.text || play.description || '',
    description: play.text || play.description || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.period || 1,
    periodDisplay: play.period_display || `P${play.period || 1}`,
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || false,
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name,
      abbreviation: play.team.abbreviation || play.team.tricode,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name,
    teamAbbreviation: play.team?.abbreviation || play.team?.tricode,
    timestamp: play.wallclock,
  }));
}

/**
 * Fetch play-by-play for NCAAF game
 */
async function fetchNCAAFPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/ncaaf/v1/plays`, {
    params: { game_id: gameId },
    headers: { Authorization: apiKey },
  });

  const plays = response.data?.data || [];
  
  return plays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `ncaaf-${gameId}-${play.order || index}`,
    order: play.order || index + 1,
    type: play.type || 'Unknown',
    text: play.text || play.description || '',
    description: play.text || play.description || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.period || play.quarter || 1,
    periodDisplay: play.period_display || `Q${play.period || play.quarter || 1}`,
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || false,
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name || play.team.school,
      abbreviation: play.team.abbreviation,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name || play.team?.school,
    teamAbbreviation: play.team?.abbreviation,
    timestamp: play.wallclock,
  }));
}

/**
 * Fetch play-by-play for NCAAB game
 */
async function fetchNCAABPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/ncaab/v1/plays`, {
    params: { game_id: gameId },
    headers: { Authorization: apiKey },
  });

  const plays = response.data?.data || [];
  
  return plays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `ncaab-${gameId}-${play.order || index}`,
    order: play.order || index + 1,
    type: play.type || 'Unknown',
    text: play.text || play.description || '',
    description: play.text || play.description || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.period || 1,
    periodDisplay: play.period_display || `H${play.period || 1}`,
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || false,
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name || play.team.school,
      abbreviation: play.team.abbreviation,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name || play.team?.school,
    teamAbbreviation: play.team?.abbreviation,
    timestamp: play.wallclock,
  }));
}

/**
 * Fetch play-by-play for WNBA game
 */
async function fetchWNBAPlays(gameId: number): Promise<NormalizedPlay[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/wnba/v1/plays`, {
    params: { game_id: gameId },
    headers: { Authorization: apiKey },
  });

  const plays = response.data?.data || [];
  
  return plays.map((play: any, index: number) => ({
    // Generate unique ID for frontend tracking
    id: `wnba-${gameId}-${play.order || index}`,
    order: play.order || index,
    type: play.type || 'Unknown',
    text: play.text || '',
    description: play.text || '', // Alias for frontend
    homeScore: play.home_score || 0,
    awayScore: play.away_score || 0,
    period: play.period || 1,
    periodDisplay: play.period_display || `Q${play.period || 1}`,
    clock: play.clock || '',
    time: play.clock || '', // Alias for frontend
    scoringPlay: play.scoring_play || false,
    // Team object for frontend compatibility
    team: play.team ? {
      id: play.team.id,
      name: play.team.full_name || play.team.name,
      abbreviation: play.team.abbreviation,
    } : undefined,
    // Keep flat fields for backward compatibility
    teamId: play.team?.id,
    teamName: play.team?.full_name || play.team?.name,
    teamAbbreviation: play.team?.abbreviation,
    timestamp: play.wallclock,
  }));
}

// ==================== Soccer Match Events ====================

/**
 * Fetch EPL goals using the /games/{id}/goals endpoint
 * EPL uses a different API structure than other soccer leagues
 */
async function fetchEPLGoals(matchId: number): Promise<NormalizedEvent[]> {
  const apiKey = getApiKey();
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/epl/v1/games/${matchId}/goals`, {
    headers: { Authorization: apiKey },
  });

  const goals = response.data?.data || [];
  
  return goals.map((goal: any, index: number) => {
    const scorerName = goal.scorer 
      ? `${goal.scorer.first_name || ''} ${goal.scorer.last_name || ''}`.trim()
      : 'Unknown';
    const assisterName = goal.assister
      ? `${goal.assister.first_name || ''} ${goal.assister.last_name || ''}`.trim()
      : undefined;
    
    // Determine period from phase (FirstHalf = 1, SecondHalf = 2)
    const period = goal.phase === 'FirstHalf' ? 1 : 2;
    
    // Build description
    const assistText = assisterName ? ` - Assist: ${assisterName}` : '';
    const goalTypeText = goal.type === 'OwnGoal' ? ' (own goal)' : 
                         goal.type === 'Penalty' ? ' (pen)' : '';
    const description = `${goal.clock_display || goal.clock + "'"} ⚽ GOAL! ${scorerName}${goalTypeText}${assistText}`;
    
    return {
      id: goal.game_id * 1000 + index, // Generate unique ID
      eventType: goal.type?.toLowerCase() === 'owngoal' ? 'own_goal' : 
                 goal.type?.toLowerCase() === 'penalty' ? 'penalty' : 'goal',
      eventTime: goal.clock,
      period,
      teamId: undefined, // EPL goals don't include team_id directly
      playerName: scorerName,
      secondaryPlayerName: assisterName,
      goalType: goal.type,
      cardType: null,
      description,
    };
  });
}

/**
 * Fetch match events for other soccer leagues (La Liga, Serie A, Bundesliga, Ligue 1)
 * Uses /match_events endpoint
 */
async function fetchOtherSoccerEvents(sport: string, matchId: number): Promise<NormalizedEvent[]> {
  const apiKey = getApiKey();
  const apiSport = normalizeSport(sport);
  
  const response = await axios.get(`${BALLDONTLIE_BASE_URL}/${apiSport}/v1/match_events`, {
    params: { match_ids: [matchId] },
    headers: { Authorization: apiKey },
  });

  const events = response.data?.data || [];
  
  return events.map((event: any) => ({
    id: event.id,
    eventType: event.event_type || 'unknown',
    eventTime: event.event_time,
    period: event.period,
    teamId: event.team_id,
    playerName: event.player 
      ? `${event.player.first_name || ''} ${event.player.last_name || ''}`.trim()
      : undefined,
    secondaryPlayerName: event.secondary_player
      ? `${event.secondary_player.first_name || ''} ${event.secondary_player.last_name || ''}`.trim()
      : undefined,
    goalType: event.goal_type,
    cardType: event.card_type,
    description: formatSoccerEventDescription(event),
  }));
}

/**
 * Fetch match events for soccer game
 * Works for: EPL, La Liga, Serie A, Bundesliga, Ligue 1
 * Note: EPL uses a different endpoint (/games/{id}/goals) than other leagues (/match_events)
 */
async function fetchSoccerEvents(sport: string, matchId: number): Promise<NormalizedEvent[]> {
  const apiSport = normalizeSport(sport);
  
  // EPL uses a different API structure - only has /goals endpoint
  if (apiSport === 'epl') {
    return fetchEPLGoals(matchId);
  }
  
  // Other soccer leagues use /match_events
  return fetchOtherSoccerEvents(sport, matchId);
}

/**
 * Format a soccer event into a human-readable description
 */
function formatSoccerEventDescription(event: any): string {
  const playerName = event.player 
    ? `${event.player.first_name || ''} ${event.player.last_name || ''}`.trim()
    : 'Unknown';
  
  const time = event.event_time ? `${event.event_time}'` : '';
  
  switch (event.event_type) {
    case 'goal':
      const goalType = event.goal_type ? ` (${event.goal_type})` : '';
      const assist = event.secondary_player 
        ? ` - Assist: ${event.secondary_player.first_name} ${event.secondary_player.last_name}`
        : '';
      return `${time} ⚽ GOAL! ${playerName}${goalType}${assist}`;
    
    case 'yellow_card':
      return `${time} 🟨 Yellow Card - ${playerName}`;
    
    case 'red_card':
      return `${time} 🟥 Red Card - ${playerName}`;
    
    case 'second_yellow':
      return `${time} 🟨🟥 Second Yellow (Red) - ${playerName}`;
    
    case 'substitution':
      const subIn = event.secondary_player 
        ? `${event.secondary_player.first_name} ${event.secondary_player.last_name}`
        : 'Unknown';
      return `${time} 🔄 Substitution - ${subIn} ON, ${playerName} OFF`;
    
    case 'penalty':
      return `${time} ⚽ Penalty - ${playerName}`;
    
    case 'own_goal':
      return `${time} ⚽ Own Goal - ${playerName}`;
    
    case 'penalty_missed':
      return `${time} ❌ Penalty Missed - ${playerName}`;
    
    default:
      return `${time} ${event.event_type} - ${playerName}`;
  }
}

// ==================== Main Entry Point ====================

/**
 * Get play-by-play data for a game
 * @param sport - Sport name (nba, nfl, nhl, ncaaf, ncaab, epl, laliga, seriea, bundesliga, ligue1)
 * @param gameId - Ball Don't Lie game/match ID
 * @returns Normalized play-by-play data
 */
export async function getPlayByPlay(sport: string, gameId: number): Promise<PlayByPlayResponse> {
  const normalizedSport = normalizeSport(sport);
  
  if (!normalizedSport) {
    return {
      success: false,
      sport: sport,
      gameId,
      dataType: 'plays',
      data: [],
      error: `Unknown sport: ${sport}`,
    };
  }

  const dataType = getPlayByPlayType(sport);
  
  if (!dataType) {
    return {
      success: false,
      sport: normalizedSport,
      gameId,
      dataType: 'plays',
      data: [],
      error: `Sport ${sport} does not support play-by-play data. MLB is not supported.`,
    };
  }

  try {
    logger.info({
      message: 'Fetching play-by-play data',
      sport: normalizedSport,
      gameId,
      dataType,
    });

    let data: NormalizedPlay[] | NormalizedEvent[];

    if (dataType === 'plays') {
      // US Sports
      switch (normalizedSport) {
        case 'nba':
          data = await fetchNBAPlays(gameId);
          break;
        case 'nfl':
          data = await fetchNFLPlays(gameId);
          break;
        case 'nhl':
          data = await fetchNHLPlays(gameId);
          break;
        case 'ncaaf':
          data = await fetchNCAAFPlays(gameId);
          break;
        case 'ncaab':
          data = await fetchNCAABPlays(gameId);
          break;
        case 'wnba':
          data = await fetchWNBAPlays(gameId);
          break;
        default:
          throw new Error(`Unsupported plays sport: ${normalizedSport}`);
      }
    } else {
      // Soccer
      data = await fetchSoccerEvents(normalizedSport, gameId);
    }

    logger.info({
      message: 'Play-by-play data fetched successfully',
      sport: normalizedSport,
      gameId,
      dataType,
      count: data.length,
    });

    return {
      success: true,
      sport: normalizedSport,
      gameId,
      dataType,
      data,
      meta: {
        totalPlays: data.length,
        lastUpdated: new Date().toISOString(),
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const statusCode = axios.isAxiosError(error) ? error.response?.status : undefined;

    logger.error({
      message: 'Error fetching play-by-play data',
      sport: normalizedSport,
      gameId,
      error: errorMessage,
      statusCode,
    });

    // Handle specific error cases
    if (statusCode === 404) {
      return {
        success: true,
        sport: normalizedSport,
        gameId,
        dataType,
        data: [],
        meta: {
          totalPlays: 0,
          lastUpdated: new Date().toISOString(),
        },
      };
    }

    return {
      success: false,
      sport: normalizedSport,
      gameId,
      dataType,
      data: [],
      error: errorMessage,
    };
  }
}

/**
 * Get supported sports for play-by-play
 */
export function getSupportedSports(): { plays: string[]; events: string[]; unsupported: string[] } {
  return {
    plays: [...PLAYS_SPORTS],
    events: [...SOCCER_SPORTS],
    unsupported: ['mlb'],
  };
}
