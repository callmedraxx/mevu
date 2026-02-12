/**
 * Kalshi Trading Service
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getUserByPrivyId } from '../privy/user.service';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';
import { dflowClient } from '../dflow/dflow.client';
import { validateKalshiBuyRequest, validateKalshiSellRequest } from './kalshi-trade-validation';
import { validateDFlowBuyOrder, validateDFlowSellOrder, SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';

const KALSHI_TRADING_ENABLED = process.env.KALSHI_TRADING_ENABLED === 'true';

export interface KalshiBuyRequest {
  privyUserId: string;
  kalshiTicker: string;
  outcome: 'YES' | 'NO';
  usdcAmount: string;
  slippageBps?: number;
}

export interface KalshiSellRequest {
  privyUserId: string;
  kalshiTicker: string;
  outcome: 'YES' | 'NO';
  tokenAmount: string;
  slippageBps?: number;
}

export interface KalshiTradeResult {
  success: boolean;
  tradeId?: string;
  solanaSignature?: string;
  error?: string;
}

export async function executeKalshiBuy(req: KalshiBuyRequest): Promise<KalshiTradeResult> {
  if (!KALSHI_TRADING_ENABLED) return { success: false, error: 'Kalshi trading is disabled' };
  const validation = validateKalshiBuyRequest(req);
  if (!validation.valid) return { success: false, error: validation.error };
  const user = await getUserByPrivyId(req.privyUserId);
  if (!user) return { success: false, error: 'User not found' };
  const solanaWallet = (user as any).solanaWalletAddress;
  if (!solanaWallet) return { success: false, error: 'User has no Solana wallet' };
  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) return { success: false, error: 'Market not available for trading' };
  const dflowParams = { inputMint: SOLANA_USDC_MINT, outputMint: outcomeMint, amount: req.usdcAmount, userPublicKey: solanaWallet, slippageBps: req.slippageBps };
  if (!validateDFlowBuyOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };
  try {
    const orderResponse = await dflowClient.getBuyOrder(dflowParams);
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(`INSERT INTO kalshi_trades_history (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, dflow_order_id, status) VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, 'PENDING') RETURNING id`, [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, req.usdcAmount, orderResponse.outAmount ?? '0', orderResponse.orderId ?? null]);
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: orderResponse.transaction ? 'serialized' : undefined };
      } finally { client.release(); }
    }
    return { success: true, solanaSignature: orderResponse.transaction ? 'serialized' : undefined };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function executeKalshiSell(req: KalshiSellRequest): Promise<KalshiTradeResult> {
  if (!KALSHI_TRADING_ENABLED) return { success: false, error: 'Kalshi trading is disabled' };
  const validation = validateKalshiSellRequest(req);
  if (!validation.valid) return { success: false, error: validation.error };
  const user = await getUserByPrivyId(req.privyUserId);
  if (!user) return { success: false, error: 'User not found' };
  const solanaWallet = (user as any).solanaWalletAddress;
  if (!solanaWallet) return { success: false, error: 'User has no Solana wallet' };
  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) return { success: false, error: 'Market not available for trading' };
  const dflowParams = { inputMint: outcomeMint, outputMint: SOLANA_USDC_MINT, amount: req.tokenAmount, userPublicKey: solanaWallet, slippageBps: req.slippageBps };
  if (!validateDFlowSellOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };
  try {
    const orderResponse = await dflowClient.getSellOrder(dflowParams);
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(`INSERT INTO kalshi_trades_history (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, dflow_order_id, status) VALUES ($1, $2, $3, $4, $5, 'SELL', $6, $7, $8, 'PENDING') RETURNING id`, [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, req.tokenAmount, orderResponse.inAmount ?? '0', orderResponse.orderId ?? null]);
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: orderResponse.transaction ? 'serialized' : undefined };
      } finally { client.release(); }
    }
    return { success: true, solanaSignature: orderResponse.transaction ? 'serialized' : undefined };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
