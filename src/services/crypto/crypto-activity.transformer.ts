/**
 * Crypto Activity Transformer
 * Transforms crypto market detail (from getCryptoMarketDetailBySlug) into an
 * activity-watcher-style payload for the frontend. No teams — just markets and outcomes.
 * Reuses ActivityWatcherMarket/ActivityWatcherOutcome for consistent API contract.
 */

import type { ActivityWatcherMarket, ActivityWatcherOutcome } from '../polymarket/activity-watcher.transformer';

export interface CryptoActivityPayload {
  id: string;
  slug: string;
  title: string;
  asset?: string;
  timeframe?: string;
  icon?: string;
  seriesSlug?: string;
  endDate?: string;
  volume: string;
  liquidity: string;
  markets: ActivityWatcherMarket[];
}

interface SubMarketRaw {
  id?: string;
  question?: string;
  groupItemTitle?: string;
  outcomes?: string[];
  outcomePrices?: (string | number)[];
  bestBid?: number | string;
  bestAsk?: number | string;
  volume?: string | number;
  liquidity?: string | number;
  liquidity_num?: number | null;
  liquidityClob?: number;
  clobTokenIds?: string[];
  conditionId?: string;
  negRisk?: boolean;
  negRiskMarketId?: string;
}

function formatCurrency(value: number | string | undefined | null): string {
  const numeric = typeof value === 'string' ? parseFloat(value) : Number(value ?? 0);
  if (!Number.isFinite(numeric)) return '$0';
  if (numeric >= 1_000_000) return `$${(numeric / 1_000_000).toFixed(2)}M`;
  if (numeric >= 1_000) return `$${(numeric / 1_000).toFixed(1)}k`;
  return `$${Math.round(numeric)}`;
}

/** Parse price: Gamma uses 0-1 scale; we want 0-100 for display. */
function toPercent(raw: unknown): number {
  const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function transformSubMarket(sub: SubMarketRaw, index: number): ActivityWatcherMarket | null {
  const outcomes = Array.isArray(sub.outcomes) ? sub.outcomes : ['Yes', 'No'];
  const prices = Array.isArray(sub.outcomePrices)
    ? sub.outcomePrices.map(toPercent)
    : [];

  const outcomeList: ActivityWatcherOutcome[] = outcomes.map((label, i) => {
    const rawPrice = sub.outcomePrices?.[i];
    const price = toPercent(rawPrice);
    const buyPrice = sub.bestAsk != null ? toPercent(sub.bestAsk) : undefined;
    const sellPrice = sub.bestBid != null ? toPercent(sub.bestBid) : undefined;
    const clobTokenId = Array.isArray(sub.clobTokenIds) ? sub.clobTokenIds[i] : undefined;

    return {
      label,
      price: Number(price.toFixed(2)),
      probability: Number(price.toFixed(2)),
      buyPrice,
      sellPrice,
      clobTokenId,
    };
  });

  const vol = sub.volume ?? sub.liquidity ?? 0;
  const liq = sub.liquidity ?? sub.liquidity_num ?? sub.liquidityClob ?? 0;

  return {
    id: String(sub.id ?? index),
    title: sub.groupItemTitle ?? sub.question ?? `Market ${index + 1}`,
    question: sub.question ?? sub.groupItemTitle ?? `Market ${index + 1}`,
    volume: formatCurrency(vol),
    liquidity: formatCurrency(liq),
    outcomes: outcomeList,
    conditionId: sub.conditionId,
    clobTokenIds: sub.clobTokenIds,
    negRisk: sub.negRisk,
    negRiskMarketId: sub.negRiskMarketId,
  };
}

/**
 * Transform crypto market detail into activity-watcher-style payload.
 * No teams — only markets and their outcomes for display/trading.
 */
export function transformCryptoDetailToActivity(
  detail: Record<string, unknown>
): CryptoActivityPayload {
  const marketsRaw = (detail.markets as SubMarketRaw[]) ?? [];
  const markets = marketsRaw
    .map((m, i) => transformSubMarket(m, i))
    .filter((m): m is ActivityWatcherMarket => m !== null);

  const vol = (detail.volume ?? 0) as string | number | null | undefined;
  const liq = (detail.liquidity ?? detail.liquidity_clob ?? 0) as string | number | null | undefined;

  return {
    id: String(detail.id ?? ''),
    slug: String(detail.slug ?? detail.ticker ?? ''),
    title: String(detail.title ?? ''),
    asset: detail.asset as string | undefined,
    timeframe: detail.timeframe as string | undefined,
    icon: detail.icon as string | undefined,
    seriesSlug: detail.series_slug as string | undefined,
    endDate: detail.end_date as string | undefined,
    volume: formatCurrency(vol),
    liquidity: formatCurrency(liq),
    markets,
  };
}
