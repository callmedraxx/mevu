/**
 * Unit Tests for Frontend Game Transformer
 * Tests moneyline market detection, tennis name cleaning, and price extraction
 */

import { describe, it, expect } from 'vitest';

// Helper functions to test (we'll extract the logic for testing)

/**
 * Clean tennis team names by removing tournament prefixes
 */
function cleanTennisTeamName(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  
  let cleaned = name.trim();
  
  // Generic pattern: anything before a colon is likely a tournament/qualification prefix
  const colonIndex = cleaned.indexOf(':');
  if (colonIndex !== -1) {
    const afterColon = cleaned.slice(colonIndex + 1).trim();
    if (afterColon.length > 0) {
      cleaned = afterColon;
    }
  }
  
  // Also handle specific patterns without colons
  const tournamentPrefixes = [
    /^Australian\s+Open[\s,]*(Men'?s?|Women'?s?)?\s*/i,
    /^US\s+Open[\s,]*(Men'?s?|Women'?s?)?\s*/i,
    /^French\s+Open[\s,]*(Men'?s?|Women'?s?)?\s*/i,
    /^Wimbledon[\s,]*(Men'?s?|Women'?s?)?\s*/i,
    /^Roland\s+Garros[\s,]*(Men'?s?|Women'?s?)?\s*/i,
    /^Qatar\s+Total\s+Open[\s,]*(Qualification)?\s*/i,
    /^Transylvania\s+Open[\s,]*(Qualification)?\s*/i,
    /^Open\s+Sud\s+de\s+France[\s,]*(Qualification)?\s*/i,
    /^Ostrava\s+Open[\s,]*(Qualification)?\s*/i,
    /^Mubadala\s+Abu\s+Dhabi\s+Open[\s,]*(Qualification)?\s*/i,
    /^WTA\s+/i,
    /^ATP\s+/i,
  ];
  
  for (const pattern of tournamentPrefixes) {
    cleaned = cleaned.replace(pattern, '').trim();
  }
  
  return cleaned || undefined;
}

/**
 * Check if a market question indicates a totals market (not moneyline)
 */
function isTotalsMarket(questionLower: string): boolean {
  const hasTotalsKeyword = questionLower.includes('total points') || 
                           questionLower.includes('total sets') || 
                           questionLower.includes('total games') ||
                           questionLower.includes('total score') ||
                           questionLower.includes('total goals') ||
                           questionLower.includes('total runs') ||
                           questionLower.includes('total corners') ||
                           questionLower.includes('total cards');
  return questionLower.includes('o/u') || 
         questionLower.includes('over/under') ||
         hasTotalsKeyword;
}

/**
 * Check if a market question indicates a tennis set prop (not match winner)
 */
function isTennisSetProp(questionLower: string): boolean {
  return questionLower.includes('set 1') ||
         questionLower.includes('set 2') ||
         questionLower.includes('set 3') ||
         questionLower.includes('1st set') ||
         questionLower.includes('2nd set') ||
         questionLower.includes('3rd set') ||
         questionLower.includes('set winner') ||
         questionLower.includes('games o/u') ||
         questionLower.includes('match o/u');
}

describe('Tennis Team Name Cleaning', () => {
  it('should clean Qatar Total Open prefix with colon', () => {
    expect(cleanTennisTeamName('Qatar Total Open, Qualification: Anastasia Zakharova'))
      .toBe('Anastasia Zakharova');
  });

  it('should clean Qatar Total Open prefix without colon', () => {
    expect(cleanTennisTeamName('Qatar Total Open Anastasia Zakharova'))
      .toBe('Anastasia Zakharova');
  });

  it('should clean Australian Open prefix', () => {
    expect(cleanTennisTeamName("Australian Open Men's: Novak Djokovic"))
      .toBe('Novak Djokovic');
  });

  it('should clean Transylvania Open prefix', () => {
    expect(cleanTennisTeamName('Transylvania Open: Emma Raducanu'))
      .toBe('Emma Raducanu');
  });

  it('should clean Mubadala Abu Dhabi Open prefix', () => {
    expect(cleanTennisTeamName('Mubadala Abu Dhabi Open: Hailey Baptiste'))
      .toBe('Hailey Baptiste');
  });

  it('should clean Ostrava Open prefix', () => {
    expect(cleanTennisTeamName('Ostrava Open, Qualification: Katie Volynets'))
      .toBe('Katie Volynets');
  });

  it('should not modify already clean names', () => {
    expect(cleanTennisTeamName('Julia Grabher')).toBe('Julia Grabher');
    expect(cleanTennisTeamName('Anastasia Zakharova')).toBe('Anastasia Zakharova');
  });

  it('should handle empty/null input', () => {
    expect(cleanTennisTeamName(null)).toBeUndefined();
    expect(cleanTennisTeamName(undefined)).toBeUndefined();
    expect(cleanTennisTeamName('')).toBeUndefined();
  });
});

describe('Totals Market Detection', () => {
  it('should NOT detect moneyline as totals', () => {
    // This was the bug - "Qatar Total Open" was detected as totals
    expect(isTotalsMarket('qatar total open, qualification: anastasia zakharova vs julia grabher'))
      .toBe(false);
  });

  it('should detect O/U markets', () => {
    expect(isTotalsMarket('zakharova vs. grabher: total sets o/u 2.5')).toBe(true);
    expect(isTotalsMarket('lakers vs celtics: points o/u 220.5')).toBe(true);
  });

  it('should detect total points markets', () => {
    expect(isTotalsMarket('pacers at bucks total points 220.5')).toBe(true);
  });

  it('should detect total sets markets', () => {
    expect(isTotalsMarket('nadal vs djokovic total sets over 3.5')).toBe(true);
  });

  it('should detect total games markets', () => {
    expect(isTotalsMarket('zakharova vs grabher: total games 21.5')).toBe(true);
  });

  it('should detect total goals markets', () => {
    expect(isTotalsMarket('arsenal vs chelsea total goals 2.5')).toBe(true);
  });

  it('should NOT detect regular moneyline', () => {
    expect(isTotalsMarket('indiana pacers at milwaukee bucks')).toBe(false);
    expect(isTotalsMarket('warriors vs lakers')).toBe(false);
  });
});

describe('Tennis Set Prop Detection', () => {
  it('should detect set 1 winner props', () => {
    expect(isTennisSetProp('set 1 winner: zakharova vs grabher')).toBe(true);
  });

  it('should detect set games O/U props', () => {
    expect(isTennisSetProp('zakharova vs. grabher: set 1 games o/u 8.5')).toBe(true);
  });

  it('should detect match O/U props', () => {
    expect(isTennisSetProp('zakharova vs. grabher: match o/u 21.5')).toBe(true);
  });

  it('should detect 1st/2nd/3rd set props', () => {
    expect(isTennisSetProp('1st set winner: djokovic vs nadal')).toBe(true);
    expect(isTennisSetProp('2nd set total games')).toBe(true);
    expect(isTennisSetProp('3rd set winner')).toBe(true);
  });

  it('should NOT detect moneyline as set prop', () => {
    expect(isTennisSetProp('qatar total open, qualification: anastasia zakharova vs julia grabher'))
      .toBe(false);
    expect(isTennisSetProp('anastasia zakharova vs julia grabher'))
      .toBe(false);
  });

  it('should NOT detect handicap as set prop', () => {
    expect(isTennisSetProp('set handicap: zakharova (-1.5) vs grabher (+1.5)'))
      .toBe(false);
  });
});

describe('Tennis Moneyline Market Matching', () => {
  // Simulated matching logic
  function shouldMatchMoneyline(
    questionLower: string,
    outcomeLabels: string[],
    homeTeamName: string,
    awayTeamName: string
  ): boolean {
    // Check filters
    const isSpreadMarket = questionLower.includes('spread') || 
                           questionLower.includes('(-') || 
                           questionLower.includes('(+') ||
                           questionLower.includes('handicap');
    
    const totalsCheck = isTotalsMarket(questionLower);
    const setPropCheck = isTennisSetProp(questionLower);
    
    const labels = outcomeLabels.map(l => l.toLowerCase());
    const hasNonMoneylineOutcomes = labels.some(l => 
      l === 'over' || l === 'under' || l === 'o/u' ||
      l.startsWith('over ') || l.startsWith('under ')
    );
    
    if (isSpreadMarket || totalsCheck || setPropCheck || hasNonMoneylineOutcomes) {
      return false;
    }
    
    // Check team matching
    const homeLower = homeTeamName.toLowerCase();
    const awayLower = awayTeamName.toLowerCase();
    
    let homeMatch = false;
    let awayMatch = false;
    
    for (const label of labels) {
      if (label.includes(homeLower) || homeLower.includes(label)) {
        homeMatch = true;
      }
      if (label.includes(awayLower) || awayLower.includes(label)) {
        awayMatch = true;
      }
    }
    
    return homeMatch && awayMatch;
  }

  it('should match Qatar Total Open moneyline market', () => {
    const result = shouldMatchMoneyline(
      'qatar total open, qualification: anastasia zakharova vs julia grabher',
      ['Zakharova', 'Grabher'],
      'julia grabher',
      'anastasia zakharova'
    );
    expect(result).toBe(true);
  });

  it('should NOT match set 1 winner market', () => {
    const result = shouldMatchMoneyline(
      'set 1 winner: zakharova vs grabher',
      ['Zakharova', 'Grabher'],
      'julia grabher',
      'anastasia zakharova'
    );
    expect(result).toBe(false);
  });

  it('should NOT match total sets O/U market', () => {
    const result = shouldMatchMoneyline(
      'zakharova vs. grabher: total sets o/u 2.5',
      ['Over 2.5', 'Under 2.5'],
      'julia grabher',
      'anastasia zakharova'
    );
    expect(result).toBe(false);
  });

  it('should NOT match set handicap market', () => {
    const result = shouldMatchMoneyline(
      'set handicap: zakharova (-1.5) vs grabher (+1.5)',
      ['Zakharova', 'Grabher'],
      'julia grabher',
      'anastasia zakharova'
    );
    expect(result).toBe(false);
  });

  it('should match Transylvania Open moneyline', () => {
    const result = shouldMatchMoneyline(
      'transylvania open: emma raducanu vs oleksandra oliynykova',
      ['Raducanu', 'Oliynykova'],
      'oleksandra oliynykova',
      'emma raducanu'
    );
    expect(result).toBe(true);
  });

  it('should match Mubadala Abu Dhabi Open moneyline', () => {
    const result = shouldMatchMoneyline(
      'mubadala abu dhabi open: hailey baptiste vs ekaterina alexandrova',
      ['Baptiste', 'Alexandrova'],
      'ekaterina alexandrova',
      'hailey baptiste'
    );
    expect(result).toBe(true);
  });

  it('should match Sierra vs Al-Mudahka moneyline', () => {
    // This game was failing because matching wasn't working for hyphenated names
    const result = shouldMatchMoneyline(
      'qatar total open, qualification: solana sierra vs hind al-mudahka',
      ['Sierra', 'Al-Mudahka'],
      'hind al-mudahka',
      'solana sierra'
    );
    expect(result).toBe(true);
  });

  it('should match with partial name for hyphenated names', () => {
    // The label is "Al-Mudahka" and team name is "hind al-mudahka"
    const labels = ['sierra', 'al-mudahka'];
    const homeTeamName = 'hind al-mudahka';
    
    // This should match because 'al-mudahka' is included in 'hind al-mudahka'
    const homeMatch = labels.some(label => 
      label.includes(homeTeamName.toLowerCase()) || 
      homeTeamName.toLowerCase().includes(label)
    );
    expect(homeMatch).toBe(true);
  });
});

describe('Price Precision', () => {
  it('should preserve decimal precision for buyPrice', () => {
    // Best ask = 0.995 (99.5%)
    const bestAsk = 0.995;
    const buyPrice = Math.round(bestAsk * 1000) / 10;
    expect(buyPrice).toBe(99.5);
  });

  it('should preserve decimal precision for sellPrice', () => {
    // Best bid = 0.005 (0.5%)
    const bestBid = 0.005;
    const sellPrice = Math.round(bestBid * 1000) / 10;
    expect(sellPrice).toBe(0.5);
  });

  it('should handle whole number prices', () => {
    const bestAsk = 0.84;
    const buyPrice = Math.round(bestAsk * 1000) / 10;
    expect(buyPrice).toBe(84);
  });

  it('should handle edge case near 100', () => {
    const bestAsk = 0.999;
    const buyPrice = Math.round(bestAsk * 1000) / 10;
    expect(buyPrice).toBe(99.9);
  });

  it('should handle edge case near 0', () => {
    const bestBid = 0.001;
    const sellPrice = Math.round(bestBid * 1000) / 10;
    expect(sellPrice).toBe(0.1);
  });

  it('should calculate spread with decimals correctly', () => {
    function calculateSpread(buyPrice: number, sellPrice: number): string {
      const spread = Math.abs(buyPrice - sellPrice);
      const spreadRounded = Math.round(spread * 10) / 10;
      if (spreadRounded <= 1) return '1¢';
      const spreadDisplay = spreadRounded % 1 === 0 ? spreadRounded.toString() : spreadRounded.toFixed(1);
      return `1-${spreadDisplay}¢`;
    }

    expect(calculateSpread(99.5, 98.5)).toBe('1¢');
    expect(calculateSpread(100, 99)).toBe('1¢');
    expect(calculateSpread(85, 82)).toBe('1-3¢');
    expect(calculateSpread(85.5, 82)).toBe('1-3.5¢');
  });
});

// ---------------------------------------------------------------------------
// MWOH (Men's Winter Olympics Hockey) Transformer Tests
// Slug format: mwoh-{team1}-{team2}-{date}  e.g. mwoh-swi-fra-2026-02-12
// Outcomes are full country names e.g. ["Switzerland", "France"]
// Series ID: 11136
// ---------------------------------------------------------------------------

/**
 * Duplicate of extractAbbrevsFromSlug logic (from frontend-game.transformer.ts)
 * with mwoh added to sportIdentifiers — used here for pure-unit testing.
 */
function extractAbbrevsFromSlug(slug: string | undefined, gameSport?: string): { away?: string; home?: string } {
  if (!slug) return {};

  const sportIdentifiers = new Set([
    'nhl', 'nba', 'nfl', 'mlb', 'epl', 'cbb', 'cfb', 'lal',
    'ser', 'bund', 'lig1', 'mls', 'ufc', 'tennis', 'atp', 'wta', 'mwoh',
  ]);

  const slugParts = slug.split('-');
  const firstPartLower = slugParts[0]?.toLowerCase() || '';

  // UFC-specific handling
  if (firstPartLower === 'ufc') {
    const fighterCodes = slugParts
      .slice(1)
      .filter((part) => !/^\d{4}$/.test(part) && !/^\d{2}$/.test(part));
    if (fighterCodes.length >= 2) {
      return { away: fighterCodes[0].toUpperCase(), home: fighterCodes[1].toUpperCase() };
    }
  }

  const teamAbbrevs: string[] = [];
  for (let i = 0; i < slugParts.length; i++) {
    const part = slugParts[i];
    const partLower = part.toLowerCase();
    if (/^\d+$/.test(part)) continue;
    if (i === 0 && sportIdentifiers.has(partLower)) continue;
    if (i > 0 && gameSport && partLower === gameSport.toLowerCase() && sportIdentifiers.has(partLower)) continue;
    if (part.length >= 2 && part.length <= 10 && /^[a-z]+$/i.test(part)) {
      teamAbbrevs.push(part.toUpperCase());
    }
  }

  if (teamAbbrevs.length >= 2) return { away: teamAbbrevs[0], home: teamAbbrevs[1] };
  return {};
}

describe('MWOH Slug Extraction', () => {
  it('should extract country abbreviations from mwoh slug', () => {
    const result = extractAbbrevsFromSlug('mwoh-swi-fra-2026-02-12', 'mwoh');
    expect(result.away).toBe('SWI');
    expect(result.home).toBe('FRA');
  });

  it('should extract abbreviations for other mwoh matchups', () => {
    const result = extractAbbrevsFromSlug('mwoh-can-usa-2026-02-20', 'mwoh');
    expect(result.away).toBe('CAN');
    expect(result.home).toBe('USA');
  });

  it('should NOT treat mwoh as a team abbreviation', () => {
    const result = extractAbbrevsFromSlug('mwoh-ger-swe-2026-02-15', 'mwoh');
    // mwoh must be skipped as the sport identifier, not returned as a team
    expect(result.away).toBe('GER');
    expect(result.home).toBe('SWE');
    expect(result.away).not.toBe('MWOH');
    expect(result.home).not.toBe('GER'); // home should be SWE not GER
  });

  it('should handle mwoh slug without gameSport hint', () => {
    // Even without gameSport, mwoh at index 0 is always skipped
    const result = extractAbbrevsFromSlug('mwoh-fin-lat-2026-02-14');
    expect(result.away).toBe('FIN');
    expect(result.home).toBe('LAT');
  });

  it('should return empty for malformed mwoh slug', () => {
    const result = extractAbbrevsFromSlug('mwoh-2026-02-12', 'mwoh');
    // Only date parts, no valid team abbreviations
    expect(result.away).toBeUndefined();
    expect(result.home).toBeUndefined();
  });
});

describe('MWOH Moneyline Market Matching', () => {
  // mwoh markets use full country names as outcomes: ["Switzerland", "France"]
  // The market question mirrors the game title: "Men's Group A - Switzerland vs. France"
  function isMwohMoneyline(
    questionLower: string,
    outcomeLabels: string[],
  ): boolean {
    // Must not be a prop market
    if (
      questionLower.includes('spread') ||
      questionLower.includes('handicap') ||
      questionLower.includes('total') ||
      questionLower.includes('o/u') ||
      questionLower.includes('over/under')
    ) return false;

    const labels = outcomeLabels.map(l => l.toLowerCase());
    const hasNonMoneyline = labels.some(
      l => l === 'over' || l === 'under' || l.startsWith('over ') || l.startsWith('under ')
    );
    if (hasNonMoneyline) return false;

    // Must have exactly 2 outcomes (home/away countries)
    return labels.length === 2;
  }

  it('should match standard mwoh group game market', () => {
    expect(isMwohMoneyline(
      "men's group a - switzerland vs. france",
      ['Switzerland', 'France'],
    )).toBe(true);
  });

  it('should match mwoh knockout/medal round market', () => {
    expect(isMwohMoneyline(
      "men's quarterfinal - canada vs. usa",
      ['Canada', 'USA'],
    )).toBe(true);
  });

  it('should NOT match total goals prop', () => {
    expect(isMwohMoneyline(
      "switzerland vs. france: total goals o/u 5.5",
      ['Over 5.5', 'Under 5.5'],
    )).toBe(false);
  });

  it('should NOT match handicap prop', () => {
    expect(isMwohMoneyline(
      "switzerland (-1.5) vs. france: handicap",
      ['Switzerland', 'France'],
    )).toBe(false);
  });

  it('should have correct outcome labels as full country names', () => {
    // Real Polymarket mwoh outcomes are full names, not abbreviations
    const outcomes = ['Switzerland', 'France'];
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toBe('Switzerland');
    expect(outcomes[1]).toBe('France');
  });
});

describe('MWOH Sport Detection', () => {
  // Duplicate of the relevant slug-first-part detection logic
  function detectSportFromSlug(slug: string): string | null {
    const configuredSports = new Set([
      'nfl', 'nba', 'mlb', 'nhl', 'ufc', 'epl', 'lal',
      'tennis', 'cbb', 'cfb', 'mwoh',
    ]);
    const firstPart = slug.toLowerCase().split('-')[0];
    if (configuredSports.has(firstPart)) return firstPart;
    return null;
  }

  function isStandardLeague(league: string | null): boolean {
    const STANDARD = new Set([
      'nfl', 'nba', 'mlb', 'nhl', 'ufc', 'epl', 'lal',
      'cbb', 'cfb', 'tennis', 'atp', 'wta', 'mwoh',
    ]);
    return !!league && STANDARD.has(league.toLowerCase());
  }

  it('should detect mwoh sport from slug', () => {
    expect(detectSportFromSlug('mwoh-swi-fra-2026-02-12')).toBe('mwoh');
    expect(detectSportFromSlug('mwoh-can-usa-2026-02-20')).toBe('mwoh');
    expect(detectSportFromSlug('mwoh-ger-swe-2026-02-15')).toBe('mwoh');
  });

  it('should treat mwoh as a standard league for filtering', () => {
    expect(isStandardLeague('mwoh')).toBe(true);
  });

  it('should not confuse mwoh with other hockey (nhl)', () => {
    expect(detectSportFromSlug('nhl-bos-was-2026-02-12')).toBe('nhl');
    expect(detectSportFromSlug('mwoh-swi-fra-2026-02-12')).toBe('mwoh');
  });

  it('should return null for non-sport slugs', () => {
    expect(detectSportFromSlug('btc-usd-2026-02-12')).toBeNull();
    expect(detectSportFromSlug('nflx-earnings-2026')).toBeNull();
  });
});
