/**
 * Kalshi Trading Service
 * Executes trades server-side: DFlow order → Privy sign & submit → Solana
 */

import { pool, getDatabaseConfig } from '../../config/database';
import { getUserByPrivyId } from '../privy/user.service';
import { privyService } from '../privy/privy.service';
import { dflowMetadataService } from '../dflow/dflow-metadata.service';
import { dflowClient } from '../dflow/dflow.client';
import { getAllOutcomeTokenBalances, getMintTokenProgram } from '../solana/solana-token-accounts';
import { validateKalshiBuyRequest, validateKalshiSellRequest } from './kalshi-trade-validation';
import { validateDFlowBuyOrder, validateDFlowSellOrder, SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';
import { setKalshiUsdcBalance, updateUserSolanaWallet } from '../privy/kalshi-user.service';
import { getSolanaUsdcBalance } from '../solana/solana-usdc-balance';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';
import { checkVerification } from '../proof/proof.service';
import { applyKalshiTradeToPositions } from './kalshi-positions.service';
import { logger } from '../../config/logger';

const KALSHI_TRADING_ENABLED = process.env.KALSHI_TRADING_ENABLED === 'true';

/** 1% platform fee (same as Polymarket). Fee is collected in the trade tx via DFlow when KALSHI_FEE_ACCOUNT_SOLANA is set. */
const KALSHI_FEE_BPS = 100;
const KALSHI_FEE_ACCOUNT = process.env.KALSHI_FEE_ACCOUNT_SOLANA?.trim() || null;

/**
 * Resolve Solana wallet and walletId for Kalshi trading.
 * Uses solana_wallet_address only — NOT proxy_wallet or embedded_wallet (those are EVM).
 * Falls back to kalshi_trades_history if users.solana_wallet_address is null.
 */
async function resolveSolanaWalletForUser(privyUserId: string): Promise<{
  solanaWallet: string;
  solanaWalletId: string | null;
} | null> {
  const user = await getUserByPrivyId(privyUserId);
  if (!user) return null;

  let solanaWallet = (user as any).solanaWalletAddress;
  let solanaWalletId = (user as any).solanaWalletId;

  // Fallback: get from kalshi_trades_history if users table has null (e.g. wallet created but not persisted)
  if (!solanaWallet && getDatabaseConfig().type === 'postgres') {
    const client = await pool.connect();
    try {
      const r = await client.query<{ solana_wallet_address: string }>(
        `SELECT solana_wallet_address FROM kalshi_trades_history
         WHERE privy_user_id = $1 AND solana_wallet_address IS NOT NULL AND solana_wallet_address != ''
         ORDER BY created_at DESC LIMIT 1`,
        [privyUserId]
      );
      const addr = r.rows[0]?.solana_wallet_address;
      if (addr) {
        await updateUserSolanaWallet(privyUserId, addr);
        solanaWallet = addr;
        logger.info({
          message: 'Kalshi: backfilled solana_wallet_address from trade history',
          privyUserId,
          solanaWalletAddress: addr.slice(0, 8) + '...',
        });
      }
    } finally {
      client.release();
    }
  }

  if (!solanaWallet) return null;

  // Always resolve walletId from address — DB may have stale/wrong solana_wallet_id for a different wallet
  const lookedUpWalletId = await privyService.getWalletIdByAddress(privyUserId, solanaWallet);
  if (lookedUpWalletId) {
    solanaWalletId = lookedUpWalletId;
    if (lookedUpWalletId !== (user as any).solanaWalletId) {
      await updateUserSolanaWallet(privyUserId, solanaWallet, lookedUpWalletId);
      logger.info({
        message: 'Kalshi: corrected solana_wallet_id to match solana_wallet_address',
        privyUserId,
        solanaWallet: solanaWallet.slice(0, 12) + '...',
      });
    }
  } else if (solanaWalletId) {
    logger.warn({
      message: 'Kalshi: could not verify walletId for solana address — Privy lookup returned null',
      privyUserId,
      solanaWallet: solanaWallet.slice(0, 12) + '...',
      dbWalletId: solanaWalletId,
    });
  }

  return { solanaWallet, solanaWalletId };
}

/** Map raw on-chain/API errors to user-friendly messages. Full error is always logged. */
function toUserFriendlyTradeError(rawError: unknown): string {
  const raw = rawError instanceof Error ? rawError.message : String(rawError);
  // DFlow API errors (e.g. 400 from getBuyOrder/getSellOrder)
  if (raw.startsWith('DFlow API ')) {
    if (raw.includes('route_not_found')) {
      return 'This market may have resolved. If your position is a winning outcome, use Claim instead of Sell.';
    }
    const afterPrefix = raw.replace(/^DFlow API \d+: /, '');
    if (afterPrefix && afterPrefix.length < 150) return afterPrefix;
    return 'DFlow could not fill this order. The market may be closed or have low liquidity.';
  }
  if (raw.includes('user_quote_vault check failed') || raw.includes('Invalid account owner')) {
    return 'Your Solana wallet may not have USDC yet. Please fund your wallet with USDC before trading.';
  }
  if (raw.includes('Insufficient') || raw.includes('insufficient')) {
    if (raw.includes('insufficient funds')) {
      return 'Insufficient outcome tokens for this sell. The position may have changed — refresh the page and try again.';
    }
    return raw.length < 120 ? raw : 'Insufficient balance. Please add more USDC to your wallet.';
  }
  if (raw.includes('PROOF_REQUIRED') || raw.includes('Proof')) {
    return 'Identity verification required. Please complete KYC verification first.';
  }
  if (raw.includes('Slippage') || raw.includes('slippage')) {
    return 'Price moved too much. Please try again.';
  }
  if (raw.includes('Blockhash not found') || raw.includes('blockhash') || raw.includes('expired')) {
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
  /** When true on failure: position is still on-chain; frontend should refetch to avoid stale optimistic state */
  refetchPositions?: boolean;
}

export async function executeKalshiBuy(req: KalshiBuyRequest, traceId?: string): Promise<KalshiTradeResult> {
  const tid = traceId ?? `kalshi_buy_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const logCtx = (step: string, extra: Record<string, unknown>) =>
    logger.info({ message: '[KALSHI_TRACE]', traceId: tid, step, direction: 'buy', ...extra });

  if (!KALSHI_TRADING_ENABLED) return { success: false, error: 'Kalshi trading is disabled' };
  const validation = validateKalshiBuyRequest(req);
  if (!validation.valid) return { success: false, error: validation.error };

  const resolved = await resolveSolanaWalletForUser(req.privyUserId);
  if (!resolved) return { success: false, error: 'User not found' };
  const { solanaWallet, solanaWalletId } = resolved;
  if (!solanaWallet) return { success: false, error: 'User has no Solana wallet' };
  if (!solanaWalletId) return { success: false, error: 'User has no Solana wallet ID — please recreate wallet via Kalshi onboarding' };

  const usdcAmountHuman = (Number(req.usdcAmount) / 1e6).toFixed(6);
  logCtx('2_request_parsed', {
    kalshiTicker: req.kalshiTicker,
    outcome: req.outcome,
    usdcAmountRaw: req.usdcAmount,
    usdcAmountUsd: usdcAmountHuman,
    slippageBps: req.slippageBps,
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
    predictionMarketSlippageBps: 1000,
    ...(KALSHI_FEE_ACCOUNT && {
      platformFeeBps: KALSHI_FEE_BPS,
      feeAccount: KALSHI_FEE_ACCOUNT,
    }),
  };
  if (!validateDFlowBuyOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };

  logCtx('3_dflow_request', {
    dflowParams: {
      inputMint: dflowParams.inputMint.slice(0, 12) + '...',
      outputMint: dflowParams.outputMint.slice(0, 12) + '...',
      amount: dflowParams.amount,
      amountUsd: (Number(dflowParams.amount) / 1e6).toFixed(6),
      userPublicKey: solanaWallet.slice(0, 12) + '...',
      slippageBps: dflowParams.slippageBps,
      predictionMarketSlippageBps: dflowParams.predictionMarketSlippageBps,
      ...(dflowParams.platformFeeBps && { platformFeeBps: dflowParams.platformFeeBps, feeAccount: (dflowParams.feeAccount ?? '').slice(0, 12) + '...' }),
    },
  });

  const MAX_BLOCKHASH_RETRIES = 2; // Retry up to 2x on blockhash expiry (3 attempts total)

  const isBlockhashError = (err: unknown) => {
    const s = err instanceof Error ? err.message : String(err);
    return s.includes('Blockhash not found') || s.includes('blockhash') || s.includes('expired');
  };

  try {
    let orderResponse: Awaited<ReturnType<typeof dflowClient.getBuyOrder>> | null = null;
    let hash: string | null = null;

    for (let attempt = 0; attempt <= MAX_BLOCKHASH_RETRIES; attempt++) {
      const freshOrder = await dflowClient.getBuyOrder(dflowParams);
      if (!freshOrder.transaction) {
        return { success: false, error: 'DFlow did not return a transaction' };
      }
      try {
        const result = await privyService.signAndSendSolanaTransaction(
          solanaWalletId,
          freshOrder.transaction
        );
        orderResponse = freshOrder;
        hash = result.hash;
        break;
      } catch (signErr) {
        if (attempt < MAX_BLOCKHASH_RETRIES && isBlockhashError(signErr)) {
          logger.info({
            message: 'Kalshi buy: blockhash expired, retrying with fresh order',
            attempt: attempt + 1,
            kalshiTicker: req.kalshiTicker,
          });
          continue;
        }
        throw signErr;
      }
    }

    if (!hash || !orderResponse) {
      return { success: false, error: 'Transaction failed. Please try again.' };
    }

    // Step 4: Full DFlow response (exclude base64 transaction)
    const dflowResponse = {
      inAmount: orderResponse.inAmount,
      inAmountUsd: (Number(orderResponse.inAmount ?? 0) / 1e6).toFixed(6),
      outAmount: orderResponse.outAmount,
      outAmountShares: (Number(orderResponse.outAmount ?? 0) / 1e6).toFixed(6),
      otherAmountThreshold: orderResponse.otherAmountThreshold,
      minOutAmount: orderResponse.minOutAmount,
      slippageBps: orderResponse.slippageBps,
      priceImpactPct: orderResponse.priceImpactPct,
      executionMode: orderResponse.executionMode,
      platformFee: orderResponse.platformFee
        ? {
            amount: orderResponse.platformFee.amount,
            amountUsd: (Number(orderResponse.platformFee.amount) / 1e6).toFixed(6),
            feeBps: orderResponse.platformFee.feeBps,
            feeAccount: orderResponse.platformFee.feeAccount?.slice(0, 12) + '...',
            segmenterFeeAmount: orderResponse.platformFee.segmenterFeeAmount,
            segmenterFeePct: orderResponse.platformFee.segmenterFeePct,
          }
        : null,
      inputMint: orderResponse.inputMint?.slice(0, 12) + '...',
      outputMint: orderResponse.outputMint?.slice(0, 12) + '...',
      hasTransaction: !!orderResponse.transaction,
    };
    logCtx('4_dflow_response', { dflowResponse, txHash: hash });

    // Step 5: Fund flow accounting
    const requestedUsdc = Number(req.usdcAmount) / 1e6;
    const inUsdc = Number(orderResponse.inAmount ?? 0) / 1e6; // USDC that went to token swap
    const outShares = Number(orderResponse.outAmount ?? 0) / 1e6;
    const platformFeeUsdc = orderResponse.platformFee ? Number(orderResponse.platformFee.amount) / 1e6 : 0;
    const unaccountedUsdc = requestedUsdc - inUsdc - platformFeeUsdc; // requested - inAmount; often DFlow PM fee when platformFee is null (async)
    logCtx('5_fund_flow', {
      requestedUsdc: requestedUsdc.toFixed(6),
      sentToDflow: requestedUsdc.toFixed(6),
      usdcToTokenSwap: inUsdc.toFixed(6),
      platformFeeUsdc: platformFeeUsdc.toFixed(6),
      unaccountedUsdc: unaccountedUsdc.toFixed(6),
      unaccountedNote:
        unaccountedUsdc > 0.001 && !orderResponse.platformFee
          ? 'Likely DFlow prediction-market fee (not in platformFee for async). Verify on Solscan: tx debits full requested amount.'
          : null,
      tokensReceived: outShares.toFixed(6),
      effectivePriceCents: outShares > 0 ? ((inUsdc / outShares) * 100).toFixed(2) : null,
      executionMode: orderResponse.executionMode,
    });

    // Sync on-chain balance after trade (delayed to allow Solana confirmation)
    syncBalanceAfterTrade(req.privyUserId, solanaWallet, 'kalshi_buy');

    // Save trade with FILLED status and actual tx hash.
    // Use DFlow's inAmount (execution USDC) so avg entry = execution price, not total cost with fees.
    const usdcExecuted = orderResponse.inAmount ?? req.usdcAmount;
    const tokensReceived = orderResponse.outAmount ?? '0';
    const platformFeeRaw = orderResponse.platformFee?.amount ?? null;
    const marketInfo = await dflowMetadataService.getMarketByMint(outcomeMint);
    const marketTitle = marketInfo?.title ?? null;

    const effectivePrice = tokensReceived && Number(tokensReceived) > 0
      ? Number(usdcExecuted) / Number(tokensReceived)
      : null;
    const dbInsertValues = {
      privy_user_id: req.privyUserId,
      solana_wallet_address: solanaWallet,
      kalshi_ticker: req.kalshiTicker,
      outcome_mint: outcomeMint,
      outcome: req.outcome,
      side: 'BUY',
      input_amount: usdcExecuted,
      input_amount_usd: (Number(usdcExecuted) / 1e6).toFixed(6),
      output_amount: tokensReceived,
      output_amount_shares: (Number(tokensReceived) / 1e6).toFixed(6),
      price_per_token: effectivePrice,
      platform_fee: platformFeeRaw,
      platform_fee_usd: platformFeeRaw ? (Number(platformFeeRaw) / 1e6).toFixed(6) : null,
      status: 'FILLED',
      solana_signature: hash,
      market_title: marketTitle,
    };
    logCtx('6_kalshi_trades_history_insert', { dbInsertValues });

    let tradeId: string | undefined;
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, price_per_token, platform_fee, dflow_order_id, status, solana_signature, market_title)
           VALUES ($1, $2, $3, $4, $5, 'BUY', $6, $7, $8, $9, $10, 'FILLED', $11, $12)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, usdcExecuted, tokensReceived, effectivePrice, platformFeeRaw, null, hash, marketTitle]
        );
        tradeId = r.rows[0]?.id;
        logCtx('7_trade_stored', { tradeId });
      } finally {
        client.release();
      }
    }

    // Instant position update in kalshi_positions DB (after releasing trade client)
    await applyKalshiTradeToPositions('BUY', {
      privyUserId: req.privyUserId,
      solanaWalletAddress: solanaWallet,
      kalshiTicker: req.kalshiTicker,
      outcomeMint,
      outcome: req.outcome,
      marketTitle,
      tokenAmount: tokensReceived,
      effectivePrice,
      usdcAmount: usdcExecuted,
    });
    publishKalshiPositionUpdate(req.privyUserId, { type: 'position_update', source: 'trade_fill' });

    return { success: true, tradeId, solanaSignature: hash };
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

export async function executeKalshiSell(req: KalshiSellRequest, traceId?: string): Promise<KalshiTradeResult> {
  const tid = traceId ?? `kalshi_sell_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const logCtx = (step: string, extra: Record<string, unknown>) =>
    logger.info({ message: '[KALSHI_TRACE]', traceId: tid, step, direction: 'sell', ...extra });

  if (!KALSHI_TRADING_ENABLED) return { success: false, error: 'Kalshi trading is disabled' };
  const validation = validateKalshiSellRequest(req);
  if (!validation.valid) return { success: false, error: validation.error };

  const resolved = await resolveSolanaWalletForUser(req.privyUserId);
  if (!resolved) return { success: false, error: 'User not found' };
  const { solanaWallet, solanaWalletId } = resolved;
  if (!solanaWallet) return { success: false, error: 'User has no Solana wallet' };
  if (!solanaWalletId) return { success: false, error: 'User has no Solana wallet ID — please recreate wallet via Kalshi onboarding' };

  logCtx('2_request_parsed', {
    kalshiTicker: req.kalshiTicker,
    outcome: req.outcome,
    tokenAmountRaw: req.tokenAmount,
    tokenAmountShares: (Number(req.tokenAmount) / 1e6).toFixed(6),
    slippageBps: req.slippageBps,
  });

  const outcomeMint = await dflowMetadataService.getOutcomeMint(req.kalshiTicker, req.outcome);
  if (!outcomeMint) {
    logger.warn({
      message: 'Kalshi sell: no DFlow mapping for ticker',
      kalshiTicker: req.kalshiTicker,
      outcome: req.outcome,
    });
    return { success: false, error: `Market not available for trading. Ticker "${req.kalshiTicker}" not in dflow_market_mappings.` };
  }

  // Verify on-chain balance and cap amount — frontend tokenAmount can be stale
  // Query both standard SPL Token and Token-2022 (outcome mints vary by market)
  const tokens = await getAllOutcomeTokenBalances(solanaWallet);
  const token = tokens.find((t) => t.mint === outcomeMint);
  const actualBalance = token ? token.rawBalance : '0';
  const requestedAmount = BigInt(req.tokenAmount);
  const balanceBigInt = BigInt(actualBalance);
  if (balanceBigInt <= 0) {
    return { success: false, error: 'No balance found for this position. Refresh the page and try again.' };
  }
  let sellAmount = requestedAmount > balanceBigInt ? actualBalance : req.tokenAmount;
  if (requestedAmount > balanceBigInt) {
    logger.info({
      message: 'Kalshi sell: capping to on-chain balance',
      kalshiTicker: req.kalshiTicker,
      requested: req.tokenAmount,
      actual: actualBalance,
    });
  }

  // Diagnostic: which program holds the balance vs which program the mint uses (DFlow tx uses standard Token)
  const balanceFromProgram = token?.tokenProgram ?? 'unknown';
  const mintProgram = await getMintTokenProgram(outcomeMint);

  logCtx('3_preflight_balance', {
    solanaWallet: solanaWallet.slice(0, 12) + '...',
    sellAmountRaw: sellAmount,
    sellAmountShares: (Number(sellAmount) / 1e6).toFixed(6),
    actualBalanceRaw: actualBalance,
    actualBalanceShares: (Number(actualBalance) / 1e6).toFixed(6),
    outcomeMint: outcomeMint.slice(0, 12) + '...',
    balanceFromProgram,
    mintProgram,
    tokenProgramMismatch:
      mintProgram === 'Token-2022'
        ? 'Mint is Token-2022; DFlow tx uses standard Token — likely cause of insufficient funds'
        : undefined,
  });

  // Re-fetch balance immediately before DFlow to reduce race (user may have sold elsewhere)
  const tokensRefreshed = await getAllOutcomeTokenBalances(solanaWallet);
  const tokenRefreshed = tokensRefreshed.find((t) => t.mint === outcomeMint);
  const actualBalanceRefreshed = tokenRefreshed ? tokenRefreshed.rawBalance : '0';
  const balanceRefreshedBigInt = BigInt(actualBalanceRefreshed);
  const finalSellAmount = balanceRefreshedBigInt < BigInt(sellAmount) ? actualBalanceRefreshed : sellAmount;
  if (balanceRefreshedBigInt < BigInt(sellAmount)) {
    logger.info({
      message: 'Kalshi sell: balance changed since first fetch, using refreshed amount',
      kalshiTicker: req.kalshiTicker,
      previousSellAmount: sellAmount,
      refreshedBalance: actualBalanceRefreshed,
      finalSellAmount,
    });
  }

  const dflowParams = {
    inputMint: outcomeMint,
    outputMint: SOLANA_USDC_MINT,
    amount: finalSellAmount,
    userPublicKey: solanaWallet,
    slippageBps: req.slippageBps,
    predictionMarketSlippageBps: 1000,
    ...(KALSHI_FEE_ACCOUNT && {
      platformFeeBps: KALSHI_FEE_BPS,
      feeAccount: KALSHI_FEE_ACCOUNT,
    }),
  };
  if (!validateDFlowSellOrder(dflowParams).valid) return { success: false, error: 'Invalid DFlow params' };

  logCtx('4_dflow_request', {
    dflowParams: {
      inputMint: dflowParams.inputMint.slice(0, 12) + '...',
      outputMint: dflowParams.outputMint.slice(0, 12) + '...',
      amount: dflowParams.amount,
      amountShares: (Number(dflowParams.amount) / 1e6).toFixed(6),
      userPublicKey: solanaWallet.slice(0, 12) + '...',
      slippageBps: dflowParams.slippageBps,
      predictionMarketSlippageBps: dflowParams.predictionMarketSlippageBps,
      ...(dflowParams.platformFeeBps && { platformFeeBps: dflowParams.platformFeeBps, feeAccount: (dflowParams.feeAccount ?? '').slice(0, 12) + '...' }),
    },
  });

  const MAX_BLOCKHASH_RETRIES = 2;
  const isBlockhashError = (err: unknown) => {
    const s = err instanceof Error ? err.message : String(err);
    return s.includes('Blockhash not found') || s.includes('blockhash') || s.includes('expired');
  };

  try {
    let orderResponse: Awaited<ReturnType<typeof dflowClient.getSellOrder>> | null = null;
    let hash: string | null = null;

    for (let attempt = 0; attempt <= MAX_BLOCKHASH_RETRIES; attempt++) {
      const freshOrder = await dflowClient.getSellOrder({
        ...dflowParams,
        predictionMarketSlippageBps: 1000,
      });
      if (!freshOrder.transaction) {
        return { success: false, error: 'DFlow did not return a transaction' };
      }
      try {
        const result = await privyService.signAndSendSolanaTransaction(
          solanaWalletId,
          freshOrder.transaction
        );
        orderResponse = freshOrder;
        hash = result.hash;
        break;
      } catch (signErr) {
        if (attempt < MAX_BLOCKHASH_RETRIES && isBlockhashError(signErr)) {
          logger.info({
            message: 'Kalshi sell: blockhash expired, retrying with fresh order',
            attempt: attempt + 1,
            kalshiTicker: req.kalshiTicker,
          });
          continue;
        }
        throw signErr;
      }
    }

    if (!hash || !orderResponse) {
      return { success: false, error: 'Transaction failed. Please try again.' };
    }

    // Step 5: Full DFlow response (exclude base64 transaction)
    // For SELL: inAmount=tokens sold, outAmount=USDC received
    const dflowResponse = {
      inAmount: orderResponse.inAmount,
      inAmountShares: (Number(orderResponse.inAmount ?? 0) / 1e6).toFixed(6),
      outAmount: orderResponse.outAmount,
      outAmountUsd: (Number(orderResponse.outAmount ?? 0) / 1e6).toFixed(6),
      otherAmountThreshold: orderResponse.otherAmountThreshold,
      minOutAmount: orderResponse.minOutAmount,
      slippageBps: orderResponse.slippageBps,
      priceImpactPct: orderResponse.priceImpactPct,
      executionMode: orderResponse.executionMode,
      platformFee: orderResponse.platformFee
        ? {
            amount: orderResponse.platformFee.amount,
            amountUsd: (Number(orderResponse.platformFee.amount) / 1e6).toFixed(6),
            feeBps: orderResponse.platformFee.feeBps,
            feeAccount: orderResponse.platformFee.feeAccount?.slice(0, 12) + '...',
          }
        : null,
      inputMint: orderResponse.inputMint?.slice(0, 12) + '...',
      outputMint: orderResponse.outputMint?.slice(0, 12) + '...',
      hasTransaction: !!orderResponse.transaction,
    };
    logCtx('5_dflow_response', { dflowResponse, txHash: hash });

    // Step 6: Fund flow accounting (tokens out, USDC in)
    const tokensSold = Number(finalSellAmount) / 1e6;
    const usdcReceived = Number(orderResponse.outAmount ?? 0) / 1e6; // outAmount = USDC for sell
    const feeUsdc = orderResponse.platformFee ? Number(orderResponse.platformFee.amount) / 1e6 : 0;
    logCtx('6_fund_flow', {
      tokensSoldRaw: finalSellAmount,
      tokensSoldShares: tokensSold.toFixed(6),
      usdcCreditedToWallet: usdcReceived.toFixed(6),
      platformFeeUsdc: feeUsdc.toFixed(6),
      effectivePriceCents: tokensSold > 0 ? ((usdcReceived / tokensSold) * 100).toFixed(2) : null,
    });

    // Sync on-chain balance after trade (delayed to allow Solana confirmation)
    syncBalanceAfterTrade(req.privyUserId, solanaWallet, 'kalshi_sell');

    // Save trade with FILLED status and actual tx hash
    const marketInfo = await dflowMetadataService.getMarketByMint(outcomeMint);
    const marketTitle = marketInfo?.title ?? null;
    const usdcFromSell = orderResponse.outAmount ?? '0'; // outAmount = USDC received for sell
    const effectivePrice = finalSellAmount && Number(finalSellAmount) > 0
      ? Number(usdcFromSell) / Number(finalSellAmount)
      : null;

    const dbInsertValues = {
      privy_user_id: req.privyUserId,
      solana_wallet_address: solanaWallet,
      kalshi_ticker: req.kalshiTicker,
      outcome_mint: outcomeMint,
      outcome: req.outcome,
      side: 'SELL',
      input_amount: finalSellAmount,
      input_amount_shares: (Number(finalSellAmount) / 1e6).toFixed(6),
      output_amount: usdcFromSell,
      output_amount_usd: (Number(usdcFromSell) / 1e6).toFixed(6),
      price_per_token: effectivePrice,
      status: 'FILLED',
      solana_signature: hash,
      market_title: marketTitle,
    };
    logCtx('7_kalshi_trades_history_insert', { dbInsertValues });

    let tradeId: string | undefined;
    if (getDatabaseConfig().type === 'postgres') {
      const client = await pool.connect();
      try {
        const r = await client.query(
          `INSERT INTO kalshi_trades_history
           (privy_user_id, solana_wallet_address, kalshi_ticker, outcome_mint, outcome, side, input_amount, output_amount, price_per_token, dflow_order_id, status, solana_signature, market_title)
           VALUES ($1, $2, $3, $4, $5, 'SELL', $6, $7, $8, $9, 'FILLED', $10, $11)
           RETURNING id`,
          [req.privyUserId, solanaWallet, req.kalshiTicker, outcomeMint, req.outcome, finalSellAmount, usdcFromSell, effectivePrice, null, hash, marketTitle]
        );
        tradeId = r.rows[0]?.id;
        logCtx('8_trade_stored', { tradeId });
      } finally {
        client.release();
      }
    }

    // Instant position update in kalshi_positions DB (after releasing trade client)
    await applyKalshiTradeToPositions('SELL', {
      privyUserId: req.privyUserId,
      solanaWalletAddress: solanaWallet,
      kalshiTicker: req.kalshiTicker,
      outcomeMint,
      outcome: req.outcome,
      tokenAmount: finalSellAmount,
    });
    publishKalshiPositionUpdate(req.privyUserId, { type: 'position_update', source: 'trade_fill' });

    return { success: true, tradeId, solanaSignature: hash };
  } catch (e) {
    const rawError = e instanceof Error ? e.message : String(e);
    logger.error({
      message: 'Kalshi SELL trade failed',
      traceId: tid,
      privyUserId: req.privyUserId,
      kalshiTicker: req.kalshiTicker,
      error: rawError,
      stack: e instanceof Error ? e.stack : undefined,
    });
    // IMPORTANT: On failure we never modify DB or broadcast. Position remains on-chain.
    // Frontend should refetch positions on error to avoid stale optimistic updates.
    return {
      success: false,
      error: toUserFriendlyTradeError(e),
      refetchPositions: true, // Hint: position is still on-chain; frontend should refetch
    };
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
