/**
 * Kalshi API Types
 * TypeScript interfaces for Kalshi market data
 */

// Raw Kalshi API response types
export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle?: string;
  status: 'unopened' | 'open' | 'closed' | 'settled';
  close_time: string;     // ISO timestamp
  yes_bid: number;        // cents (0-100)
  yes_ask: number;        // cents (0-100)
  no_bid: number;         // cents (0-100)
  no_ask: number;         // cents (0-100)
  volume: number;
  open_interest: number;
  // Extended fields (may be present)
  result?: string;
  category?: string;
  series_ticker?: string;
  // Internal tracking (added during processing)
  _sport?: string;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string | null;
}

// Stored/transformed types
export interface StoredKalshiMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  subtitle: string | null;
  status: string;
  closeTs: Date;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamAbbr: string;
  awayTeamAbbr: string;
  gameDate: Date;
  liveGameId: string | null;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  volume: number;
  openInterest: number;
  rawData: KalshiMarket;
}

// Kalshi prices for a matched game
export interface KalshiPrices {
  ticker: string;
  yesBid: number;   // Best bid for YES = away sell price
  yesAsk: number;   // Best ask for YES = away buy price
  noBid: number;    // Best bid for NO = home sell price
  noAsk: number;    // Best ask for NO = home buy price
}

// Database row type
export interface KalshiMarketRow {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string | null;
  status: string;
  close_ts: Date;
  sport: string;
  league: string;
  home_team: string;
  away_team: string;
  home_team_abbr: string;
  away_team_abbr: string;
  game_date: Date;
  live_game_id: string | null;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  volume: number;
  open_interest: number;
  raw_data: KalshiMarket;
  created_at: Date;
  updated_at: Date;
}
