Kalshi WebSocket Integration Plan
Executive Summary
This plan outlines a careful, phased approach to integrate Kalshi real-time price updates via WebSocket while preserving the existing Polymarket CLOB price streaming infrastructure. The design prioritizes database connection management, memory efficiency, and multi-worker coordination.
1. Current Architecture Analysis
1.1 Existing CLOB Price Update Flow
┌─────────────────────────────────────────────────────────────────────────────┐│                         CURRENT ARCHITECTURE                                 │├─────────────────────────────────────────────────────────────────────────────┤│                                                                              ││  Polymarket CLOB WebSocket                                                   ││         │                                                                    ││         ▼                                                                    ││  clob-price-update.service.ts                                               ││    - Subscribes to price_change events                                       ││    - Queues updates in memory (priceUpdateQueue)                            ││    - Batches DB writes (queueDatabaseWrite → flushPriceUpdates)             ││    - Updates frontend_games table                                            ││         │                                                                    ││         ▼                                                                    ││  Redis Games Cache (redis-games-cache.service.ts)                           ││    - Caches frontend game data                                               ││    - Invalidation on updates                                                 ││         │                                                                    ││         ▼                                                                    ││  Frontend WebSocket (activity-watcher-websocket.service.ts)                 ││    - Sends price_update events to connected clients                          ││    - Broadcasts per-game updates                                             ││                                                                              │└─────────────────────────────────────────────────────────────────────────────┘
1.2 Key Design Patterns to Preserve
Batched Database Writes: Never write to DB on every price tick; batch with configurable flush intervals
Memory-Bounded Queues: Use Maps with fixed-size considerations to prevent memory bloat
Single Worker Responsibility: Only one worker handles WebSocket connections (via isMainWorker checks)
Redis Coordination: Use Redis for cross-worker state and cache invalidation
Graceful Degradation: Connection failures shouldn't crash workers
2. Kalshi WebSocket API Analysis
Based on the Kalshi AsyncAPI documentation:
2.1 Relevant Channels
Channel	Purpose	Authentication
ticker	Price/volume updates (yes_bid, yes_ask, volume)	Required for connection
ticker_v2	Incremental ticker deltas	Required for connection
2.2 Key Considerations
Authentication: API key required during WebSocket handshake
Heartbeat: Kalshi sends Ping every 10 seconds; must respond with Pong
Subscription Limit: Can subscribe to multiple markets per connection
Message Format: JSON with type, sid, seq, msg structure
2.3 Ticker Message Structure
interface KalshiTickerMessage {  type: 'ticker';  sid: number;  msg: {    market_ticker: string;      // e.g., "KXNBAGAME-26FEB05CHAHOU-CHA"    market_id: string;    price: number;              // Last traded price (1-99 cents)    yes_bid: number;            // Best bid for YES    yes_ask: number;            // Best ask for YES    volume: number;    open_interest: number;    ts: number;                 // Unix timestamp  };}
3. Proposed Architecture
3.1 High-Level Design
┌─────────────────────────────────────────────────────────────────────────────┐│                         PROPOSED ARCHITECTURE                                │├─────────────────────────────────────────────────────────────────────────────┤│                                                                              ││  ┌─────────────────────┐     ┌─────────────────────┐                        ││  │ Polymarket CLOB WS  │     │   Kalshi WS         │                        ││  │ (existing)          │     │   (NEW)             │                        ││  └─────────┬───────────┘     └─────────┬───────────┘                        ││            │                           │                                     ││            ▼                           ▼                                     ││  ┌─────────────────────┐     ┌─────────────────────┐                        ││  │ clob-price-update   │     │ kalshi-price-update │  ◄── NEW SERVICE       ││  │ .service.ts         │     │ .service.ts         │                        ││  │                     │     │                     │                        ││  │ - priceUpdateQueue  │     │ - kalshiPriceQueue  │                        ││  │ - 5s flush interval │     │ - 5s flush interval │                        ││  └─────────┬───────────┘     └─────────┬───────────┘                        ││            │                           │                                     ││            └───────────┬───────────────┘                                     ││                        ▼                                                     ││            ┌───────────────────────┐                                         ││            │ Unified Price Manager │  ◄── NEW COORDINATOR                    ││            │ (coordinates batches) │                                         ││            └───────────┬───────────┘                                         ││                        │                                                     ││            ┌───────────┴───────────┐                                         ││            ▼                       ▼                                         ││  ┌─────────────────┐    ┌─────────────────────┐                             ││  │ PostgreSQL      │    │ Redis               │                             ││  │ (frontend_games)│    │ - Price cache       │                             ││  │                 │    │ - Pub/Sub channels  │                             ││  └─────────────────┘    └─────────┬───────────┘                             ││                                   │                                          ││                                   ▼                                          ││            ┌─────────────────────────────────────┐                           ││            │ activity-watcher-websocket.service  │                           ││            │ - Subscribes to Redis price channels│                           ││            │ - Broadcasts to frontend clients    │                           ││            │                                     │                           ││            │ Events:                             │                           ││            │ - price_update (CLOB)               │                           ││            │ - kalshi_price_update (NEW)         │                           ││            └─────────────────────────────────────┘                           ││                                                                              │└─────────────────────────────────────────────────────────────────────────────┘
3.2 New Files to Create
File	Purpose
src/services/kalshi/kalshi-websocket.client.ts	Low-level WebSocket connection management
src/services/kalshi/kalshi-price-update.service.ts	Price queue management and batching
src/services/kalshi/kalshi-ticker-mapper.ts	Maps Kalshi tickers to live_game_ids
4. Detailed Component Design
4.1 Kalshi WebSocket Client (kalshi-websocket.client.ts)
Responsibilities:
Establish authenticated WebSocket connection
Handle Ping/Pong heartbeats
Subscribe to ticker channel for active markets
Emit price events to internal event bus
Key Design Decisions:
class KalshiWebSocketClient extends EventEmitter {  private ws: WebSocket | null = null;  private reconnectAttempts = 0;  private maxReconnectAttempts = 10;  private reconnectDelayMs = 5000;  private subscribedTickers: Set<string> = new Set();    // CRITICAL: Only allow one instance per process  private static instance: KalshiWebSocketClient | null = null;    // Memory guard: Maximum subscriptions to prevent unbounded growth  private static MAX_SUBSCRIPTIONS = 500;}
Connection Lifecycle:
┌─────────────┐     ┌─────────────┐     ┌─────────────┐│   INIT      │────▶│  CONNECTING │────▶│  CONNECTED  │└─────────────┘     └─────────────┘     └──────┬──────┘                                               │                    ┌─────────────┐            │                    │ RECONNECTING│◀───────────┤ (on error/close)                    └──────┬──────┘            │                           │                   │                           └───────────────────┘
Subscription Management:
// Batch subscribe to avoid overwhelming Kalshiasync subscribeToMarkets(tickers: string[]): Promise<void> {  // Chunk into batches of 50 to respect rate limits  const BATCH_SIZE = 50;  const BATCH_DELAY_MS = 100;    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {    const batch = tickers.slice(i, i + BATCH_SIZE);    await this.sendSubscribeCommand(batch);        if (i + BATCH_SIZE < tickers.length) {      await sleep(BATCH_DELAY_MS);    }  }}
4.2 Kalshi Price Update Service (kalshi-price-update.service.ts)
Responsibilities:
Receive price events from WebSocket client
Queue updates in memory with deduplication
Batch flush to database at intervals
Publish to Redis for frontend broadcast
Memory-Safe Queue Design:
interface KalshiPriceUpdate {  ticker: string;  liveGameId: string;  yesBid: number;  yesAsk: number;  noBid: number;   // Derived: 100 - yesAsk  noAsk: number;   // Derived: 100 - yesBid  timestamp: number;}class KalshiPriceUpdateService {  // Deduplication map: only keep latest price per game  private priceQueue: Map<string, KalshiPriceUpdate> = new Map();    // MEMORY GUARD: Maximum queue size before forced flush  private static MAX_QUEUE_SIZE = 1000;    // Flush interval (aligned with CLOB for consistency)  private static FLUSH_INTERVAL_MS = 5000;    // Track if flush is in progress to prevent overlapping writes  private isFlushInProgress = false;}
Batched Database Write Pattern:
private async flushPriceUpdates(): Promise<void> {  if (this.isFlushInProgress || this.priceQueue.size === 0) {    return;  }    this.isFlushInProgress = true;    try {    // Snapshot and clear queue atomically    const updates = Array.from(this.priceQueue.values());    this.priceQueue.clear();        // Single batch update query    await this.batchUpdateFrontendGames(updates);        // Publish to Redis for WebSocket broadcast    await this.publishPriceUpdates(updates);      } catch (error) {    logger.error('Kalshi price flush failed', { error });    // Don't re-queue failed updates; next tick will have fresh data  } finally {    this.isFlushInProgress = false;  }}
Database Update Query (Optimized):
-- Update frontend_data JSONB in batchUPDATE frontend_games fgSET   frontend_data = jsonb_set(    jsonb_set(      jsonb_set(        jsonb_set(          fg.frontend_data,          '{awayTeam,kalshiBuyPrice}', to_jsonb(u.away_buy)        ),        '{awayTeam,kalshiSellPrice}', to_jsonb(u.away_sell)      ),      '{homeTeam,kalshiBuyPrice}', to_jsonb(u.home_buy)    ),    '{homeTeam,kalshiSellPrice}', to_jsonb(u.home_sell)  ),  updated_at = NOW()FROM (  VALUES     ($1::text, $2::int, $3::int, $4::int, $5::int),    ($6::text, $7::int, $8::int, $9::int, $10::int),    -- ... more values) AS u(live_game_id, away_buy, away_sell, home_buy, home_sell)WHERE fg.live_game_id = u.live_game_id
4.3 Ticker-to-Game Mapper (kalshi-ticker-mapper.ts)
Purpose: Efficiently map Kalshi market tickers to our live_game_id without hitting database on every price tick.
Design:
class KalshiTickerMapper {  // In-memory cache: Kalshi ticker → live_game_id  private tickerToGameId: Map<string, string> = new Map();    // Reverse map: live_game_id → Set of Kalshi tickers (for cleanup)  private gameIdToTickers: Map<string, Set<string>> = new Map();    // Cache refresh interval  private static REFRESH_INTERVAL_MS = 60_000; // 1 minute    // Redis key for cross-worker coordination  private static REDIS_TICKER_MAP_KEY = 'kalshi:ticker_map';    async refreshCache(): Promise<void> {    // Load from DB only active markets with live_game_id    const result = await this.loadActiveMarketsFromDB();        // Update in-memory cache    this.tickerToGameId.clear();    this.gameIdToTickers.clear();        for (const row of result) {      this.tickerToGameId.set(row.ticker, row.live_game_id);            const tickers = this.gameIdToTickers.get(row.live_game_id) || new Set();      tickers.add(row.ticker);      this.gameIdToTickers.set(row.live_game_id, tickers);    }        // Store in Redis for cross-worker access    await this.redis.set(      KalshiTickerMapper.REDIS_TICKER_MAP_KEY,      JSON.stringify(Object.fromEntries(this.tickerToGameId)),      'EX', 120 // 2 minute TTL    );  }    getGameIdForTicker(ticker: string): string | null {    return this.tickerToGameId.get(ticker) || null;  }}
4.4 Multi-Worker Coordination
Critical Constraint: Only ONE worker should maintain the Kalshi WebSocket connection.
Implementation Strategy:
// In kalshi-price-update.service.tsclass KalshiPriceUpdateService {  private isMainKalshiWorker = false;    async initialize(): Promise<void> {    // Use Redis distributed lock to elect leader    this.isMainKalshiWorker = await this.tryAcquireLeaderLock();        if (this.isMainKalshiWorker) {      logger.info('This worker is the Kalshi WebSocket leader');      await this.startWebSocketConnection();    } else {      logger.info('This worker is a Kalshi follower (no WS connection)');      // Subscribe to Redis channel for price updates instead      await this.subscribeToRedisPriceChannel();    }  }    private async tryAcquireLeaderLock(): Promise<boolean> {    const LOCK_KEY = 'kalshi:websocket:leader';    const LOCK_TTL_SECONDS = 30;    const workerId = process.env.WORKER_ID || process.pid.toString();        // SET NX with TTL for distributed lock    const acquired = await this.redis.set(      LOCK_KEY,       workerId,       'NX',       'EX',       LOCK_TTL_SECONDS    );        if (acquired) {      // Refresh lock periodically      this.leaderLockRefreshInterval = setInterval(async () => {        await this.redis.expire(LOCK_KEY, LOCK_TTL_SECONDS);      }, (LOCK_TTL_SECONDS - 5) * 1000);    }        return acquired === 'OK';  }}
Leader Failover:
┌─────────────────────────────────────────────────────────────────────────────┐│                        MULTI-WORKER COORDINATION                             │├─────────────────────────────────────────────────────────────────────────────┤│                                                                              ││  Worker 1 (Leader)           Worker 2 (Follower)      Worker N (Follower)   ││  ┌────────────────┐          ┌────────────────┐       ┌────────────────┐    ││  │ Kalshi WS ●────┼──────────┼───────────────┼───────┼────────────────┼───▶ ││  │ Connection     │          │                │       │                │    ││  │                │          │                │       │                │    ││  │ Redis Lock: ✓  │          │ Redis Lock: ✗  │       │ Redis Lock: ✗  │    ││  │                │          │                │       │                │    ││  │ Publishes to   │          │ Subscribes to  │       │ Subscribes to  │    ││  │ Redis Channel  │          │ Redis Channel  │       │ Redis Channel  │    ││  └────────────────┘          └────────────────┘       └────────────────┘    ││         │                           │                        │              ││         │                           │                        │              ││         └───────────────────────────┴────────────────────────┘              ││                                     │                                        ││                                     ▼                                        ││                          ┌──────────────────┐                                ││                          │ Redis Pub/Sub    │                                ││                          │ kalshi:prices    │                                ││                          └──────────────────┘                                ││                                                                              ││  If Leader crashes:                                                          ││  1. Redis lock expires (30s TTL)                                            ││  2. Another worker acquires lock                                             ││  3. New leader starts WebSocket connection                                   ││                                                                              │└─────────────────────────────────────────────────────────────────────────────┘
5. Redis Integration
5.1 Redis Keys and Channels
Key/Channel	Type	Purpose	TTL
kalshi:websocket:leader	String	Leader election lock	30s
kalshi:ticker_map	String (JSON)	Ticker → game_id mapping	120s
kalshi:prices:{gameId}	Hash	Per-game price cache	60s
kalshi:prices:channel	Pub/Sub	Real-time price broadcasts	N/A
5.2 Price Cache Structure
// Redis Hash: kalshi:prices:193462{  awayBuyPrice: "43",  awaySellPrice: "42",  homeBuyPrice: "58",  homeSellPrice: "57",  ticker: "KXNBAGAME-26FEB05CHAHOU-CHA",  updatedAt: "1738772400"}
5.3 Pub/Sub Message Format
interface KalshiPriceMessage {  type: 'kalshi_price_update';  gameId: string;  slug: string;  awayTeam: {    kalshiBuyPrice: number;    kalshiSellPrice: number;  };  homeTeam: {    kalshiBuyPrice: number;    kalshiSellPrice: number;  };  ticker: string;  timestamp: number;}
6. Frontend WebSocket Integration
6.1 Activity Watcher WebSocket Changes
Current Events:
price_update - CLOB price changes
game_status_update - Game state changes
new_game - New games added
New Event:
kalshi_price_update - Kalshi price changes
Modified activity-watcher-websocket.service.ts:
// Add Redis subscription for Kalshi pricesprivate async subscribeToKalshiPrices(): Promise<void> {  const subscriber = this.redis.duplicate();  await subscriber.subscribe('kalshi:prices:channel');    subscriber.on('message', (channel, message) => {    if (channel === 'kalshi:prices:channel') {      const priceUpdate = JSON.parse(message) as KalshiPriceMessage;      this.broadcastKalshiPriceUpdate(priceUpdate);    }  });}private broadcastKalshiPriceUpdate(update: KalshiPriceMessage): void {  // Find all clients subscribed to this game  const gameSubscribers = this.getSubscribersForGame(update.gameId);    const message: WebSocketMessage = {    type: 'kalshi_price_update',    data: {      gameId: update.gameId,      slug: update.slug,      awayTeam: update.awayTeam,      homeTeam: update.homeTeam,      ticker: update.ticker,      timestamp: update.timestamp,    },  };    for (const client of gameSubscribers) {    this.sendToClient(client, message);  }}
6.2 Frontend Client Handling
GlassMarketCard Component:
// hooks/useGamePrices.tsinterface GamePrices {  // CLOB prices (Polymarket)  awayBuyPrice: number;  awaySellPrice: number;  homeBuyPrice: number;  homeSellPrice: number;    // Kalshi prices  kalshiAwayBuyPrice: number | null;  kalshiAwaySellPrice: number | null;  kalshiHomeBuyPrice: number | null;  kalshiHomeSellPrice: number | null;}function useGamePrices(gameId: string): GamePrices {  const [prices, setPrices] = useState<GamePrices>(initialPrices);    useEffect(() => {    const ws = getActivityWebSocket();        // Handle CLOB price updates (existing)    ws.on('price_update', (data) => {      if (data.gameId === gameId) {        setPrices(prev => ({          ...prev,          awayBuyPrice: data.awayTeam.buyPrice,          awaySellPrice: data.awayTeam.sellPrice,          homeBuyPrice: data.homeTeam.buyPrice,          homeSellPrice: data.homeTeam.sellPrice,        }));      }    });        // Handle Kalshi price updates (NEW)    ws.on('kalshi_price_update', (data) => {      if (data.gameId === gameId) {        setPrices(prev => ({          ...prev,          kalshiAwayBuyPrice: data.awayTeam.kalshiBuyPrice,          kalshiAwaySellPrice: data.awayTeam.kalshiSellPrice,          kalshiHomeBuyPrice: data.homeTeam.kalshiBuyPrice,          kalshiHomeSellPrice: data.homeTeam.kalshiSellPrice,        }));      }    });        return () => ws.off('price_update').off('kalshi_price_update');  }, [gameId]);    return prices;}
6.3 Component Update Flow
┌─────────────────────────────────────────────────────────────────────────────┐│                      FRONTEND PRICE UPDATE FLOW                              │├─────────────────────────────────────────────────────────────────────────────┤│                                                                              ││  WebSocket Connection                                                        ││         │                                                                    ││         ├──▶ price_update (CLOB)                                            ││         │         │                                                          ││         │         ▼                                                          ││         │    ┌────────────────┐                                              ││         │    │ Update CLOB    │                                              ││         │    │ prices in state│                                              ││         │    └────────────────┘                                              ││         │                                                                    ││         └──▶ kalshi_price_update                                            ││                   │                                                          ││                   ▼                                                          ││              ┌────────────────┐                                              ││              │ Update Kalshi  │                                              ││              │ prices in state│                                              ││              └────────────────┘                                              ││                                                                              ││                        ▼                                                     ││              ┌─────────────────────────────────────────┐                     ││              │           React Components              │                     ││              │                                         │                     ││              │  ┌─────────────┐  ┌─────────────────┐  │                     ││              │  │GlassMarket │  │ MobileSwipeCard │  │                     ││              │  │   Card      │  │                 │  │                     ││              │  │             │  │                 │  │                     ││              │  │ CLOB: $0.58 │  │ CLOB: $0.58    │  │                     ││              │  │ Kalshi: 57¢ │  │ Kalshi: 57¢    │  │                     ││              │  └─────────────┘  └─────────────────┘  │                     ││              │                                         │                     ││              │  ┌─────────────┐  ┌─────────────────┐  │                     ││              │  │ActivityMkt │  │ TradingWidget   │  │                     ││              │  │   Widget    │  │                 │  │                     ││              │  │             │  │                 │  │                     ││              │  │ Kalshi: 57¢ │  │ Kalshi: 57¢    │  │                     ││              │  └─────────────┘  └─────────────────┘  │                     ││              │                                         │                     ││              └─────────────────────────────────────────┘                     ││                                                                              │└─────────────────────────────────────────────────────────────────────────────┘
7. Memory Management Strategy
7.1 Bounded Data Structures
Component	Data Structure	Max Size	Eviction Strategy
Price Queue	Map<gameId, price>	1,000 entries	Force flush at limit
Ticker Map	Map<ticker, gameId>	2,000 entries	LRU eviction
WS Subscriptions	Set<ticker>	500 tickers	Oldest first
7.2 Memory Monitoring
class MemoryGuard {  private static CHECK_INTERVAL_MS = 30_000;  private static HEAP_THRESHOLD_MB = 400; // Alert at 400MB  private static HEAP_CRITICAL_MB = 600;  // Force GC at 600MB    startMonitoring(): void {    setInterval(() => {      const usage = process.memoryUsage();      const heapUsedMB = usage.heapUsed / 1024 / 1024;            if (heapUsedMB > MemoryGuard.HEAP_CRITICAL_MB) {        logger.warn('Critical heap usage, forcing cache clear', { heapUsedMB });        this.clearNonEssentialCaches();        global.gc?.(); // If --expose-gc flag is set      } else if (heapUsedMB > MemoryGuard.HEAP_THRESHOLD_MB) {        logger.warn('High heap usage detected', { heapUsedMB });      }    }, MemoryGuard.CHECK_INTERVAL_MS);  }}
8. Database Connection Management
8.1 Connection Pool Strategy
// Existing pool configuration (preserve)const pool = new Pool({  max: 20,                    // Max connections  idleTimeoutMillis: 30000,   // Close idle connections after 30s  connectionTimeoutMillis: 5000,});// Kalshi writes share the same pool// Key: Never hold connections during price accumulation
8.2 Write Pattern Comparison
Service	Write Frequency	Batch Size	Connection Hold Time
CLOB Price Update	Every 5s	Up to 100 games	< 100ms
Kalshi Price Update	Every 5s	Up to 100 games	< 100ms
Live Games Sync	Every 5min	Up to 50 games	< 500ms
8.3 Staggered Flush Timing
// Prevent both services from flushing at exact same timeclass KalshiPriceUpdateService {  private static FLUSH_INTERVAL_MS = 5000;  private static FLUSH_OFFSET_MS = 2500; // Offset from CLOB flush    startFlushTimer(): void {    // Start with offset to stagger with CLOB    setTimeout(() => {      setInterval(() => this.flushPriceUpdates(),         KalshiPriceUpdateService.FLUSH_INTERVAL_MS);    }, KalshiPriceUpdateService.FLUSH_OFFSET_MS);  }}
Timing Diagram:
Time (seconds): 0    1    2    3    4    5    6    7    8    9    10                |----|----|----|----|----|----|----|----|----|----|CLOB Flush:     ●                   ●                   ●Kalshi Flush:        ●                   ●                   ●                     ▲                   ▲                     2.5s offset         Staggered to avoid                                         connection spike
9. Error Handling & Resilience
9.1 WebSocket Reconnection Strategy
class KalshiWebSocketClient {  private reconnectAttempts = 0;  private static RECONNECT_DELAYS = [    1000,   // 1s    2000,   // 2s    5000,   // 5s    10000,  // 10s    30000,  // 30s    60000,  // 1min (max)  ];    private getReconnectDelay(): number {    const index = Math.min(      this.reconnectAttempts,       KalshiWebSocketClient.RECONNECT_DELAYS.length - 1    );    return KalshiWebSocketClient.RECONNECT_DELAYS[index];  }    private async handleDisconnect(): Promise<void> {    this.reconnectAttempts++;    const delay = this.getReconnectDelay();        logger.warn('Kalshi WS disconnected, reconnecting', {       attempt: this.reconnectAttempts,       delayMs: delay     });        await sleep(delay);    await this.connect();  }}
9.2 Graceful Degradation
// If Kalshi WS fails, fall back to REST pollingclass KalshiFallbackPoller {  private isActive = false;    async activateFallback(): Promise<void> {    if (this.isActive) return;    this.isActive = true;        logger.info('Activating Kalshi REST fallback polling');        // Poll every 30 seconds (much less frequent than WS)    setInterval(async () => {      await this.pollActivePrices();    }, 30_000);  }    async deactivateFallback(): Promise<void> {    this.isActive = false;    logger.info('Deactivating Kalshi REST fallback');  }}
10. Monitoring & Observability
10.1 Metrics to Track
Metric	Type	Alert Threshold
kalshi_ws_connected	Gauge (0/1)	0 for > 60s
kalshi_price_queue_size	Gauge	> 800
kalshi_flush_duration_ms	Histogram	p99 > 500ms
kalshi_prices_per_flush	Histogram	-
kalshi_ws_reconnects	Counter	> 5 in 5min
kalshi_ticker_cache_size	Gauge	> 1800
10.2 Logging Strategy
// Structured logging levelsconst LogLevels = {  // DEBUG: Individual price updates (disabled in prod)  priceReceived: 'debug',    // INFO: Normal operations  flushCompleted: 'info',  connectionEstablished: 'info',    // WARN: Recoverable issues    reconnecting: 'warn',  queueNearCapacity: 'warn',    // ERROR: Failures  flushFailed: 'error',  connectionFailed: 'error',};
11. Implementation Phases
Phase 1: Foundation (Week 1)
Create kalshi-websocket.client.ts with connection management
Create kalshi-ticker-mapper.ts with caching
Unit tests for ticker mapping
Phase 2: Price Processing (Week 1-2)
Create kalshi-price-update.service.ts
Implement batched database writes
Add Redis pub/sub integration
Integration tests
Phase 3: Frontend Integration (Week 2)
Modify activity-watcher-websocket.service.ts
Add kalshi_price_update event handling
Update frontend hooks (useGamePrices)
Update components (GlassMarketCard, etc.)
Phase 4: Multi-Worker & Production (Week 2-3)
Implement leader election
Add fallback REST polling
Add monitoring/alerting
Load testing
Staged rollout
12. Risk Mitigation
Risk	Mitigation
Memory leak from unbounded queues	Hard limits with forced flush
Database connection exhaustion	Staggered flushes, connection pooling
Worker crash from WS errors	Isolated error handlers, reconnection
Kalshi API rate limiting	Batched subscriptions, backoff
Redis pubsub message loss	Periodic full refresh from cache
Leader election race condition	Redis SET NX with TTL
13. Testing Strategy
13.1 Unit Tests
Ticker mapping logic
Price queue deduplication
Batch query generation
13.2 Integration Tests
WebSocket connection/reconnection
Redis pub/sub flow
Database batch updates
13.3 Load Tests
500 concurrent price updates/second
Memory usage under sustained load
Database connection pool behavior
14. Rollback Plan
Feature Flag: KALSHI_WS_ENABLED=false disables WS, falls back to REST
Quick Disable: Remove Kalshi subscription from activity-watcher
Full Rollback: Revert to previous release, prices still work from REST refresh
This plan ensures that Kalshi WebSocket integration:
Respects multi-worker setup via Redis leader election
Protects database with batched writes and staggered timing
Prevents memory issues with bounded queues and monitoring
Maintains frontend independence with separate event types
Provides graceful degradation with REST fallback