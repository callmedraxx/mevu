/**
 * Kalshi Price Update Service
 * Manages real-time Kalshi price updates via WebSocket
 * 
 * Key features:
 * - Receives price events from WebSocket client
 * - Queues updates in memory with deduplication
 * - Batches database writes at intervals (staggered from CLOB)
 * - Publishes to Redis for frontend broadcast
 * - Multi-worker coordination via Redis leader election
 */

import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { connectWithRetry } from '../../config/database';
import { logger } from '../../config/logger';
import { getKalshiWebSocketClient, KalshiTickerMessage, KalshiWebSocketClient } from './kalshi-websocket.client';
import { getKalshiTickerMapper, KalshiTickerMapper, TickerMapping } from './kalshi-ticker-mapper';
import {
  publishKalshiPriceBroadcast,
  publishKalshiPriceBroadcastActivity,
  initRedisClusterBroadcast,
  isRedisClusterBroadcastReady,
} from '../redis-cluster-broadcast.service';
import { registerOnGamesRefreshed } from '../polymarket/live-games.service';
import { ingestDebugLog, ingestDebugLogWithBackup } from '../../config/debug-ingest';

// Queue settings
const MAX_QUEUE_SIZE = 1000;           // Max entries before forced flush
const FLUSH_INTERVAL_MS = 5000;         // Flush every 5 seconds
const FLUSH_OFFSET_MS = 2500;           // Offset from CLOB flush to stagger DB writes

// Leader election settings
const LEADER_LOCK_KEY = 'kalshi:websocket:leader';
const LEADER_LOCK_TTL_SECONDS = 30;
const LEADER_LOCK_REFRESH_MS = (LEADER_LOCK_TTL_SECONDS - 5) * 1000;

// Redis channel for price updates
const KALSHI_PRICES_CHANNEL = 'kalshi:prices:channel';

export interface KalshiPriceUpdate {
  ticker: string;
  liveGameId: string;
  slug?: string;
  homeTeam: string;
  awayTeam: string;
  sport: string;
  yesBid: number;    // Best bid for YES
  yesAsk: number;    // Best ask for YES
  noBid: number;     // Best bid for NO = 100 - yesAsk
  noAsk: number;     // Best ask for NO = 100 - yesBid
  timestamp: number;
  /** Dollar volume from Kalshi ticker (dollar_volume); populates kalshi_markets.volume so we have non-zero volume even when liquidity is thin */
  dollarVolume?: number;
  // Which team does YES represent in this ticker?
  isAwayTeamTicker?: boolean;  // If true, YES = away team wins
  isHomeTeamTicker?: boolean;  // If true, YES = home team wins
}

export interface KalshiPriceMessage {
  type: 'kalshi_price_update';
  gameId: string;
  slug?: string;
  awayTeam: {
    kalshiBuyPrice: number;
    kalshiSellPrice: number;
  };
  homeTeam: {
    kalshiBuyPrice: number;
    kalshiSellPrice: number;
  };
  /** When set, only these sides have real data; frontend merges and keeps existing for other sides (tennis/soccer partial) */
  updatedSides?: ('away' | 'home')[];
  ticker: string;
  timestamp: number;
}

export class KalshiPriceUpdateService extends EventEmitter {
  // Moneyline price queue: gameId -> latest moneyline price (for frontend_games table)
  private priceQueue: Map<string, KalshiPriceUpdate> = new Map();
  
  // All market prices queue: ticker -> latest price (for Redis broadcast to activity widget)
  private allMarketsQueue: Map<string, KalshiPriceUpdate> = new Map();
  
  // WebSocket client and ticker mapper
  private wsClient: KalshiWebSocketClient | null = null;
  private tickerMapper: KalshiTickerMapper | null = null;
  
  // Leader election
  private isLeader = false;
  private leaderLockRefreshTimer: NodeJS.Timeout | null = null;
  private redis: Redis | null = null;
  private redisSub: Redis | null = null;
  
  // Flush control
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushInProgress = false;
  
  // State
  private isInitialized = false;
  private unregisterOnGamesRefreshed: (() => void) | null = null;
  
  // Worker ID for logging
  private workerId: string;
  
  // Ticker message counter for debugging
  private tickerMessageCount = 0;
  private lastTickerLogTime = 0;

  // Singleton pattern
  private static instance: KalshiPriceUpdateService | null = null;

  static getInstance(): KalshiPriceUpdateService {
    if (!KalshiPriceUpdateService.instance) {
      KalshiPriceUpdateService.instance = new KalshiPriceUpdateService();
    }
    return KalshiPriceUpdateService.instance;
  }

  private constructor() {
    super();
    this.workerId = process.env.WORKER_ID || process.pid.toString();
  }

  /**
   * Initialize the service
   * Performs leader election and starts WebSocket if leader
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn({ message: 'Kalshi price update service already initialized' });
      return;
    }

    logger.info({ message: 'Initializing Kalshi price update service', workerId: this.workerId });

    try {
      // Initialize Redis for leader election and pub/sub
      await this.initializeRedis();

      // Initialize ticker mapper
      this.tickerMapper = getKalshiTickerMapper();
      await this.tickerMapper.initialize();

      // Attempt to become leader
      this.isLeader = await this.tryAcquireLeaderLock();

      if (this.isLeader) {
        logger.info({ message: 'This worker is the Kalshi WebSocket leader', workerId: this.workerId });
        await this.startAsLeader();
      } else {
        logger.info({ message: 'This worker is a Kalshi follower (no WS connection)', workerId: this.workerId });
        await this.startAsFollower();
      }

      // Register for games refresh to re-subscribe
      this.unregisterOnGamesRefreshed = registerOnGamesRefreshed(() => {
        if (this.isLeader) {
          this.refreshSubscriptions().catch(err => {
            logger.error({
              message: 'Error refreshing Kalshi subscriptions after games refresh',
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      });

      this.isInitialized = true;
      logger.info({ message: 'Kalshi price update service initialized', isLeader: this.isLeader });
    } catch (error) {
      logger.error({
        message: 'Failed to initialize Kalshi price update service',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Initialize Redis connections
   */
  private async initializeRedis(): Promise<void> {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      logger.warn({ message: 'No REDIS_URL configured, Kalshi price updates will be local only' });
      return;
    }

    const redisOptions = {
      maxRetriesPerRequest: 3,
      connectTimeout: 10000,
      commandTimeout: 10000,
    };

    try {
      this.redis = new Redis(redisUrl, redisOptions);
      this.redisSub = new Redis(redisUrl, redisOptions);

      this.redis.on('error', (err) => {
        logger.warn({ message: 'Kalshi price service Redis error', error: err.message });
      });

      this.redisSub.on('error', (err) => {
        logger.warn({ message: 'Kalshi price service Redis sub error', error: err.message });
      });

      // Subscribe to price channel for follower workers
      this.redisSub.on('message', (channel, message) => {
        if (channel === KALSHI_PRICES_CHANNEL && !this.isLeader) {
          this.handleRedisPriceMessage(message);
        }
      });

      await this.redisSub.subscribe(KALSHI_PRICES_CHANNEL);
      
      logger.info({ message: 'Kalshi price service Redis initialized' });
    } catch (error) {
      logger.warn({
        message: 'Failed to initialize Redis for Kalshi price service',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Try to acquire leader lock using Redis SET NX
   */
  private async tryAcquireLeaderLock(): Promise<boolean> {
    if (!this.redis) {
      // Without Redis, assume we're the leader (single worker mode)
      logger.info({ message: 'No Redis, assuming leader' });
      return true;
    }

    try {
      // First check if lock exists and who holds it
      const existingLock = await this.redis.get(LEADER_LOCK_KEY);
      logger.info({
        message: 'Checking leader lock status',
        existingLock,
        ourWorkerId: this.workerId,
      });

      const result = await this.redis.set(
        LEADER_LOCK_KEY,
        this.workerId,
        'EX',
        LEADER_LOCK_TTL_SECONDS,
        'NX'
      );

      logger.info({
        message: 'Leader lock acquisition attempt result',
        result,
        acquired: result === 'OK',
        workerId: this.workerId,
      });

      if (result === 'OK') {
        // Start lock refresh timer
        this.leaderLockRefreshTimer = setInterval(async () => {
          try {
            await this.redis?.expire(LEADER_LOCK_KEY, LEADER_LOCK_TTL_SECONDS);
          } catch (error) {
            logger.warn({
              message: 'Failed to refresh leader lock',
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }, LEADER_LOCK_REFRESH_MS);

        return true;
      }

      return false;
    } catch (error) {
      logger.warn({
        message: 'Leader lock acquisition failed, assuming leader',
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  /**
   * Start as the leader worker (maintains WebSocket connection)
   */
  private async startAsLeader(): Promise<void> {
    // Initialize WebSocket client
    this.wsClient = getKalshiWebSocketClient();
    
    // Set up event handlers
    this.wsClient.on('ticker', (message: KalshiTickerMessage) => {
      this.handleTickerMessage(message);
    });

    this.wsClient.on('connected', () => {
      logger.info({ message: 'Kalshi WebSocket connected (leader)' });
      this.refreshSubscriptions().catch(err => {
        logger.error({
          message: 'Error subscribing after Kalshi WS connect',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    this.wsClient.on('disconnected', (code, reason) => {
      logger.warn({ message: 'Kalshi WebSocket disconnected', code, reason });
    });

    this.wsClient.on('error', (error) => {
      logger.error({
        message: 'Kalshi WebSocket error',
        error: error.message,
      });
    });

    // Connect to Kalshi
    await this.wsClient.connect();

    // Start flush timer (with offset to stagger from CLOB)
    this.startFlushTimer();
  }

  /**
   * Start as a follower worker (subscribes to Redis for price updates)
   */
  private async startAsFollower(): Promise<void> {
    // Follower just listens to Redis pub/sub for price updates
    // The activity-watcher-websocket service will handle broadcasting to clients
    logger.info({ message: 'Kalshi follower worker started, listening to Redis' });
  }

  /**
   * Normalize Kalshi team abbreviation to match our live_games/kalshi_markets format
   * Kalshi uses different abbreviations than our slugs for some teams
   */
  private normalizeKalshiTickerAbbr(abbr: string): string {
    const upperAbbr = abbr.toUpperCase();
    
    // Kalshi -> Our slug format mappings
    // EPL (English Premier League)
    const KALSHI_TO_SLUG: Record<string, string> = {
      'NFO': 'NOT',   // Nottingham Forest
      'MCI': 'MAC',   // Manchester City
      'WHU': 'WES',   // West Ham United
      'AVL': 'AST',   // Aston Villa
      'CFC': 'CHE',   // Chelsea FC
      'LFC': 'LIV',   // Liverpool FC
      // NHL
      'VGK': 'LAS',   // Vegas Golden Knights
      'LA': 'LAK',    // LA Kings
      'CGY': 'CAL',   // Calgary Flames
      'MTL': 'MON',   // Montreal Canadiens
      'UTA': 'UTAH',  // Utah Hockey Club (NHL only, not NBA Jazz!)
      'SJ': 'SJS',    // San Jose Sharks
      // Men's Winter Olympics Hockey (mwoh) — ISO 3166-1 alpha-3 → slug abbr
      'CHE': 'SWI',   // Switzerland
      'DEU': 'GER',   // Germany
      'LVA': 'LAT',   // Latvia
      'DNK': 'DEN',   // Denmark
      'SVN': 'SLO',   // Slovenia
      'SVK': 'SLO',   // Slovakia (our slug uses "slo")
    };
    
    return KALSHI_TO_SLUG[upperAbbr] || upperAbbr;
  }

  /**
   * Derive away/home abbreviations from game slug (same convention as kalshi-matcher).
   * Slug format: league-awayname-homename-... e.g. atp-sinner-sinner-2025-02-06
   * Returns UPPER(LEFT(part2, 3)) and UPPER(LEFT(part3, 3)) so ticker suffix can be matched.
   */
  private getAwayHomeAbbrFromSlug(slug: string): { awayAbbr: string; homeAbbr: string } | null {
    if (!slug || typeof slug !== 'string') return null;
    const parts = slug.split('-');
    if (parts.length < 3) return null;
    const awayPart = parts[1];
    const homePart = parts[2];
    if (!awayPart || !homePart) return null;
    return {
      awayAbbr: awayPart.slice(0, 3).toUpperCase(),
      homeAbbr: homePart.slice(0, 3).toUpperCase(),
    };
  }

  /**
   * Extract the team abbreviation from a Kalshi ticker
   * e.g., KXNBAGAME-26FEB06LACSAC-LAC -> LAC
   * e.g., KXNBAGAME-26FEB06LACSAC-SAC -> SAC
   * e.g., KXEPLGAME-26FEB06LEENFO-NFO -> NOT (normalized from NFO)
   */
  private extractTeamFromTicker(ticker: string): string | null {
    const upperTicker = ticker.toUpperCase();
    
    // Moneyline ticker ends with -TEAMABBR (2-4 letters only, no numbers)
    // This excludes spread markers like -SAC9 or -SEA5
    const match = upperTicker.match(/-([A-Z]{2,4})$/);
    if (match) {
      // Normalize the abbreviation to match our database format
      return this.normalizeKalshiTickerAbbr(match[1]);
    }
    
    return null;
  }

  /**
   * Check if a ticker is a moneyline market (not spread/total/tie)
   * Moneyline tickers end with `-TEAMABBR` (2-4 uppercase letters only)
   * Spread tickers: KXNBASPREAD, KXNFLSPREAD, or end with team+number like -SAC9, -SEA5
   * Total tickers have suffixes like `OVER230.5`, `UNDER230.5`
   * TIE/DRAW tickers end with `-TIE` (soccer draw markets)
   * UFC tickers: KXUFCFIGHT-YYMONDDXXX where XXX is 3-letter code
   */
  private isMoneylineMarket(ticker: string): boolean {
    const upperTicker = ticker.toUpperCase();
    
    // UFC fights are single-market (YES = fighter1 wins) - treat as moneyline
    if (upperTicker.startsWith('KXUFCFIGHT-')) {
      // UFC ticker format: KXUFCFIGHT-26FEB07OLEBAR
      // Should NOT contain +/- for spreads
      return !ticker.includes('+') && !ticker.includes('OVER') && !ticker.includes('UNDER');
    }

    // Men's Winter Olympics Hockey: single binary market per game
    // Ticker format: KXWOMHOCKEY-26FEB12CHEFRA (YES = first team / away wins)
    if (upperTicker.startsWith('KXWOMHOCKEY-')) {
      return !ticker.includes('+') && !ticker.includes('OVER') && !ticker.includes('UNDER');
    }

    // Tennis matches are single-market (YES = player1 wins) - treat as moneyline
    // WTA ticker format: KXWTAMATCH-26FEB06ZARBIR (ZAR=Zarazua, BIR=Birrell)
    // ATP ticker format: KXATPMATCH-26FEB06XXXYYY
    if (upperTicker.startsWith('KXWTAMATCH-') || upperTicker.startsWith('KXATPMATCH-')) {
      // Should NOT contain +/- for spreads (though tennis on Kalshi doesn't have spreads currently)
      return !ticker.includes('+') && !ticker.includes('OVER') && !ticker.includes('UNDER');
    }
    
    // Skip spread markets by ticker prefix (e.g., KXNBASPREAD, KXNFLSPREAD)
    if (upperTicker.includes('SPREAD')) {
      return false;
    }
    
    // Skip total markets by ticker prefix (e.g., KXNBATOTAL, KXNFLTOTAL)
    if (upperTicker.includes('TOTAL')) {
      return false;
    }
    
    // Standard game markets (NBA, NFL, etc.)
    // Moneyline: KXNBAGAME-26FEB06INDMIL-IND (ends with -TEAMABBR, 2-4 letters)
    // Spread: KXNBAGAME-26FEB06INDMIL-IND+11.5 (has + or - followed by number)
    // Total: KXNBAGAME-26FEB06INDMIL-OVER230.5 (contains OVER or UNDER)
    
    // Check for spread/total patterns
    if (ticker.includes('OVER') || ticker.includes('UNDER')) {
      return false;
    }
    
    // Check for spread pattern: ends with +X.X or -X.X (number after team abbr)
    // e.g., -IND+11.5 or -MIL-5.5
    const spreadPattern = /[+-]\d+\.?\d*$/;
    if (spreadPattern.test(ticker)) {
      return false;
    }
    
    // Skip spread markets that end with team+number (e.g., -SAC9, -SEA5, -IND12)
    // Moneyline should end with letters only, not letters+numbers
    const teamPlusNumberPattern = /-[A-Z]{2,4}\d+$/;
    if (teamPlusNumberPattern.test(upperTicker)) {
      return false;
    }
    
    // Skip TIE/DRAW markets (soccer) - they don't belong to home or away team
    // e.g., KXEPLGAME-26FEB07BOUAVL-TIE, KXLALIGAGAME-26FEB06RCCOSA-TIE
    if (upperTicker.endsWith('-TIE') || upperTicker.endsWith('-DRAW')) {
      return false;
    }
    
    // Should end with -TEAMABBR (2-4 uppercase letters ONLY, no numbers)
    const moneylinePattern = /-[A-Z]{2,4}$/;
    return moneylinePattern.test(upperTicker);
  }

  /**
   * Handle incoming ticker message from Kalshi WebSocket
   */
  private handleTickerMessage(message: KalshiTickerMessage): void {
    // Count all ticker messages for debugging
    this.tickerMessageCount++;
    const now = Date.now();
    if (now - this.lastTickerLogTime > 30000) { // Log every 30 seconds
      logger.info({
        message: 'Kalshi ticker messages received',
        count: this.tickerMessageCount,
        queueSize: this.priceQueue.size,
        allMarketsQueueSize: this.allMarketsQueue.size,
      });
      this.lastTickerLogTime = now;
    }
    
    if (!this.tickerMapper) return;

    const ticker = message.msg.market_ticker;

    // Debug: Log all tennis ticker messages to trace the flow
    if (ticker.toUpperCase().includes('ATPMATCH') || ticker.toUpperCase().includes('WTAMATCH')) {
      logger.info({
        message: 'Tennis ticker message received',
        ticker,
        yesBid: message.msg.yes_bid,
        yesAsk: message.msg.yes_ask,
      });
    }

    // Debug: Log mwoh ticker messages
    if (ticker.toUpperCase().startsWith('KXWOMHOCKEY-')) {
      logger.info({
        message: 'MWOH ticker message received',
        ticker,
        yesBid: message.msg.yes_bid,
        yesAsk: message.msg.yes_ask,
      });
    }

    const mapping = this.tickerMapper.getMappingForTicker(ticker);
    if (!mapping) {
      // Ticker not mapped to a game - skip
      // Debug: Log unmapped tennis tickers
      if (ticker.toUpperCase().includes('ATPMATCH') || ticker.toUpperCase().includes('WTAMATCH')) {
        logger.warn({
          message: 'Tennis ticker NOT MAPPED - skipping',
          ticker,
          mapperStats: this.tickerMapper.getStats(),
        });
      }
      if (ticker.toUpperCase().startsWith('KXWOMHOCKEY-')) {
        logger.warn({
          message: 'MWOH ticker NOT MAPPED - skipping',
          ticker,
          mapperStats: this.tickerMapper.getStats(),
        });
      }
      return;
    }

    // Get the raw YES prices from Kalshi
    const yesBid = message.msg.yes_bid;
    const yesAsk = message.msg.yes_ask;

    // Determine which team this ticker is for
    // Kalshi ticker ends with team abbr (e.g., KXNBAGAME-26FEB06LACSAC-LAC means YES = LAC wins)
    const tickerTeam = this.extractTeamFromTicker(ticker);
    // For tennis, use slug-derived away/home so our slug order is source of truth (avoids Kalshi vs slug ordering bugs)
    const sport = mapping.sport?.toLowerCase() || '';
    const isTennis = sport === 'tennis';
    const slugAbbr = isTennis && mapping.slug ? this.getAwayHomeAbbrFromSlug(mapping.slug) : null;
    const awayAbbr = slugAbbr ? slugAbbr.awayAbbr : (mapping.awayTeam?.toUpperCase() ?? '');
    const homeAbbr = slugAbbr ? slugAbbr.homeAbbr : (mapping.homeTeam?.toUpperCase() ?? '');

    // Check if this ticker is for the away team or home team
    // When slug gives same abbr for both (e.g. "sinner" vs "sinner"), we can't distinguish by suffix; queuePriceUpdate will assign by order (first=away, second=home)
    const slugSameAbbr = !!(slugAbbr && awayAbbr === homeAbbr);
    let isAwayTeamTicker = tickerTeam === awayAbbr;
    let isHomeTeamTicker = tickerTeam === homeAbbr;
    if (slugSameAbbr && isTennis) {
      // Don't set both true or we'd treat a single ticker as merged; queuePriceUpdate will set one side when it sees the other ticker
      isAwayTeamTicker = false;
      isHomeTeamTicker = false;
    }

    // mwoh: single binary market with no per-team suffix (KXWOMHOCKEY-26FEB12CHEFRA).
    // YES = first-listed team = away team (slug convention: sport-away-home-date).
    if (!isAwayTeamTicker && !isHomeTeamTicker && sport === 'mwoh') {
      isAwayTeamTicker = true;
    }

    // If we can't determine which team, skip (shouldn't happen for moneyline)
    if (!isAwayTeamTicker && !isHomeTeamTicker) {
      logger.debug({
        message: 'Cannot determine team for ticker',
        ticker,
        tickerTeam,
        homeAbbr,
        awayAbbr,
      });
      // Still queue for kalshi_markets update but don't update frontend_games
    }

    const msg = message.msg as { dollar_volume?: number; volume?: number };
    const dollarVolume = msg.dollar_volume ?? (msg.volume != null ? msg.volume : undefined);

    const priceUpdate: KalshiPriceUpdate = {
      ticker,
      liveGameId: mapping.liveGameId,
      slug: mapping.slug,
      homeTeam: mapping.homeTeam,
      awayTeam: mapping.awayTeam,
      sport: mapping.sport,
      // Store raw YES prices - we'll interpret them based on which team's ticker this is
      yesBid,
      yesAsk,
      noBid: 100 - yesAsk,  // NO bid = 100 - YES ask
      noAsk: 100 - yesBid,  // NO ask = 100 - YES bid
      timestamp: message.msg.ts || Date.now(),
      dollarVolume: dollarVolume != null ? Number(dollarVolume) : undefined,
      // Track which team this ticker represents
      isAwayTeamTicker,
      isHomeTeamTicker,
    };

    // Queue ALL market updates for Redis broadcast and kalshi_markets table
    this.allMarketsQueue.set(ticker, priceUpdate);

    // Only queue MONEYLINE markets for frontend_games table (main game display)
    // Spread and total prices would overwrite the moneyline price if we didn't filter
    if (this.isMoneylineMarket(ticker)) {
      // Debug: log EPL ticker team detection
      if (ticker.includes('EPLGAME')) {
        logger.info({
          message: 'EPL moneyline ticker queued',
          ticker,
          tickerTeam,
          homeAbbr,
          awayAbbr,
          isAwayTeamTicker,
          isHomeTeamTicker,
          sport: mapping.sport,
        });
      }
      this.queuePriceUpdate(priceUpdate);
    } else {
      // For non-moneyline markets, still check if we need to force flush
      this.checkAndForceFlush();
    }
  }

  /**
   * Queue a price update for batched processing
   * For soccer games (EPL, LaLiga), merges updates from both team tickers
   * rather than overwriting, since each team has a separate market.
   */
  private queuePriceUpdate(update: KalshiPriceUpdate): void {
    const sport = update.sport?.toLowerCase() || '';
    const isSoccer = sport === 'epl' || sport === 'laliga' || sport === 'soccer';
    const isTennis = sport === 'tennis';
    const isSuperBowl = sport === 'nfl' && update.ticker.toUpperCase().startsWith('KXSB-');

    // For soccer, tennis, and Super Bowl (two tickers per game), merge updates from both team tickers
    // so we send both sides; otherwise we'd overwrite and alternate which side is correct (price swap bug).
    if (isSoccer || isTennis || isSuperBowl) {
      const existing = this.priceQueue.get(update.liveGameId);
      if (existing) {
        // Same ticker (e.g. two price updates for same market): do not merge – would send same prices for both away and home
        if (existing.ticker === update.ticker) {
          // Replace with latest prices; no merge
        } else {
          if (isTennis) {
          // Tennis: two different tickers – assign by order (first = away, second = home) so we don't rely on slug when abbrs match
          (update as any)._mergedAwayPrices = {
            yesBid: existing.yesBid,
            yesAsk: existing.yesAsk,
          };
          update.isAwayTeamTicker = false;
          update.isHomeTeamTicker = true;
        } else if (update.isAwayTeamTicker) {
          // Soccer or Super Bowl: current ticker is away, merge home from existing
          update.isHomeTeamTicker = existing.isHomeTeamTicker;
          if (existing.isHomeTeamTicker) {
            (update as any)._mergedHomePrices = {
              yesBid: existing.yesBid,
              yesAsk: existing.yesAsk,
            };
          }
        } else if (update.isHomeTeamTicker) {
          // Soccer or Super Bowl: current ticker is home, merge away from existing
          update.isAwayTeamTicker = existing.isAwayTeamTicker;
          if (existing.isAwayTeamTicker) {
            (update as any)._mergedAwayPrices = {
              yesBid: existing.yesBid,
              yesAsk: existing.yesAsk,
            };
          }
        }
        }
      }
    }

    this.priceQueue.set(update.liveGameId, update);

    // Memory guard: force flush if either queue is too large
    // This ensures both queues flush together to keep data in sync
    this.checkAndForceFlush();
  }

  /**
   * Check if queues are at capacity and force flush if needed
   * Flushes both queues together to keep frontend_games and kalshi_markets in sync
   */
  private checkAndForceFlush(): void {
    const moneylineQueueSize = this.priceQueue.size;
    const allMarketsQueueSize = this.allMarketsQueue.size;
    
    // Force flush if either queue exceeds capacity
    if (moneylineQueueSize >= MAX_QUEUE_SIZE || allMarketsQueueSize >= MAX_QUEUE_SIZE * 10) {
      // allMarketsQueue can be ~10x larger since it has all tickers per game
      logger.warn({
        message: 'Kalshi price queue at capacity, forcing flush',
        moneylineQueueSize,
        allMarketsQueueSize,
      });
      this.flushPriceUpdates().catch(err => {
        logger.error({
          message: 'Error in forced flush',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Start the flush timer with offset from CLOB
   */
  private startFlushTimer(): void {
    // Offset the first flush to stagger with CLOB (which flushes at 0, 5s, 10s, etc.)
    setTimeout(() => {
      // Start periodic flush
      this.flushTimer = setInterval(() => {
        this.flushPriceUpdates().catch(err => {
          logger.error({
            message: 'Error in periodic Kalshi price flush',
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, FLUSH_INTERVAL_MS);
    }, FLUSH_OFFSET_MS);
  }

  /**
   * Flush price updates to database and broadcast to Redis
   */
  private async flushPriceUpdates(): Promise<void> {
    const hasMoneylineUpdates = this.priceQueue.size > 0;
    const hasAllMarketUpdates = this.allMarketsQueue.size > 0;
    
    if (this.isFlushInProgress || (!hasMoneylineUpdates && !hasAllMarketUpdates)) {
      return;
    }

    this.isFlushInProgress = true;

    // Snapshot and clear queues atomically
    const moneylineUpdates = Array.from(this.priceQueue.values());
    const allMarketUpdates = Array.from(this.allMarketsQueue.values());
    this.priceQueue.clear();
    this.allMarketsQueue.clear();
    
    // For backward compatibility, use moneylineUpdates for DB and legacy Redis
    const updates = moneylineUpdates;

    let client;
    try {
      // Batch update frontend_games table
      client = await connectWithRetry(3, 100);
      
      await client.query('BEGIN');

      // Build batch update query using CTE
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      // Separate updates for soccer (partial updates) vs other sports (full updates)
      const fullUpdates: { liveGameId: string; awayBuy: number; awaySell: number; homeBuy: number; homeSell: number }[] = [];
      const awayOnlyUpdates: { liveGameId: string; awayBuy: number; awaySell: number }[] = [];
      const homeOnlyUpdates: { liveGameId: string; homeBuy: number; homeSell: number }[] = [];

      for (const update of updates) {
        // Check for merged soccer prices (from both team tickers)
        const mergedAwayPrices = (update as any)._mergedAwayPrices;
        const mergedHomePrices = (update as any)._mergedHomePrices;
        const sport = update.sport?.toLowerCase() || '';
        const isSoccer = sport === 'epl' || sport === 'laliga' || sport === 'soccer';
        
        if (update.isAwayTeamTicker && update.isHomeTeamTicker) {
          // BOTH teams have been seen - we have complete data
          let awayBuy: number, awaySell: number, homeBuy: number, homeSell: number;
          if (mergedAwayPrices) {
            // Current ticker is for home, away prices were merged from previous ticker
            homeBuy = update.yesAsk;
            homeSell = update.yesBid;
            awayBuy = mergedAwayPrices.yesAsk;
            awaySell = mergedAwayPrices.yesBid;
          } else if (mergedHomePrices) {
            // Current ticker is for away, home prices were merged from previous ticker
            awayBuy = update.yesAsk;
            awaySell = update.yesBid;
            homeBuy = mergedHomePrices.yesAsk;
            homeSell = mergedHomePrices.yesBid;
          } else {
            // Fallback - shouldn't happen for merged
            awayBuy = update.yesAsk;
            awaySell = update.yesBid;
            homeBuy = update.noAsk;
            homeSell = update.noBid;
          }
          fullUpdates.push({ liveGameId: update.liveGameId, awayBuy, awaySell, homeBuy, homeSell });
        } else if (update.isAwayTeamTicker) {
          if (isSoccer) {
            // Soccer: only update away team prices, don't touch home (NO is not accurate)
            awayOnlyUpdates.push({
              liveGameId: update.liveGameId,
              awayBuy: update.yesAsk,
              awaySell: update.yesBid,
            });
          } else {
            // Non-soccer: YES = away, NO = home (binary market)
            fullUpdates.push({
              liveGameId: update.liveGameId,
              awayBuy: update.yesAsk,
              awaySell: update.yesBid,
              homeBuy: update.noAsk,
              homeSell: update.noBid,
            });
          }
        } else if (update.isHomeTeamTicker) {
          if (isSoccer) {
            // Soccer: only update home team prices, don't touch away
            logger.info({
              message: 'Soccer home team update queued',
              ticker: update.ticker,
              liveGameId: update.liveGameId,
              homeBuy: update.yesAsk,
              homeSell: update.yesBid,
            });
            homeOnlyUpdates.push({
              liveGameId: update.liveGameId,
              homeBuy: update.yesAsk,
              homeSell: update.yesBid,
            });
          } else {
            // Non-soccer: YES = home, NO = away (binary market)
            fullUpdates.push({
              liveGameId: update.liveGameId,
              awayBuy: update.noAsk,
              awaySell: update.noBid,
              homeBuy: update.yesAsk,
              homeSell: update.yesBid,
            });
          }
        } else {
          // Unknown team - skip frontend_games update
          logger.debug({
            message: 'Cannot determine team for frontend_games update, skipping (kalshi_markets still updated)',
            ticker: update.ticker,
            liveGameId: update.liveGameId,
            tickerTeam: this.extractTeamFromTicker(update.ticker),
            mappedHomeTeam: update.homeTeam,
            mappedAwayTeam: update.awayTeam,
          });
          continue;
        }
      }

      // Full updates (all 4 prices)
      for (const u of fullUpdates) {
        placeholders.push(
          `($${paramIndex++}::text, $${paramIndex++}::int, $${paramIndex++}::int, $${paramIndex++}::int, $${paramIndex++}::int)`
        );
        values.push(u.liveGameId, u.awayBuy, u.awaySell, u.homeBuy, u.homeSell);
      }

      if (placeholders.length > 0) {
        // Update frontend_data JSONB with Kalshi prices (full updates - all 4 prices)
        await client.query(`
          UPDATE frontend_games fg
          SET frontend_data = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(
                      fg.frontend_data,
                      '{awayTeam,kalshiBuyPrice}', to_jsonb(u.away_buy)
                    ),
                    '{awayTeam,kalshiSellPrice}', to_jsonb(u.away_sell)
                  ),
                  '{homeTeam,kalshiBuyPrice}', to_jsonb(u.home_buy)
                ),
                '{homeTeam,kalshiSellPrice}', to_jsonb(u.home_sell)
              ),
              updated_at = NOW()
          FROM (
            VALUES ${placeholders.join(', ')}
          ) AS u(live_game_id, away_buy, away_sell, home_buy, home_sell)
          WHERE fg.id = u.live_game_id
        `, values);
      }

      // Soccer partial updates: away team only
      if (awayOnlyUpdates.length > 0) {
        const awayPlaceholders: string[] = [];
        const awayValues: any[] = [];
        let awayIdx = 1;
        for (const u of awayOnlyUpdates) {
          awayPlaceholders.push(`($${awayIdx++}::text, $${awayIdx++}::int, $${awayIdx++}::int)`);
          awayValues.push(u.liveGameId, u.awayBuy, u.awaySell);
        }
        await client.query(`
          UPDATE frontend_games fg
          SET frontend_data = jsonb_set(
                jsonb_set(
                  fg.frontend_data,
                  '{awayTeam,kalshiBuyPrice}', to_jsonb(u.away_buy)
                ),
                '{awayTeam,kalshiSellPrice}', to_jsonb(u.away_sell)
              ),
              updated_at = NOW()
          FROM (
            VALUES ${awayPlaceholders.join(', ')}
          ) AS u(live_game_id, away_buy, away_sell)
          WHERE fg.id = u.live_game_id
        `, awayValues);
      }

      // Soccer partial updates: home team only
      if (homeOnlyUpdates.length > 0) {
        const homePlaceholders: string[] = [];
        const homeValues: any[] = [];
        let homeIdx = 1;
        for (const u of homeOnlyUpdates) {
          homePlaceholders.push(`($${homeIdx++}::text, $${homeIdx++}::int, $${homeIdx++}::int)`);
          homeValues.push(u.liveGameId, u.homeBuy, u.homeSell);
        }
        await client.query(`
          UPDATE frontend_games fg
          SET frontend_data = jsonb_set(
                jsonb_set(
                  fg.frontend_data,
                  '{homeTeam,kalshiBuyPrice}', to_jsonb(u.home_buy)
                ),
                '{homeTeam,kalshiSellPrice}', to_jsonb(u.home_sell)
              ),
              updated_at = NOW()
          FROM (
            VALUES ${homePlaceholders.join(', ')}
          ) AS u(live_game_id, home_buy, home_sell)
          WHERE fg.id = u.live_game_id
        `, homeValues);
      }

      // Also batch update kalshi_markets table with ALL market prices (spreads, totals, moneyline)
      if (allMarketUpdates.length > 0) {
        await this.batchUpdateKalshiMarkets(client, allMarketUpdates);
      }

      await client.query('COMMIT');

      // Publish moneyline updates to Redis for all workers to broadcast to clients
      await this.publishPriceUpdates(updates);
      
      // Also publish ALL market updates (spreads, totals) for activity widget
      if (allMarketUpdates.length > 0) {
        await this.publishAllMarketUpdates(allMarketUpdates);
      }

      logger.info({
        message: 'Kalshi price flush completed',
        moneylineCount: updates.length,
        allMarketsCount: allMarketUpdates.length,
      });
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }

      logger.error({
        message: 'Kalshi price flush failed',
        error: error instanceof Error ? error.message : String(error),
        updateCount: updates.length,
      });

      // Don't re-queue failed updates - next tick will have fresh data
    } finally {
      if (client) {
        client.release();
      }
      this.isFlushInProgress = false;
    }
  }

  /**
   * Batch update kalshi_markets table with real-time prices
   * Similar to how CLOB updates live_games - keeps prices fresh for page refresh
   */
  private async batchUpdateKalshiMarkets(client: any, updates: KalshiPriceUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    // Build batch update using VALUES clause
    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const update of updates) {
      placeholders.push(
        `($${paramIndex++}::text, $${paramIndex++}::smallint, $${paramIndex++}::smallint, $${paramIndex++}::smallint, $${paramIndex++}::smallint, $${paramIndex++}::numeric)`
      );
      values.push(
        update.ticker,
        update.yesBid,
        update.yesAsk,
        100 - update.yesAsk,  // no_bid = 100 - yes_ask
        100 - update.yesBid,  // no_ask = 100 - yes_bid
        update.dollarVolume != null ? update.dollarVolume : null
      );
    }

    // Batch update kalshi_markets prices and volume (dollar_volume from ticker so we have non-zero volume even when liquidity is thin)
    await client.query(`
      UPDATE kalshi_markets km
      SET 
        yes_bid = u.yes_bid,
        yes_ask = u.yes_ask,
        no_bid = u.no_bid,
        no_ask = u.no_ask,
        volume = COALESCE(u.volume, km.volume),
        updated_at = NOW()
      FROM (
        VALUES ${placeholders.join(', ')}
      ) AS u(ticker, yes_bid, yes_ask, no_bid, no_ask, volume)
      WHERE km.ticker = u.ticker
    `, values);

    logger.debug({
      message: 'Kalshi markets prices updated',
      count: updates.length,
    });
  }

  /**
   * Publish price updates to Redis for broadcasting
   */
  private async publishPriceUpdates(updates: KalshiPriceUpdate[]): Promise<void> {
    // Check if we have any way to publish (either direct Redis or cluster broadcast)
    const hasDirectRedis = this.redis !== null;
    const hasClusterBroadcast = isRedisClusterBroadcastReady();
    
    if (!hasDirectRedis && !hasClusterBroadcast) {
      return;
    }

    for (const update of updates) {
      // Determine away/home prices based on which team the ticker represents
      let awayBuy: number, awaySell: number, homeBuy: number, homeSell: number;
      const mergedAway = (update as any)._mergedAwayPrices;
      const mergedHome = (update as any)._mergedHomePrices;
      const isMerged = update.isAwayTeamTicker && update.isHomeTeamTicker && (mergedAway ?? mergedHome);
      const sport = update.sport?.toLowerCase() || '';
      const isTennis = sport === 'tennis';
      const isSoccer = sport === 'epl' || sport === 'laliga' || sport === 'soccer';
      const isSuperBowl = sport === 'nfl' && update.ticker.toUpperCase().startsWith('KXSB-');
      const isTwoTickerSport = isTennis || isSoccer || isSuperBowl;

      if (update.isAwayTeamTicker && update.isHomeTeamTicker && (mergedAway ?? mergedHome)) {
        // Merged update (both tickers) – both sides are real
        if (mergedAway) {
          homeBuy = update.yesAsk;
          homeSell = update.yesBid;
          awayBuy = mergedAway.yesAsk;
          awaySell = mergedAway.yesBid;
        } else {
          awayBuy = update.yesAsk;
          awaySell = update.yesBid;
          homeBuy = mergedHome!.yesAsk;
          homeSell = mergedHome!.yesBid;
        }
      } else if (update.isAwayTeamTicker) {
        awayBuy = update.yesAsk;
        awaySell = update.yesBid;
        homeBuy = update.noAsk;
        homeSell = update.noBid;
      } else if (update.isHomeTeamTicker) {
        homeBuy = update.yesAsk;
        homeSell = update.yesBid;
        awayBuy = update.noAsk;
        awaySell = update.noBid;
      } else {
        continue;
      }
      // For tennis/soccer: send partial updates so frontend merges by side (avoids swap).
      // Single-ticker: one message with updatedSides. Merged: two messages (away then home) so frontend always sees updatedSides.
      const partialAwayOnly = isTwoTickerSport && !isMerged && update.isAwayTeamTicker;
      const partialHomeOnly = isTwoTickerSport && !isMerged && update.isHomeTeamTicker;
      const mergedTwoTicker = isTwoTickerSport && isMerged;

      const messagesToSend: KalshiPriceMessage[] = [];

      // Never send a message that sets an updated side to 0/0 – frontend would overwrite good data with zeros.
      const awayHasPrice = awayBuy !== 0 || awaySell !== 0;
      const homeHasPrice = homeBuy !== 0 || homeSell !== 0;

      if (mergedTwoTicker) {
        // Send two messages so frontend receives updatedSides and merges. Skip a side if we have no price for it.
        if (awayHasPrice) {
          messagesToSend.push({
            type: 'kalshi_price_update',
            gameId: String(update.liveGameId),
            slug: update.slug,
            awayTeam: { kalshiBuyPrice: awayBuy, kalshiSellPrice: awaySell },
            homeTeam: { kalshiBuyPrice: 0, kalshiSellPrice: 0 },
            updatedSides: ['away'],
            ticker: update.ticker,
            timestamp: update.timestamp,
          });
        }
        if (homeHasPrice) {
          messagesToSend.push({
            type: 'kalshi_price_update',
            gameId: String(update.liveGameId),
            slug: update.slug,
            awayTeam: { kalshiBuyPrice: 0, kalshiSellPrice: 0 },
            homeTeam: { kalshiBuyPrice: homeBuy, kalshiSellPrice: homeSell },
            updatedSides: ['home'],
            ticker: update.ticker,
            timestamp: update.timestamp,
          });
        }
      } else {
        const updatedSides: ('away' | 'home')[] | undefined =
          partialAwayOnly ? ['away'] : partialHomeOnly ? ['home'] : undefined;
        const partialWouldOverwriteWithZero =
          (partialAwayOnly && !awayHasPrice) || (partialHomeOnly && !homeHasPrice);
        if (!partialWouldOverwriteWithZero) {
          messagesToSend.push({
            type: 'kalshi_price_update',
            gameId: String(update.liveGameId),
            slug: update.slug,
            awayTeam: {
              kalshiBuyPrice: partialHomeOnly ? 0 : awayBuy,
              kalshiSellPrice: partialHomeOnly ? 0 : awaySell,
            },
            homeTeam: {
              kalshiBuyPrice: partialAwayOnly ? 0 : homeBuy,
              kalshiSellPrice: partialAwayOnly ? 0 : homeSell,
            },
            ...(updatedSides && { updatedSides }),
            ticker: update.ticker,
            timestamp: update.timestamp,
          });
        }
      }

      for (const message of messagesToSend) {
        if (hasDirectRedis) {
          try {
            await this.redis!.publish(KALSHI_PRICES_CHANNEL, JSON.stringify(message));
          } catch (err) {
            logger.warn({
              message: 'Failed to publish Kalshi price update to Redis',
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (hasClusterBroadcast) {
          logger.info({
            message: '[Kalshi broadcast] Publishing kalshi_price_update to Redis',
            gameId: message.gameId,
            updatedSides: message.updatedSides,
            awayBuy: message.awayTeam.kalshiBuyPrice,
            homeBuy: message.homeTeam.kalshiBuyPrice,
          });
          publishKalshiPriceBroadcast(message);
        }
      }
    }
  }

  /**
   * Publish ALL market updates (including spreads, totals) to Redis
   * These are used by the activity widget for real-time updates on all market types
   */
  private async publishAllMarketUpdates(updates: KalshiPriceUpdate[]): Promise<void> {
    if (!this.redis && !isRedisClusterBroadcastReady()) return;

    for (const update of updates) {
      // For all markets broadcast, include raw YES/NO prices with ticker
      // The activity widget can interpret based on ticker
      const message: KalshiPriceMessage = {
        type: 'kalshi_price_update',
        gameId: String(update.liveGameId),
        slug: update.slug,
        awayTeam: {
          // For non-moneyline (spreads/totals), YES/NO don't map directly to teams
          // Include raw prices - activity widget fetches fresh data anyway
          kalshiBuyPrice: update.yesAsk,
          kalshiSellPrice: update.yesBid,
        },
        homeTeam: {
          kalshiBuyPrice: update.noAsk,
          kalshiSellPrice: update.noBid,
        },
        ticker: update.ticker,
        timestamp: update.timestamp,
      };

      // Publish to activity channel only (games list uses moneyline channel with updatedSides)
      if (isRedisClusterBroadcastReady()) {
        publishKalshiPriceBroadcastActivity(message);
      }
    }
  }

  /**
   * Handle price message received from Redis (follower workers)
   */
  private handleRedisPriceMessage(message: string): void {
    try {
      const priceMessage = JSON.parse(message) as KalshiPriceMessage;
      
      // Emit event for activity watcher to pick up
      this.emit('price_update', priceMessage);
    } catch (error) {
      logger.warn({
        message: 'Failed to parse Redis price message',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Refresh WebSocket subscriptions based on current ticker mappings
   */
  private async refreshSubscriptions(): Promise<void> {
    if (!this.wsClient || !this.tickerMapper) {
      return;
    }

    // Refresh ticker mapper cache
    await this.tickerMapper.refreshCache();

    // Get all mapped tickers
    const tickers = this.tickerMapper.getAllMappedTickers();

    if (tickers.length === 0) {
      logger.info({ message: 'No Kalshi tickers to subscribe to' });
      return;
    }

    // Subscribe to all mapped tickers
    await this.wsClient.subscribeToMarkets(tickers);

    logger.info({
      message: 'Kalshi subscriptions refreshed',
      tickerCount: tickers.length,
    });
  }

  /**
   * Get service status
   */
  getStatus(): {
    isInitialized: boolean;
    isLeader: boolean;
    queueSize: number;
    wsStatus: { isConnected: boolean; subscriptionCount: number } | null;
    mapperStats: { tickerCount: number; gameCount: number } | null;
  } {
    return {
      isInitialized: this.isInitialized,
      isLeader: this.isLeader,
      queueSize: this.priceQueue.size,
      wsStatus: this.wsClient?.getStatus() || null,
      mapperStats: this.tickerMapper?.getStats() || null,
    };
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    // Clear timers
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.leaderLockRefreshTimer) {
      clearInterval(this.leaderLockRefreshTimer);
      this.leaderLockRefreshTimer = null;
    }

    // Unregister callbacks
    if (this.unregisterOnGamesRefreshed) {
      this.unregisterOnGamesRefreshed();
      this.unregisterOnGamesRefreshed = null;
    }

    // Flush any remaining updates
    if (this.priceQueue.size > 0) {
      await this.flushPriceUpdates().catch(() => {});
    }

    // Shutdown WebSocket
    if (this.wsClient) {
      await this.wsClient.shutdown();
      this.wsClient = null;
    }

    // Shutdown ticker mapper
    if (this.tickerMapper) {
      await this.tickerMapper.shutdown();
      this.tickerMapper = null;
    }

    // Release leader lock
    if (this.redis && this.isLeader) {
      try {
        await this.redis.del(LEADER_LOCK_KEY);
      } catch {}
    }

    // Close Redis connections
    if (this.redisSub) {
      await this.redisSub.quit();
      this.redisSub = null;
    }

    if (this.redis) {
      await this.redis.quit();
      this.redis = null;
    }

    this.priceQueue.clear();
    this.isInitialized = false;
    this.isLeader = false;

    logger.info({ message: 'Kalshi price update service shut down' });
  }
}

// Export singleton getter and instance
export function getKalshiPriceUpdateService(): KalshiPriceUpdateService {
  return KalshiPriceUpdateService.getInstance();
}

export const kalshiPriceUpdateService = KalshiPriceUpdateService.getInstance();
