/**
 * Debug script: fetch UFC game from DB, run actual transformToFrontendGame,
 * and validate buyPrice, sellPrice, probability are correct (not 50/50 or -1).
 *
 * Run: npm run debug:ufc-moneyline:docker
 * Or:  npx tsx scripts/debug-ufc-moneyline.ts
 */

import dotenv from 'dotenv';
import { Pool } from 'pg';
import { loadFromDatabase as loadUfcFighterRecords } from '../src/services/ufc/ufc-fighter-records.service';
import { transformToFrontendGame } from '../src/services/polymarket/frontend-game.transformer';
import type { LiveGame } from '../src/services/polymarket/live-games.service';
import type { FrontendGame } from '../src/services/polymarket/frontend-game.transformer';

dotenv.config();

const TARGET_SLUG = 'ufc-riz-jai3-2026-02-07';

function parseArr(val: any): any[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const p = JSON.parse(val);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Mirrors extractPrices logic from frontend-game.transformer:
 * - 2-way markets: round higher probability, derive lower = 100 - higher (so they sum to 100)
 * - buyPrice: use structuredOutcomes.buyPrice if available, else Math.ceil(rawPrice)
 * - sellPrice: use structuredOutcomes.sellPrice if available, else Math.ceil(100 - buyPrice)
 */
function getExpectedFromFirstMarket(game: any): {
  awayProb: number;
  homeProb: number;
  awayBuy: number;
  awaySell: number;
  homeBuy: number;
  homeSell: number;
} | null {
  const markets = game.markets || [];
  const rawDataMarkets = (game.rawData as any)?.markets || [];
  const marketsToUse =
    (game.sport?.toLowerCase() === 'ufc' || game.league?.toLowerCase() === 'ufc') &&
    markets.length === 0 &&
    rawDataMarkets.length > 0
      ? rawDataMarkets
      : markets;

  for (const m of marketsToUse) {
    const rawOutcomes = parseArr(m.outcomes);
    const rawPrices = parseArr(m.outcomePrices);
    if (rawOutcomes.length !== 2 || rawPrices.length !== 2) continue;

    const questionLower = (m.question || '').toLowerCase();
    const labels = rawOutcomes.map((l: string) => String(l).toLowerCase());
    const hasNonMoneyline = labels.some(
      (l: string) =>
        l === 'over' || l === 'under' || l === 'yes' || l === 'no' || l.includes('points') || l.includes('rounds')
    );
    if (
      questionLower.includes('spread') ||
      questionLower.includes('handicap') ||
      questionLower.includes('o/u') ||
      questionLower.includes('over/under') ||
      questionLower.includes('total') ||
      questionLower.includes('win by') ||
      hasNonMoneyline
    )
      continue;

    const awayYesPrice = parseFloat(String(rawPrices[0])) * 100;
    const homeYesPrice = parseFloat(String(rawPrices[1])) * 100;
    const structuredOutcomes = m.structuredOutcomes || [];

    // Probability: same as extractPrices for 2-way (round higher, derive lower)
    let awayProb: number;
    let homeProb: number;
    if (homeYesPrice >= awayYesPrice) {
      homeProb = Math.round(homeYesPrice);
      awayProb = 100 - homeProb;
    } else {
      awayProb = Math.round(awayYesPrice);
      homeProb = 100 - awayProb;
    }

    // buyPrice/sellPrice: use CLOB from structuredOutcomes if present, else ceil(rawPrice)
    let awayBuy: number;
    let awaySell: number;
    let homeBuy: number;
    let homeSell: number;
    if (structuredOutcomes[0]?.buyPrice != null) {
      awayBuy = structuredOutcomes[0].buyPrice;
      awaySell = structuredOutcomes[0].sellPrice != null ? structuredOutcomes[0].sellPrice : Math.ceil(100 - awayBuy);
    } else {
      awayBuy = Math.ceil(awayYesPrice);
      awaySell = Math.ceil(100 - awayYesPrice);
    }
    if (structuredOutcomes[1]?.buyPrice != null) {
      homeBuy = structuredOutcomes[1].buyPrice;
      homeSell = structuredOutcomes[1].sellPrice != null ? structuredOutcomes[1].sellPrice : Math.ceil(100 - homeBuy);
    } else {
      homeBuy = Math.ceil(homeYesPrice);
      homeSell = Math.ceil(100 - homeYesPrice);
    }

    return { awayProb, homeProb, awayBuy, awaySell, homeBuy, homeSell };
  }
  return null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL required. Set it in .env or pass as env var.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString });

  console.log(`\n=== Fetching game from live_games (slug=${TARGET_SLUG}) ===\n`);

  const result = await pool.query(
    `SELECT id, slug, sport, league, transformed_data, raw_data
     FROM live_games
     WHERE LOWER(slug) = $1 OR LOWER(ticker) = $1
     LIMIT 1`,
    [TARGET_SLUG.toLowerCase()]
  );
  await pool.end();

  if (result.rows.length === 0) {
    console.log('Game not found in database.');
    process.exit(1);
  }

  const row = result.rows[0];
  let game: any = row.transformed_data;
  if (typeof game === 'string') {
    game = JSON.parse(game);
  }
  if (row.raw_data) {
    const raw = typeof row.raw_data === 'object' ? row.raw_data : JSON.parse(row.raw_data);
    game.rawData = raw;
  }

  const expected = getExpectedFromFirstMarket(game);
  if (expected) {
    console.log('Expected from first moneyline market (transformer logic):');
    console.log('  away: probability', expected.awayProb, '%, buyPrice', expected.awayBuy, ', sellPrice', expected.awaySell);
    console.log('  home: probability', expected.homeProb, '%, buyPrice', expected.homeBuy, ', sellPrice', expected.homeSell);
  } else {
    console.log('Could not derive expected values from markets.');
  }

  console.log('\n=== Running transformToFrontendGame (actual transformer) ===\n');

  process.env.NODE_ENV = 'production';
  await loadUfcFighterRecords();

  const fg: FrontendGame = await transformToFrontendGame(game as LiveGame, {
    homePercentChange: 0,
    awayPercentChange: 0,
  });

  console.log('=== TRANSFORM OUTPUT ===');
  console.log('awayTeam:', JSON.stringify(fg.awayTeam, null, 2));
  console.log('homeTeam:', JSON.stringify(fg.homeTeam, null, 2));
  console.log('spread:', fg.spread);

  const NO_PRICE = -1;
  const issues: string[] = [];

  if (fg.awayTeam.probability === 50 && fg.homeTeam.probability === 50) {
    issues.push('Both probabilities are 50/50 (moneyline likely not found)');
  }
  if (fg.awayTeam.probability === NO_PRICE || fg.homeTeam.probability === NO_PRICE) {
    issues.push('Probability is -1 (NO_PRICE - moneyline not found)');
  }
  if (fg.awayTeam.buyPrice === 50 && fg.awayTeam.sellPrice === 50) {
    issues.push('Away buyPrice/sellPrice are 50/50');
  }
  if (fg.homeTeam.buyPrice === 50 && fg.homeTeam.sellPrice === 50) {
    issues.push('Home buyPrice/sellPrice are 50/50');
  }
  if (fg.awayTeam.buyPrice === NO_PRICE || fg.homeTeam.buyPrice === NO_PRICE) {
    issues.push('buyPrice is -1 (NO_PRICE)');
  }

  if (expected) {
    const awayProbOk =
      fg.awayTeam.probability === expected.awayProb &&
      fg.awayTeam.probability !== 50 &&
      fg.awayTeam.probability !== NO_PRICE;
    const homeProbOk =
      fg.homeTeam.probability === expected.homeProb &&
      fg.homeTeam.probability !== 50 &&
      fg.homeTeam.probability !== NO_PRICE;
    const awayPriceOk = fg.awayTeam.buyPrice === expected.awayBuy && fg.awayTeam.sellPrice === expected.awaySell;
    const homePriceOk = fg.homeTeam.buyPrice === expected.homeBuy && fg.homeTeam.sellPrice === expected.homeSell;
    if (!awayProbOk || !homeProbOk) {
      issues.push(
        `Probabilities: got away=${fg.awayTeam.probability} home=${fg.homeTeam.probability}, expected away=${expected.awayProb} home=${expected.homeProb}`
      );
    }
    if (!awayPriceOk || !homePriceOk) {
      issues.push(
        `Prices: got away buy=${fg.awayTeam.buyPrice} sell=${fg.awayTeam.sellPrice}, home buy=${fg.homeTeam.buyPrice} sell=${fg.homeTeam.sellPrice}; expected away buy=${expected.awayBuy} sell=${expected.awaySell}, home buy=${expected.homeBuy} sell=${expected.homeSell}`
      );
    }
  }

  console.log('\n=== VALIDATION ===');
  if (issues.length === 0) {
    console.log('PASS: buyPrice, sellPrice, probability look correct.');
  } else {
    console.log('FAIL:');
    issues.forEach((i) => console.log('  -', i));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
