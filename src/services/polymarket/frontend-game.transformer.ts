/**
 * Frontend Game Transformer
 * Transforms LiveGame data into the frontend-friendly Game interface
 */

import { LiveGame } from './live-games.service';
import { Team } from './teams.service';
import { logger } from '../../config/logger';
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
  quarter?: string;          // "3Q"
  gameTime?: string;         // "5:45" (time remaining)
  sport?: string;            // "nba", "nfl", etc.
  league?: string;           // league identifier
  slug?: string;             // URL slug
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
 * Parse score string (e.g., "99-82") into individual scores
 * Polymarket format: "home-away" (first number is home team score)
 */
function parseScore(scoreStr: string | undefined): { home?: number; away?: number } {
  if (!scoreStr) return {};
  
  const parts = scoreStr.split('-').map(s => parseInt(s.trim(), 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return { home: parts[0], away: parts[1] };
  }
  return {};
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
 * Extract team info from title (e.g., "Warriors vs Lakers" or "WAS @ PHX")
 */
function extractTeamsFromTitle(title: string): { home?: string; away?: string } {
  // Try "Team1 vs Team2" or "Team1 @ Team2" format
  // Format: "Away vs Home" or "Away @ Home" -> team1 is away, team2 is home
  const vsMatch = title.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+?)(?:\s*[-–—]|$)/i);
  if (vsMatch) {
    // For "vs" format: "Away vs Home" -> team1 is away, team2 is home
    // For "@" format: "Away @ Home" -> team1 is away, team2 is home
    return { away: vsMatch[1].trim(), home: vsMatch[2].trim() };
  }
  
  return {};
}

/**
 * Extract team abbreviations from slug (format: sport-away-home-date)
 * Returns { away: 'SEA', home: 'UTA' } for slug like 'nhl-sea-utah-2025-12-13'
 */
function extractAbbrevsFromSlug(slug: string | undefined): { away?: string; home?: string } {
  if (!slug) return {};
  
  const slugParts = slug.split('-');
  const teamAbbrevs: string[] = [];
  
  // Common sport identifiers to skip
  const sportIdentifiers = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'lal', 'ser', 'bund', 'lig1', 'mls']);
  
  for (const part of slugParts) {
    // Skip numbers (dates)
    if (/^\d+$/.test(part)) continue;
    // Skip sport identifier (first part is usually sport)
    if (slugParts.indexOf(part) === 0 && sportIdentifiers.has(part.toLowerCase())) continue;
    // Match team abbreviations (2-5 letters)
    if (part.length >= 2 && part.length <= 5 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }
  
  if (teamAbbrevs.length >= 2) {
    // Slug format: sport-away-home-date, so first team is away, second is home
    return { away: teamAbbrevs[0], home: teamAbbrevs[1] };
  }
  
  return {};
}

/**
 * Team outcome with win probability
 */
interface TeamOutcome {
  label: string;
  price: number;  // Probability (e.g., 50.50 = 50.50% chance to win)
}

/**
 * Find the moneyline market (team vs team) from markets
 * The moneyline market has structuredOutcomes with team names, not Over/Under
 */
function findMoneylineMarket(game: LiveGame): { home: TeamOutcome | null; away: TeamOutcome | null } {
  if (!game.markets || game.markets.length === 0) {
    return { home: null, away: null };
  }
  
  // Get team identifiers to match
  const homeTeamName = game.homeTeam?.name?.toLowerCase() || game.teamIdentifiers?.home?.toLowerCase() || '';
  const awayTeamName = game.awayTeam?.name?.toLowerCase() || game.teamIdentifiers?.away?.toLowerCase() || '';
  const homeAbbr = game.homeTeam?.abbreviation?.toLowerCase() || '';
  const awayAbbr = game.awayTeam?.abbreviation?.toLowerCase() || '';
  
  // Look through markets to find the moneyline (team vs team) market
  for (const market of game.markets) {
    const outcomes = market.structuredOutcomes;
    if (!outcomes || outcomes.length !== 2) continue;
    
    // Check if this is a team vs team market (not Over/Under)
    const labels = outcomes.map((o: any) => String(o.label || '').toLowerCase());
    
    // Skip Over/Under, Points, Rebounds, etc.
    if (labels.some(l => l.includes('over') || l.includes('under') || l.includes('o/u') || 
                         l.includes('points') || l.includes('rebounds') || l.includes('assists'))) {
      continue;
    }
    
    // Try to match teams
    let homeOutcome: TeamOutcome | null = null;
    let awayOutcome: TeamOutcome | null = null;
    
    for (const outcome of outcomes) {
      const label = String(outcome.label || '').toLowerCase();
      const shortLabel = String(outcome.shortLabel || '').toLowerCase();
      const price = parseFloat(String(outcome.price || '50'));
      
      // Check if this matches home team
      if (homeTeamName && (label.includes(homeTeamName) || homeTeamName.includes(label))) {
        homeOutcome = { label: outcome.label, price };
      } else if (homeAbbr && (label === homeAbbr || shortLabel === homeAbbr)) {
        homeOutcome = { label: outcome.label, price };
      }
      // Check if this matches away team
      else if (awayTeamName && (label.includes(awayTeamName) || awayTeamName.includes(label))) {
        awayOutcome = { label: outcome.label, price };
      } else if (awayAbbr && (label === awayAbbr || shortLabel === awayAbbr)) {
        awayOutcome = { label: outcome.label, price };
      }
    }
    
    // If we found both teams, return
    if (homeOutcome && awayOutcome) {
      return { home: homeOutcome, away: awayOutcome };
    }
    
    // Fallback: if this looks like a team market (2 outcomes, both have team-like names)
    // Assume first is home, second is away (or vice versa based on title parsing)
    if (outcomes.length === 2 && !labels.some(l => l.includes('yes') || l.includes('no'))) {
      const o1 = outcomes[0];
      const o2 = outcomes[1];
      
      // Use title to determine order: "Heat vs. Magic" -> Heat is home
      const titleLower = (game.title || '').toLowerCase();
      const o1Label = String(o1.label || '').toLowerCase();
      const o2Label = String(o2.label || '').toLowerCase();
      
      // Check which team appears first in title (usually format: "Home vs Away")
      const o1Pos = titleLower.indexOf(o1Label);
      const o2Pos = titleLower.indexOf(o2Label);
      
      if (o1Pos !== -1 && o2Pos !== -1) {
        if (o1Pos < o2Pos) {
          // o1 is home (appears first)
          homeOutcome = { label: o1.label, price: parseFloat(String(o1.price || '50')) };
          awayOutcome = { label: o2.label, price: parseFloat(String(o2.price || '50')) };
        } else {
          // o2 is home (appears first)
          homeOutcome = { label: o2.label, price: parseFloat(String(o2.price || '50')) };
          awayOutcome = { label: o1.label, price: parseFloat(String(o1.price || '50')) };
        }
        return { home: homeOutcome, away: awayOutcome };
      }
    }
  }
  
  return { home: null, away: null };
}

/**
 * Get prices for Yes/No outcomes from moneyline market
 * probability = raw YES outcome probability (team wins)
 * buyPrice = YES outcome price rounded UP
 * sellPrice = NO outcome price rounded UP = ceil(100 - YES price)
 */
function extractPrices(game: LiveGame): { 
  homeBuy: number; 
  homeSell: number; 
  awayBuy: number; 
  awaySell: number;
  homeProb: number;
  awayProb: number;
} {
  // Default prices (50/50)
  let homeBuy = 50;
  let homeSell = 50;
  let awayBuy = 50;
  let awaySell = 50;
  let homeProb = 50;
  let awayProb = 50;
  
  // Find moneyline market with team outcomes
  const moneyline = findMoneylineMarket(game);
  
  if (moneyline.home && moneyline.away) {
    // Get YES prices for each team (raw probability)
    const homeYesPrice = moneyline.home.price;  // e.g., 50.50
    const awayYesPrice = moneyline.away.price;  // e.g., 49.50
    
    // Store raw probabilities (keep decimal precision)
    homeProb = Number(homeYesPrice.toFixed(1));  // e.g., 50.5
    awayProb = Number(awayYesPrice.toFixed(1));  // e.g., 49.5
    
    // buyPrice = YES price rounded UP (you buy YES if you think team wins)
    // sellPrice = NO price rounded UP = ceil(100 - YES price)
    homeBuy = Math.ceil(homeYesPrice);           // 50.50 → 51
    homeSell = Math.ceil(100 - homeYesPrice);    // 100 - 50.50 = 49.50 → 50
    
    awayBuy = Math.ceil(awayYesPrice);           // 49.50 → 50
    awaySell = Math.ceil(100 - awayYesPrice);    // 100 - 49.50 = 50.50 → 51
  }
  
  return { homeBuy, homeSell, awayBuy, awaySell, homeProb, awayProb };
}

/**
 * Calculate spread string (difference between buy and sell for same team)
 * This represents the bid-ask spread
 */
function calculateSpread(buyPrice: number, sellPrice: number): string {
  // Spread is the gap between buying YES and selling (buying NO)
  const spread = Math.abs(buyPrice - sellPrice);
  if (spread <= 1) return '1¢';
  return `1-${spread}¢`;
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
 * Transform a LiveGame to FrontendGame format
 * @param game - The LiveGame to transform
 * @param historicalChange - Optional pre-calculated probability change (for batch processing)
 */
export async function transformToFrontendGame(
  game: LiveGame,
  historicalChange?: { homePercentChange: number; awayPercentChange: number }
): Promise<FrontendGame> {
  // Parse score
  const scores = parseScore(game.score);
  
  // Extract win probabilities (Yes outcome for each team)
  const prices = extractPrices(game);
  
  // Get team info
  const homeTeam = game.homeTeam;
  const awayTeam = game.awayTeam;
  
  // Extract team names from title if no team data
  const titleTeams = extractTeamsFromTitle(game.title);
  
  // Extract team abbreviations from slug as fallback (format: sport-away-home-date)
  const slugAbbrevs = extractAbbrevsFromSlug(game.slug);
  
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
  
  // Get endDate - use endDate if available, fall back to startDate
  const endDateStr = game.endDate || game.startDate || '';
  
  // Generate mock traders count (seeded by game id for consistency)
  const seedNum = game.id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const mockTraders = 50 + (seedNum % 500);
  
  // Build frontend game
  const frontendGame: FrontendGame = {
    id: game.id,
    endDate: endDateStr, // ISO 8601 for frontend sorting
    time: formatGameTime(endDateStr), // Display-friendly time from endDate
    volume: formatVolume(game.totalVolume || game.volume),
    awayTeam: {
      abbr: awayTeam?.abbreviation || slugAbbrevs.away || game.teamIdentifiers?.away?.substring(0, 3).toUpperCase() || titleTeams.away?.substring(0, 3).toUpperCase() || 'AWY',
      name: awayTeam?.name || game.teamIdentifiers?.away || titleTeams.away || 'Away Team',
      record: awayTeam?.record || '0-0',
      probability: prices.awayProb,  // Raw YES probability (e.g., 35.5)
      buyPrice: prices.awayBuy,      // YES price rounded up (e.g., 36)
      sellPrice: prices.awaySell,    // NO price rounded up (e.g., 65)
      score: game.live ? scores.away : undefined,
    },
    homeTeam: {
      abbr: homeTeam?.abbreviation || slugAbbrevs.home || game.teamIdentifiers?.home?.substring(0, 3).toUpperCase() || titleTeams.home?.substring(0, 3).toUpperCase() || 'HME',
      name: homeTeam?.name || game.teamIdentifiers?.home || titleTeams.home || 'Home Team',
      record: homeTeam?.record || '0-0',
      probability: prices.homeProb,  // Raw YES probability (e.g., 64.5)
      buyPrice: prices.homeBuy,      // YES price rounded up (e.g., 65)
      sellPrice: prices.homeSell,    // NO price rounded up (e.g., 36)
      score: game.live ? scores.home : undefined,
    },
    liquidity: formatLiquidity(game.liquidity),
    chartData,
    percentChange,
    traders: game.commentCount || mockTraders, // Use comment count or seeded mock
    spread: calculateSpread(prices.homeBuy, prices.homeSell),
    isLive: game.live,
    quarter: game.live ? formatQuarter(game.period) : undefined,
    gameTime: game.live ? formatElapsedTime(game.elapsed) : undefined,
    sport: game.sport,
    league: game.league,
    slug: game.slug,
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
      results.push({
        id: game.id,
        endDate: game.endDate || game.startDate || '',
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

