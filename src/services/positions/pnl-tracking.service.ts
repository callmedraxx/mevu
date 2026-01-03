/**
 * P&L Tracking Service
 * Handles calculation and storage of profit/loss data including:
 * - Realized P&L from closed positions (trades)
 * - Unrealized P&L from active positions
 * - Historical P&L snapshots for charting
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { logger } from '../../config/logger';
import { getTradeHistory } from '../polymarket/trading/trades-history.service';
import { getPortfolioSummary, getPositions } from './positions.service';
import { getUserByPrivyId } from '../privy/user.service';

/**
 * P&L snapshot interface
 */
export interface PnLSnapshot {
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  portfolioValue: number;
  usdcBalance: number;
  totalValue: number;
  activePositionsCount: number;
  totalPositionsCount: number;
  totalPercentPnl: number;
  snapshotAt: Date;
  // Additional tracking fields
  estimatedDeposits: number;
  externalWithdrawals: number;
  tradingIn: number;
  tradingOut: number;
}

/**
 * Historical P&L data point for charting
 */
export interface HistoricalPnLPoint {
  date: string; // ISO date string
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  portfolioValue: number;
  usdcBalance: number;
  totalValue: number;
}

/**
 * Calculate realized P&L from trade history
 * 
 * Strategy: Match BUY/SELL pairs per position (clob_token_id) to calculate actual profit/loss
 * 
 * For each unique clob_token_id:
 * 1. Sum all BUY costs (including fees)
 * 2. Sum all SELL/REDEEM proceeds
 * 3. Realized P&L = Total SELL proceeds - Total BUY costs
 * 
 * This ensures we only count profit/loss from closed positions, not all trades.
 */
async function calculateRealizedPnl(privyUserId: string): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In development mode, return 0
    return 0;
  }

  const client = await pool.connect();

  try {
    // Calculate realized P&L by matching BUY/SELL pairs per position (clob_token_id)
    // For each position, calculate: (Total SELL proceeds + REDEEM proceeds) - (Total BUY cost)
    // Only count positions where we've actually sold/redeemed shares
    const positionResult = await client.query(
      `WITH position_summary AS (
        SELECT 
          clob_token_id,
          SUM(CASE WHEN side = 'BUY' THEN cost_usdc ELSE 0 END) as total_buy_cost,
          SUM(CASE WHEN side = 'SELL' AND price < 0.99 THEN cost_usdc ELSE 0 END) as total_sell_proceeds,
          SUM(CASE WHEN side = 'SELL' AND price >= 0.99 THEN size * 1.0 ELSE 0 END) as total_redeem_proceeds,
          SUM(CASE WHEN side = 'BUY' THEN size ELSE 0 END) as total_bought_shares,
          SUM(CASE WHEN side = 'SELL' THEN size ELSE 0 END) as total_sold_shares
        FROM trades_history
        WHERE privy_user_id = $1 AND status = 'FILLED'
        GROUP BY clob_token_id
      )
      SELECT 
        total_buy_cost,
        total_sell_proceeds,
        total_redeem_proceeds,
        total_bought_shares,
        total_sold_shares,
        (total_sell_proceeds + total_redeem_proceeds) - total_buy_cost as realized_pnl
      FROM position_summary
      WHERE total_sold_shares > 0 OR total_redeem_proceeds > 0`,
      [privyUserId]
    );

    let totalRealizedPnl = 0;
    for (const row of positionResult.rows) {
      const buyCost = parseFloat(row.total_buy_cost || '0');
      const sellProceeds = parseFloat(row.total_sell_proceeds || '0');
      const redeemProceeds = parseFloat(row.total_redeem_proceeds || '0');
      
      // Realized P&L for this position = (SELL proceeds + REDEEM proceeds) - BUY cost
      const positionRealizedPnl = (sellProceeds + redeemProceeds) - buyCost;
      totalRealizedPnl += positionRealizedPnl;
    }

    return totalRealizedPnl;
  } catch (error) {
    logger.error({
      message: 'Error calculating realized P&L',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Known Polymarket contract addresses on Polygon
 * Transfers to/from these are trading activity, NOT deposits/withdrawals
 */
const POLYMARKET_CONTRACTS = [
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', // CTF Exchange
  '0xc5d563a36ae78145c45a50134d48a1215220f80a', // Neg Risk CTF Exchange  
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // Conditional Tokens (redemptions)
  '0x23895ddd9d2a22215080c0529614e471e1006bdf', // Fee/Gas address
  '0x0000000000000000000000000000000000000000', // Burn address
].map(addr => addr.toLowerCase());

/**
 * Check if an address is a Polymarket contract
 */
function isPolymarketContract(address: string): boolean {
  return POLYMARKET_CONTRACTS.includes(address.toLowerCase());
}

/**
 * Calculate TRUE external deposits (money put into wallet from outside)
 * Excludes: trading proceeds (sells/redemptions from Polymarket)
 * Includes: bridge deposits, external wallet transfers
 */
async function calculateTrueDeposits(privyUserId: string): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return 0;
  }

  const client = await pool.connect();

  try {
    // Get all "in" transfers NOT from Polymarket contracts
    const result = await client.query(
      `SELECT COALESCE(SUM(amount_human), 0) as total_deposits
       FROM wallet_usdc_transfers
       WHERE privy_user_id = $1 
         AND transfer_type = 'in'
         AND LOWER(from_address) NOT IN (${POLYMARKET_CONTRACTS.map((_, i) => `$${i + 2}`).join(', ')})`,
      [privyUserId, ...POLYMARKET_CONTRACTS]
    );
    
    return parseFloat(result.rows[0]?.total_deposits || '0');
  } catch (error) {
    logger.error({
      message: 'Error calculating true deposits',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Calculate TRUE external withdrawals (money taken out to external addresses)
 * Excludes: trading activity (buys to Polymarket), fees
 * Includes: withdrawals to external wallets
 */
async function calculateTrueWithdrawals(privyUserId: string): Promise<number> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return 0;
  }

  const client = await pool.connect();

  try {
    // Get all "out" transfers NOT to Polymarket contracts
    const result = await client.query(
      `SELECT COALESCE(SUM(amount_human), 0) as total_withdrawals
       FROM wallet_usdc_transfers
       WHERE privy_user_id = $1 
         AND transfer_type = 'out'
         AND LOWER(to_address) NOT IN (${POLYMARKET_CONTRACTS.map((_, i) => `$${i + 2}`).join(', ')})`,
      [privyUserId, ...POLYMARKET_CONTRACTS]
    );
    
    return parseFloat(result.rows[0]?.total_withdrawals || '0');
  } catch (error) {
    logger.error({
      message: 'Error calculating true withdrawals',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    client.release();
  }
}

/**
 * Get user's current USDC balance
 */
async function getUserBalance(privyUserId: string): Promise<number> {
  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user || !user.proxyWalletAddress) {
      return 0;
    }

    // Import balance service dynamically to avoid circular dependencies
    const { getBalanceFromDb } = await import('../alchemy/balance.service');
    const balanceResult = await getBalanceFromDb(user.proxyWalletAddress);
    return parseFloat(balanceResult?.balanceHuman || '0');
  } catch (error) {
    logger.error({
      message: 'Error fetching user balance for P&L calculation',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Calculate estimated initial deposit when explicit deposits aren't tracked
 * 
 * Formula: Initial Deposit = Trading OUT + External Withdrawals + Current Value - Trading IN
 * 
 * This works because:
 * - Money that went out (trading + withdrawals) minus money that came in (trading) 
 *   plus what remains = what was deposited initially
 */
async function calculateEstimatedDeposit(
  privyUserId: string, 
  tradingIn: number, 
  tradingOut: number, 
  externalWithdrawals: number,
  currentValue: number
): Promise<number> {
  // If we have explicit external deposits tracked, use those
  const trackedDeposits = await calculateTrueDeposits(privyUserId);
  
  if (trackedDeposits > 0) {
    return trackedDeposits;
  }
  
  // Otherwise, calculate estimated deposit from money flow
  // Initial + Trading IN = Trading OUT + Withdrawals + Current Value
  // Initial = Trading OUT + Withdrawals + Current Value - Trading IN
  const estimatedDeposit = tradingOut + externalWithdrawals + currentValue - tradingIn;
  
  // Estimated deposit should never be negative
  return Math.max(0, estimatedDeposit);
}

/**
 * Calculate trading P&L from wallet transfers
 * This is the actual money flow to/from Polymarket
 * Trading P&L = Money received from trading - Money spent on trading
 */
async function calculateTradingPnL(privyUserId: string): Promise<{ tradingIn: number; tradingOut: number; tradingPnl: number }> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return { tradingIn: 0, tradingOut: 0, tradingPnl: 0 };
  }

  const client = await pool.connect();

  try {
    // Money received from Polymarket (sells, redemptions)
    const inResult = await client.query(
      `SELECT COALESCE(SUM(amount_human), 0) as total
       FROM wallet_usdc_transfers
       WHERE privy_user_id = $1 
         AND transfer_type = 'in'
         AND LOWER(from_address) IN (${POLYMARKET_CONTRACTS.map((_, i) => `$${i + 2}`).join(', ')})`,
      [privyUserId, ...POLYMARKET_CONTRACTS]
    );
    
    // Money spent on Polymarket (buys) - exclude fees
    const outResult = await client.query(
      `SELECT COALESCE(SUM(amount_human), 0) as total
       FROM wallet_usdc_transfers
       WHERE privy_user_id = $1 
         AND transfer_type = 'out'
         AND LOWER(to_address) IN (${POLYMARKET_CONTRACTS.map((_, i) => `$${i + 2}`).join(', ')})`,
      [privyUserId, ...POLYMARKET_CONTRACTS]
    );
    
    const tradingIn = parseFloat(inResult.rows[0]?.total || '0');
    const tradingOut = parseFloat(outResult.rows[0]?.total || '0');
    const tradingPnl = tradingIn - tradingOut;
    
    return { tradingIn, tradingOut, tradingPnl };
  } catch (error) {
    logger.error({
      message: 'Error calculating trading P&L',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { tradingIn: 0, tradingOut: 0, tradingPnl: 0 };
  } finally {
    client.release();
  }
}

/**
 * Calculate comprehensive P&L snapshot for a user
 * 
 * Strategy based on wallet transfer data (source of truth for money movements):
 * 
 * Trading P&L = Money received from Polymarket - Money spent on Polymarket
 *   - Includes: sells, redemptions, buys (all actual wallet movements)
 * 
 * Total P&L = Trading P&L + Unrealized P&L on current positions
 *   - Trading P&L is "realized" (money actually moved)
 *   - Unrealized P&L is current positions' paper profit/loss
 * 
 * This approach is accurate because it uses actual wallet movements
 * rather than relying on potentially incomplete trade records.
 */
export async function calculatePnLSnapshot(privyUserId: string): Promise<PnLSnapshot> {
  try {
    // Get portfolio summary (current positions)
    const portfolioSummary = await getPortfolioSummary(privyUserId);
    
    // Get USDC balance
    const usdcBalance = await getUserBalance(privyUserId);
    
    // Calculate total current value (what user has now)
    const totalValue = portfolioSummary.portfolio + usdcBalance;

    // Get TRUE external withdrawal totals
    const externalWithdrawals = await calculateTrueWithdrawals(privyUserId);
    
    // Calculate trading P&L from actual wallet movements
    const { tradingIn, tradingOut, tradingPnl } = await calculateTradingPnL(privyUserId);

    // Calculate estimated deposits (includes bridge deposits that may not be explicitly tracked)
    const estimatedDeposits = await calculateEstimatedDeposit(
      privyUserId, 
      tradingIn, 
      tradingOut, 
      externalWithdrawals, 
      totalValue
    );

    // Unrealized P&L from active positions
    const unrealizedPnl = portfolioSummary.totalPnl;

    // Total P&L = Current Total Value + External Withdrawals - Estimated Deposits
    // This is the most accurate P&L: what you have now + what you took out - what you put in
    const totalPnl = (totalValue + externalWithdrawals) - estimatedDeposits;

    // Realized P&L = Total P&L - Unrealized P&L
    // This is the "locked in" profit/loss from closed positions
    const realizedPnl = totalPnl - unrealizedPnl;

    // Calculate percentage P&L based on estimated deposits
    const totalPercentPnl = estimatedDeposits > 0 ? (totalPnl / estimatedDeposits) * 100 : 0;

    // Get total positions count (all-time, including closed)
    // This is an approximation - we count all unique clob_token_ids from trade history
    const dbConfig = getDatabaseConfig();
    let totalPositionsCount = portfolioSummary.totalPositions;

    if (dbConfig.type === 'postgres') {
      const client = await pool.connect();
      try {
        const countResult = await client.query(
          `SELECT COUNT(DISTINCT clob_token_id) as total_count
           FROM trades_history
           WHERE privy_user_id = $1 AND status = 'FILLED'`,
          [privyUserId]
        );
        totalPositionsCount = parseInt(countResult.rows[0]?.total_count || '0', 10);
      } catch (error) {
        logger.warn({
          message: 'Error counting total positions, using active count',
          privyUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        client.release();
      }
    }

    return {
      totalPnl,
      realizedPnl,
      unrealizedPnl,
      portfolioValue: portfolioSummary.portfolio,
      usdcBalance,
      totalValue,
      activePositionsCount: portfolioSummary.totalPositions,
      totalPositionsCount,
      totalPercentPnl,
      snapshotAt: new Date(),
      // Additional tracking fields
      estimatedDeposits,
      externalWithdrawals,
      tradingIn,
      tradingOut,
    };
  } catch (error) {
    logger.error({
      message: 'Error calculating P&L snapshot',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Store P&L snapshot to database
 */
export async function storePnLSnapshot(privyUserId: string, snapshot: PnLSnapshot): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In development mode, skip storage
    return;
  }

  const client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO user_pnl_history (
        privy_user_id,
        total_pnl,
        realized_pnl,
        unrealized_pnl,
        portfolio_value,
        usdc_balance,
        total_value,
        active_positions_count,
        total_positions_count,
        total_percent_pnl,
        snapshot_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        privyUserId,
        snapshot.totalPnl,
        snapshot.realizedPnl,
        snapshot.unrealizedPnl,
        snapshot.portfolioValue,
        snapshot.usdcBalance,
        snapshot.totalValue,
        snapshot.activePositionsCount,
        snapshot.totalPositionsCount,
        snapshot.totalPercentPnl,
        snapshot.snapshotAt,
      ]
    );
  } catch (error) {
    logger.error({
      message: 'Error storing P&L snapshot',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get historical P&L data for charting
 * Returns data points for the specified time range
 */
export async function getHistoricalPnL(
  privyUserId: string,
  options: {
    days?: number; // Number of days to look back (default: 30)
    limit?: number; // Maximum number of points (default: 100)
  } = {}
): Promise<HistoricalPnLPoint[]> {
  const { days = 30, limit = 100 } = options;
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In development mode, return empty array
    return [];
  }

  const client = await pool.connect();

  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const result = await client.query(
      `SELECT 
        snapshot_at,
        total_pnl,
        realized_pnl,
        unrealized_pnl,
        portfolio_value,
        usdc_balance,
        total_value
      FROM user_pnl_history
      WHERE privy_user_id = $1 
        AND snapshot_at >= $2
      ORDER BY snapshot_at ASC
      LIMIT $3`,
      [privyUserId, startDate, limit]
    );

    return result.rows.map((row) => ({
      date: new Date(row.snapshot_at).toISOString(),
      totalPnl: parseFloat(row.total_pnl || '0'),
      realizedPnl: parseFloat(row.realized_pnl || '0'),
      unrealizedPnl: parseFloat(row.unrealized_pnl || '0'),
      portfolioValue: parseFloat(row.portfolio_value || '0'),
      usdcBalance: parseFloat(row.usdc_balance || '0'),
      totalValue: parseFloat(row.total_value || '0'),
    }));
  } catch (error) {
    logger.error({
      message: 'Error fetching historical P&L',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    client.release();
  }
}

/**
 * Calculate and store current P&L snapshot
 * This should be called periodically (e.g., after trades, daily, etc.)
 */
export async function updatePnLSnapshot(privyUserId: string): Promise<PnLSnapshot> {
  const snapshot = await calculatePnLSnapshot(privyUserId);
  await storePnLSnapshot(privyUserId, snapshot);
  
  logger.info({
    message: 'P&L snapshot updated',
    privyUserId,
    totalPnl: snapshot.totalPnl,
    realizedPnl: snapshot.realizedPnl,
    unrealizedPnl: snapshot.unrealizedPnl,
  });

  return snapshot;
}

