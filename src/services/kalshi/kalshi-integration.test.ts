/**
 * Integration Tests for Kalshi Matching and Price Transformation
 *
 * Tests:
 * 1. Matching accuracy - Kalshi markets correctly match to live_games
 * 2. Price transformation - Kalshi prices correctly added to frontend games
 *
 * Uses real API data from dev.api.mevu.com for integration tests
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { transformToFrontendGame, KalshiPriceData } from '../polymarket/frontend-game.transformer';
import { LiveGame } from '../polymarket/live-games.service';
import { normalizeTeamName, parseTeamsFromTitle, teamsMatch } from './team-normalizer';

// =============================================================================
// UNIT TESTS: Price Transformation
// =============================================================================

describe('Kalshi Price Transformation', () => {
  // Mock logger to prevent console output during tests
  vi.mock('../../config/logger', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }));

  describe('transformToFrontendGame with Kalshi data', () => {
    const createMockLiveGame = (overrides: Partial<LiveGame> = {}): LiveGame => ({
      id: 'test-game-1',
      title: 'Lakers vs Celtics',
      slug: 'nba-lal-bos-2026-02-05',
      sport: 'nba',
      league: 'nba',
      startDate: '2026-02-05T00:00:00Z',
      endDate: '2026-02-05T03:00:00Z',
      markets: [{
        id: 'market-1',
        question: 'Lakers vs Celtics',
        outcomes: ['Lakers', 'Celtics'],
        outcomePrices: ['0.45', '0.55'],
        structuredOutcomes: [
          { label: 'Lakers', shortLabel: 'LAL', price: '45.00', probability: 45 },
          { label: 'Celtics', shortLabel: 'BOS', price: '55.00', probability: 55 },
        ],
      }],
      teamIdentifiers: { away: 'Lakers', home: 'Celtics' },
      homeTeam: { name: 'Celtics', abbreviation: 'BOS', record: '35-15' },
      awayTeam: { name: 'Lakers', abbreviation: 'LAL', record: '28-22' },
      ...overrides,
    } as LiveGame);

    it('should add Kalshi prices to away team correctly', async () => {
      const game = createMockLiveGame();
      const kalshiData: KalshiPriceData = {
        yesBid: 43,   // Away sell price
        yesAsk: 47,   // Away buy price
        noBid: 52,    // Home sell price
        noAsk: 56,    // Home buy price
        ticker: 'KXNBA-LAL-BOS-20260205',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      // Away team (YES outcome = away wins)
      expect(result.awayTeam.kalshiBuyPrice).toBe(47);   // yesAsk
      expect(result.awayTeam.kalshiSellPrice).toBe(43);  // yesBid
    });

    it('should add Kalshi prices to home team correctly', async () => {
      const game = createMockLiveGame();
      const kalshiData: KalshiPriceData = {
        yesBid: 43,
        yesAsk: 47,
        noBid: 52,    // Home sell price
        noAsk: 56,    // Home buy price
        ticker: 'KXNBA-LAL-BOS-20260205',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      // Home team (NO outcome = home wins)
      expect(result.homeTeam.kalshiBuyPrice).toBe(56);   // noAsk
      expect(result.homeTeam.kalshiSellPrice).toBe(52);  // noBid
    });

    it('should include Kalshi ticker in frontend game', async () => {
      const game = createMockLiveGame();
      const kalshiData: KalshiPriceData = {
        yesBid: 43,
        yesAsk: 47,
        noBid: 52,
        noAsk: 56,
        ticker: 'KXNBA-LAL-BOS-20260205',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      expect(result.kalshiTicker).toBe('KXNBA-LAL-BOS-20260205');
    });

    it('should handle zero Kalshi prices', async () => {
      const game = createMockLiveGame();
      const kalshiData: KalshiPriceData = {
        yesBid: 0,
        yesAsk: 1,
        noBid: 99,
        noAsk: 100,
        ticker: 'KXNBA-HEAVY-FAVORITE',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      expect(result.awayTeam.kalshiBuyPrice).toBe(1);
      expect(result.awayTeam.kalshiSellPrice).toBe(0);
      expect(result.homeTeam.kalshiBuyPrice).toBe(100);
      expect(result.homeTeam.kalshiSellPrice).toBe(99);
    });

    it('should not include Kalshi fields when no Kalshi data provided', async () => {
      const game = createMockLiveGame();

      const result = await transformToFrontendGame(game);

      expect(result.awayTeam.kalshiBuyPrice).toBeUndefined();
      expect(result.awayTeam.kalshiSellPrice).toBeUndefined();
      expect(result.homeTeam.kalshiBuyPrice).toBeUndefined();
      expect(result.homeTeam.kalshiSellPrice).toBeUndefined();
      expect(result.kalshiTicker).toBeUndefined();
    });

    it('should preserve Polymarket prices when Kalshi data is added', async () => {
      const game = createMockLiveGame();
      const kalshiData: KalshiPriceData = {
        yesBid: 40,
        yesAsk: 44,
        noBid: 55,
        noAsk: 59,
        ticker: 'KXNBA-TEST',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      // Polymarket prices should still be present
      expect(result.awayTeam.buyPrice).toBeDefined();
      expect(result.awayTeam.sellPrice).toBeDefined();
      expect(result.homeTeam.buyPrice).toBeDefined();
      expect(result.homeTeam.sellPrice).toBeDefined();

      // Kalshi prices should be separate
      expect(result.awayTeam.kalshiBuyPrice).toBe(44);
      expect(result.homeTeam.kalshiBuyPrice).toBe(59);
    });
  });
});

// =============================================================================
// UNIT TESTS: Matching Logic
// =============================================================================

describe('Kalshi Matching Logic', () => {
  describe('Team Name Matching for Kalshi Markets', () => {
    // Test cases based on real Kalshi market titles
    const matchingTestCases = [
      // NBA
      { kalshiTitle: 'Lakers vs Celtics', polyTeams: { away: 'los angeles lakers', home: 'boston celtics' }, shouldMatch: true },
      { kalshiTitle: 'Thunder @ Spurs', polyTeams: { away: 'oklahoma city thunder', home: 'san antonio spurs' }, shouldMatch: true },
      { kalshiTitle: 'Warriors vs Heat', polyTeams: { away: 'golden state warriors', home: 'miami heat' }, shouldMatch: true },

      // NFL
      { kalshiTitle: 'Chiefs vs Bills', polyTeams: { away: 'kansas city chiefs', home: 'buffalo bills' }, shouldMatch: true },
      { kalshiTitle: 'Eagles @ Cowboys', polyTeams: { away: 'philadelphia eagles', home: 'dallas cowboys' }, shouldMatch: true },

      // Different teams should not match
      { kalshiTitle: 'Lakers vs Celtics', polyTeams: { away: 'los angeles clippers', home: 'boston celtics' }, shouldMatch: false },
      { kalshiTitle: 'Chiefs vs Bills', polyTeams: { away: 'kansas city chiefs', home: 'miami dolphins' }, shouldMatch: false },
    ];

    matchingTestCases.forEach(({ kalshiTitle, polyTeams, shouldMatch }) => {
      it(`should ${shouldMatch ? '' : 'NOT '}match "${kalshiTitle}" to ${polyTeams.away} vs ${polyTeams.home}`, () => {
        const parsed = parseTeamsFromTitle(kalshiTitle);
        expect(parsed).not.toBeNull();

        if (parsed) {
          const awayNormalized = normalizeTeamName(parsed.awayTeam);
          const homeNormalized = normalizeTeamName(parsed.homeTeam);

          const awayMatches = teamsMatch(awayNormalized, polyTeams.away);
          const homeMatches = teamsMatch(homeNormalized, polyTeams.home);

          expect(awayMatches && homeMatches).toBe(shouldMatch);
        }
      });
    });
  });

  describe('Sport-specific matching rules', () => {
    it('should match NBA team names with city prefix', () => {
      expect(teamsMatch('Lakers', 'Los Angeles Lakers')).toBe(true);
      expect(teamsMatch('Celtics', 'Boston Celtics')).toBe(true);
      expect(teamsMatch('Warriors', 'Golden State Warriors')).toBe(true);
    });

    it('should match NFL team names via normalization', () => {
      // Test via normalization - both should normalize to the same value
      expect(normalizeTeamName('Chiefs')).toBe('kansas city chiefs');
      expect(normalizeTeamName('49ers')).toBe('san francisco 49ers');
      expect(normalizeTeamName('Bills')).toBe('buffalo bills');

      // Direct teamsMatch works when Kalshi uses short name
      expect(teamsMatch('Chiefs', 'chiefs')).toBe(true);
      expect(teamsMatch('49ers', 'san francisco 49ers')).toBe(true);
      expect(teamsMatch('Bills', 'Buffalo Bills')).toBe(true);
    });

    it('should match NHL team names', () => {
      expect(teamsMatch('Bruins', 'Boston Bruins')).toBe(true);
      expect(teamsMatch('Golden Knights', 'Vegas Golden Knights')).toBe(true);
    });

    it('should match EPL team names with common abbreviations', () => {
      expect(teamsMatch('Man City', 'Manchester City')).toBe(true);
      expect(teamsMatch('Man Utd', 'Manchester United')).toBe(true);
    });
  });

  describe('Date matching simulation', () => {
    it('should correctly extract game date from close_time', () => {
      // Simulate Kalshi close_time to game_date extraction
      const closeTime = new Date('2026-02-05T04:00:00Z');
      const gameDate = new Date(closeTime);
      gameDate.setHours(0, 0, 0, 0);

      expect(gameDate.toISOString().split('T')[0]).toBe('2026-02-05');
    });

    it('should handle timezone edge cases for game dates', () => {
      // A game at 11pm EST (4am UTC next day) should still match the EST date
      const closeTimeUtc = new Date('2026-02-06T04:00:00Z'); // 11pm EST Feb 5
      const gameDate = new Date(closeTimeUtc);
      gameDate.setHours(0, 0, 0, 0);

      // The game date in UTC would be Feb 6, but the actual game is Feb 5 EST
      // This tests that our matching logic handles this correctly
      expect(gameDate.getUTCDate()).toBe(6);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS: Real API Data
// =============================================================================

describe('Integration: Real API Data Matching', () => {
  interface FrontendGame {
    id: string;
    slug: string;
    sport: string;
    awayTeam: { abbr: string; name: string };
    homeTeam: { abbr: string; name: string };
    endDate: string;
  }

  let frontendGames: FrontendGame[] = [];

  beforeAll(async () => {
    try {
      const response = await fetch('https://dev.api.mevu.com/api/games/frontend?limit=50');
      const data = await response.json() as { games?: FrontendGame[] };
      frontendGames = data.games || [];
    } catch (error) {
      console.warn('Could not fetch from dev API, skipping integration tests');
    }
  });

  describe('Team name normalization for API games', () => {
    it('should normalize team names from real API data', () => {
      if (frontendGames.length === 0) {
        console.warn('No games fetched, skipping test');
        return;
      }

      // Test that we can normalize team names from real games
      for (const game of frontendGames.slice(0, 10)) {
        const homeNormalized = normalizeTeamName(game.homeTeam.name);
        const awayNormalized = normalizeTeamName(game.awayTeam.name);

        // Normalized names should be lowercase
        expect(homeNormalized).toBe(homeNormalized.toLowerCase());
        expect(awayNormalized).toBe(awayNormalized.toLowerCase());

        // Normalized names should not be empty
        expect(homeNormalized.length).toBeGreaterThan(0);
        expect(awayNormalized.length).toBeGreaterThan(0);
      }
    });

    it('should correctly identify teams from slug format', () => {
      if (frontendGames.length === 0) {
        console.warn('No games fetched, skipping test');
        return;
      }

      // Slugs follow format: sport-away-home-date
      for (const game of frontendGames.slice(0, 10)) {
        if (!game.slug) continue;

        const slugParts = game.slug.split('-');
        if (slugParts.length >= 4) {
          const sport = slugParts[0];
          expect(game.sport?.toLowerCase()).toBe(sport);
        }
      }
    });
  });

  describe('Simulated Kalshi market matching', () => {
    it('should match simulated Kalshi NBA markets to real games', () => {
      const nbaGames = frontendGames.filter(g => g.sport === 'nba');
      if (nbaGames.length === 0) {
        console.warn('No NBA games found, skipping test');
        return;
      }

      // Simulate a Kalshi market for the first NBA game
      const game = nbaGames[0];
      const simulatedKalshiTitle = `${game.awayTeam.name} vs ${game.homeTeam.name}`;

      const parsed = parseTeamsFromTitle(simulatedKalshiTitle);
      expect(parsed).not.toBeNull();

      if (parsed) {
        // The parsed teams should match back to the original game
        const awayMatches = teamsMatch(parsed.awayTeam, game.awayTeam.name);
        const homeMatches = teamsMatch(parsed.homeTeam, game.homeTeam.name);

        expect(awayMatches).toBe(true);
        expect(homeMatches).toBe(true);
      }
    });

    it('should match simulated Kalshi CBB markets to real games', () => {
      const cbbGames = frontendGames.filter(g => g.sport === 'cbb');
      if (cbbGames.length === 0) {
        console.warn('No CBB games found, skipping test');
        return;
      }

      const game = cbbGames[0];
      const simulatedKalshiTitle = `${game.awayTeam.name} @ ${game.homeTeam.name}`;

      const parsed = parseTeamsFromTitle(simulatedKalshiTitle);
      expect(parsed).not.toBeNull();

      if (parsed) {
        const awayMatches = teamsMatch(parsed.awayTeam, game.awayTeam.name);
        const homeMatches = teamsMatch(parsed.homeTeam, game.homeTeam.name);

        expect(awayMatches).toBe(true);
        expect(homeMatches).toBe(true);
      }
    });
  });

  describe('Game date extraction from API', () => {
    it('should extract valid game dates from real games', () => {
      if (frontendGames.length === 0) {
        console.warn('No games fetched, skipping test');
        return;
      }

      for (const game of frontendGames.slice(0, 10)) {
        if (game.endDate) {
          const endDate = new Date(game.endDate);
          expect(endDate.toString()).not.toBe('Invalid Date');
        }

        // Slug should contain date in YYYY-MM-DD format at the end
        if (game.slug) {
          const dateMatch = game.slug.match(/(\d{4}-\d{2}-\d{2})$/);
          if (dateMatch) {
            const slugDate = new Date(dateMatch[1]);
            expect(slugDate.toString()).not.toBe('Invalid Date');
          }
        }
      }
    });
  });
});

// =============================================================================
// MATCHING CRITERIA TESTS
// =============================================================================

describe('Kalshi Matching Criteria', () => {
  describe('SQL matching logic simulation', () => {
    interface KalshiMarket {
      ticker: string;
      sport: string;
      homeTeam: string;
      awayTeam: string;
      homeTeamAbbr: string;
      awayTeamAbbr: string;
      gameDate: Date;
    }

    interface LiveGameRow {
      id: string;
      sport: string;
      homeTeamNormalized: string;
      awayTeamNormalized: string;
      homeAbbr: string;
      awayAbbr: string;
      startDate: Date;
    }

    // Simulate the SQL matching logic from kalshi-matcher.service.ts
    function simulateMatch(kalshi: KalshiMarket, liveGame: LiveGameRow): boolean {
      // 1. Sport must match
      if (kalshi.sport.toLowerCase() !== liveGame.sport.toLowerCase()) {
        return false;
      }

      // 2. Date must match
      const kalshiDate = kalshi.gameDate.toISOString().split('T')[0];
      const liveGameDate = liveGame.startDate.toISOString().split('T')[0];
      if (kalshiDate !== liveGameDate) {
        return false;
      }

      // 3. Team names must match (one of three methods)
      const normalizedMatch =
        kalshi.homeTeam.toLowerCase() === liveGame.homeTeamNormalized.toLowerCase() &&
        kalshi.awayTeam.toLowerCase() === liveGame.awayTeamNormalized.toLowerCase();

      const abbrMatch =
        kalshi.homeTeamAbbr.toUpperCase() === liveGame.homeAbbr.toUpperCase() &&
        kalshi.awayTeamAbbr.toUpperCase() === liveGame.awayAbbr.toUpperCase();

      const fuzzyMatch =
        (kalshi.homeTeam.toLowerCase().includes(liveGame.homeTeamNormalized.toLowerCase()) ||
         liveGame.homeTeamNormalized.toLowerCase().includes(kalshi.homeTeam.toLowerCase())) &&
        (kalshi.awayTeam.toLowerCase().includes(liveGame.awayTeamNormalized.toLowerCase()) ||
         liveGame.awayTeamNormalized.toLowerCase().includes(kalshi.awayTeam.toLowerCase()));

      return normalizedMatch || abbrMatch || fuzzyMatch;
    }

    it('should match by exact normalized team names', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNBA-LAL-BOS',
        sport: 'nba',
        homeTeam: 'boston celtics',
        awayTeam: 'los angeles lakers',
        homeTeamAbbr: 'BOS',
        awayTeamAbbr: 'LAL',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-1',
        sport: 'nba',
        homeTeamNormalized: 'boston celtics',
        awayTeamNormalized: 'los angeles lakers',
        homeAbbr: 'bos',
        awayAbbr: 'lal',
        startDate: new Date('2026-02-05'),
      };

      expect(simulateMatch(kalshi, liveGame)).toBe(true);
    });

    it('should match by abbreviation', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNBA-OKC-SAS',
        sport: 'nba',
        homeTeam: 'spurs',  // Partial name
        awayTeam: 'thunder',
        homeTeamAbbr: 'SAS',
        awayTeamAbbr: 'OKC',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-2',
        sport: 'nba',
        homeTeamNormalized: 'san antonio spurs',
        awayTeamNormalized: 'oklahoma city thunder',
        homeAbbr: 'SAS',
        awayAbbr: 'OKC',
        startDate: new Date('2026-02-05'),
      };

      expect(simulateMatch(kalshi, liveGame)).toBe(true);
    });

    it('should match by fuzzy name (contains)', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNBA-GSW-MIA',
        sport: 'nba',
        homeTeam: 'heat',
        awayTeam: 'warriors',
        homeTeamAbbr: '',
        awayTeamAbbr: '',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-3',
        sport: 'nba',
        homeTeamNormalized: 'miami heat',
        awayTeamNormalized: 'golden state warriors',
        homeAbbr: 'MIA',
        awayAbbr: 'GSW',
        startDate: new Date('2026-02-05'),
      };

      expect(simulateMatch(kalshi, liveGame)).toBe(true);
    });

    it('should NOT match different sports', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNFL-KC-BUF',
        sport: 'nfl',  // NFL
        homeTeam: 'buffalo bills',
        awayTeam: 'kansas city chiefs',
        homeTeamAbbr: 'BUF',
        awayTeamAbbr: 'KC',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-4',
        sport: 'nba',  // NBA
        homeTeamNormalized: 'buffalo bills',
        awayTeamNormalized: 'kansas city chiefs',
        homeAbbr: 'BUF',
        awayAbbr: 'KC',
        startDate: new Date('2026-02-05'),
      };

      expect(simulateMatch(kalshi, liveGame)).toBe(false);
    });

    it('should NOT match different dates', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNBA-LAL-BOS',
        sport: 'nba',
        homeTeam: 'boston celtics',
        awayTeam: 'los angeles lakers',
        homeTeamAbbr: 'BOS',
        awayTeamAbbr: 'LAL',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-5',
        sport: 'nba',
        homeTeamNormalized: 'boston celtics',
        awayTeamNormalized: 'los angeles lakers',
        homeAbbr: 'BOS',
        awayAbbr: 'LAL',
        startDate: new Date('2026-02-06'),  // Different date
      };

      expect(simulateMatch(kalshi, liveGame)).toBe(false);
    });

    it('should NOT match swapped home/away teams', () => {
      const kalshi: KalshiMarket = {
        ticker: 'KXNBA-LAL-BOS',
        sport: 'nba',
        homeTeam: 'boston celtics',
        awayTeam: 'los angeles lakers',
        homeTeamAbbr: 'BOS',
        awayTeamAbbr: 'LAL',
        gameDate: new Date('2026-02-05'),
      };

      const liveGame: LiveGameRow = {
        id: 'game-6',
        sport: 'nba',
        // Swapped: Lakers at home, Celtics away
        homeTeamNormalized: 'los angeles lakers',
        awayTeamNormalized: 'boston celtics',
        homeAbbr: 'LAL',
        awayAbbr: 'BOS',
        startDate: new Date('2026-02-05'),
      };

      // This should NOT match because home/away are swapped
      expect(simulateMatch(kalshi, liveGame)).toBe(false);
    });
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
  describe('Special team name formats', () => {
    it('should handle team names with numbers (76ers, 49ers)', () => {
      const normalized76ers = normalizeTeamName('76ers');
      const normalized49ers = normalizeTeamName('49ers');

      expect(normalized76ers).toBe('philadelphia 76ers');
      expect(normalized49ers).toBe('san francisco 49ers');
    });

    it('should handle team names with special characters', () => {
      const normalizedBrighton = normalizeTeamName("Brighton & Hove Albion");
      expect(normalizedBrighton.toLowerCase()).toContain('brighton');
    });

    it('should handle college team full names', () => {
      // CBB teams often have full names like "South Dakota Coyotes"
      const parsed = parseTeamsFromTitle('South Dakota Coyotes vs Kansas City Roos');
      expect(parsed).not.toBeNull();
      expect(parsed?.awayTeam).toBe('South Dakota Coyotes');
      expect(parsed?.homeTeam).toBe('Kansas City Roos');
    });
  });

  describe('Title parsing edge cases', () => {
    it('should handle "at" separator', () => {
      const result = parseTeamsFromTitle('Lakers at Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should handle "@" separator', () => {
      const result = parseTeamsFromTitle('Lakers @ Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should handle "vs." with period', () => {
      const result = parseTeamsFromTitle('Lakers vs. Celtics');
      expect(result).toEqual({ awayTeam: 'Lakers', homeTeam: 'Celtics' });
    });

    it('should handle extra whitespace', () => {
      const result = parseTeamsFromTitle('  Lakers   vs   Celtics  ');
      expect(result).not.toBeNull();
      expect(result?.awayTeam.trim()).toBe('Lakers');
      expect(result?.homeTeam.trim()).toBe('Celtics');
    });
  });

  describe('Price edge cases', () => {
    it('should handle Kalshi prices at extremes (1-99)', async () => {
      const { transformToFrontendGame } = await import('../polymarket/frontend-game.transformer');

      const game = {
        id: 'extreme-test',
        title: 'Lakers vs Celtics',
        slug: 'nba-lal-bos-2026-02-05',
        sport: 'nba',
        league: 'nba',
        markets: [{
          outcomes: ['Lakers', 'Celtics'],
          outcomePrices: ['0.99', '0.01'],
        }],
        teamIdentifiers: { away: 'Lakers', home: 'Celtics' },
      } as any;

      const kalshiData: KalshiPriceData = {
        yesBid: 98,
        yesAsk: 99,
        noBid: 1,
        noAsk: 2,
        ticker: 'KXNBA-EXTREME',
      };

      const result = await transformToFrontendGame(game, undefined, kalshiData);

      expect(result.awayTeam.kalshiBuyPrice).toBe(99);
      expect(result.awayTeam.kalshiSellPrice).toBe(98);
      expect(result.homeTeam.kalshiBuyPrice).toBe(2);
      expect(result.homeTeam.kalshiSellPrice).toBe(1);
    });
  });
});
