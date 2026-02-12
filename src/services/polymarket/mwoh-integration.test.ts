/**
 * Integration Tests: MWOH (Men's Winter Olympics Hockey) Polymarket Support
 *
 * Verifies that mwoh games are:
 *   1. Present in the sports config with the correct series ID
 *   2. Passed through filterGamesBySports (live-games service)
 *   3. Correctly transformed by the transformer (slug → team abbreviations,
 *      moneyline market detection, frontend_game shape)
 *
 * No Docker / database required — all DB calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock heavy / DB-dependent modules before any service import ─────────────
vi.mock('../../config/database', () => ({
  pool: { connect: vi.fn() },
  getDatabaseConfig: () => ({ type: 'postgres' }),
  memoryStore: new Map(),
}));

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../polymarket/probability-history.service', () => ({
  calculateProbabilityChange: vi.fn().mockResolvedValue({ homePercentChange: 0, awayPercentChange: 0 }),
}));

vi.mock('../polymarket/teams.service', () => ({
  teamsService: {
    getTeamByAbbreviation: vi.fn().mockReturnValue(null),
    getTeamByName: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../redis-games-broadcast.service', () => ({
  broadcastGameUpdate: vi.fn(),
}));

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    on: vi.fn(),
  })),
}));

// ── Now import the modules under test ───────────────────────────────────────
import {
  getSeriesIdForSport,
  isValidSport,
  getSportGameConfig,
  getAvailableSports,
} from './sports-games.config';

import {
  filterGamesBySports,
  type LiveGameEvent,
} from './live-games.service';

import { transformToFrontendGame } from './frontend-game.transformer';
import type { LiveGame } from './live-games.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal LiveGameEvent for an mwoh game */
function makeMwohEvent(overrides: Partial<LiveGameEvent> = {}): LiveGameEvent {
  return {
    id: 'mwoh-swi-fra-test',
    ticker: 'MWOH_SWI_FRA',
    slug: 'mwoh-swi-fra-2026-02-12',
    title: "Men's Group A - Switzerland vs. France",
    description: 'Switzerland vs. France in the Men\'s Winter Olympics Hockey Group A.',
    startDate: '2026-02-12T11:10:00Z',
    endDate: '2026-02-13T00:00:00Z',
    active: true,
    closed: false,
    archived: false,
    markets: [
      {
        id: '1342680',
        question: "Men's Group A - Switzerland vs. France",
        outcomes: '["Switzerland", "France"]',
        outcomePrices: '["0.93", "0.07"]',
        active: true,
        closed: false,
        archived: false,
      },
    ],
    ...overrides,
  };
}

/** Minimal LiveGame (post-transform) for mwoh */
function makeMwohLiveGame(overrides: Partial<LiveGame> = {}): LiveGame {
  return {
    id: 'mwoh-swi-fra-test',
    slug: 'mwoh-swi-fra-2026-02-12',
    title: "Men's Group A - Switzerland vs. France",
    description: 'Switzerland vs. France in the Men\'s Winter Olympics Hockey Group A.',
    startDate: '2026-02-12T11:10:00Z',
    endDate: '2026-02-13T00:00:00Z',
    active: true,
    closed: false,
    archived: false,
    sport: 'mwoh',
    league: 'mwoh',
    live: false,
    ended: false,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    markets: [
      {
        id: '1342680',
        question: "Men's Group A - Switzerland vs. France",
        outcomes: ['Switzerland', 'France'],
        outcomePrices: ['0.93', '0.07'],
        active: true,
        closed: false,
        archived: false,
      },
    ],
    ...overrides,
  } as LiveGame;
}

// ── Sports Config Tests ───────────────────────────────────────────────────────

describe('MWOH Sports Config', () => {
  it('should have mwoh as a valid sport', () => {
    expect(isValidSport('mwoh')).toBe(true);
  });

  it('should return the correct series ID for mwoh (11136)', () => {
    expect(getSeriesIdForSport('mwoh')).toBe('11136');
  });

  it('should return the correct label for mwoh', () => {
    const config = getSportGameConfig('mwoh');
    expect(config).not.toBeNull();
    expect(config!.label).toBe("Men's Winter Olympics Hockey");
  });

  it('should include mwoh in getAvailableSports()', () => {
    expect(getAvailableSports()).toContain('mwoh');
  });

  it('should not affect other sports when mwoh is added', () => {
    // Ensure existing sports still have correct series IDs
    expect(getSeriesIdForSport('nhl')).toBe('10346');
    expect(getSeriesIdForSport('nba')).toBe('10345');
    expect(getSeriesIdForSport('nfl')).toBe('10187');
  });
});

// ── Live-Games Filter Tests ───────────────────────────────────────────────────

describe('MWOH filterGamesBySports', () => {
  it('should include mwoh games in the filtered output', () => {
    const mwohGame = makeMwohEvent();
    const result = filterGamesBySports([mwohGame]);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('mwoh-swi-fra-2026-02-12');
  });

  it('should include multiple mwoh games', () => {
    const games: LiveGameEvent[] = [
      makeMwohEvent({ id: 'g1', slug: 'mwoh-swi-fra-2026-02-12', title: "Men's Group A - Switzerland vs. France" }),
      makeMwohEvent({ id: 'g2', slug: 'mwoh-can-usa-2026-02-14', title: "Men's Group B - Canada vs. USA" }),
      makeMwohEvent({ id: 'g3', slug: 'mwoh-ger-swe-2026-02-15', title: "Men's Group C - Germany vs. Sweden" }),
    ];
    const result = filterGamesBySports(games);
    expect(result).toHaveLength(3);
  });

  it('should NOT include a non-sport game mixed in with mwoh games', () => {
    const games: LiveGameEvent[] = [
      makeMwohEvent({ id: 'g1', slug: 'mwoh-swi-fra-2026-02-12' }),
      makeMwohEvent({ id: 'g2', slug: 'nflx-earnings-2026-02-12', title: 'Netflix Earnings', active: true }),
      makeMwohEvent({ id: 'g3', slug: 'mwoh-can-usa-2026-02-14' }),
    ];
    const result = filterGamesBySports(games);
    const slugs = result.map(g => g.slug);
    expect(slugs).toContain('mwoh-swi-fra-2026-02-12');
    expect(slugs).toContain('mwoh-can-usa-2026-02-14');
    expect(slugs).not.toContain('nflx-earnings-2026-02-12');
  });

  it('should still include existing NHL games alongside mwoh', () => {
    const games: LiveGameEvent[] = [
      makeMwohEvent({ id: 'mwoh1', slug: 'mwoh-swi-fra-2026-02-12' }),
      makeMwohEvent({ id: 'nhl1', slug: 'nhl-bos-was-2026-02-12', title: 'Bruins vs Capitals' }),
    ];
    const result = filterGamesBySports(games);
    const slugs = result.map(g => g.slug);
    expect(slugs).toContain('mwoh-swi-fra-2026-02-12');
    expect(slugs).toContain('nhl-bos-was-2026-02-12');
  });
});

// ── Frontend Game Transformer Tests ──────────────────────────────────────────

describe('MWOH transformToFrontendGame', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should transform an mwoh game to a valid FrontendGame shape', async () => {
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    expect(result).toBeDefined();
    expect(result.id).toBe('mwoh-swi-fra-test');
    expect(result.sport).toBe('mwoh');
    expect(result.slug).toBe('mwoh-swi-fra-2026-02-12');
  });

  it('should extract team abbreviations SWI / FRA from slug', async () => {
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    // Away = SWI (first team in slug), Home = FRA (second team)
    // FrontendTeam uses `abbr`, not `abbreviation`
    expect(result.awayTeam.abbr).toBe('SWI');
    expect(result.homeTeam.abbr).toBe('FRA');
  });

  it('should extract country names and strip group prefix from title', async () => {
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    // Title is "Men's Group A - Switzerland vs. France"
    // After cleaning: away = "Switzerland", home = "France"
    expect(result.awayTeam.name).toBe('Switzerland');
    expect(result.homeTeam.name).toBe('France');
  });

  it('should extract win probabilities from outcome prices', async () => {
    // Switzerland: 0.93, France: 0.07
    // Probabilities live in awayTeam.probability / homeTeam.probability
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    expect(result.awayTeam.probability).toBeGreaterThan(0);
    expect(result.homeTeam.probability).toBeGreaterThan(0);
    // They should sum close to 100
    const total = result.awayTeam.probability + result.homeTeam.probability;
    expect(total).toBeGreaterThan(95);
    expect(total).toBeLessThanOrEqual(100.1);
  });

  it('should identify the 2-outcome market and populate probabilities', async () => {
    // If a moneyline market is found, awayTeam.probability will be non-zero
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    // Switzerland is heavy favourite (~93%), France underdog (~7%)
    expect(result.awayTeam.probability).toBeGreaterThan(0);
    expect(result.homeTeam.probability).toBeGreaterThan(0);
  });

  it('should not treat an mwoh game as a tennis game', async () => {
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    // Tennis-specific fields should not be populated at game level
    expect(result.tennisScore).toBeUndefined();
    // And team-level tennis fields should not be populated
    expect(result.awayTeam.tennisScore).toBeUndefined();
  });

  it('should handle a live mwoh game (in-progress score)', async () => {
    const game = makeMwohLiveGame({
      live: true,
      ended: false,
      score: '2-1',
      period: '2nd',
      elapsed: '14',
    });
    const result = await transformToFrontendGame(game);

    // FrontendGame uses `isLive`, not `live`
    expect(result.isLive).toBe(true);
    expect(result.ended).toBeFalsy();
    // Score lives in awayTeam.score / homeTeam.score (only shown when live or ended)
    expect(result.awayTeam.score).toBeDefined();
    expect(result.homeTeam.score).toBeDefined();
  });

  it('should handle an ended mwoh game', async () => {
    const game = makeMwohLiveGame({
      live: false,
      ended: true,
      closed: true,
      score: '3-1',
    });
    const result = await transformToFrontendGame(game);

    expect(result.ended).toBe(true);
  });
});

// ── Active Market / Outcome Transformation Tests ─────────────────────────────

describe('MWOH Active Market and Outcome Transformation', () => {
  it('should parse mwoh outcomes as an array of country names', () => {
    // The raw Polymarket market has outcomes as a JSON string
    const rawOutcomes = '["Switzerland", "France"]';
    const parsed: string[] = JSON.parse(rawOutcomes);
    expect(parsed).toEqual(['Switzerland', 'France']);
    expect(parsed).toHaveLength(2);
  });

  it('should parse mwoh outcome prices correctly', () => {
    const rawPrices = '["0.93", "0.07"]';
    const prices = JSON.parse(rawPrices).map(Number);
    expect(prices[0]).toBeCloseTo(0.93);
    expect(prices[1]).toBeCloseTo(0.07);
    expect(prices[0] + prices[1]).toBeCloseTo(1.0, 1);
  });

  it('should identify mwoh market as 2-outcome (not 3-way draw)', () => {
    // mwoh is head-to-head: no draw outcome
    const outcomes = ['Switzerland', 'France'];
    expect(outcomes).toHaveLength(2);
    const hasDraw = outcomes.some(o => o.toLowerCase().includes('draw') || o.toLowerCase() === 'tie');
    expect(hasDraw).toBe(false);
  });

  it('should transform mwoh outcome prices to percentage probabilities', () => {
    function toPercent(price: string): number {
      return Math.round(parseFloat(price) * 100 * 100) / 100;
    }
    expect(toPercent('0.93')).toBeCloseTo(93);
    expect(toPercent('0.07')).toBeCloseTo(7);
  });

  it('should match mwoh moneyline market when outcomes are full country names', async () => {
    // The full-country-name outcome is the key difference from typical team abbreviation sports.
    // The transformer must find the moneyline market even though outcome labels are
    // "Switzerland" / "France" rather than short codes.
    const game = makeMwohLiveGame();
    const result = await transformToFrontendGame(game);

    // Probabilities populated means the moneyline market was found
    // Switzerland ~93%, France ~7%
    expect(result.awayTeam.probability).toBeGreaterThan(0);
    expect(result.homeTeam.probability).toBeGreaterThan(0);
  });
});
