/**
 * Debug script to inspect UFC game structure for moneyline lookup
 * Run with: npx ts-node scripts/debug-ufc-moneyline.ts
 *
 * Investigates why findMoneylineMarket fails for ufc-riz-jai3-2026-02-07
 */

import axios from 'axios';

const TARGET_SLUG = 'ufc-riz-jai3-2026-02-07';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function main() {
  console.log(`\n=== Fetching UFC events (series_id=38) to find ${TARGET_SLUG} ===\n`);

  const url = `${GAMMA_API}/events?series_id=38&limit=50&offset=0&order=endDate&ascending=false&include_chat=false&active=true`;

  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });

  const events = Array.isArray(response.data) ? response.data : response.data?.data || response.data?.events || [];
  console.log(`Fetched ${events.length} UFC events\n`);

  const target = events.find((e: any) => (e.slug || '').toLowerCase() === TARGET_SLUG.toLowerCase());
  if (!target) {
    console.log(`Event not found. Slugs in response: ${events.slice(0, 10).map((e: any) => e.slug).join(', ')}...`);
    return;
  }

  console.log('=== TARGET EVENT ===');
  console.log('id:', target.id);
  console.log('slug:', target.slug);
  console.log('title:', target.title);
  console.log('description:', target.description?.substring(0, 150) + '...');
  console.log('\n=== TEAM IDENTIFIERS (for findMoneylineMarket) ===');
  console.log('teamIdentifiers:', JSON.stringify(target.teamIdentifiers, null, 2));
  console.log('homeTeam:', JSON.stringify(target.homeTeam, null, 2));
  console.log('awayTeam:', JSON.stringify(target.awayTeam, null, 2));

  const markets = target.markets || [];
  console.log(`\n=== MARKETS (${markets.length} total) ===`);

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    console.log(`\n--- Market ${i + 1} ---`);
    console.log('  question:', m.question);
    console.log('  outcomes:', JSON.stringify(m.outcomes));
    console.log('  outcomePrices:', JSON.stringify(m.outcomePrices));
    console.log('  structuredOutcomes:', JSON.stringify(m.structuredOutcomes, null, 4));
    console.log('  closed:', m.closed);
  }

  const parseArr = (val: any): any[] => {
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
  };

  console.log('\n=== SIMULATING findMoneylineMarket (with JSON parse) ===');
  let homeTeamName = (target.homeTeam?.name || target.teamIdentifiers?.home || '').toLowerCase();
  let awayTeamName = (target.awayTeam?.name || target.teamIdentifiers?.away || '').toLowerCase();
  let homeAbbr = (target.homeTeam?.abbreviation || '').toLowerCase();
  let awayAbbr = (target.teamIdentifiers?.away || target.teamIdentifiers?.home || '').toLowerCase();

  const stripUfcPrefix = (s: string) =>
    s.replace(/^ufc[^:]*:\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  if (!homeTeamName && !awayTeamName && target.title) {
    const vsMatch = target.title.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+)$/i);
    if (vsMatch) {
      awayTeamName = stripUfcPrefix(vsMatch[1].trim().toLowerCase());
      homeTeamName = stripUfcPrefix(vsMatch[2].trim().toLowerCase());
    }
  }
  if (homeTeamName) homeTeamName = stripUfcPrefix(homeTeamName);
  if (awayTeamName) awayTeamName = stripUfcPrefix(awayTeamName);

  if (!homeTeamName && !awayTeamName && target.slug) {
    const slugParts = target.slug.split('-');
    const sportIds = new Set(['nhl', 'nba', 'nfl', 'mlb', 'epl', 'cbb', 'cfb', 'ufc', 'lal', 'ser', 'bund', 'lig1', 'mls']);
    const teamParts: string[] = [];
    for (let i = 1; i < slugParts.length; i++) {
      const part = slugParts[i];
      if (/^\d{4}-\d{2}-\d{2}/.test(part) || sportIds.has(part.toLowerCase())) continue;
      if (part.length >= 2 && part.length <= 10) teamParts.push(part.toLowerCase());
    }
    if (teamParts.length >= 2) {
      awayAbbr = teamParts[0];
      homeAbbr = teamParts[1];
    }
  }

  console.log('  homeTeamName:', homeTeamName || '(empty)');
  console.log('  awayTeamName:', awayTeamName || '(empty)');
  console.log('  homeAbbr:', homeAbbr || '(empty)');
  console.log('  awayAbbr:', awayAbbr || '(empty)');

  // Check each market for match
  for (const market of markets) {
    const rawOutcomes = parseArr(market.outcomes);
    const rawPrices = parseArr(market.outcomePrices);
    const outcomes =
      rawOutcomes.length === 2 && rawPrices.length === 2
        ? rawOutcomes.map((l: string, i: number) => ({
            label: l,
            price: parseFloat(String(rawPrices[i])) * 100,
          }))
        : market.structuredOutcomes || [];

    if (!Array.isArray(outcomes) || outcomes.length !== 2) {
      console.log(`\n  Market "${market.question?.substring(0, 50)}..." - SKIP (outcomes: ${rawOutcomes.length}, prices: ${rawPrices.length})`);
      continue;
    }

    const labels = outcomes.map((o: any) => String(o.label || '').toLowerCase());
    console.log(`\n  Market: "${market.question}"`);
    console.log('    labels:', labels);

    let homeMatch = false;
    let awayMatch = false;
    for (const o of outcomes) {
      const label = String(o.label || '').toLowerCase();
      const shortLabel = String((o as any).shortLabel || '').toLowerCase();
      if (homeTeamName && (label.includes(homeTeamName) || homeTeamName.includes(label) || label === homeTeamName)) homeMatch = true;
      if (homeAbbr && (label === homeAbbr || shortLabel === homeAbbr || label.includes(homeAbbr))) homeMatch = true;
      if (awayTeamName && (label.includes(awayTeamName) || awayTeamName.includes(label) || label === awayTeamName)) awayMatch = true;
      if (awayAbbr && (label === awayAbbr || shortLabel === awayAbbr || label.includes(awayAbbr))) awayMatch = true;
    }
    console.log('    homeMatch:', homeMatch, 'awayMatch:', awayMatch);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
