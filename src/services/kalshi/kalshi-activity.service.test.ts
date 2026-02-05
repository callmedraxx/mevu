/**
 * Unit and Integration Tests for Kalshi Activity Service
 * Tests spread/total market transformation and pairing logic
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the service
vi.mock('../../config/database', () => ({
  connectWithRetry: vi.fn(),
}));

vi.mock('../../config/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../polymarket/live-games.service', () => ({
  getLiveGameBySlug: vi.fn(),
}));

vi.mock('../polymarket/frontend-game.transformer', () => ({
  transformToFrontendGame: vi.fn(),
}));

// Import after mocks
import { kalshiActivityService } from './kalshi-activity.service';

// =============================================================================
// UNIT TESTS: Helper Functions
// =============================================================================

describe('Kalshi Activity Service - Helper Functions', () => {
  // Access private methods for testing
  const extractSpreadPoints = (kalshiActivityService as any).extractSpreadPoints.bind(kalshiActivityService);
  const extractTeamFromSpreadTitle = (kalshiActivityService as any).extractTeamFromSpreadTitle.bind(kalshiActivityService);
  const extractTotalFromTicker = (kalshiActivityService as any).extractTotalFromTicker.bind(kalshiActivityService);
  const extractTeamFromTicker = (kalshiActivityService as any).extractTeamFromTicker.bind(kalshiActivityService);

  describe('extractSpreadPoints', () => {
    it('should extract point value from standard spread title', () => {
      expect(extractSpreadPoints('Houston wins by over 3.5 Points?')).toBe(3.5);
      expect(extractSpreadPoints('Charlotte wins by over 6.5 Points?')).toBe(6.5);
      expect(extractSpreadPoints('Lakers wins by over 12.5 Points?')).toBe(12.5);
    });

    it('should handle whole number spreads', () => {
      expect(extractSpreadPoints('Houston wins by over 3 Points?')).toBe(3);
      expect(extractSpreadPoints('Charlotte wins by over 10 Points?')).toBe(10);
    });

    it('should be case insensitive', () => {
      expect(extractSpreadPoints('HOUSTON WINS BY OVER 3.5 POINTS?')).toBe(3.5);
      expect(extractSpreadPoints('houston wins by over 3.5 points?')).toBe(3.5);
    });

    it('should return null for invalid titles', () => {
      expect(extractSpreadPoints('Houston vs Charlotte')).toBeNull();
      expect(extractSpreadPoints('Over 220.5 points')).toBeNull();
      expect(extractSpreadPoints('')).toBeNull();
    });
  });

  describe('extractTeamFromSpreadTitle', () => {
    it('should extract team name from spread title', () => {
      expect(extractTeamFromSpreadTitle('Houston wins by over 3.5 Points?')).toBe('Houston');
      expect(extractTeamFromSpreadTitle('Charlotte wins by over 6.5 Points?')).toBe('Charlotte');
      expect(extractTeamFromSpreadTitle('Lakers wins by over 12.5 Points?')).toBe('Lakers');
    });

    it('should be case insensitive', () => {
      expect(extractTeamFromSpreadTitle('HOUSTON wins by over 3.5 Points?')).toBe('HOUSTON');
    });

    it('should return null for invalid titles', () => {
      expect(extractTeamFromSpreadTitle('Over 220.5 points')).toBeNull();
      expect(extractTeamFromSpreadTitle('')).toBeNull();
    });
  });

  describe('extractTotalFromTicker', () => {
    it('should extract total value from ticker and add 0.5', () => {
      expect(extractTotalFromTicker('KXNBATOTAL-26FEB05CHAHOU-220')).toBe(220.5);
      expect(extractTotalFromTicker('KXNBATOTAL-26FEB05CHAHOU-217')).toBe(217.5);
      expect(extractTotalFromTicker('KXNBATOTAL-26FEB05CHAHOU-205')).toBe(205.5);
    });

    it('should handle different sport prefixes', () => {
      expect(extractTotalFromTicker('KXNFLTOTAL-26FEB05KCBUF-45')).toBe(45.5);
      expect(extractTotalFromTicker('KXNHLTOTAL-26FEB05BOSNYY-6')).toBe(6.5);
    });

    it('should return null for tickers without trailing number', () => {
      expect(extractTotalFromTicker('KXNBAGAME-26FEB05CHAHOU-CHA')).toBeNull();
      expect(extractTotalFromTicker('KXNBASPREAD-26FEB05CHAHOU')).toBeNull();
    });
  });

  describe('extractTeamFromTicker', () => {
    it('should extract team abbreviation from ticker', () => {
      expect(extractTeamFromTicker('KXNBAGAME-26FEB05CHAHOU-HOU')).toBe('HOU');
      expect(extractTeamFromTicker('KXNBAGAME-26FEB05CHAHOU-CHA')).toBe('CHA');
      expect(extractTeamFromTicker('KXNFLGAME-26FEB05KCBUF-KC')).toBe('KC');
    });

    it('should return empty string for invalid tickers', () => {
      expect(extractTeamFromTicker('KXNBATOTAL-26FEB05CHAHOU-220')).toBe('');
      expect(extractTeamFromTicker('invalid')).toBe('');
    });
  });
});

// =============================================================================
// UNIT TESTS: Market Grouping
// =============================================================================

describe('Kalshi Activity Service - Market Grouping', () => {
  const groupMarketsByType = (kalshiActivityService as any).groupMarketsByType.bind(kalshiActivityService);

  const createMockRow = (ticker: string, title: string = 'Test Market') => ({
    ticker,
    title,
    yes_bid: 50,
    yes_ask: 52,
    no_bid: 48,
    no_ask: 50,
    volume: 1000,
  });

  it('should group moneyline markets correctly', () => {
    const rows = [
      createMockRow('KXNBAGAME-26FEB05CHAHOU-CHA'),
      createMockRow('KXNBAGAME-26FEB05CHAHOU-HOU'),
    ];

    const groups = groupMarketsByType(rows);

    expect(groups.moneyline).toHaveLength(2);
    expect(groups.spread).toHaveLength(0);
    expect(groups.total).toHaveLength(0);
  });

  it('should group spread markets correctly', () => {
    const rows = [
      createMockRow('KXNBASPREAD-26FEB05CHAHOU-CHA3', 'Charlotte wins by over 3.5 Points?'),
      createMockRow('KXNBASPREAD-26FEB05CHAHOU-HOU3', 'Houston wins by over 3.5 Points?'),
    ];

    const groups = groupMarketsByType(rows);

    expect(groups.spread).toHaveLength(2);
    expect(groups.moneyline).toHaveLength(0);
  });

  it('should group total markets correctly', () => {
    const rows = [
      createMockRow('KXNBATOTAL-26FEB05CHAHOU-217'),
      createMockRow('KXNBATOTAL-26FEB05CHAHOU-220'),
    ];

    const groups = groupMarketsByType(rows);

    expect(groups.total).toHaveLength(2);
    expect(groups.moneyline).toHaveLength(0);
  });

  it('should group team total markets correctly', () => {
    const rows = [
      createMockRow('KXNBATEAMTOTAL-26FEB05CHAHOU-CHA100'),
      createMockRow('KXNBATEAMTOTAL-26FEB05CHAHOU-HOU115'),
    ];

    const groups = groupMarketsByType(rows);

    expect(groups.teamTotal).toHaveLength(2);
  });

  it('should handle mixed market types', () => {
    const rows = [
      createMockRow('KXNBAGAME-26FEB05CHAHOU-CHA'),
      createMockRow('KXNBAGAME-26FEB05CHAHOU-HOU'),
      createMockRow('KXNBASPREAD-26FEB05CHAHOU-CHA3', 'Charlotte wins by over 3.5 Points?'),
      createMockRow('KXNBASPREAD-26FEB05CHAHOU-HOU3', 'Houston wins by over 3.5 Points?'),
      createMockRow('KXNBATOTAL-26FEB05CHAHOU-217'),
      createMockRow('KXNBATOTAL-26FEB05CHAHOU-220'),
    ];

    const groups = groupMarketsByType(rows);

    expect(groups.moneyline).toHaveLength(2);
    expect(groups.spread).toHaveLength(2);
    expect(groups.total).toHaveLength(2);
  });
});

// =============================================================================
// UNIT TESTS: Spread Market Building
// =============================================================================

describe('Kalshi Activity Service - Spread Market Building', () => {
  const buildSpreadMarkets = (kalshiActivityService as any).buildSpreadMarkets.bind(kalshiActivityService);

  const createSpreadRow = (team: string, points: number, yesAsk: number, yesBid: number) => ({
    ticker: `KXNBASPREAD-26FEB05CHAHOU-${team}${points * 10}`,
    title: `${team} wins by over ${points} Points?`,
    yes_bid: yesBid,
    yes_ask: yesAsk,
    no_bid: 100 - yesAsk,
    no_ask: 100 - yesBid,
    volume: 1000,
  });

  it('should pair spread markets by point value', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 3.5, 34, 31),
      createSpreadRow('Houston', 3.5, 51, 49),
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');

    expect(markets).toHaveLength(1);
    expect(markets[0].id).toBe('spread-3.5');
    expect(markets[0].outcomes).toHaveLength(2);
  });

  it('should create correct outcome labels for spread markets', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 3.5, 34, 31),
      createSpreadRow('Houston', 3.5, 51, 49),
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');
    const outcomes = markets[0].outcomes;

    // Away team (Charlotte) should have +
    const awayOutcome = outcomes.find((o: any) => o.label.includes('Charlotte'));
    expect(awayOutcome?.label).toBe('Charlotte +3.5');

    // Home team (Houston) should have -
    const homeOutcome = outcomes.find((o: any) => o.label.includes('Houston'));
    expect(homeOutcome?.label).toBe('Houston -3.5');
  });

  it('should use correct prices for each outcome', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 3.5, 34, 31),
      createSpreadRow('Houston', 3.5, 51, 49),
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');
    const outcomes = markets[0].outcomes;

    const charlotteOutcome = outcomes.find((o: any) => o.label.includes('Charlotte'));
    expect(charlotteOutcome?.buyPrice).toBe(34);
    expect(charlotteOutcome?.sellPrice).toBe(31);

    const houstonOutcome = outcomes.find((o: any) => o.label.includes('Houston'));
    expect(houstonOutcome?.buyPrice).toBe(51);
    expect(houstonOutcome?.sellPrice).toBe(49);
  });

  it('should create multiple markets for different point values', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 3.5, 34, 31),
      createSpreadRow('Houston', 3.5, 51, 49),
      createSpreadRow('Charlotte', 6.5, 27, 22),
      createSpreadRow('Houston', 6.5, 41, 38),
      createSpreadRow('Charlotte', 9.5, 20, 15),
      createSpreadRow('Houston', 9.5, 33, 29),
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');

    expect(markets).toHaveLength(3);
    expect(markets.map((m: any) => m.id)).toEqual(['spread-3.5', 'spread-6.5', 'spread-9.5']);
  });

  it('should sort markets by point value ascending', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 9.5, 20, 15),
      createSpreadRow('Houston', 9.5, 33, 29),
      createSpreadRow('Charlotte', 3.5, 34, 31),
      createSpreadRow('Houston', 3.5, 51, 49),
      createSpreadRow('Charlotte', 6.5, 27, 22),
      createSpreadRow('Houston', 6.5, 41, 38),
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');

    expect(markets[0].id).toBe('spread-3.5');
    expect(markets[1].id).toBe('spread-6.5');
    expect(markets[2].id).toBe('spread-9.5');
  });

  it('should handle markets with only one team for a point value', () => {
    const spreadRows = [
      createSpreadRow('Charlotte', 3.5, 34, 31),
      // Missing Houston 3.5
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');

    expect(markets).toHaveLength(1);
    expect(markets[0].outcomes).toHaveLength(1);
    expect(markets[0].outcomes[0].label).toBe('Charlotte +3.5');
  });

  it('should calculate total volume for paired markets', () => {
    const spreadRows = [
      { ...createSpreadRow('Charlotte', 3.5, 34, 31), volume: 500 },
      { ...createSpreadRow('Houston', 3.5, 51, 49), volume: 750 },
    ];

    const markets = buildSpreadMarkets(spreadRows, 'HOU', 'CHA');

    // Volume should be formatted as $1.3k (500 + 750 = 1250)
    expect(markets[0].volume).toBe('$1.3k');
  });

  it('should handle empty spread rows', () => {
    const markets = buildSpreadMarkets([], 'HOU', 'CHA');
    expect(markets).toHaveLength(0);
  });
});

// =============================================================================
// UNIT TESTS: Total Market Building
// =============================================================================

describe('Kalshi Activity Service - Total Market Building', () => {
  const buildTotalMarkets = (kalshiActivityService as any).buildTotalMarkets.bind(kalshiActivityService);

  const createTotalRow = (total: number, yesAsk: number, yesBid: number, noAsk: number, noBid: number) => ({
    ticker: `KXNBATOTAL-26FEB05CHAHOU-${total}`,
    title: `Over ${total}.5 points scored?`,
    yes_bid: yesBid,
    yes_ask: yesAsk,
    no_bid: noBid,
    no_ask: noAsk,
    volume: 1000,
  });

  it('should create Over/Under outcomes for each total', () => {
    const totalRows = [
      createTotalRow(217, 50, 49, 51, 50),
    ];

    const markets = buildTotalMarkets(totalRows);

    expect(markets).toHaveLength(1);
    expect(markets[0].id).toBe('total-217.5');
    expect(markets[0].outcomes).toHaveLength(2);
  });

  it('should create correct labels for Over/Under', () => {
    const totalRows = [
      createTotalRow(217, 50, 49, 51, 50),
    ];

    const markets = buildTotalMarkets(totalRows);
    const outcomes = markets[0].outcomes;

    expect(outcomes[0].label).toBe('Over 217.5');
    expect(outcomes[1].label).toBe('Under 217.5');
  });

  it('should use yes prices for Over and no prices for Under', () => {
    const totalRows = [
      createTotalRow(217, 52, 50, 48, 46),  // yes_ask=52, yes_bid=50, no_ask=48, no_bid=46
    ];

    const markets = buildTotalMarkets(totalRows);
    const outcomes = markets[0].outcomes;

    // Over uses Yes prices
    expect(outcomes[0].buyPrice).toBe(52);   // yes_ask
    expect(outcomes[0].sellPrice).toBe(50);  // yes_bid

    // Under uses No prices
    expect(outcomes[1].buyPrice).toBe(48);   // no_ask
    expect(outcomes[1].sellPrice).toBe(46);  // no_bid
  });

  it('should create multiple markets for different totals', () => {
    const totalRows = [
      createTotalRow(217, 50, 49, 51, 50),
      createTotalRow(220, 44, 42, 56, 54),
      createTotalRow(214, 57, 56, 44, 43),
    ];

    const markets = buildTotalMarkets(totalRows);

    expect(markets).toHaveLength(3);
  });

  it('should sort markets by total value ascending', () => {
    const totalRows = [
      createTotalRow(220, 44, 42, 56, 54),
      createTotalRow(214, 57, 56, 44, 43),
      createTotalRow(217, 50, 49, 51, 50),
    ];

    const markets = buildTotalMarkets(totalRows);

    expect(markets[0].id).toBe('total-214.5');
    expect(markets[1].id).toBe('total-217.5');
    expect(markets[2].id).toBe('total-220.5');
  });

  it('should handle extreme price values', () => {
    const totalRows = [
      createTotalRow(200, 95, 93, 7, 5),  // Heavy over favorite
    ];

    const markets = buildTotalMarkets(totalRows);
    const outcomes = markets[0].outcomes;

    expect(outcomes[0].buyPrice).toBe(95);  // Over
    expect(outcomes[1].buyPrice).toBe(7);   // Under
  });

  it('should include volume for each market', () => {
    const totalRows = [
      { ...createTotalRow(217, 50, 49, 51, 50), volume: 5000 },
    ];

    const markets = buildTotalMarkets(totalRows);

    expect(markets[0].volume).toBe('$5.0k');
  });

  it('should handle empty total rows', () => {
    const markets = buildTotalMarkets([]);
    expect(markets).toHaveLength(0);
  });

  it('should skip rows with invalid tickers', () => {
    const totalRows = [
      {
        ticker: 'INVALID-TICKER',  // No trailing number
        title: 'Over 217.5 points?',
        yes_bid: 49,
        yes_ask: 50,
        no_bid: 50,
        no_ask: 51,
        volume: 0,
      },
    ];

    const markets = buildTotalMarkets(totalRows);
    expect(markets).toHaveLength(0);
  });
});

// =============================================================================
// INTEGRATION TESTS: Full Market Building
// =============================================================================

describe('Kalshi Activity Service - Integration: Full Market Building', () => {
  const buildActivityGame = (kalshiActivityService as any).buildActivityGame.bind(kalshiActivityService);

  const mockFrontendGame = {
    id: '193462',
    slug: 'nba-cha-hou-2026-02-05',
    sport: 'nba',
    league: 'nba',
    homeTeam: {
      abbr: 'hou',
      name: 'Rockets',
      record: '31-18',
      probability: 58,
      buyPrice: 59,
      sellPrice: 58,
    },
    awayTeam: {
      abbr: 'cha',
      name: 'Hornets',
      record: '23-28',
      probability: 42,
      buyPrice: 42,
      sellPrice: 41,
    },
  };

  it('should build complete activity game with all market types', () => {
    const kalshiRows = [
      // Moneyline
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA', title: 'Charlotte at Houston Winner?', yes_bid: 42, yes_ask: 43, no_bid: 57, no_ask: 58, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-HOU', title: 'Charlotte at Houston Winner?', yes_bid: 58, yes_ask: 59, no_bid: 42, no_ask: 43, volume: 0 },
      // Spreads
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-HOU3', title: 'Houston wins by over 3.5 Points?', yes_bid: 49, yes_ask: 51, no_bid: 49, no_ask: 51, volume: 0 },
      // Totals
      { ticker: 'KXNBATOTAL-26FEB05CHAHOU-217', title: 'Over 217.5 points?', yes_bid: 49, yes_ask: 50, no_bid: 50, no_ask: 51, volume: 0 },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // Should have moneyline, spread, and total markets
    expect(result.markets).toHaveLength(3);

    const moneyline = result.markets.find((m: any) => m.id === 'moneyline');
    const spread = result.markets.find((m: any) => m.id === 'spread-3.5');
    const total = result.markets.find((m: any) => m.id === 'total-217.5');

    expect(moneyline).toBeDefined();
    expect(spread).toBeDefined();
    expect(total).toBeDefined();
  });

  it('should set Kalshi prices on teams from moneyline markets', () => {
    const kalshiRows = [
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA', title: 'Charlotte at Houston Winner?', yes_bid: 42, yes_ask: 43, no_bid: 57, no_ask: 58, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-HOU', title: 'Charlotte at Houston Winner?', yes_bid: 58, yes_ask: 59, no_bid: 42, no_ask: 43, volume: 0 },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // Home team (Houston) prices
    expect(result.homeTeam.kalshiBuyPrice).toBe(59);
    expect(result.homeTeam.kalshiSellPrice).toBe(58);

    // Away team (Charlotte) prices
    expect(result.awayTeam.kalshiBuyPrice).toBe(43);
    expect(result.awayTeam.kalshiSellPrice).toBe(42);
  });

  it('should include platform identifier', () => {
    const result = buildActivityGame(mockFrontendGame, []);

    expect(result.platform).toBe('kalshi');
  });

  it('should handle empty kalshi rows gracefully', () => {
    const result = buildActivityGame(mockFrontendGame, []);

    expect(result.markets).toHaveLength(0);
    expect(result.homeTeam.kalshiBuyPrice).toBeUndefined();
    expect(result.awayTeam.kalshiBuyPrice).toBeUndefined();
  });
});

// =============================================================================
// REGRESSION TESTS: Real Data Format
// =============================================================================

describe('Kalshi Activity Service - Regression: Real Data Format', () => {
  const buildActivityGame = (kalshiActivityService as any).buildActivityGame.bind(kalshiActivityService);

  it('should produce correct format matching Kalshi website display', () => {
    const mockFrontendGame = {
      id: '193462',
      slug: 'nba-cha-hou-2026-02-05',
      sport: 'nba',
      league: 'nba',
      homeTeam: { abbr: 'hou', name: 'Rockets', record: '31-18', probability: 58, buyPrice: 59, sellPrice: 58 },
      awayTeam: { abbr: 'cha', name: 'Hornets', record: '23-28', probability: 42, buyPrice: 42, sellPrice: 41 },
    };

    // Real data format from Kalshi
    const kalshiRows = [
      // Moneyline markets
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA', title: 'Charlotte at Houston Winner?', yes_bid: 42, yes_ask: 43, no_bid: 57, no_ask: 58, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-HOU', title: 'Charlotte at Houston Winner?', yes_bid: 58, yes_ask: 59, no_bid: 42, no_ask: 43, volume: 0 },
      // Spread markets (like Kalshi displays: "Houston wins by over 3.5 Points?")
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-HOU3', title: 'Houston wins by over 3.5 Points?', yes_bid: 49, yes_ask: 51, no_bid: 49, no_ask: 51, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA6', title: 'Charlotte wins by over 6.5 Points?', yes_bid: 22, yes_ask: 26, no_bid: 74, no_ask: 78, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-HOU6', title: 'Houston wins by over 6.5 Points?', yes_bid: 37, yes_ask: 42, no_bid: 58, no_ask: 63, volume: 0 },
      // Total markets
      { ticker: 'KXNBATOTAL-26FEB05CHAHOU-217', title: 'Over 217.5 points?', yes_bid: 49, yes_ask: 50, no_bid: 50, no_ask: 51, volume: 0 },
      { ticker: 'KXNBATOTAL-26FEB05CHAHOU-220', title: 'Over 220.5 points?', yes_bid: 42, yes_ask: 44, no_bid: 56, no_ask: 58, volume: 0 },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // Verify structure
    expect(result.platform).toBe('kalshi');
    expect(result.markets.length).toBeGreaterThan(0);

    // Verify spread market format (paired teams at same point value)
    const spread35 = result.markets.find((m: any) => m.id === 'spread-3.5');
    expect(spread35).toBeDefined();
    expect(spread35.outcomes).toHaveLength(2);
    
    // Should have "Charlotte +3.5" and "Houston -3.5" (not the raw Kalshi titles)
    const spreadLabels = spread35.outcomes.map((o: any) => o.label);
    expect(spreadLabels).toContain('Charlotte +3.5');
    expect(spreadLabels).toContain('Houston -3.5');

    // Verify total market format (Over/Under at same total)
    const total217 = result.markets.find((m: any) => m.id === 'total-217.5');
    expect(total217).toBeDefined();
    expect(total217.outcomes).toHaveLength(2);
    
    // Should have "Over 217.5" and "Under 217.5"
    const totalLabels = total217.outcomes.map((o: any) => o.label);
    expect(totalLabels).toContain('Over 217.5');
    expect(totalLabels).toContain('Under 217.5');
  });
});
