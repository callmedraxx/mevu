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
// UNIT TESTS: Helper Functions (getMarketType, rowToYesNoMarket via buildActivityGame)
// =============================================================================

describe('Kalshi Activity Service - Helper Functions', () => {
  const getMarketType = (kalshiActivityService as any).getMarketType?.bind(kalshiActivityService);

  describe('getMarketType', () => {
    it('should return Winner for GAME tickers', () => {
      expect(getMarketType('KXNBAGAME-26FEB05CHAHOU-HOU')).toBe('Winner');
    });
    it('should return Spread for SPREAD tickers', () => {
      expect(getMarketType('KXNBASPREAD-26FEB05CHAHOU-CHA3')).toBe('Spread');
    });
    it('should return Total Points for TOTAL tickers (not TEAMTOTAL)', () => {
      expect(getMarketType('KXNBATOTAL-26FEB05CHAHOU-220')).toBe('Total Points');
    });
    it('should return Team Total for TEAMTOTAL tickers', () => {
      expect(getMarketType('KXNBATEAMTOTAL-26FEB05CHAHOU-CHA100')).toBe('Team Total');
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
// UNIT TESTS: One market per row, Yes/No outcomes (replaces spread/total grouping)
// =============================================================================

describe('Kalshi Activity Service - One Market Per Row', () => {
  const buildActivityGame = (kalshiActivityService as any).buildActivityGame.bind(kalshiActivityService);
  const mockGame = {
    id: '193462',
    slug: 'nba-cha-hou-2026-02-05',
    sport: 'nba',
    league: 'nba',
    homeTeam: { abbr: 'hou', name: 'Rockets', record: '31-18', probability: 58, buyPrice: 59, sellPrice: 58 },
    awayTeam: { abbr: 'cha', name: 'Hornets', record: '23-28', probability: 42, buyPrice: 42, sellPrice: 41 },
  };

  it('should create one market per Kalshi row with ticker as id', () => {
    const kalshiRows = [
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-HOU3', title: 'Houston wins by over 3.5 Points?', yes_bid: 49, yes_ask: 51, no_bid: 49, no_ask: 51, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    expect(result.markets).toHaveLength(2);
    expect(result.markets[0].id).toBe('KXNBASPREAD-26FEB05CHAHOU-CHA3');
    expect(result.markets[1].id).toBe('KXNBASPREAD-26FEB05CHAHOU-HOU3');
  });

  it('should use actual Kalshi question for each market', () => {
    const kalshiRows = [
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    expect(result.markets[0].question).toBe('Charlotte wins by over 3.5 Points?');
  });

  it('should have Yes/No outcomes for each market', () => {
    const kalshiRows = [
      { ticker: 'KXNBATOTAL-26FEB05CHAHOU-217', title: 'Over 217.5 points?', yes_bid: 49, yes_ask: 50, no_bid: 50, no_ask: 51, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    const outcomes = result.markets[0].outcomes;
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].label).toBe('Yes');
    expect(outcomes[1].label).toBe('No');
    expect(outcomes[0].kalshiOutcome).toBe('YES');
    expect(outcomes[1].kalshiOutcome).toBe('NO');
  });

  it('should include kalshiTicker and kalshiOutcome on each outcome for trading', () => {
    const kalshiRows = [
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    const yesOutcome = result.markets[0].outcomes.find((o: any) => o.kalshiOutcome === 'YES');
    const noOutcome = result.markets[0].outcomes.find((o: any) => o.kalshiOutcome === 'NO');
    expect(yesOutcome?.kalshiTicker).toBe('KXNBASPREAD-26FEB05CHAHOU-CHA3');
    expect(noOutcome?.kalshiTicker).toBe('KXNBASPREAD-26FEB05CHAHOU-CHA3');
  });

  it('should add teamAbbr to moneyline (GAME) outcomes so frontend can show team', () => {
    const kalshiRows = [
      { ticker: 'KXNBAGAME-26FEB19HOUCHA-CHA', title: 'Houston at Charlotte Winner?', yes_bid: 44, yes_ask: 45, no_bid: 55, no_ask: 56, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB19HOUCHA-HOU', title: 'Houston at Charlotte Winner?', yes_bid: 57, yes_ask: 58, no_bid: 42, no_ask: 43, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    const chaMarket = result.markets.find((m: any) => m.id === 'KXNBAGAME-26FEB19HOUCHA-CHA');
    const houMarket = result.markets.find((m: any) => m.id === 'KXNBAGAME-26FEB19HOUCHA-HOU');
    expect(chaMarket?.outcomes.every((o: any) => o.teamAbbr === 'CHA')).toBe(true);
    expect(houMarket?.outcomes.every((o: any) => o.teamAbbr === 'HOU')).toBe(true);
  });

  it('should not add teamAbbr to non-moneyline markets', () => {
    const kalshiRows = [
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
    ];
    const result = buildActivityGame(mockGame, kalshiRows);
    expect(result.markets[0].outcomes.every((o: any) => o.teamAbbr === undefined)).toBe(true);
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

  it('should build complete activity game with one market per Kalshi row', () => {
    const kalshiRows = [
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-CHA', title: 'Charlotte at Houston Winner?', yes_bid: 42, yes_ask: 43, no_bid: 57, no_ask: 58, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB05CHAHOU-HOU', title: 'Charlotte at Houston Winner?', yes_bid: 58, yes_ask: 59, no_bid: 42, no_ask: 43, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-CHA3', title: 'Charlotte wins by over 3.5 Points?', yes_bid: 31, yes_ask: 34, no_bid: 66, no_ask: 69, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05CHAHOU-HOU3', title: 'Houston wins by over 3.5 Points?', yes_bid: 49, yes_ask: 51, no_bid: 49, no_ask: 51, volume: 0 },
      { ticker: 'KXNBATOTAL-26FEB05CHAHOU-217', title: 'Over 217.5 points?', yes_bid: 49, yes_ask: 50, no_bid: 50, no_ask: 51, volume: 0 },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // One market per row, each with Yes/No outcomes
    expect(result.markets).toHaveLength(5);
    const spreadMarket = result.markets.find((m: any) => m.id === 'KXNBASPREAD-26FEB05CHAHOU-CHA3');
    expect(spreadMarket?.question).toBe('Charlotte wins by over 3.5 Points?');
    expect(spreadMarket?.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);
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

    // Each Kalshi row = one market with actual question and Yes/No outcomes
    const spreadCha = result.markets.find((m: any) => m.id === 'KXNBASPREAD-26FEB05CHAHOU-CHA3');
    expect(spreadCha).toBeDefined();
    expect(spreadCha.question).toBe('Charlotte wins by over 3.5 Points?');
    expect(spreadCha.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);

    // Verify total market format (Yes/No outcomes)
    const total217 = result.markets.find((m: any) => m.id === 'KXNBATOTAL-26FEB05CHAHOU-217');
    expect(total217).toBeDefined();
    expect(total217.outcomes).toHaveLength(2);
    
    // Total market has Yes/No outcomes (Kalshi style)
    const totalLabels = total217.outcomes.map((o: any) => o.label);
    expect(totalLabels).toContain('Yes');
    expect(totalLabels).toContain('No');
  });

  it('should show both spread outcomes when Kalshi only has one row per spread (single-row spreads)', () => {
    const mockFrontendGame = {
      id: '193444',
      slug: 'nba-was-det-2026-02-05',
      sport: 'nba',
      league: 'nba',
      homeTeam: { abbr: 'det', name: 'Pistons', record: '37-12', probability: 88, buyPrice: 88, sellPrice: 87 },
      awayTeam: { abbr: 'was', name: 'Wizards', record: '13-36', probability: 12, buyPrice: 13, sellPrice: 12 },
    };

    // Simulate Kalshi API: only one market per spread (e.g. "Washington +1.5" OR "Detroit -2.5" per line)
    const kalshiRows = [
      { ticker: 'KXNBAGAME-26FEB05WASDET-DET', title: 'Washington at Detroit Winner?', yes_bid: 87, yes_ask: 88, no_bid: 12, no_ask: 14, volume: 0 },
      { ticker: 'KXNBAGAME-26FEB05WASDET-WAS', title: 'Washington at Detroit Winner?', yes_bid: 11, yes_ask: 12, no_bid: 88, no_ask: 87, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05WASDET-WAS1', title: 'Washington wins by over 1.5 Points?', yes_bid: 11, yes_ask: 12, no_bid: 88, no_ask: 89, volume: 0 },
      { ticker: 'KXNBASPREAD-26FEB05WASDET-DET2', title: 'Detroit wins by over 2.5 Points?', yes_bid: 80, yes_ask: 86, no_bid: 14, no_ask: 20, volume: 0 },
      { ticker: 'KXNBATOTAL-26FEB05WASDET-209', title: 'Over 209.5 points?', yes_bid: 80, yes_ask: 87, no_bid: 13, no_ask: 20, volume: 0 },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // One market per row - find spread markets by ticker
    const spreadWas1 = result.markets.find((m: any) => m.id === 'KXNBASPREAD-26FEB05WASDET-WAS1');
    expect(spreadWas1).toBeDefined();
    expect(spreadWas1.question).toBe('Washington wins by over 1.5 Points?');
    expect(spreadWas1.outcomes).toHaveLength(2);
    expect(spreadWas1.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);
    const yesOutcome = spreadWas1.outcomes.find((o: any) => o.kalshiOutcome === 'YES');
    expect(yesOutcome?.buyPrice).toBe(12);
    expect(yesOutcome?.sellPrice).toBe(11);

    const spreadDet2 = result.markets.find((m: any) => m.id === 'KXNBASPREAD-26FEB05WASDET-DET2');
    expect(spreadDet2).toBeDefined();
    const det2Yes = spreadDet2.outcomes.find((o: any) => o.kalshiOutcome === 'YES');
    expect(det2Yes?.buyPrice).toBe(86);
    expect(det2Yes?.sellPrice).toBe(80);
  });

  it('should build moneyline market for tennis (single-market sport)', () => {
    const mockFrontendGame = {
      id: '198793',
      slug: 'atp-mannari-gea-2026-02-06',
      sport: 'tennis',
      league: 'tennis',
      homeTeam: { abbr: 'GEA', name: 'Arthur Gea', record: '0-0', probability: 63, buyPrice: 63, sellPrice: 62 },
      awayTeam: { abbr: 'MANNARI', name: 'Adrian Mannarino', record: '0-0', probability: 37, buyPrice: 38, sellPrice: 37 },
    };

    // Tennis has a single market per match: YES = away (Mannarino) wins, NO = home (Gea) wins
    const kalshiRows = [
      { 
        ticker: 'KXATPMATCH-26FEB06MANGEA', 
        title: 'Mannarino vs Gea',
        yes_bid: 37,   // Away (Mannarino) sell price
        yes_ask: 38,   // Away (Mannarino) buy price
        no_bid: 62,    // Home (Gea) sell price  
        no_ask: 63,    // Home (Gea) buy price
        volume: 5000 
      },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    // Verify structure - single market with Yes/No
    expect(result.platform).toBe('kalshi');
    expect(result.kalshiTicker).toBe('KXATPMATCH-26FEB06MANGEA');
    expect(result.markets.length).toBe(1);

    const moneyline = result.markets[0];
    expect(moneyline.id).toBe('KXATPMATCH-26FEB06MANGEA');
    expect(moneyline.question).toBe('Mannarino vs Gea');
    expect(moneyline.outcomes).toHaveLength(2);
    expect(moneyline.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);

    // Yes = away (Mannarino) wins
    const yesOutcome = moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'YES');
    expect(yesOutcome?.buyPrice).toBe(38);
    expect(yesOutcome?.sellPrice).toBe(37);

    // No = home (Gea) wins
    const noOutcome = moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'NO');
    expect(noOutcome?.buyPrice).toBe(63);
    expect(noOutcome?.sellPrice).toBe(62);

    // Verify team prices are set correctly
    expect(result.awayTeam.kalshiBuyPrice).toBe(38);
    expect(result.awayTeam.kalshiSellPrice).toBe(37);
    expect(result.homeTeam.kalshiBuyPrice).toBe(63);
    expect(result.homeTeam.kalshiSellPrice).toBe(62);
  });

  it('should build moneyline market for WTA tennis', () => {
    const mockFrontendGame = {
      id: '199509',
      slug: 'wta-zarazua-birrell-2026-02-06',
      sport: 'tennis',
      league: 'tennis',
      homeTeam: { abbr: 'BIRRELL', name: 'Kimberly Birrell', record: '0-0', probability: 60, buyPrice: 60, sellPrice: 59 },
      awayTeam: { abbr: 'ZARAZUA', name: 'Renata Zarazua', record: '0-0', probability: 40, buyPrice: 41, sellPrice: 40 },
    };

    const kalshiRows = [
      { 
        ticker: 'KXWTAMATCH-26FEB06ZARBIR', 
        title: 'Zarazua vs Birrell',
        yes_bid: 40,   // Away (Zarazua) sell
        yes_ask: 41,   // Away (Zarazua) buy
        no_bid: 59,    // Home (Birrell) sell
        no_ask: 60,    // Home (Birrell) buy
        volume: 8000 
      },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    expect(result.markets.length).toBe(1);
    const moneyline = result.markets[0];
    expect(moneyline.outcomes).toHaveLength(2);
    expect(moneyline.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);

    // Away = YES, Home = NO
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'YES')?.buyPrice).toBe(41);
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'NO')?.buyPrice).toBe(60);
  });

  it('should build moneyline market for UFC (single-market sport)', () => {
    const mockFrontendGame = {
      id: '190700',
      slug: 'ufc-mic1-mar14-2026-02-07',
      sport: 'ufc',
      league: 'ufc',
      homeTeam: { abbr: 'MAR14', name: 'Marc-Andre Barriault', record: '17-10', probability: 20, buyPrice: 21, sellPrice: 80 },
      awayTeam: { abbr: 'MIC1', name: 'Michal Oleksiejczuk', record: '21-9', probability: 80, buyPrice: 80, sellPrice: 21 },
    };

    const kalshiRows = [
      { 
        ticker: 'KXUFCFIGHT-26FEB07OLEBAR', 
        title: 'Oleksiejczuk vs Barriault',
        yes_bid: 79,   // Away wins sell
        yes_ask: 81,   // Away wins buy
        no_bid: 19,    // Home wins sell
        no_ask: 21,    // Home wins buy
        volume: 10000 
      },
    ];

    const result = buildActivityGame(mockFrontendGame, kalshiRows);

    expect(result.markets.length).toBe(1);
    const moneyline = result.markets[0];
    expect(moneyline.outcomes).toHaveLength(2);
    expect(moneyline.outcomes.map((o: any) => o.label)).toEqual(['Yes', 'No']);

    // Away fighter = YES
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'YES')?.buyPrice).toBe(81);
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'YES')?.sellPrice).toBe(79);

    // Home fighter = NO
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'NO')?.buyPrice).toBe(21);
    expect(moneyline.outcomes.find((o: any) => o.kalshiOutcome === 'NO')?.sellPrice).toBe(19);
  });
});
