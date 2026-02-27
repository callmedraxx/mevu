/**
 * Finance Market Transformer
 * Transforms finance_markets DB rows to PredictionMarket frontend format.
 * Reuses the same outcome/price logic as crypto markets with category='finance'.
 */

export interface FinanceMarketOutcome {
  label: string;
  price: number;
  clobTokenId?: string;
  marketId?: string;
}

export interface FinanceMarketFrontend {
  id: string;
  slug: string;
  question: string;
  category: 'finance';
  subcategory: string;
  timeframe?: string;
  yesPrice: number;
  noPrice: number;
  yesProbability: number;
  volume: string;
  liquidity: string;
  traders: number;
  percentChange: number;
  endDate: string;
  isLive: boolean;
  icon?: string;
  tags?: string[];
  kalshiYesPrice?: number | null;
  kalshiNoPrice?: number | null;
  marketType: 'binary' | 'multi-outcome';
  outcomes: FinanceMarketOutcome[];
}

interface SubMarket {
  id?: string;
  question?: string;
  outcomes?: string[] | unknown;
  outcomePrices?: string[] | number[] | unknown;
  clobTokenIds?: string[] | unknown;
}

export interface FinanceMarketRow {
  id: string;
  slug: string;
  title: string;
  end_date: string | null;
  icon: string | null;
  active: boolean;
  closed: boolean;
  liquidity: number | null;
  volume: number | null;
  comment_count: number;
  is_live: boolean;
  timeframe: string | null;
  asset: string | null;
  tags: string[];
  markets: SubMarket[];
}

function formatVolume(value: number | null | undefined): string {
  if (value == null) return '$0';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${Math.round(value)}`;
}

function toPercent(raw: unknown): number {
  const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (isNaN(n)) return 0;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? val : [];
}

function extractPriceLabel(question: string): string {
  const priceMatch = question.match(/\$[\d,]+(?:k)?/i);
  const price = priceMatch ? priceMatch[0] : question;
  const isDip = /dip\s+to/i.test(question);
  return isDip ? `${price} (dip)` : price;
}

function extractDifferentiatingLabels(questions: string[]): string[] {
  if (questions.length <= 1) return questions;

  let prefixLen = 0;
  const shortest = questions.reduce((a, b) => (a.length < b.length ? a : b));
  for (let i = 0; i < shortest.length; i++) {
    if (questions.every((q) => q[i] === shortest[i])) {
      prefixLen = i + 1;
    } else {
      break;
    }
  }

  while (prefixLen > 0 && shortest[prefixLen - 1] !== ' ') {
    prefixLen--;
  }

  let suffixLen = 0;
  for (let i = 1; i <= shortest.length - prefixLen; i++) {
    if (questions.every((q) => q[q.length - i] === shortest[shortest.length - i])) {
      suffixLen = i;
    } else {
      break;
    }
  }

  while (suffixLen > 0 && shortest[shortest.length - suffixLen] !== ' ') {
    suffixLen--;
  }

  return questions.map((q) => {
    let label = q.slice(prefixLen, q.length - suffixLen).trim();
    label = label.replace(/^[?,.\s]+|[?,.\s]+$/g, '');
    label = label.replace(/^(by|in|to|on|at|for|of)\s+/i, '');
    return label || q;
  });
}

function buildBinaryOutcomes(market: SubMarket): FinanceMarketOutcome[] {
  const outcomes = safeArray<string>(market.outcomes).map(String);
  const prices = safeArray(market.outcomePrices);
  const tokenIds = safeArray<string>(market.clobTokenIds);

  return outcomes.map((label, i) => ({
    label,
    price: toPercent(prices[i]),
    clobTokenId: tokenIds[i] ?? undefined,
    marketId: market.id ?? undefined,
  }));
}

function buildMultiOutcomes(markets: SubMarket[]): FinanceMarketOutcome[] {
  const questions = markets.map((m) => m.question ?? '');

  const hasPrices = questions.some((q) => /\$[\d,]+(?:k)?/i.test(q));
  const labels = hasPrices
    ? questions.map(extractPriceLabel)
    : extractDifferentiatingLabels(questions);

  return markets.map((m, i) => {
    const outcomes = safeArray<string>(m.outcomes).map(String);
    const prices = safeArray(m.outcomePrices);
    const tokenIds = safeArray<string>(m.clobTokenIds);

    const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
    const priceIdx = yesIdx >= 0 ? yesIdx : 0;

    return {
      label: labels[i],
      price: toPercent(prices[priceIdx]),
      clobTokenId: tokenIds[priceIdx] ?? undefined,
      marketId: m.id ?? undefined,
    };
  });
}

function extractYesNoPrices(markets: SubMarket[]): { yesPrice: number; noPrice: number } {
  const m = markets?.[0];
  if (!m) return { yesPrice: 50, noPrice: 50 };
  const outcomes = safeArray<string>(m.outcomes).map(String);
  const prices = safeArray(m.outcomePrices).map(toPercent);

  const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === 'yes');
  if (yesIdx >= 0 && prices[yesIdx] != null) {
    const yes = prices[yesIdx];
    return { yesPrice: yes, noPrice: Math.round((100 - yes) * 10) / 10 };
  }
  if (prices.length >= 2) {
    return { yesPrice: prices[0], noPrice: prices[1] };
  }
  if (prices.length === 1) {
    return { yesPrice: prices[0], noPrice: Math.round((100 - prices[0]) * 10) / 10 };
  }
  return { yesPrice: 50, noPrice: 50 };
}

// Map of asset slugs to display names
const ASSET_DISPLAY_NAMES: Record<string, string> = {
  'stocks': 'Stocks',
  'earnings': 'Earnings',
  'indicies': 'Indices',
  'indices': 'Indices',
  'commodities': 'Commodities',
  'forex': 'Forex',
  'collectibles': 'Collectibles',
  'acquisitions': 'Acquisitions',
  'earnings-calls': 'Earnings Calls',
  'ipos': 'IPOs',
  'ipo': 'IPOs',
  'fed-rates': 'Fed Rates',
  'prediction-markets': 'Prediction Markets',
  'treasuries': 'Treasuries',
  'treasures': 'Treasuries',
  'tech': 'Tech',
  'big-tech': 'Big Tech',
  'economy': 'Economy',
};

export function transformFinanceMarketToFrontend(row: FinanceMarketRow): FinanceMarketFrontend {
  const markets = row.markets ?? [];
  const isMultiOutcome = markets.length > 1;
  const marketType = isMultiOutcome ? 'multi-outcome' : 'binary';

  const outcomes = isMultiOutcome
    ? buildMultiOutcomes(markets)
    : markets.length === 1
      ? buildBinaryOutcomes(markets[0])
      : [];

  const { yesPrice, noPrice } = extractYesNoPrices(markets);
  const subcategory = row.asset
    ? (ASSET_DISPLAY_NAMES[row.asset] ?? row.asset.charAt(0).toUpperCase() + row.asset.slice(1).toLowerCase())
    : 'Finance';
  const timeframe = row.timeframe?.toLowerCase() ?? undefined;

  return {
    id: row.id,
    slug: row.slug,
    question: row.title,
    category: 'finance',
    subcategory,
    timeframe: timeframe || undefined,
    yesPrice,
    noPrice,
    yesProbability: yesPrice,
    volume: formatVolume(row.volume),
    liquidity: formatVolume(row.liquidity),
    traders: row.comment_count ?? 0,
    percentChange: 0,
    endDate: row.end_date ?? new Date().toISOString().slice(0, 10),
    isLive: row.is_live ?? false,
    icon: row.icon ?? undefined,
    tags: row.tags?.length ? row.tags : undefined,
    kalshiYesPrice: null,
    kalshiNoPrice: null,
    marketType,
    outcomes,
  };
}
