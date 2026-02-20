/**
 * Unified Positions Service
 * Merges Polymarket and Kalshi positions for the frontend positions tab.
 */

import { fetchAndStorePositions } from '../positions/positions.service';
import {
  getKalshiPositions,
  getKalshiAvgEntryFromTrades,
  getKalshiCurrentPrice,
} from '../kalshi/kalshi-positions.service';
import { getUserByPrivyId } from '../privy/user.service';
import { UserPosition } from '../positions/positions.types';
import { PositionsQueryParams } from '../positions/positions.types';

export type UnifiedPositionPlatform = 'polymarket' | 'kalshi';

export interface UnifiedPosition {
  id: string;
  title: string;
  slug: string;
  eventId: string;
  conditionId: string;
  asset: string;
  outcome: string;
  oppositeOutcome: string;
  size: string;
  avgPrice: string;
  curPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  redeemable?: boolean;
  endDate: string;
  platform: UnifiedPositionPlatform;
  /** Kalshi-only: ticker for sell */
  kalshiTicker?: string;
  /** Kalshi-only: raw token amount (6 decimals) for sell */
  tokenAmount?: string;
  /** Kalshi-only: outcome YES | NO for sell */
  kalshiOutcome?: string;
  eventSlug?: string;
  privyUserId?: string;
  proxyWalletAddress?: string;
}

/**
 * Fetch unified positions (Polymarket + Kalshi) for a user.
 * Fetches both platforms in parallel when platform is 'all'.
 */
export async function getUnifiedPositions(
  privyUserId: string,
  params: PositionsQueryParams & { platform?: 'all' | 'polymarket' | 'kalshi' } = {}
): Promise<UnifiedPosition[]> {
  const { platform = 'all', ...positionsParams } = params;
  const user = await getUserByPrivyId(privyUserId);
  if (!user) return [];

  const wantsPoly = platform === 'all' || platform === 'polymarket';
  const wantsKalshi = (platform === 'all' || platform === 'kalshi') && !!(user as any).solanaWalletAddress;
  const solanaAddress = (user as any).solanaWalletAddress;

  const [polyPositions, kalshiPositions] = await Promise.all([
    wantsPoly ? fetchAndStorePositions(privyUserId, positionsParams).catch(() => [] as UserPosition[]) : Promise.resolve([] as UserPosition[]),
    wantsKalshi ? getKalshiPositions(solanaAddress) : Promise.resolve([] as Awaited<ReturnType<typeof getKalshiPositions>>),
  ]);

  const results: UnifiedPosition[] = [];

  for (const p of polyPositions) {
    results.push({
      id: p.id,
      title: p.title ?? '',
      slug: p.slug ?? '',
      eventId: p.eventId ?? '',
      conditionId: p.conditionId ?? '',
      asset: p.asset,
      outcome: p.outcome ?? '',
      oppositeOutcome: p.oppositeOutcome ?? '',
      size: p.size,
      avgPrice: p.avgPrice,
      curPrice: p.curPrice,
      initialValue: p.initialValue,
      currentValue: p.currentValue,
      cashPnl: p.cashPnl,
      percentPnl: p.percentPnl,
      redeemable: p.redeemable,
      endDate: p.endDate ?? '',
      platform: 'polymarket',
      eventSlug: p.eventSlug ?? undefined,
    });
  }

  for (const p of kalshiPositions) {
    const sizeNum = parseFloat(p.tokenBalanceHuman);
    const avgCents =
      p.avgEntryPrice ?? (await getKalshiAvgEntryFromTrades(privyUserId, p.kalshiTicker, p.outcome));
    const curCents = await getKalshiCurrentPrice(p.kalshiTicker, p.outcome);
    const curPrice = curCents != null ? (curCents / 100).toString() : (avgCents != null ? (avgCents / 100).toString() : '0.5');
    const avgPrice = avgCents != null ? (avgCents / 100).toString() : (curCents != null ? (curCents / 100).toString() : '0.5');
    const currentValue = (sizeNum * parseFloat(curPrice)).toFixed(2);
    const initialValue = avgCents != null ? (sizeNum * (avgCents / 100)).toFixed(2) : p.totalCostUsdc;
    const cashPnlNum = parseFloat(currentValue) - parseFloat(initialValue);
    const pnlPercent = parseFloat(initialValue) > 0 ? (cashPnlNum / parseFloat(initialValue)) * 100 : 0;
    results.push({
      id: p.outcomeMint,
      title: p.marketTitle,
      slug: p.kalshiTicker,
      eventId: p.kalshiTicker,
      conditionId: '',
      asset: p.outcomeMint,
      outcome: p.outcome,
      oppositeOutcome: p.outcome === 'YES' ? 'NO' : 'YES',
      size: p.tokenBalanceHuman,
      avgPrice,
      curPrice,
      initialValue,
      currentValue,
      cashPnl: cashPnlNum.toFixed(2),
      percentPnl: pnlPercent.toFixed(1),
      redeemable: false,
      endDate: '',
      platform: 'kalshi',
      kalshiTicker: p.kalshiTicker,
      tokenAmount: p.tokenBalance,
      kalshiOutcome: p.outcome,
    });
  }

  return results;
}
