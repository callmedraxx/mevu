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
import { setKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { getSolanaUsdcBalance } from '../solana/solana-usdc-balance';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';
import { checkVerification } from '../proof/proof.service';
import { logger } from '../../config/logger';

const KALSHI_TRADING_ENABLED = process.env.KALSHI_TRADING_ENABLED === 'true';

/** Map raw on-chain/API errors to user-friendly messages. Full error is always logged. */
function toUserFriendlyTradeError(rawError: unknown): string {
  const raw = rawError instanceof Error ? rawError.message : String(rawError);
  if (raw.includes('user_quote_vault check failed') || raw.includes('Invalid account owner')) {
    return 'Your Solana wallet may not have USDC yet. Please fund your wallet with USDC before trading.';
  }
  if (raw.includes('Insufficient') || raw.includes('insufficient')) {
    return raw.length < 120 ? raw : 'Insufficient balance. Please add more USDC to your wallet.';
  }
  if (raw.includes('PROOF_REQUIRED') || raw.includes('Proof')) {
    return 'Identity verification required. Please complete KYC verification first.';
  }
  if (raw.includes('Slippage') || raw.includes('slippage')) {
    return 'Price moved too much. Please try again.';
  }
  if (raw.includes('blockhash') || raw.includes('expired')) {
    return 'Transaction expired. Please try again.';
  }
  // Long/technical errors (program logs, JSON blobs) → generic message
  if (raw.length > 200 || raw.includes('Program log:') || raw.includes('"error":') || raw.includes('{"error"')) {
    return 'Transaction failed. Please ensure your wallet has USDC and try again.';
  }
  return raw;
}

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
  errorCode?: string;
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
  logger.info({
    message: 'Kalshi buy request',
    kalshiTicker: req.kalshiTicker,
    outcome: req.outcome,
    usdcAmount: req.usdcAmount,
  });
  const skipBalanceCheck = process.env.KALSHI_SKIP_BALANCE_CHECK === 'true';
  if (!skipBalanceCheck) {
    // Use on-chain balance as source of truth for pre-trade check
    const onChainBalance = await getSolanaUsdcBalance(solanaWallet);
    const balance = parseFloat(onChainBalance) || 0;
    if (balance < parseFloat(usdcAmountHuman)) {
      return { success: false, error: `Insufficient balance. You have $${balance.toFixed(2)} USDC. Need $${parseFloat(usdcAmountHuman).toFixed(2)}.` };
    }
  }

  // Proof KYC verification gate — required for all Kalshi buys
  const isVerified = await checkVerification(solanaWallet);
  if (!isVerified) {
    return { success: false, error: 'PROOF_REQUIRED', errorCode: 'PROOF_REQUIRED' };
  }

  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) {
    logger.warn({
      message: 'Kalshi buy: no DFlow mapping for ticker',
      kalshiTicker: req.kalshiTicker,
      outcome: req.outcome,
    });
    return { success: false, error: `Market not available for trading. Ticker "${req.kalshiTicker}" not in dflow_market_mappings.` };
  }

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

    // Sync on-chain balance after trade (delayed to allow Solana confirmation)
    syncBalanceAfterTrade(req.privyUserId, solanaWallet, 'kalshi_buy');

    // Save trade with FILLED status and actual tx hash.
    // Use DFlow's inAmount (execution USDC) so avg entry = execution price, not total cost with fees.
    const usdcExecuted = orderResponse.inAmount ?? req.usdcAmount;
    const tokensReceived = orderResponse.outAmount ?? '0';
    const platformFeeRaw = orderResponse.platformFee?.amount ?? null;
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, platform_fee, dflow_order_id, status, solana_signature)
           VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, $9, 'FILLED', $10)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, usdcExecuted, tokensReceived, platformFeeRaw, null, hash]
        );
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: hash };
      } finally {
        client.release();
      }
    }

    return { success: true, solanaSignature: hash };
  } catch (e) {
    const rawError = e instanceof Error ? e.message : String(e);
    logger.error({
      message: 'Kalshi BUY trade failed',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      error: rawError,
      stack: e instanceof Error ? e.stack : undefined,
    });
    return { success: false, error: toUserFriendlyTradeError(e) };
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
  if (!outcomeMint) {
    logger.warn({
      message: 'Kalshi sell: no DFlow mapping for ticker',
      kalshiTicker: req.kalshiTicker,
      outcome: req.outcome,
    });
    return { success: false, error: `Market not available for trading. Ticker "${req.kalshiTicker}" not in dflow_market_mappings.` };
  }

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

    // Sync on-chain balance after trade (delayed to allow Solana confirmation)
    syncBalanceAfterTrade(req.privyUserId, solanaWallet, 'kalshi_sell');

    // Save trade with FILLED status and actual tx hash
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, dflow_order_id, status, solana_signature)
           VALUES ($1, $2, $3, $4, $5, 'SELL', $6, $7, $8, 'FILLED', $9)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, req.tokenAmount, orderResponse.inAmount ?? '0', null, hash]
        );
        return { success: true, tradeId: r.rows[0]?.id, solanaSignature: hash };
      } finally {
        client.release();
      }
    }

    return { success: true, solanaSignature: hash };
  } catch (e) {
    const rawError = e instanceof Error ? e.message : String(e);
    logger.error({
      message: 'Kalshi SELL trade failed',
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      error: rawError,
      stack: e instanceof Error ? e.stack : undefined,
    });
    return { success: false, error: toUserFriendlyTradeError(e) };
  }
}

/**
 * Post-trade on-chain balance sync (fallback for unreliable Alchemy Solana webhooks).
 *
 * Primary path: Alchemy webhook fires → updates DB balance in real time.
 * Fallback: if the webhook doesn't fire, we check on-chain at 5s, 15s, 30s
 * and sync only if the DB balance hasn't already been updated by the webhook.
 *
 * We record a snapshot of the DB balance before the trade. If any retry sees
 * the DB balance has changed from that snapshot, the webhook already handled it.
 */
function syncBalanceAfterTrade(privyUserId: string, solanaWallet: string, source: string): void {
  // Snapshot the current DB balance to detect webhook updates
  import('../privy/user.service').then(({ getUserByPrivyId }) => {
    getUserByPrivyId(privyUserId).then((user) => {
      const preTradeBalance = parseFloat((user as any)?.kalshiUsdcBalance ?? '0') || 0;
      const delays = [5000, 15000, 30000];

      for (const delay of delays) {
        setTimeout(async () => {
          try {
            // Check if webhook already updated the balance
            const { getUserByPrivyId: getUser } = await import('../privy/user.service');
            const currentUser = await getUser(privyUserId);
            const dbBalance = parseFloat((currentUser as any)?.kalshiUsdcBalance ?? '0') || 0;

            // If DB balance changed from pre-trade snapshot, webhook handled it
            if (Math.abs(dbBalance - preTradeBalance) > 0.001) {
              logger.debug({
                message: 'Webhook already updated balance, skipping on-chain sync',
                privyUserId,
                preTradeBalance,
                dbBalance,
                delayMs: delay,
              });
              return;
            }

            // Webhook hasn't fired — sync from on-chain
            const onChainBalance = await getSolanaUsdcBalance(solanaWallet);
            const onChainNum = parseFloat(onChainBalance) || 0;

            if (Math.abs(onChainNum - dbBalance) > 0.001) {
              await setKalshiUsdcBalance(privyUserId, onChainBalance);
              publishKalshiPositionUpdate(privyUserId, {
                type: 'balance_update',
                amount: onChainBalance,
                source: `${source}_onchain_fallback`,
              });
              logger.info({
                message: 'Post-trade on-chain balance synced (webhook fallback)',
                privyUserId,
                solanaWallet: solanaWallet.slice(0, 8) + '...',
                balance: onChainBalance,
                previousDbBalance: dbBalance,
                source,
                delayMs: delay,
              });
            }
          } catch (err) {
            logger.warn({
              message: 'Post-trade balance sync attempt failed',
              privyUserId,
              delayMs: delay,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }, delay);
      }
    }).catch(() => {});
  }).catch(() => {});
}
