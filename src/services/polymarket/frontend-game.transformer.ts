/**
 * Frontend Game Transformer
 * Transforms LiveGame data into the frontend-friendly Game interface
 */

import { LiveGame } from './live-games.service';
import { Team } from './teams.service';
import { logger } from '../../config/logger';
import { getFighterRecord, getFighterDisplayName, prefetchFighterRecords } from '../ufc/ufc-fighter-records.service';
import { calculateProbabilityChange, getProbabilityFromHoursAgo } from './probability-history.service';

/**
 * Frontend Team interface
 */
export interface FrontendTeam {
  abbr: string;            // "WAS"
  name: string;            // "Wizards"
  record: string;          // "3-18"
  probability: number;     // 65.5 (% chance to win, YES outcome)
  buyPrice: number;        // 66 (cents, YES price rounded up)
  sellPrice: number;       // 35 (cents, NO price rounded up)
  score?: number;          // 87 (live games only)
  tennisScore?: string;    // Raw tennis score: "6-4, 2-6, 1-1"
  setsWon?: number;        // Number of sets won (0, 1, 2, 3) - for tennis
  quarterScores?: { q1: number; q2: number; q3: number; q4: number; };
}

/**
 * Frontend Game interface
 */
export interface FrontendGame {
  id: string;
  endDate: string;           // ISO 8601 date string for sorting "2025-12-09T19:00:00Z"
  time: string;              // "7:00 PM EST" (formatted for display)
  volume: string;            // "$612.4k"
  awayTeam: FrontendTeam;
  homeTeam: FrontendTeam;
  liquidity: string;         // "$2.50M"
  chartData: number[];       // [50, 52, 48, ...] for mini sparkline (home team probability history)
  percentChange: number;     // 3.4 or -2.9 (change in home team probability over 24h)
  traders: number;           // 207
  spread: string;            // "1-2¢"
  isLive?: boolean;          // true for in-progress games
  ended?: boolean;           // true for ended/closed games
  quarter?: string;          // "3Q"
  gameTime?: string;         // "5:45" (time remaining)
  sport?: string;            // "nba", "nfl", etc.
  league?: string;           // league identifier
  slug?: string;             // URL slug
  tennisScore?: string;      // Raw tennis score at game level: "6-4, 2-6, 1-1"
}

/**
 * Format number as currency string
 */
function formatVolume(value: number | undefined | null): string {
  if (value === undefined || value === null) return '$0';
  
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  } else if (value >= 1000) {
    return `$${(value / 1000).toFixed(1)}k`;
  }
  return `$${value.toFixed(0)}`;
}

/**
 * Format liquidity as currency string
 */
function formatLiquidity(value: number | undefined | null): string {
  return formatVolume(value);
}

/**
 * Parse score string (e.g., "0-2") into individual scores
 * Polymarket format: "away-home" (first number is AWAY team score, second is HOME team score)
 */
function parseScore(scoreStr: string | undefined): { home?: number; away?: number } {
  if (!scoreStr) return {};
  
  const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    // Format is away-home: first number is away, second is home
    return { away: parts[0], home: parts[1] };
  }
  return {};
}

/**
 * Parse tennis score format
 * Examples:
 * - "6-7(5-7), 1-2" -> Set 1: 6-7 (tiebreak 5-7), Set 2: 1-2 (current)
 * - "6-4, 2-5" -> Set 1: 6-4 (player 1 won), Set 2: 2-5 (current)
 * - "6-4, 6-3" -> Set 1: 6-4, Set 2: 6-3 (match complete)
 *
 * Returns current set score + sets won count + raw score string
 */
function parseTennisScore(scoreStr: string): { 
  home: number; 
  away: number; 
  setsWon: { home: number; away: number }; 
  rawScore: string 
} | null {
  if (!scoreStr) return null;

  // Split by comma to get individual sets
  const sets = scoreStr.split(',').map(s => s.trim());

  let homeSetsWon = 0;
  let awaySetsWon = 0;
  let currentSetHome = 0;
  let currentSetAway = 0;

  for (let i = 0; i < sets.length; i++) {
    const setScore = sets[i];

    // Remove tiebreak notation (e.g., "6-7(5-7)" -> "6-7")
    const cleanScore = setScore.replace(/\([^)]+\)/, '').trim();

    // Parse the set score
    const parts = cleanScore.split('-').map(s => parseInt(s.trim(), 10));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) continue;

    const [awayGames, homeGames] = parts;

    // If this is the last set, it's the current set score
    if (i === sets.length - 1) {
      currentSetAway = awayGames;
      currentSetHome = homeGames;
    }

    // Check if this set is complete (one player reached 6+ games with 2 game lead, or 7 in tiebreak)
    const isSetComplete =
      (awayGames >= 6 && awayGames - homeGames >= 2) ||
      (homeGames >= 6 && homeGames - awayGames >= 2) ||
      awayGames === 7 || homeGames === 7;

    if (isSetComplete || i < sets.length - 1) {
      // Completed set - count who won
      if (awayGames > homeGames) {
        awaySetsWon++;
      } else if (homeGames > awayGames) {
        homeSetsWon++;
      }
    }
  }

  return {
    away: currentSetAway,
    home: currentSetHome,
    setsWon: { home: homeSetsWon, away: awaySetsWon },
    rawScore: scoreStr,
  };
}

/**
 * Check if a game is a tennis game based on sport/league
 */
function isTennisGame(game: LiveGame): boolean {
  const sport = (game.sport || '').toLowerCase();
  const league = (game.league || '').toLowerCase();
  return sport === 'tennis' || sport === 'atp' || sport === 'wta' ||
         league === 'tennis' || league === 'atp' || league === 'wta';
}

/**
 * Format time from date string
 */
function formatGameTime(dateStr: string | undefined): string {
  if (!dateStr) return 'TBD';
  
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'TBD';
    
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
  } catch {
    return 'TBD';
  }
}

/**
 * Format elapsed time for display
 * Handles various formats: "7" (minutes), "0:42" (minutes:seconds), "15:50" (minutes:seconds)
 * Returns consistent "M:SS" or "MM:SS" format
 */
function formatElapsedTime(elapsed: string | undefined): string | undefined {
  if (!elapsed) return undefined;
  
  // If it already has a colon, assume it's in MM:SS format
  if (elapsed.includes(':')) {
    const parts = elapsed.split(':');
    if (parts.length === 2) {
      const minutes = parseInt(parts[0], 10);
      const seconds = parseInt(parts[1], 10);
      if (!isNaN(minutes) && !isNaN(seconds)) {
        // Format as M:SS or MM:SS
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
      }
    }
    // If parsing fails, return as-is
    return elapsed;
  }
  
  // If it's just a number, assume it's minutes elapsed in the period
  const numValue = parseInt(elapsed, 10);
  if (!isNaN(numValue)) {
    // Format as M:00 or MM:00
    return `${numValue}:00`;
  }
  
  // If we can't parse it, return as-is
  return elapsed;
}

/**
 * Format period/quarter for display
 */
function formatQuarter(period: string | undefined): string | undefined {
  if (!period) return undefined;
  
  const periodLower = period.toLowerCase();
  
  // Handle common formats
  if (periodLower === 'q1' || periodLower === '1q' || periodLower === '1st') return '1Q';
  if (periodLower === 'q2' || periodLower === '2q' || periodLower === '2nd') return '2Q';
  if (periodLower === 'q3' || periodLower === '3q' || periodLower === '3rd') return '3Q';
  if (periodLower === 'q4' || periodLower === '4q' || periodLower === '4th') return '4Q';
  
  // Handle NHL periods (P1, P2, P3)
  if (periodLower === 'p1' || periodLower === '1p' || periodLower === 'period 1') return 'P1';
  if (periodLower === 'p2' || periodLower === '2p' || periodLower === 'period 2') return 'P2';
  if (periodLower === 'p3' || periodLower === '3p' || periodLower === 'period 3') return 'P3';
  
  // Handle overtime
  if (periodLower === 'ot' || periodLower === 'overtime') return 'OT';
  
  // Handle halftime
  if (periodLower === 'ht' || periodLower === 'halftime' || periodLower === 'half') return 'HT';
  
  // Handle halves
  if (periodLower === '1h' || periodLower === '1st half') return '1H';
  if (periodLower === '2h' || periodLower === '2nd half') return '2H';
  
  return period.toUpperCase();
}

/**
 * Clean tennis team names by removing tournament prefixes like "Australian Open Men's", "American Open Women's", etc.
 */
function cleanTennisTeamName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  
  let cleaned = name.trim();
  
  // Remove tournament prefixes (case-insensitive, with optional apostrophe variations)
  // Pattern: [Tournament Name] [Men's/Women's]: [Player Name]
  const tournamentPrefixes = [
    /^Australian\s+Open\s+Men'?s?\s*:\s*/i,
    /^Australian\s+Open\s+Women'?s?\s*:\s*/i,
    /^American\s+Open\s+Men'?s?\s*:\s*/i,
    /^American\s+Open\s+Women'?s?\s*:\s*/i,
    /^US\s+Open\s+Men'?s?\s*:\s*/i,
    /^US\s+Open\s+Women'?s?\s*:\s*/i,
    /^French\s+Open\s+Men'?s?\s*:\s*/i,
    /^French\s+Open\s+Women'?s?\s*:\s*/i,
    /^Wimbledon\s+Men'?s?\s*:\s*/i,
    /^Wimbledon\s+Women'?s?\s*:\s*/i,
    // Generic patterns
    /^[A-Z][a-z]+\s+Open\s+Men'?s?\s*:\s*/i,
    /^[A-Z][a-z]+\s+Open\s+Women'?s?\s*:\s*/i,
  ];
  
  for (const pattern of tournamentPrefixes) {
    cleaned = cleaned.replace(pattern, '').trim();
  }
  
  return cleaned || undefined;
}

/**
 * Extract team info from title (e.g., "Warriors vs Lakers" or "WAS @ PHX")
 */
function extractTeamsFromTitle(title: string): { home?: string; away?: string } {
  if (!title) return {};

  // Normalize common noise in titles before extracting team/fighter names.
  let working = title.trim();

  // 1) Drop trailing parenthetical details:
  //    "Finney vs. Malkoun (Middleweight, Prelims)" -> "Finney vs. Malkoun"
  working = working.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // 2) Drop leading competition / event prefixes before the first colon:
  //    "UFC 325: Finney vs. Malkoun" -> "Finney vs. Malkoun"
  //    "NFL Week 5: Bills @ Chiefs"  -> "Bills @ Chiefs"
  const colonIndex = working.indexOf(':');
  if (colonIndex !== -1) {
    const afterColon = working.slice(colonIndex + 1).trim();
    if (afterColon.length > 0) {
      working = afterColon;
    }
  }

  // Try "Team1 vs Team2" or "Team1 @ Team2" format
  // Format: "Away vs Home" or "Away @ Home" -> team1 is away, team2 is home
  const vsMatch = working.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+)$/i);
  if (vsMatch) {
    // For "vs" format: "Away vs Home" -> team1 is away, team2 is home
    // For "@" format: "Away @ Home" -> team1 is away, team2 is home
    return { away: vsMatch[1].trim(), home: vsMatch[2].trim() };
  }
  
  return {};
}

/**
 * Extract full participant names (e.g., "First Last") from an event or market
 * description. Intended for UFC and Tennis where the title may only contain
 * surnames or include tournament prefixes, but the description includes full names.
 *
 * Examples:
 *   UFC: "Torrez Finney vs. Jacob Malkoun in a middleweight bout at UFC 325..."
 *        -> { away: "Torrez Finney", home: "Jacob Malkoun" }
 *   Tennis: "Lorenzo Musetti vs. Novak Djokovic in the Australian Open..."
 *           -> { away: "Lorenzo Musetti", home: "Novak Djokovic" }
 */
function extractFullNamesFromDescription(desc?: string | null): { away?: string; home?: string } {
  if (!desc) return {};

  // Look only at the first sentence/line to reduce noise.
  let working = String(desc).split(/[\n\.]/)[0] || '';
  working = working.trim();
  if (!working) return {};

  // Drop leading prefixes before the first colon, e.g. "UFC 325: Alexander Volkanovski vs ..."
  const colonIndex = working.indexOf(':');
  if (colonIndex !== -1) {
    const after = working.slice(colonIndex + 1).trim();
    if (after) {
      working = after;
    }
  }

  // Regex: "Name1 vs Name2" or "Name1 vs. Name2"
  // Name is at least two capitalized words (to avoid matching stray single words).
  const namePart = '([A-Z][A-Za-zÀ-ÖØ-öø-ÿ\'’\\-]+(?:\\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ\'’\\-]+)+)';
  const re = new RegExp(`${namePart}\\s+vs\\.?\\s+${namePart}`, 'i');
  const match = working.match(re);
  if (match) {
    const away = match[1].trim();
    const home = match[2].trim();
    return { away, home };
  }

  return {};
}

/**
 * Extract team abbreviations from slug (format: sport-away-home-date)
 * Returns { away: 'SEA', home: 'UTA' } for slug like 'nhl-sea-utah-2025-12-13'
 * 
 * @param slug - The game slug
 * @param gameSport - The actual sport of the game (e.g., 'cbb', 'nfl') - used to avoid skipping team abbreviations that happen to match sport identifiers
 */
function extractAbbrevsFromSlug(slug: string | undefined, gameSport?: string): { away?: string; home?: string } {
  if (!slug) return {};
  
  const slugParts = slug.split('-');
  const teamAbbrevs: string[] = [];
  
  // Common sport identifiers
  const sportIdentifiers = new Set([
    'nhl',
    'nba',
    'nfl',
    'mlb',
    'epl',
    'cbb',
    'cfb',
    'lal',
    'ser',
    'bund',
    'lig1',
    'mls',
    'ufc',
    'tennis',
    'atp',
    'wta',
  ]);

  const firstPartLower = slugParts[0]?.toLowerCase() || '';

  // UFC-specific handling: slugs look like "ufc-ale14-die4-2026-01-31"
  // The middle tokens (e.g. "ale14", "die4") are the fighter abbreviations we want.
  if (firstPartLower === 'ufc') {
    const fighterCodes = slugParts
      .slice(1)
      // Drop pure date segments (YYYY, MM, DD)
      .filter((part) => !/^\d{4}$/.test(part) && !/^\d{2}$/.test(part));
    
    if (fighterCodes.length >= 2) {
      return {
        away: fighterCodes[0].toUpperCase(),
        home: fighterCodes[1].toUpperCase(),
      };
    }
  }
  
  for (let i = 0; i < slugParts.length; i++) {
    const part = slugParts[i];
    const partLower = part.toLowerCase();
    
    // Skip numbers (dates)
    if (/^\d+$/.test(part)) continue;
    
    // Always skip the first part if it's a sport identifier (that's the actual sport in the slug)
    if (i === 0 && sportIdentifiers.has(partLower)) {
      continue;
    }
    
    // For other positions: only skip if it matches the game's actual sport
    // This prevents skipping team abbreviations that happen to match sport identifiers
    // (e.g., "nfl" in "cbb-colmb-nfl-2025-12-28" is "North Florida", not "National Football League")
    if (i > 0 && gameSport && partLower === gameSport.toLowerCase() && sportIdentifiers.has(partLower)) {
      continue;
    }
    
    // Match team abbreviations (2-10 letters to handle longer team names like HARVRD, BALLST)
    if (part.length >= 2 && part.length <= 10 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }
  
  if (teamAbbrevs.length >= 2) {
    // Slug format: sport-away-home-date, so first team is away, second is home
    logger.debug({
      message: 'Extracted team abbreviations from slug',
      slug,
      gameSport,
      away: teamAbbrevs[0],
      home: teamAbbrevs[1],
    });
    return { away: teamAbbrevs[0], home: teamAbbrevs[1] };
  }
  
  if (teamAbbrevs.length > 0) {
    // logger.warn({
    //   message: 'Insufficient team abbreviations extracted from slug',
    //   slug,
    //   gameSport,
    //   extracted: teamAbbrevs,
    // });
  }
  
  return {};
}

/**
 * Team outcome with win probability
 */
interface TeamOutcome {
  label: string;
  price: number;  // Probability (e.g., 50.50 = 50.50% chance to win)
  buyPrice?: number;  // Best ask price for buying (from CLOB best_ask)
  sellPrice?: number; // Best bid price for selling (from CLOB best_bid)
}

/**
 * Find the moneyline market (team vs team) from markets
 * The moneyline market has structuredOutcomes with team names, not Over/Under
 */
function findMoneylineMarket(game: LiveGame): { home: TeamOutcome | null; away: TeamOutcome | null } {
  // Use game.markets; fall back to rawData.markets when game.markets is empty (for all sports)
  const markets = game.markets && game.markets.length > 0
    ? game.markets
    : ((game.rawData as any)?.markets?.length > 0
      ? (game.rawData as any).markets
      : []);
  if (markets.length === 0) {
    return { home: null, away: null };
  }

  // Get team identifiers to match - try multiple sources
  let homeTeamName = game.homeTeam?.name?.toLowerCase() || game.teamIdentifiers?.home?.toLowerCase() || '';
  let awayTeamName = game.awayTeam?.name?.toLowerCase() || game.teamIdentifiers?.away?.toLowerCase() || '';
  let homeAbbr = game.homeTeam?.abbreviation?.toLowerCase() || '';
  let awayAbbr = game.awayTeam?.abbreviation?.toLowerCase() || '';

  // UFC: normalize "UFC Fight Night: Fighter Name" -> "Fighter Name" for matching market labels
  const stripUfcPrefix = (s: string) => s.replace(/^ufc[^:]*:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (homeTeamName) homeTeamName = stripUfcPrefix(homeTeamName);
  if (awayTeamName) awayTeamName = stripUfcPrefix(awayTeamName);
  
  // Fallback: Extract team names from title if teams aren't enriched
  if (!homeTeamName && !awayTeamName && game.title) {
    const title = game.title;
    // Try common separators: "vs", "vs.", "@", "at"
    const separators = [' vs. ', ' vs ', ' @ ', ' at '];
    for (const sep of separators) {
      const parts = title.split(sep);
      if (parts.length === 2) {
        awayTeamName = stripUfcPrefix(parts[0].trim().toLowerCase());
        homeTeamName = stripUfcPrefix(parts[1].trim().toLowerCase());
        break;
      }
    }
  }
  
  // Fallback: Extract from slug if available (format: sport-away-home-date)
  if (!homeTeamName && !awayTeamName && game.slug) {
    const slugParts = game.slug.split('-');
    // Skip sport identifier and date, get team abbreviations
    const sportIdentifiers = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'cbb', 'cfb', 'lal', 'ser', 'bund', 'lig1', 'mls', 'ufc']);
    const teamParts: string[] = [];
    for (let i = 1; i < slugParts.length; i++) {
      const part = slugParts[i];
      // Skip if it's a date (YYYY-MM-DD pattern) or sport identifier
      if (/^\d{4}-\d{2}-\d{2}/.test(part) || sportIdentifiers.has(part.toLowerCase())) {
        continue;
      }
      if (part.length >= 2 && part.length <= 10) {
        teamParts.push(part.toLowerCase());
      }
    }
    if (teamParts.length >= 2) {
      awayAbbr = teamParts[0];
      homeAbbr = teamParts[1];
    }
  }

  // UFC: resolve abbreviations to full names from Ball Don't Lie for better market label matching
  // Market labels are often last names (e.g. "Kuniev", "Almeida") while Polymarket may only have "RIZ", "JAI3"
  const isUfc = (game.sport && game.sport.toLowerCase() === 'ufc') || (game.league && game.league.toLowerCase() === 'ufc');
  if (isUfc) {
    if (homeAbbr) {
      const resolved = getFighterDisplayName(homeAbbr);
      if (resolved) homeTeamName = homeTeamName || resolved.toLowerCase();
    }
    if (awayAbbr) {
      const resolved = getFighterDisplayName(awayAbbr);
      if (resolved) awayTeamName = awayTeamName || resolved.toLowerCase();
    }
    if (homeTeamName) homeTeamName = stripUfcPrefix(homeTeamName);
    if (awayTeamName) awayTeamName = stripUfcPrefix(awayTeamName);
  }
  
  // SOCCER/FOOTBALL: First try to find individual "Will X win?" markets
  // These are Yes/No markets where each team has their own market
  // This handles 3-way outcomes (home win, draw, away win) correctly
  let homeWinMarket: { price: number } | null = null;
  let awayWinMarket: { price: number } | null = null;
  
  for (const market of markets) {
    const question = (market.question || '').toLowerCase();

    // Exclude prop markets: "Will X win by KO/TKO/submission?" - only match main "Will X win?"
    if (question.includes('win by') || question.includes(' by ko') || question.includes(' by tko') || question.includes('by submission')) continue;

    // Check if this is a "Will X win?" market (main match outcome, not props)
    if (question.includes('will') && question.includes('win')) {
      // Prefer raw outcomePrices as they're more reliable
      let yesPrice: number | null = null; // Use null to indicate "not found"
      
      if (market.outcomes && market.outcomePrices) {
        const rawOutcomes = market.outcomes as string[];
        const rawPrices = market.outcomePrices as string[];
        const yesIndex = rawOutcomes.findIndex(o => o.toLowerCase() === 'yes');
        if (yesIndex !== -1 && rawPrices[yesIndex] !== undefined) {
          yesPrice = parseFloat(rawPrices[yesIndex]) * 100; // Convert 0.365 to 36.5
        }
      } else {
        // Fallback to structuredOutcomes
        const outcomes = market.structuredOutcomes || [];
        const yesOutcome = outcomes.find((o: any) => 
          String(o.label || '').toLowerCase() === 'yes'
        );
        if (yesOutcome) {
          yesPrice = parseFloat(String(yesOutcome.price || '0'));
        }
      }
      
      // Check if we actually found a valid price (including 0% which is valid for a losing team)
      // yesPrice !== null means we found the market, even if the price is 0%
      if (yesPrice !== null && !isNaN(yesPrice)) {
        // Check if this market is for home team
        if (homeTeamName && question.includes(homeTeamName)) {
          homeWinMarket = { price: yesPrice };
        }
        // Check if this market is for away team
        else if (awayTeamName && question.includes(awayTeamName)) {
          awayWinMarket = { price: yesPrice };
        }
      }
    }
  }
  
  // If we found both individual team win markets, use those (soccer-style)
  if (homeWinMarket && awayWinMarket) {
    return {
      home: { label: homeTeamName, price: homeWinMarket.price },
      away: { label: awayTeamName, price: awayWinMarket.price },
    };
  }
  
  // Helper: normalize outcomes/prices to arrays (Gamma API sometimes returns JSON strings)
  const parseOutcomesArray = (val: any): string[] => {
    if (!val) return [];
    if (Array.isArray(val)) return val.map((o) => String(o));
    if (typeof val === 'string') {
      try {
        const p = JSON.parse(val);
        return Array.isArray(p) ? p.map((o: any) => String(o)) : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const parsePricesArray = (val: any): number[] => {
    if (!val) return [];
    if (Array.isArray(val)) return val.map((p) => parseFloat(String(p)));
    if (typeof val === 'string') {
      try {
        const p = JSON.parse(val);
        return Array.isArray(p) ? p.map((x: any) => parseFloat(String(x))) : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  // Look through markets to find the moneyline (team vs team) market
  for (const market of markets) {
    let outcomes: any[] | null = null;
    const structuredOutcomes = market.structuredOutcomes || [];

    // outcomes/outcomePrices: may be arrays or JSON strings (Gamma API returns strings)
    const rawOutcomes = parseOutcomesArray(market.outcomes);
    const rawPrices = parsePricesArray(market.outcomePrices);

    if (rawOutcomes.length === 2 && rawPrices.length === 2) {
      outcomes = rawOutcomes.map((label: string, i: number) => {
        const rawPrice = rawPrices[i];
        const pricePct = typeof rawPrice === 'number' && rawPrice <= 1 ? rawPrice * 100 : rawPrice;
        return {
          label,
          price: typeof pricePct === 'number' && !isNaN(pricePct) ? pricePct : parseFloat(String(rawPrice)) * 100,
          buyPrice: structuredOutcomes[i]?.buyPrice,
          sellPrice: structuredOutcomes[i]?.sellPrice,
        };
      });
    }

    if (!outcomes || outcomes.length === 0) {
      outcomes = structuredOutcomes.length === 2 ? structuredOutcomes : null;
    }
    
    if (!outcomes || outcomes.length !== 2) continue;
    
    // Check if this is a team vs team market (not Over/Under, Spread, etc.)
    const labels = outcomes.map((o: any) => String(o.label || '').toLowerCase());
    const questionLower = (market.question || '').toLowerCase();
    
    // Skip non-moneyline markets based on question content
    const isSpreadMarket = questionLower.includes('spread') || 
                           questionLower.includes('(-') || 
                           questionLower.includes('(+') ||
                           questionLower.includes('handicap');
    const isTotalsMarket = questionLower.includes('o/u') || 
                           questionLower.includes('over/under') ||
                           questionLower.includes('total');
    const isPropsMarket = questionLower.includes('both teams') ||
                          questionLower.includes('first goal') ||
                          questionLower.includes('clean sheet') ||
                          questionLower.includes('corner') ||
                          questionLower.includes('card');
    
    // Skip Over/Under outcomes, Points, Rebounds, etc.
    // Use exact match or word boundary to avoid false positives (e.g., "thunder" contains "under")
    const hasNonMoneylineOutcomes = labels.some(l => 
      l === 'over' || l === 'under' || l === 'o/u' ||
      l.startsWith('over ') || l.startsWith('under ') ||
      l.endsWith(' over') || l.endsWith(' under') ||
      l.includes('points') || l.includes('rebounds') || l.includes('assists')
    );
    
    const shouldSkip = isSpreadMarket || isTotalsMarket || isPropsMarket || hasNonMoneylineOutcomes;
    
    // Debug logging for specific game
    if (game.id === '117348') {
      logger.info({
        message: 'DEBUG findMoneylineMarket checking market',
        gameId: game.id,
        marketQuestion: market.question,
        labels,
        shouldSkip,
        outcomes: outcomes?.map((o: any) => ({ label: o.label, price: o.price })),
        homeTeamName,
        awayTeamName,
      });
    }
    
    if (shouldSkip) {
      continue;
    }
    
    // Try to match teams
    let homeOutcome: TeamOutcome | null = null;
    let awayOutcome: TeamOutcome | null = null;
    
    for (const outcome of outcomes) {
      const label = String(outcome.label || '').toLowerCase();
      const shortLabel = String(outcome.shortLabel || '').toLowerCase();
      const price = parseFloat(String(outcome.price || '50'));
      const buyPrice = outcome.buyPrice;
      const sellPrice = outcome.sellPrice;
      
      // Check if this matches home team (more flexible matching)
      if (homeTeamName) {
        // Try full name match (partial or exact)
        if (label.includes(homeTeamName) || homeTeamName.includes(label) || 
            label === homeTeamName || homeTeamName === label) {
          homeOutcome = { label: outcome.label, price, buyPrice, sellPrice };
          continue;
        }
      }
      if (homeAbbr) {
        // Try abbreviation match
        if (label === homeAbbr || shortLabel === homeAbbr || 
            label.includes(homeAbbr) || shortLabel.includes(homeAbbr)) {
          homeOutcome = { label: outcome.label, price, buyPrice, sellPrice };
          continue;
        }
      }
      
      // Check if this matches away team (more flexible matching)
      if (awayTeamName) {
        // Try full name match (partial or exact)
        if (label.includes(awayTeamName) || awayTeamName.includes(label) ||
            label === awayTeamName || awayTeamName === label) {
          awayOutcome = { label: outcome.label, price, buyPrice, sellPrice };
          continue;
        }
      }
      if (awayAbbr) {
        // Try abbreviation match
        if (label === awayAbbr || shortLabel === awayAbbr ||
            label.includes(awayAbbr) || shortLabel.includes(awayAbbr)) {
          awayOutcome = { label: outcome.label, price, buyPrice, sellPrice };
          continue;
        }
      }
    }
    
    // If we found both teams, return - this is the only valid moneyline match
    if (homeOutcome && awayOutcome) {
      return { home: homeOutcome, away: awayOutcome };
    }
    
    // NO FALLBACKS - if we can't match both teams explicitly, this is not a moneyline market
    // Continue to next market
  }

  // UFC fallback: first moneyline-like market (2 fighter outcomes, not Yes/No or O/U)
  if (isUfc && markets.length > 0) {
    for (const m of markets) {
      const rawOutcomes = parseOutcomesArray(m.outcomes);
      const rawPrices = parsePricesArray(m.outcomePrices);
      if (rawOutcomes.length !== 2 || rawPrices.length !== 2) continue;
      const questionLower = (m.question || '').toLowerCase();
      const isSpreadMarket = questionLower.includes('spread') || questionLower.includes('handicap');
      const isTotalsMarket = questionLower.includes('o/u') || questionLower.includes('over/under') || questionLower.includes('total');
      const labels = rawOutcomes.map((l: string) => String(l).toLowerCase());
      const hasNonMoneyline = labels.some(l =>
        l === 'over' || l === 'under' || l === 'yes' || l === 'no' ||
        l.includes('points') || l.includes('rounds')
      );
      if (isSpreadMarket || isTotalsMarket || hasNonMoneyline) continue;
      const structuredOutcomes = m.structuredOutcomes || [];
      const outcomes = rawOutcomes.map((label: string, i: number) => {
        const rawPrice = rawPrices[i];
        const pricePct = typeof rawPrice === 'number' && rawPrice <= 1 ? rawPrice * 100 : rawPrice;
        return {
          label,
          price: typeof pricePct === 'number' && !isNaN(pricePct) ? pricePct : parseFloat(String(rawPrice)) * 100,
          buyPrice: structuredOutcomes[i]?.buyPrice,
          sellPrice: structuredOutcomes[i]?.sellPrice,
        };
      });
      // Slug convention: away-home, so outcome[0]=away, outcome[1]=home
      return {
        away: { label: outcomes[0].label, price: outcomes[0].price, buyPrice: outcomes[0].buyPrice, sellPrice: outcomes[0].sellPrice },
        home: { label: outcomes[1].label, price: outcomes[1].price, buyPrice: outcomes[1].buyPrice, sellPrice: outcomes[1].sellPrice },
      };
    }
  }
  
  // No moneyline market found - return null (no fallbacks to spread/totals markets)
  return { home: null, away: null };
}

/** Sentinel when moneyline/prices not found - surfaces missing data instead of silent 50/50 */
const NO_PRICE = -1;

/**
 * Get prices for Yes/No outcomes from moneyline market
 * probability = raw YES outcome probability (team wins)
 * buyPrice = YES outcome price rounded UP
 * sellPrice = NO outcome price rounded UP = ceil(100 - YES price)
 * Returns NO_PRICE (-1) when moneyline not found instead of 50 to surface errors.
 */
function extractPrices(game: LiveGame): { 
  homeBuy: number; 
  homeSell: number; 
  awayBuy: number; 
  awaySell: number;
  homeProb: number;
  awayProb: number;
} {
  let homeBuy = NO_PRICE;
  let homeSell = NO_PRICE;
  let awayBuy = NO_PRICE;
  let awaySell = NO_PRICE;
  let homeProb = NO_PRICE;
  let awayProb = NO_PRICE;
  
  // Find moneyline market with team outcomes
  const moneyline = findMoneylineMarket(game);

  if (!moneyline.home || !moneyline.away) {
    // logger.warn({
    //   message: 'Moneyline market not found - prices will show as -1',
    //   gameId: game.id,
    //   slug: game.slug,
    //   sport: game.sport,
    //   marketCount: game.markets?.length ?? 0,
    //   homeTeam: game.homeTeam?.name ?? game.teamIdentifiers?.home,
    //   awayTeam: game.awayTeam?.name ?? game.teamIdentifiers?.away,
    // });
    return { homeBuy, homeSell, awayBuy, awaySell, homeProb, awayProb };
  }
  
  // Debug logging for specific game
  if (game.id === '117348') {
    logger.info({
      message: 'DEBUG extractPrices for game 117348',
      gameId: game.id,
      teamIdentifiers: game.teamIdentifiers,
      moneylineHome: moneyline.home,
      moneylineAway: moneyline.away,
      marketCount: game.markets?.length,
    });
  }
  
  if (moneyline.home && moneyline.away) {
    // Get YES prices for each team (raw probability)
    const homeYesPrice = moneyline.home.price;  // e.g., 25.50
    const awayYesPrice = moneyline.away.price;  // e.g., 74.50
    
    // Check if this is a 3-way sport (soccer/football) where probabilities don't add to 100
    // If sum is significantly less than 100, it's a 3-way market (home, draw, away)
    const sumOfPrices = homeYesPrice + awayYesPrice;
    const is3WayMarket = sumOfPrices < 95; // Less than 95% means there's a draw probability
    
    if (is3WayMarket) {
      // For 3-way markets: round each probability independently using standard rounding
      homeProb = Math.round(homeYesPrice);  // e.g., 60.50 → 61
      awayProb = Math.round(awayYesPrice);  // e.g., 15.50 → 16
    } else {
      // For 2-way markets: round the higher probability, derive the lower from 100 - higher
      // This guarantees they always sum to exactly 100%
      if (homeYesPrice >= awayYesPrice) {
        homeProb = Math.round(homeYesPrice);  // e.g., 71.6 → 72
        awayProb = 100 - homeProb;            // e.g., 100 - 72 = 28
      } else {
        awayProb = Math.round(awayYesPrice);  // e.g., 71.6 → 72
        homeProb = 100 - awayProb;            // e.g., 100 - 72 = 28
      }
    }
    
    // buyPrice from CLOB best_ask (what you pay to BUY)
    // sellPrice from CLOB best_bid (what you get when you SELL)
    if (moneyline.home.buyPrice !== undefined) {
      homeBuy = moneyline.home.buyPrice;
      // Use actual sellPrice from best_bid if available, otherwise fallback to calculation
      homeSell = moneyline.home.sellPrice !== undefined ? moneyline.home.sellPrice : Math.ceil(100 - homeBuy);
    } else {
      homeBuy = Math.ceil(homeYesPrice);
      homeSell = Math.ceil(100 - homeYesPrice);
    }
    
    if (moneyline.away.buyPrice !== undefined) {
      awayBuy = moneyline.away.buyPrice;
      // Use actual sellPrice from best_bid if available, otherwise fallback to calculation
      awaySell = moneyline.away.sellPrice !== undefined ? moneyline.away.sellPrice : Math.ceil(100 - awayBuy);
    } else {
      awayBuy = Math.ceil(awayYesPrice);
      awaySell = Math.ceil(100 - awayYesPrice);
    }
  }
  
  return { homeBuy, homeSell, awayBuy, awaySell, homeProb, awayProb };
}

/**
 * Calculate spread string (difference between buy and sell for same team)
 * This represents the bid-ask spread
 */
function calculateSpread(buyPrice: number, sellPrice: number): string {
  if (buyPrice === NO_PRICE || sellPrice === NO_PRICE) return '—';
  const spread = Math.abs(buyPrice - sellPrice);
  if (spread <= 1) return '1¢';
  return `1-${spread}¢`;
}

/**
 * Check if a game is ended
 * Returns true if:
 * - game.ended is true
 * - game.closed is true
 * - All markets are closed
 * - endDate + 3 hours has passed (fallback)
 */
function isGameEnded(game: LiveGame): boolean {
  // End-date override first (handles occasional stale live=true flags)
  if (game.endDate) {
    const endDate = new Date(game.endDate);
    const graceTime = 3 * 60 * 60 * 1000; // 3 hours in ms
    if ((endDate.getTime() + graceTime) < Date.now()) {
      return true;
    }
  }

  // Check explicit ended/closed flags
  if (game.ended === true) return true;
  if (game.closed === true) return true;
  
  // Check if all markets are closed
  if (game.markets && game.markets.length > 0) {
    const allMarketsClosed = game.markets.every((m: any) => m.closed === true);
    if (allMarketsClosed) return true;
  }

  return false;
}

/**
 * Generate mock chart data (sparkline)
 * In production, this would come from historical price data
 * For now, generates a realistic-looking trend towards current probability
 */
function generateChartData(currentProbability: number, seed?: string): number[] {
  const points = 20;
  const data: number[] = [];
  
  // Use a seeded random based on the game id for consistency
  let seedNum = 0;
  if (seed) {
    for (let i = 0; i < seed.length; i++) {
      seedNum += seed.charCodeAt(i);
    }
  }
  
  // Start from a different point and trend towards current probability
  const startOffset = ((seedNum % 20) - 10); // -10 to +10
  let price = Math.max(10, Math.min(90, currentProbability + startOffset));
  
  // Generate data points trending towards current probability
  for (let i = 0; i < points; i++) {
    data.push(Math.round(price));
    
    // Move towards current probability with some noise
    const progress = i / (points - 1);
    const target = currentProbability;
    const noise = ((seedNum * (i + 1)) % 7 - 3); // Seeded noise: -3 to +3
    
    // Lerp towards target with noise
    price = price + (target - price) * 0.15 + noise * 0.3;
    price = Math.max(10, Math.min(90, price));
  }
  
  // Ensure last point is close to current probability
  data[data.length - 1] = currentProbability;
  
  return data;
}

/**
 * Calculate percent change from chart data
 * Represents the change in probability from start to current
 */
function calculatePercentChange(chartData: number[]): number {
  if (chartData.length < 2) return 0;
  
  const first = chartData[0];
  const last = chartData[chartData.length - 1];
  
  if (first === 0) return 0;
  
  // Percent change: ((new - old) / old) * 100
  return Number(((last - first) / first * 100).toFixed(1));
}

/**
 * Extract UFC fighter names from a LiveGame for record lookup.
 * Returns null if not a UFC game.
 */
export function getUfcFighterNamesFromGame(
  game: LiveGame
): { away: string; home: string } | null {
  const isUfc =
    (game.sport && game.sport.toLowerCase() === 'ufc') ||
    (game.league && game.league.toLowerCase() === 'ufc');
  if (!isUfc) return null;

  const titleTeams = extractTeamsFromTitle(game.title);
  const rawAwayId = game.teamIdentifiers?.away ?? '';
  const rawHomeId = game.teamIdentifiers?.home ?? '';
  const homeTeam = game.homeTeam;
  const awayTeam = game.awayTeam;

  let descNames: { away?: string; home?: string } = {};
  const rawDesc =
    (game.description as string | undefined) ||
    (game.rawData && (game.rawData as any).description as string | undefined) ||
    '';
  let effectiveDesc = rawDesc;
  if (!effectiveDesc && Array.isArray((game.rawData as any)?.markets)) {
    const withDesc = (game.rawData as any).markets.find(
      (m: any) => typeof m.description === 'string' && m.description.trim().length > 0
    );
    if (withDesc) effectiveDesc = withDesc.description;
  }
  if (effectiveDesc) descNames = extractFullNamesFromDescription(effectiveDesc);

  const away = awayTeam?.name || descNames.away || titleTeams.away || rawAwayId || '';
  const home = homeTeam?.name || descNames.home || titleTeams.home || rawHomeId || '';
  if (!away.trim() && !home.trim()) return null;
  return { away: away.trim() || 'Away Fighter', home: home.trim() || 'Home Fighter' };
}

/**
 * Transform a LiveGame to FrontendGame format
 * @param game - The LiveGame to transform
 * @param historicalChange - Optional pre-calculated probability change (for batch processing)
 */
export async function transformToFrontendGame(
  game: LiveGame,
  historicalChange?: { homePercentChange: number; awayPercentChange: number }
): Promise<FrontendGame> {
  // Ensure consistency: if game is live, it cannot be ended
  // This is a safety check in case the game object wasn't properly normalized
  if (game.live === true && game.ended === true && game.closed !== true) {
    game.ended = false;
  }
  
  // Detect tennis games for special score handling
  const isTennisMatch = isTennisGame(game);
  
  // Parse score - use tennis parser for tennis games
  let scores: { home?: number; away?: number } = {};
  let tennisScoreData: { home: number; away: number; setsWon: { home: number; away: number }; rawScore: string } | null = null;
  
  if (isTennisMatch && game.score) {
    tennisScoreData = parseTennisScore(game.score);
    if (tennisScoreData) {
      // For tennis, use the current set games as the "score" for backwards compatibility
      scores = { home: tennisScoreData.home, away: tennisScoreData.away };
    }
  } else {
    scores = parseScore(game.score);
  }
  
  // Extract win probabilities (Yes outcome for each team)
  const prices = extractPrices(game);
  
  // Get team info
  const homeTeam = game.homeTeam;
  const awayTeam = game.awayTeam;
  
  // Extract team names from title if no team data
  let titleTeams = extractTeamsFromTitle(game.title);
  
  // Clean tennis team names from title if this is a tennis game
  if (isTennisMatch) {
    if (titleTeams.away) {
      titleTeams.away = cleanTennisTeamName(titleTeams.away) || titleTeams.away;
    }
    if (titleTeams.home) {
      titleTeams.home = cleanTennisTeamName(titleTeams.home) || titleTeams.home;
    }
  }
  
  // Extract team abbreviations from slug as fallback (format: sport-away-home-date)
  // Pass the game's sport to avoid incorrectly skipping team abbreviations that match sport identifiers
  const slugAbbrevs = extractAbbrevsFromSlug(game.slug, game.sport || game.league);
  
  // Log warnings if slug extraction seems incorrect
  if (game.slug && (slugAbbrevs.away || slugAbbrevs.home)) {
    const finalAwayAbbr = awayTeam?.abbreviation || slugAbbrevs.away || game.teamIdentifiers?.away?.substring(0, 3).toUpperCase() || titleTeams.away?.substring(0, 3).toUpperCase() || 'AWY';
    const finalHomeAbbr = homeTeam?.abbreviation || slugAbbrevs.home || game.teamIdentifiers?.home?.substring(0, 3).toUpperCase() || titleTeams.home?.substring(0, 3).toUpperCase() || 'HME';
    
    // Check if slug-extracted abbreviations match sport identifiers (common mistake)
    const sportIdentifiers = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'cbb', 'cfb', 'lal', 'ser', 'bund', 'lig1', 'mls']);
    if (sportIdentifiers.has(finalAwayAbbr.toLowerCase()) || sportIdentifiers.has(finalHomeAbbr.toLowerCase())) {
      // logger.warn({
      //   message: 'Team abbreviation matches sport identifier - likely slug parsing error',
      //   gameId: game.id,
      //   slug: game.slug,
      //   sport: game.sport,
      //   awayAbbr: finalAwayAbbr,
      //   homeAbbr: finalHomeAbbr,
      //   awayTeamName: awayTeam?.name || game.teamIdentifiers?.away,
      //   homeTeamName: homeTeam?.name || game.teamIdentifiers?.home,
      // });
    }
  }
  
  // Generate chart data based on home team's win probability
  // Use game.id as seed for consistent mock data (TODO: use real historical data)
  const chartData = generateChartData(prices.homeProb, game.id);
  
  // Calculate real percent change from probability history (24h)
  let percentChange = 0;
  if (historicalChange) {
    percentChange = historicalChange.homePercentChange;
  } else {
    try {
      const probChange = await calculateProbabilityChange(
        game.id,
        prices.homeProb,
        prices.awayProb,
        24 // 24 hours
      );
      percentChange = probChange.homePercentChange;
    } catch (error) {
      // Fall back to chart-based calculation if history fails
      percentChange = calculatePercentChange(chartData);
    }
  }
  
  // Get the game date for display - prefer gameStartTime (actual game time) over endDate (market close time)
  // This fixes the issue where games show the wrong date due to endDate being in UTC next day
  // e.g., gameStartTime "2026-01-04 01:00:00+00" = 8PM EST Jan 3, but endDate "2026-01-04T05:00:00Z" shows as Jan 4
  const gameStartTime = game.gameStartTime || (game.markets?.[0] as any)?.gameStartTime;
  const endDateStr = gameStartTime || game.endDate || game.startDate || '';
  
  // Generate mock traders count (seeded by game id for consistency)
  const seedNum = game.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const mockTraders = 50 + (seedNum % 500);
  
  // Determine if game is ended (explicit flag, market closed, or end_date + grace)
  const gameEnded = isGameEnded(game);
  
  // Show scores for both live AND ended games (if available)
  const showScores = game.live || gameEnded;

  // Detect UFC fights where "teams" are fighters and names can often be
  // reconstructed from event metadata instead of generic team names.
  const isUfc =
    (game.sport && game.sport.toLowerCase() === 'ufc') ||
    (game.league && game.league.toLowerCase() === 'ufc');

  const rawAwayId = game.teamIdentifiers?.away ?? '';
  const rawHomeId = game.teamIdentifiers?.home ?? '';

  // For UFC and Tennis, try to parse full participant names from description first (event or market),
  // then fall back to title-derived names or identifiers.
  let descNames: { away?: string; home?: string } = {};
  if (isUfc || isTennisMatch) {
    const rawDesc =
      (game.description as string | undefined) ||
      (game.rawData && (game.rawData as any).description as string | undefined) ||
      '';
    let effectiveDesc = rawDesc;

    if (!effectiveDesc && Array.isArray((game.rawData as any)?.markets)) {
      const withDesc = (game.rawData as any).markets.find(
        (m: any) => typeof m.description === 'string' && m.description.trim().length > 0
      );
      if (withDesc) {
        effectiveDesc = withDesc.description;
      }
    }

    if (effectiveDesc) {
      descNames = extractFullNamesFromDescription(effectiveDesc);
    }
  }

  // UFC: prefer Ball Don't Lie display name from DB, fallback to current method
  const ufcAwayIdentifier = descNames.away || titleTeams.away || rawAwayId || awayTeam?.name || '';
  const ufcHomeIdentifier = descNames.home || titleTeams.home || rawHomeId || homeTeam?.name || '';
  const ufcAwayAbbr = slugAbbrevs.away || awayTeam?.abbreviation || rawAwayId;
  const ufcHomeAbbr = slugAbbrevs.home || homeTeam?.abbreviation || rawHomeId;
  const ufcAwayName =
    isUfc ? (getFighterDisplayName(ufcAwayIdentifier) || getFighterDisplayName(ufcAwayAbbr) || null) : null;
  const ufcHomeName =
    isUfc ? (getFighterDisplayName(ufcHomeIdentifier) || getFighterDisplayName(ufcHomeAbbr) || null) : null;

  // Build frontend game
  const frontendGame: FrontendGame = {
    id: game.id,
    endDate: endDateStr, // ISO 8601 for frontend sorting
    time: formatGameTime(endDateStr), // Display-friendly time from endDate
    volume: formatVolume(game.totalVolume || game.volume),
    awayTeam: {
      abbr: isUfc
        ? (
            slugAbbrevs.away ||
            (awayTeam?.abbreviation && awayTeam.abbreviation.toUpperCase()) ||
            rawAwayId.toUpperCase() ||
            (titleTeams.away && titleTeams.away.replace(/\s+/g, '').slice(0, 6).toUpperCase()) ||
            'AWY'
          )
        : (
            awayTeam?.abbreviation ||
            slugAbbrevs.away ||
            (rawAwayId && rawAwayId.substring(0, 3).toUpperCase()) ||
            (titleTeams.away && titleTeams.away.substring(0, 3).toUpperCase()) ||
            'AWY'
          ),
      name: isUfc
        ? (ufcAwayName || descNames.away || titleTeams.away || rawAwayId || awayTeam?.name || 'Away Fighter')
        : isTennisMatch
        ? (descNames.away || cleanTennisTeamName(awayTeam?.name) || cleanTennisTeamName(rawAwayId) || cleanTennisTeamName(titleTeams.away) || 'Away Player')
        : (awayTeam?.name || rawAwayId || titleTeams.away || 'Away Team'),
      record: isUfc
        ? getFighterRecord(ufcAwayName || descNames.away || titleTeams.away || rawAwayId || awayTeam?.name || '')
        : (awayTeam?.record || '0-0'),
      probability: prices.awayProb,  // Raw YES probability (e.g., 35.5)
      buyPrice: prices.awayBuy,      // YES price rounded up (e.g., 36)
      sellPrice: prices.awaySell,    // NO price rounded up (e.g., 65)
      score: showScores ? scores.away : undefined,
      // Tennis-specific fields
      tennisScore: isTennisMatch && tennisScoreData ? tennisScoreData.rawScore : undefined,
      setsWon: isTennisMatch && tennisScoreData ? tennisScoreData.setsWon.away : undefined,
    },
    homeTeam: {
      abbr: isUfc
        ? (
            slugAbbrevs.home ||
            (homeTeam?.abbreviation && homeTeam.abbreviation.toUpperCase()) ||
            rawHomeId.toUpperCase() ||
            (titleTeams.home && titleTeams.home.replace(/\s+/g, '').slice(0, 6).toUpperCase()) ||
            'HME'
          )
        : (
            homeTeam?.abbreviation ||
            slugAbbrevs.home ||
            (rawHomeId && rawHomeId.substring(0, 3).toUpperCase()) ||
            (titleTeams.home && titleTeams.home.substring(0, 3).toUpperCase()) ||
            'HME'
          ),
      name: isUfc
        ? (ufcHomeName || descNames.home || titleTeams.home || rawHomeId || homeTeam?.name || 'Home Fighter')
        : isTennisMatch
        ? (descNames.home || cleanTennisTeamName(homeTeam?.name) || cleanTennisTeamName(rawHomeId) || cleanTennisTeamName(titleTeams.home) || 'Home Player')
        : (homeTeam?.name || rawHomeId || titleTeams.home || 'Home Team'),
      record: isUfc
        ? getFighterRecord(ufcHomeName || descNames.home || titleTeams.home || rawHomeId || homeTeam?.name || '')
        : (homeTeam?.record || '0-0'),
      probability: prices.homeProb,  // Raw YES probability (e.g., 64.5)
      buyPrice: prices.homeBuy,      // YES price rounded up (e.g., 65)
      sellPrice: prices.homeSell,    // NO price rounded up (e.g., 36)
      score: showScores ? scores.home : undefined,
      // Tennis-specific fields
      tennisScore: isTennisMatch && tennisScoreData ? tennisScoreData.rawScore : undefined,
      setsWon: isTennisMatch && tennisScoreData ? tennisScoreData.setsWon.home : undefined,
    },
    liquidity: formatLiquidity(game.liquidity),
    chartData,
    percentChange,
    traders: game.commentCount || mockTraders, // Use comment count or seeded mock
    spread: calculateSpread(prices.homeBuy, prices.homeSell),
    isLive: game.live,
    ended: gameEnded,
    quarter: game.live ? formatQuarter(game.period) : undefined,
    gameTime: game.live ? formatElapsedTime(game.elapsed) : undefined,
    sport: game.sport,
    league: game.league,
    slug: game.slug,
    // Tennis-specific: include raw score at game level for easier frontend access
    tennisScore: isTennisMatch && tennisScoreData ? tennisScoreData.rawScore : undefined,
  };
  
  return frontendGame;
}

/**
 * Transform multiple LiveGames to FrontendGame format
 */
export async function transformToFrontendGames(games: LiveGame[]): Promise<FrontendGame[]> {
  const results: FrontendGame[] = [];
  
  for (const game of games) {
    try {
      const frontendGame = await transformToFrontendGame(game);
      results.push(frontendGame);
    } catch (error) {
      logger.error({
        message: 'Error transforming game to frontend format',
        gameId: game.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Return a minimal valid game on error
      const fallbackGameStart = game.gameStartTime || (game.markets?.[0] as any)?.gameStartTime;
      results.push({
        id: game.id,
        endDate: fallbackGameStart || game.endDate || game.startDate || '',
        time: 'TBD',
        volume: '$0',
        awayTeam: { abbr: 'AWY', name: 'Away', record: '0-0', probability: 50, buyPrice: 50, sellPrice: 50 },
        homeTeam: { abbr: 'HME', name: 'Home', record: '0-0', probability: 50, buyPrice: 50, sellPrice: 50 },
        liquidity: '$0',
        chartData: Array(20).fill(50),
        percentChange: 0,
        traders: 0,
        spread: '1¢',
        sport: game.sport,
        league: game.league,
      });
    }
  }
  
  return results;
}

