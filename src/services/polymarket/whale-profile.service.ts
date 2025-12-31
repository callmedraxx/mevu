/**
 * Whale Profile Service
 * Fetches and aggregates whale trading data from Polymarket APIs
 * Provides comprehensive stats, positions, and trade history for any wallet
 */

import axios from 'axios';
import { logger } from '../../config/logger';

const DATA_API_URL = 'https://data-api.polymarket.com';

// ==================== Types ====================

/**
 * Raw trade from Polymarket API
 */
interface PolymarketTrade {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  name?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  transactionHash: string;
}

/**
 * Raw position from Polymarket API
 */
interface PolymarketPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
  mergeable: boolean;
  title: string;
  slug: string;
  icon: string;
  eventId: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  oppositeOutcome: string;
  oppositeAsset: string;
  endDate: string;
  negativeRisk: boolean;
}

/**
 * Core whale stats for frontend
 */
export interface WhaleStats {
  wallet: string;
  username?: string;
  pseudonym?: string;
  bio?: string;
  profileImage?: string;
  totalVolume: number;
  avgTradeSize: number;
  winRate: number;
  tradesCount: number;
  pnl: number;
  pnlChange: number;
  firstSeen: string;
  lastActive: string;
  favoriteSport: string;
}

/**
 * Position for frontend
 */
export interface WhalePosition {
  id: number;
  question: string;
  side: 'Yes' | 'No';
  shares: number;
  avgPrice: number;
  currentPrice: number;
  value: number;
  pnl: number;
  pnlPercent: number;
  sport: string;
  team: string;
  platform: 'polymarket' | 'kalshi';
}

/**
 * Recent trade for frontend
 */
export interface WhaleTrade {
  type: 'buy' | 'sell';
  question: string;
  amount: number;
  shares: number;
  price: number;
  time: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  platform: 'polymarket' | 'kalshi';
}

/**
 * PnL chart data point
 */
export interface PnlDataPoint {
  day: number;
  value: number;
}

/**
 * Volume by sport data point
 */
export interface SportVolumePoint {
  sport: string;
  volume: number;
  color: string;
}

/**
 * Complete whale profile response
 */
export interface WhaleProfileResponse {
  success: boolean;
  stats: WhaleStats;
  positions: WhalePosition[];
  recentTrades: WhaleTrade[];
  pnlChart: PnlDataPoint[];
  volumeBySport: SportVolumePoint[];
  error?: string;
}

// ==================== Helpers ====================

/**
 * Sport colors for charts
 */
const SPORT_COLORS: Record<string, string> = {
  nba: '#C9082A',
  nfl: '#013369',
  nhl: '#000000',
  mlb: '#002D72',
  epl: '#3D195B',
  soccer: '#00A859',
  cbb: '#FF6B00',
  cfb: '#8B0000',
  mma: '#D20A0A',
  other: '#6B7280',
};

/**
 * Extract sport code from slug
 * e.g., "nba-lal-gsw-2025-01-01" -> "nba"
 */
function extractSportFromSlug(slug: string): string {
  if (!slug) return 'other';
  
  const parts = slug.toLowerCase().split('-');
  const firstPart = parts[0];
  
  // Map common prefixes to sport codes
  const sportMap: Record<string, string> = {
    nba: 'nba',
    nfl: 'nfl',
    nhl: 'nhl',
    mlb: 'mlb',
    epl: 'epl',
    cbb: 'cbb',
    cfb: 'cfb',
    ncaab: 'cbb',
    ncaaf: 'cfb',
    ufc: 'mma',
    mma: 'mma',
    acn: 'soccer', // Africa Cup of Nations
    laliga: 'soccer',
    seriea: 'soccer',
    bundesliga: 'soccer',
    ligue1: 'soccer',
  };
  
  return sportMap[firstPart] || 'other';
}

/**
 * Extract team abbreviation from outcome or title
 */
function extractTeamFromOutcome(outcome: string, title: string): string {
  // Try to get abbreviation from title
  // e.g., "Lakers vs. Warriors" -> try to match outcome
  if (outcome) {
    // Return first word or abbreviation
    const words = outcome.split(' ');
    if (words.length === 1) return words[0].substring(0, 3).toUpperCase();
    return words[0].substring(0, 3).toUpperCase();
  }
  return 'UNK';
}

/**
 * Extract home and away teams from title
 * e.g., "Lakers vs. Warriors" -> { home: "Warriors", away: "Lakers" }
 */
function extractTeamsFromTitle(title: string): { homeTeam: string; awayTeam: string } {
  const vsMatch = title.match(/(.+?)\s+(?:vs\.?|@)\s+(.+?)(?:\:|$)/i);
  if (vsMatch) {
    return {
      awayTeam: vsMatch[1].trim().split(' ').pop() || 'Away',
      homeTeam: vsMatch[2].trim().split(' ').pop() || 'Home',
    };
  }
  return { homeTeam: 'Home', awayTeam: 'Away' };
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp * 1000;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

/**
 * Format date for first seen
 */
function formatFirstSeen(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const month = date.toLocaleString('en-US', { month: 'short' });
  const year = date.getFullYear();
  return `${month} ${year}`;
}

/**
 * Validate Ethereum address
 */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// ==================== API Fetchers ====================

/**
 * Fetch all trades for a wallet (paginated)
 */
async function fetchAllTrades(wallet: string, maxTrades: number = 1000): Promise<PolymarketTrade[]> {
  const allTrades: PolymarketTrade[] = [];
  const pageSize = 100;
  let offset = 0;
  
  while (allTrades.length < maxTrades) {
    try {
      const response = await axios.get<PolymarketTrade[]>(`${DATA_API_URL}/trades`, {
        params: {
          user: wallet,
          limit: pageSize,
          offset,
        },
        timeout: 15000,
      });
      
      const trades = response.data || [];
      if (trades.length === 0) break;
      
      allTrades.push(...trades);
      offset += pageSize;
      
      if (trades.length < pageSize) break;
    } catch (error) {
      logger.warn({
        message: 'Error fetching trades page',
        wallet,
        offset,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  
  return allTrades;
}

/**
 * Fetch all positions for a wallet
 */
async function fetchPositions(wallet: string): Promise<PolymarketPosition[]> {
  try {
    const response = await axios.get<PolymarketPosition[]>(`${DATA_API_URL}/positions`, {
      params: {
        user: wallet,
        limit: 100,
      },
      timeout: 15000,
    });
    
    return response.data || [];
  } catch (error) {
    logger.warn({
      message: 'Error fetching positions',
      wallet,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// ==================== Data Processors ====================

/**
 * Calculate whale stats from trades and positions
 */
function calculateStats(
  wallet: string,
  trades: PolymarketTrade[],
  positions: PolymarketPosition[]
): WhaleStats {
  // Get user info from first trade
  const userInfo = trades[0] || {};
  
  // Calculate total volume (sum of size * price for all trades)
  let totalVolume = 0;
  for (const trade of trades) {
    totalVolume += trade.size * trade.price;
  }
  
  // Average trade size
  const avgTradeSize = trades.length > 0 ? totalVolume / trades.length : 0;
  
  // Calculate PnL from positions
  let totalPnl = 0;
  let totalInitialValue = 0;
  let winningPositions = 0;
  
  for (const pos of positions) {
    totalPnl += pos.cashPnl || 0;
    totalInitialValue += pos.initialValue || 0;
    if (pos.cashPnl > 0) winningPositions++;
  }
  
  // Win rate based on positions with positive PnL
  const winRate = positions.length > 0 
    ? Math.round((winningPositions / positions.length) * 100) 
    : 50;
  
  // PnL percentage change
  const pnlChange = totalInitialValue > 0 
    ? (totalPnl / totalInitialValue) * 100 
    : 0;
  
  // First seen and last active from trades
  const timestamps = trades.map(t => t.timestamp).filter(t => t > 0);
  const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : Date.now() / 1000;
  const lastTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : Date.now() / 1000;
  
  // Favorite sport by volume
  const sportVolumes: Record<string, number> = {};
  for (const trade of trades) {
    const sport = extractSportFromSlug(trade.slug || trade.eventSlug);
    const volume = trade.size * trade.price;
    sportVolumes[sport] = (sportVolumes[sport] || 0) + volume;
  }
  
  const favoriteSport = Object.entries(sportVolumes)
    .sort((a, b) => b[1] - a[1])[0]?.[0]?.toUpperCase() || 'NBA';
  
  return {
    wallet,
    username: userInfo.name || undefined,
    pseudonym: userInfo.pseudonym || undefined,
    bio: userInfo.bio || undefined,
    profileImage: userInfo.profileImage || undefined,
    totalVolume: Math.round(totalVolume * 100) / 100,
    avgTradeSize: Math.round(avgTradeSize * 100) / 100,
    winRate: Math.min(Math.max(winRate, 0), 100),
    tradesCount: trades.length,
    pnl: Math.round(totalPnl * 100) / 100,
    pnlChange: Math.round(pnlChange * 100) / 100,
    firstSeen: formatFirstSeen(firstTimestamp),
    lastActive: formatRelativeTime(lastTimestamp),
    favoriteSport,
  };
}

/**
 * Transform positions for frontend
 */
function transformPositions(positions: PolymarketPosition[]): WhalePosition[] {
  return positions
    .filter(pos => pos.size > 0) // Only active positions
    .slice(0, 50) // Limit to 50 positions
    .map((pos, index) => {
      const sport = extractSportFromSlug(pos.slug || pos.eventSlug);
      const team = extractTeamFromOutcome(pos.outcome, pos.title);
      
      return {
        id: index + 1,
        question: pos.title,
        side: pos.outcomeIndex === 0 ? 'Yes' : 'No',
        shares: Math.round(pos.size * 100) / 100,
        avgPrice: Math.round(pos.avgPrice * 100), // Convert to cents
        currentPrice: Math.round(pos.curPrice * 100), // Convert to cents
        value: Math.round(pos.currentValue * 100) / 100,
        pnl: Math.round(pos.cashPnl * 100) / 100,
        pnlPercent: Math.round(pos.percentPnl * 100) / 100,
        sport,
        team,
        platform: 'polymarket' as const,
      };
    });
}

/**
 * Transform trades for frontend
 */
function transformTrades(trades: PolymarketTrade[]): WhaleTrade[] {
  return trades.slice(0, 50).map(trade => {
    const sport = extractSportFromSlug(trade.slug || trade.eventSlug);
    const { homeTeam, awayTeam } = extractTeamsFromTitle(trade.title);
    
    return {
      type: trade.side.toLowerCase() as 'buy' | 'sell',
      question: trade.title,
      amount: Math.round(trade.size * trade.price * 100) / 100,
      shares: Math.round(trade.size * 100) / 100,
      price: Math.round(trade.price * 100), // Convert to cents
      time: formatRelativeTime(trade.timestamp),
      sport,
      homeTeam,
      awayTeam,
      platform: 'polymarket' as const,
    };
  });
}

/**
 * Generate PnL chart data from positions
 * Creates a 30-day simulated chart based on current PnL
 */
function generatePnlChart(positions: PolymarketPosition[]): PnlDataPoint[] {
  const totalPnl = positions.reduce((sum, pos) => sum + (pos.cashPnl || 0), 0);
  const chart: PnlDataPoint[] = [];
  
  // Generate 30 days of simulated data
  // Ending at current PnL with some variance
  let currentValue = 0;
  const dailyChange = totalPnl / 30;
  
  for (let day = 1; day <= 30; day++) {
    // Add some randomness but trend towards final PnL
    const variance = (Math.random() - 0.5) * Math.abs(dailyChange) * 2;
    currentValue += dailyChange + variance;
    
    chart.push({
      day,
      value: Math.round(currentValue * 100) / 100,
    });
  }
  
  // Ensure last point matches actual PnL
  if (chart.length > 0) {
    chart[chart.length - 1].value = Math.round(totalPnl * 100) / 100;
  }
  
  return chart;
}

/**
 * Calculate volume by sport
 */
function calculateVolumeBySport(trades: PolymarketTrade[]): SportVolumePoint[] {
  const sportVolumes: Record<string, number> = {};
  
  for (const trade of trades) {
    const sport = extractSportFromSlug(trade.slug || trade.eventSlug);
    const volume = trade.size * trade.price;
    sportVolumes[sport] = (sportVolumes[sport] || 0) + volume;
  }
  
  return Object.entries(sportVolumes)
    .map(([sport, volume]) => ({
      sport: sport.toUpperCase(),
      volume: Math.round(volume * 100) / 100,
      color: SPORT_COLORS[sport] || SPORT_COLORS.other,
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 6); // Top 6 sports
}

// ==================== Main Export ====================

/**
 * Get complete whale profile for a wallet address
 */
export async function getWhaleProfile(wallet: string): Promise<WhaleProfileResponse> {
  // Validate wallet address
  if (!isValidAddress(wallet)) {
    return {
      success: false,
      stats: {} as WhaleStats,
      positions: [],
      recentTrades: [],
      pnlChart: [],
      volumeBySport: [],
      error: 'Invalid wallet address format',
    };
  }
  
  const normalizedWallet = wallet.toLowerCase();
  
  logger.info({
    message: 'Fetching whale profile',
    wallet: normalizedWallet,
  });
  
  try {
    // Fetch trades and positions in parallel
    const [trades, positions] = await Promise.all([
      fetchAllTrades(normalizedWallet, 500),
      fetchPositions(normalizedWallet),
    ]);
    
    logger.info({
      message: 'Whale data fetched',
      wallet: normalizedWallet,
      tradesCount: trades.length,
      positionsCount: positions.length,
    });
    
    // Check if wallet has any activity
    if (trades.length === 0 && positions.length === 0) {
      return {
        success: true,
        stats: {
          wallet: normalizedWallet,
          totalVolume: 0,
          avgTradeSize: 0,
          winRate: 50,
          tradesCount: 0,
          pnl: 0,
          pnlChange: 0,
          firstSeen: 'Never',
          lastActive: 'Never',
          favoriteSport: 'N/A',
        },
        positions: [],
        recentTrades: [],
        pnlChart: [],
        volumeBySport: [],
      };
    }
    
    // Calculate and transform data
    const stats = calculateStats(normalizedWallet, trades, positions);
    const transformedPositions = transformPositions(positions);
    const recentTrades = transformTrades(trades);
    const pnlChart = generatePnlChart(positions);
    const volumeBySport = calculateVolumeBySport(trades);
    
    return {
      success: true,
      stats,
      positions: transformedPositions,
      recentTrades,
      pnlChart,
      volumeBySport,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({
      message: 'Error fetching whale profile',
      wallet: normalizedWallet,
      error: errorMessage,
    });
    
    return {
      success: false,
      stats: {} as WhaleStats,
      positions: [],
      recentTrades: [],
      pnlChart: [],
      volumeBySport: [],
      error: errorMessage,
    };
  }
}

/**
 * Get just the stats for a wallet (lightweight)
 */
export async function getWhaleStats(wallet: string): Promise<{ success: boolean; stats?: WhaleStats; error?: string }> {
  if (!isValidAddress(wallet)) {
    return { success: false, error: 'Invalid wallet address format' };
  }
  
  const normalizedWallet = wallet.toLowerCase();
  
  try {
    const [trades, positions] = await Promise.all([
      fetchAllTrades(normalizedWallet, 200),
      fetchPositions(normalizedWallet),
    ]);
    
    const stats = calculateStats(normalizedWallet, trades, positions);
    return { success: true, stats };
  } catch (error) {
    return { 
      success: false, 
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
