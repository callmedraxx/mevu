/**
 * Kalshi Trading Service
 * Executes trades server-side: DFlow order → Privy sign & submit → Solana
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getUserByPrivyId } from '../privy/user.service';
import { privyService } from '../privy/privy.service';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';
import { dflowClient } from '../dflow/dflow.client';
import { validateKalshiBuyRequest, validateKalshiSellRequest } from './kalshi-trade-validation';
import { validateDFlowBuyOrder, validateDFlowSellOrder, SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';
import { subtractFromKalshiUsdcBalance, addToKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';
import { logger } from '../../config/logger';

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

  const solanaWalletId = (user as any).solanaWalletId;
  if (!solanaWalletId) return { success: false, error: 'User has no Solana wallet ID — please recreate wallet' };

  const usdcAmountHuman = (Number(req.usdcAmount) / 1e6).toFixed(6);
  const balance = parseFloat((user as any).kalshiUsdcBalance ?? '0') || 0;
  if (balance < parseFloat(usdcAmountHuman)) {
    return { success: false, error: `Insufficient balance. You have $${balance.toFixed(2)} USDC. Need $${parseFloat(usdcAmountHuman).toFixed(2)}.` };
  }

  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) return { success: false, error: 'Market not available for trading' };

  const dflowParams = {
    inputMint: SOLANA_USDC_MINT,
    outputMint: outcomeMint,
    amount: req.usdcAmount,
    userPublicKey: solanaWallet,
    slippageBps: req.slippageBps,
  };
  if (!validateDFlowBuyOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };

  try {
    // Get serialized transaction from DFlow
    const orderResponse = await dflowClient.getBuyOrder(dflowParams);

    if (!orderResponse.transaction) {
      return { success: false, error: 'DFlow did not return a transaction' };
    }

    // Sign and submit via Privy server SDK (with gas sponsorship)
    const { hash } = await privyService.signAndSendSolanaTransaction(
      solanaWalletId,
      orderResponse.transaction
    );

    logger.info({
      message: 'Kalshi BUY trade executed successfully',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      outcome: req.outcome,
      usdcAmount: req.usdcAmount,
      txHash: hash,
    });

    await subtractFromKalshiUsdcBalance(req.privyUserId, usdcAmountHuman);
    publishKalshiPositionUpdate(req.privyUserId, { type: 'balance_update', amount: `-${usdcAmountHuman}`, source: 'kalshi_buy' });

    // Save trade with FILLED status and actual tx hash
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, dflow_order_id, status, solana_signature)
           VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, 'FILLED', $9)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, req.usdcAmount, orderResponse.outAmount ?? '0', orderResponse.orderId ?? null, hash]
        );
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: hash };
      } finally {
        client.release();
      }
    }

    return { success: true, solanaSignature: hash };
  } catch (e) {
    logger.error({
      message: 'Kalshi BUY trade failed',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      error: e instanceof Error ? e.message : String(e),
    });
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

  const solanaWalletId = (user as any).solanaWalletId;
  if (!solanaWalletId) return { success: false, error: 'User has no Solana wallet ID — please recreate wallet' };

  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) return { success: false, error: 'Market not available for trading' };

  const dflowParams = {
    inputMint: outcomeMint,
    outputMint: SOLANA_USDC_MINT,
    amount: req.tokenAmount,
    userPublicKey: solanaWallet,
    slippageBps: req.slippageBps,
  };
  if (!validateDFlowSellOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };

  try {
    // Get serialized transaction from DFlow
    const orderResponse = await dflowClient.getSellOrder(dflowParams);

    if (!orderResponse.transaction) {
      return { success: false, error: 'DFlow did not return a transaction' };
    }

    // Sign and submit via Privy server SDK (with gas sponsorship)
    const { hash } = await privyService.signAndSendSolanaTransaction(
      solanaWalletId,
      orderResponse.transaction
    );

    logger.info({
      message: 'Kalshi SELL trade executed successfully',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      outcome: req.outcome,
      tokenAmount: req.tokenAmount,
      txHash: hash,
    });

    const usdcReceivedHuman = (Number(orderResponse.outAmount ?? '0') / 1e6).toFixed(6);
    await addToKalshiUsdcBalance(req.privyUserId, usdcReceivedHuman);
    publishKalshiPositionUpdate(req.privyUserId, { type: 'balance_update', amount: usdcReceivedHuman, source: 'kalshi_sell' });

    // Save trade with FILLED status and actual tx hash
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, dflow_order_id, status, solana_signature)
           VALUES ($1, $2, $3, $4, $5, 'SELL', $6, $7, $8, 'FILLED', $9)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, req.tokenAmount, orderResponse.inAmount ?? '0', orderResponse.orderId ?? null, hash]
        );
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: hash };
      } finally {
        client.release();
      }
    }

    return { success: true, solanaSignature: hash };
  } catch (e) {
    logger.error({
      message: 'Kalshi SELL trade failed',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      error: e instanceof Error ? e.message : String(e),
    });
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
