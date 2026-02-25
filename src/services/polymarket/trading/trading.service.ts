/**
 * Trading Service
 * Handles buy/sell operations on Polymarket CLOB
 * Uses RelayerClient for gasless transactions
 */

import { Side, OrderType as ClobOrderType } from '@polymarket/clob-client';
import { logger } from '../../../config/logger';
import { getUserByPrivyId } from '../../privy/user.service';
import { getClobClientForUser } from './clob-client.service';
import { CreateTradeRequest, CreateTradeResponse, OrderType, TradeSide, FEE_CONFIG } from './trading.types';
import { saveTradeRecord, updateTradeRecord, updateTradeRecordById } from './trades-history.service';

// Retry configuration for transient errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

// Error codes for frontend handling
export enum TradeErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  NO_PROXY_WALLET = 'NO_PROXY_WALLET',
  TOKENS_NOT_APPROVED = 'TOKENS_NOT_APPROVED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_PRICE = 'INVALID_PRICE',
  INVALID_SIZE = 'INVALID_SIZE',
  MARKET_UNAVAILABLE = 'MARKET_UNAVAILABLE',
  ORDER_REJECTED = 'ORDER_REJECTED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

// User-friendly error messages
const USER_FRIENDLY_MESSAGES: Record<TradeErrorCode, string> = {
  [TradeErrorCode.USER_NOT_FOUND]: 'Account not found. Please log in again.',
  [TradeErrorCode.NO_PROXY_WALLET]: 'Your trading wallet is not set up. Please complete account setup first.',
  [TradeErrorCode.TOKENS_NOT_APPROVED]: 'Token approvals required. Please approve tokens before trading.',
  [TradeErrorCode.INSUFFICIENT_BALANCE]: 'Insufficient USDC balance for this trade.',
  [TradeErrorCode.INVALID_PRICE]: 'Invalid price. Price must be between $0.01 and $0.99.',
  [TradeErrorCode.INVALID_SIZE]: 'Order amount too small. Minimum order size is $1.',
  [TradeErrorCode.MARKET_UNAVAILABLE]: 'This market is currently unavailable. Please try again later.',
  [TradeErrorCode.ORDER_REJECTED]: 'Order was rejected. The market may have moved or insufficient liquidity.',
  [TradeErrorCode.SERVICE_UNAVAILABLE]: 'Trading service is temporarily busy. Please try again in a few seconds.',
  [TradeErrorCode.RATE_LIMITED]: 'Too many requests. Please wait a moment before trying again.',
  [TradeErrorCode.UNKNOWN_ERROR]: 'Something went wrong. Please try again.',
};

/**
 * Check if an error is retryable (503, 502, 429, network errors)
 */
function isRetryableError(error: any): boolean {
  if (error?.response?.status) {
    const status = error.response.status;
    return status === 503 || status === 502 || status === 429 || status === 504 || status === 425;
  }
  // Network errors
  if (error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || error?.code === 'ENOTFOUND') {
    return true;
  }
  // Check error message for common transient error patterns
  const message = error?.message?.toLowerCase() || '';
  return message.includes('service unavailable') || 
         message.includes('temporarily unavailable') ||
         message.includes('timeout') ||
         message.includes('econnreset');
}

/**
 * Map error to user-friendly error code and message
 */
function mapErrorToUserFriendly(error: any): { code: TradeErrorCode; message: string } {
  const errorMessage = error?.message?.toLowerCase() || '';
  const responseStatus = error?.response?.status;
  const responseData = error?.response?.data;

  // Check for specific error patterns
  if (errorMessage.includes('user not found')) {
    return { code: TradeErrorCode.USER_NOT_FOUND, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.USER_NOT_FOUND] };
  }
  
  if (errorMessage.includes('proxy wallet') || errorMessage.includes('deploy proxy')) {
    return { code: TradeErrorCode.NO_PROXY_WALLET, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.NO_PROXY_WALLET] };
  }
  
  if (errorMessage.includes('approval') || errorMessage.includes('approve token')) {
    return { code: TradeErrorCode.TOKENS_NOT_APPROVED, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.TOKENS_NOT_APPROVED] };
  }
  
  if (errorMessage.includes('insufficient') || errorMessage.includes('balance') || errorMessage.includes('not enough balance')) {
    // Use the actual error message if it includes specific balance info
    if (errorMessage.includes('you have $') || errorMessage.includes('need $')) {
      return { code: TradeErrorCode.INSUFFICIENT_BALANCE, message: error?.message || USER_FRIENDLY_MESSAGES[TradeErrorCode.INSUFFICIENT_BALANCE] };
    }
    return { code: TradeErrorCode.INSUFFICIENT_BALANCE, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.INSUFFICIENT_BALANCE] };
  }
  
  if (errorMessage.includes('invalid price') || errorMessage.includes('price must be')) {
    return { code: TradeErrorCode.INVALID_PRICE, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.INVALID_PRICE] };
  }

  // Check for minimum order size errors
  if (errorMessage.includes('min size') || errorMessage.includes('minimum') || errorMessage.includes('order amount too small')) {
    // Use the actual error message which includes the amount details
    return { code: TradeErrorCode.INVALID_SIZE, message: error?.message || 'Order amount too small. Minimum order size is $1.' };
  }

  if (responseStatus === 429) {
    return { code: TradeErrorCode.RATE_LIMITED, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.RATE_LIMITED] };
  }
  
  if (responseStatus === 503 || responseStatus === 502 || responseStatus === 504) {
    return { code: TradeErrorCode.SERVICE_UNAVAILABLE, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.SERVICE_UNAVAILABLE] };
  }

  // Check Polymarket-specific errors
  if (responseData?.error) {
    const polyError = responseData.error.toLowerCase();
    if (polyError.includes('rejected') || polyError.includes('not enough liquidity')) {
      return { code: TradeErrorCode.ORDER_REJECTED, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.ORDER_REJECTED] };
    }
    if (polyError.includes('market') || polyError.includes('token')) {
      return { code: TradeErrorCode.MARKET_UNAVAILABLE, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.MARKET_UNAVAILABLE] };
    }
  }

  return { code: TradeErrorCode.UNKNOWN_ERROR, message: USER_FRIENDLY_MESSAGES[TradeErrorCode.UNKNOWN_ERROR] };
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Look up a matching trade from CLOB by orderId.
 * Returns the matching trade object if found, or null.
 */
async function findMatchingClobTrade(
  clobClient: any,
  orderId: string,
): Promise<any | null> {
  const trades = await clobClient.getTrades();
  return trades?.find((trade: any) =>
    trade.taker_order_id === orderId || trade.id === orderId
  ) ?? null;
}

/**
 * Update the trade record with actual fill data from CLOB (tx hash, price, size).
 */
async function applyFillData(
  matchingTrade: any,
  tradeRecordId: string,
  orderId: string,
  privyUserId: string,
  side?: string,
  originalSize?: string,
): Promise<void> {
  const updateData: any = {
    transactionHash: matchingTrade.transaction_hash,
  };

  if (matchingTrade.price && matchingTrade.size) {
    const actualFillPrice = parseFloat(matchingTrade.price);
    const actualFillSize = parseFloat(matchingTrade.size);
    const actualCostUsdc = actualFillPrice * actualFillSize;
    const actualFeeAmount = actualCostUsdc * FEE_CONFIG.RATE;

    updateData.price = actualFillPrice.toFixed(18);
    updateData.size = actualFillSize.toFixed(18);
    updateData.costUsdc = actualCostUsdc.toFixed(18);
    updateData.feeAmount = actualFeeAmount.toFixed(18);

    logger.info({
      message: `📊 ${side || 'UNKNOWN'} trade updated with actual fill data`,
      privyUserId,
      tradeId: tradeRecordId,
      orderId,
      originalSize,
      actualFillPrice,
      actualFillSize,
      actualCostUsdc: actualCostUsdc.toFixed(6),
      actualFeeAmount: actualFeeAmount.toFixed(6),
    });
  }

  await updateTradeRecordById(tradeRecordId, updateData);

  logger.info({
    message: 'Transaction hash and fill data updated for trade',
    privyUserId,
    tradeId: tradeRecordId,
    orderId,
    transactionHash: matchingTrade.transaction_hash,
  });
}

/**
 * Verify whether a FOK/FAK order actually filled by checking for a tx hash.
 * Polymarket CLOB returns status: 'DELAYED' for all orders — the only reliable
 * way to confirm a fill is the presence of a matching trade with a transaction_hash.
 *
 * Returns { filled: true, matchingTrade } if confirmed, { filled: false } if not.
 * Uses short polling (3 attempts, 2s/3s/4s delays) to keep user wait reasonable (~9s max).
 */
async function verifyFokFill(
  clobClient: any,
  orderId: string,
  privyUserId: string,
  tradeRecordId: string,
): Promise<{ filled: boolean; matchingTrade?: any }> {
  const maxAttempts = 3;
  const baseDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(baseDelayMs * attempt);
    try {
      const matchingTrade = await findMatchingClobTrade(clobClient, orderId);
      if (matchingTrade?.transaction_hash) {
        logger.info({
          message: 'FOK/FAK fill verified via tx hash',
          privyUserId,
          tradeId: tradeRecordId,
          orderId,
          transactionHash: matchingTrade.transaction_hash,
          attempt,
        });
        return { filled: true, matchingTrade };
      }
      logger.debug({
        message: 'FOK/FAK verification - tx hash not yet available',
        privyUserId,
        tradeId: tradeRecordId,
        orderId,
        attempt,
      });
    } catch (error) {
      logger.warn({
        message: 'Error during FOK/FAK fill verification',
        privyUserId,
        tradeId: tradeRecordId,
        orderId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn({
    message: 'FOK/FAK order not verified after polling - likely not filled',
    privyUserId,
    tradeId: tradeRecordId,
    orderId,
    maxAttempts,
  });
  return { filled: false };
}

/**
 * Fetch transaction hash from CLOB trades endpoint and update trade record (background).
 * Used for limit orders and as a secondary update for already-verified FOK/FAK orders.
 */
async function fetchAndUpdateTransactionHash(
  clobClient: any,
  orderId: string,
  tradeRecordId: string,
  privyUserId: string,
  side?: string,
  originalSize?: string
): Promise<void> {
  const maxAttempts = 5;
  const delayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delayMs * attempt);
    try {
      const matchingTrade = await findMatchingClobTrade(clobClient, orderId);

      if (matchingTrade?.transaction_hash) {
        await applyFillData(matchingTrade, tradeRecordId, orderId, privyUserId, side, originalSize);
        return;
      }

      logger.debug({
        message: 'Transaction hash not yet available',
        privyUserId,
        tradeId: tradeRecordId,
        orderId,
        attempt,
      });
    } catch (error) {
      logger.warn({
        message: 'Error fetching transaction hash',
        privyUserId,
        tradeId: tradeRecordId,
        orderId,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.warn({
    message: 'Could not fetch transaction hash after max attempts',
    privyUserId,
    tradeId: tradeRecordId,
    orderId,
    maxAttempts,
  });
}

/**
 * Execute a trade (buy or sell) on Polymarket
 * Uses RelayerClient for gasless execution
 */
export async function executeTrade(
  request: CreateTradeRequest
): Promise<CreateTradeResponse> {
  const { privyUserId, marketInfo, side, size, price } = request;

  // Crypto markets: use GTC (limit) instead of FOK/FAK to avoid frequent "couldn't be fully filled" failures
  const isCryptoMarket = marketInfo.metadata?.category === 'crypto';
  const orderType = isCryptoMarket && (request.orderType === OrderType.FOK || request.orderType === OrderType.FAK)
    ? OrderType.LIMIT
    : request.orderType;

  if (isCryptoMarket && request.orderType !== orderType) {
    logger.info({
      message: 'Crypto market: overriding order type to GTC limit',
      privyUserId,
      originalOrderType: request.orderType,
      effectiveOrderType: orderType,
      marketId: marketInfo.marketId,
    });
  }

  // Timing tracking for performance analysis
  const tradeStartTime = Date.now();
  const timings: Record<string, number> = {};

  // ============ TRADE REQUEST RECEIVED ============
  const requestedShares = parseFloat(size);
  const pricePerShare = parseFloat(price);
  const estimatedTradeCost = requestedShares * pricePerShare;
  const estimatedFee = estimatedTradeCost * FEE_CONFIG.RATE;
  
  logger.info({
    message: '🔔 TRADE REQUEST RECEIVED',
    privyUserId,
    marketId: marketInfo.marketId,
    clobTokenId: marketInfo.clobTokenId?.substring(0, 20) + '...',
    outcome: marketInfo.outcome,
    side: side === TradeSide.BUY ? 'BUY' : 'SELL',
    orderType,
    // Request details
    requestedShares,
    pricePerShare,
    // Estimated costs (before execution)
    estimatedTradeCostUsdc: estimatedTradeCost.toFixed(6),
    estimatedFeeUsdc: estimatedFee.toFixed(6),
    estimatedTotalUsdc: (estimatedTradeCost + estimatedFee).toFixed(6),
  });

  try {
    // Validate user
    const userStartTime = Date.now();
    const user = await getUserByPrivyId(privyUserId);
    timings.getUserByPrivyId = Date.now() - userStartTime;
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.proxyWalletAddress) {
      throw new Error('User does not have a proxy wallet. Please deploy proxy wallet first.');
    }
    const proxyWalletAddress = user.proxyWalletAddress;

    // Validate token approvals
    if (!user.usdcApprovalEnabled || !user.ctfApprovalEnabled) {
      throw new Error('Token approvals not set up. Please approve tokens first.');
    }

    // Price validation (required for cost calculation and BUY balance check)
    if (!price || parseFloat(price) <= 0 || parseFloat(price) > 1) {
      throw new Error('Price is required and must be between 0 and 1.');
    }

    // Precompute order cost (pure math, no async needed)
    const costUsdc = (parseFloat(size) * parseFloat(price)).toFixed(18);

    // Run balance check (BUY only), CLOB client setup, and trade record save in parallel
    const balanceCheckPromise =
      side === TradeSide.BUY
        ? (async () => {
            const estimatedCost = parseFloat(size) * parseFloat(price);
            try {
              const { getBalanceFromDb } = await import('../../alchemy/balance.service');
              const balanceResult = await getBalanceFromDb(proxyWalletAddress);
              const balanceUsdc = parseFloat(balanceResult?.balanceHuman ?? '0');
              const feeAmount = estimatedCost * FEE_CONFIG.RATE;
              const totalRequired = estimatedCost + feeAmount;

              logger.info({
                message: 'Pre-trade balance check (DB)',
                privyUserId,
                proxyWalletAddress,
                balanceUsdc,
                estimatedCost,
                feeAmount,
                totalRequired,
                hasSufficientBalance: balanceUsdc >= totalRequired,
              });

              if (balanceUsdc < totalRequired) {
                throw new Error(
                  `Insufficient balance. You have $${balanceUsdc.toFixed(2)} but need ` +
                    `$${estimatedCost.toFixed(2)} for trade + $${feeAmount.toFixed(2)} fee = $${totalRequired.toFixed(2)} total.`
                );
              }
            } catch (balanceError: any) {
              if (balanceError.message?.includes('Insufficient balance')) {
                throw balanceError;
              }
              logger.warn({
                message: 'Could not pre-check balance, proceeding with trade',
                privyUserId,
                error: balanceError instanceof Error ? balanceError.message : String(balanceError),
              });
            }
          })()
        : Promise.resolve();

    const tradeRecordPromise = saveTradeRecord({
      privyUserId,
      proxyWalletAddress: user.proxyWalletAddress,
      marketId: marketInfo.marketId,
      marketQuestion: marketInfo.marketQuestion,
      clobTokenId: marketInfo.clobTokenId,
      outcome: marketInfo.outcome,
      side,
      orderType,
      size,
      price: price,
      costUsdc,
      feeUsdc: '0', // Will be updated when order fills
      orderId: undefined, // Will be updated after CLOB call
      status: 'PENDING',
      metadata: marketInfo.metadata,
    });

    const clobClientStartTime = Date.now();
    const [, clobClient, tradeRecord] = await Promise.all([
      balanceCheckPromise,
      getClobClientForUser(privyUserId, request.userJwt, user),
      tradeRecordPromise,
    ]);
    timings.getClobClient = Date.now() - clobClientStartTime;

    logger.info({
      message: 'Trade record created with PENDING status',
      privyUserId,
      tradeId: tradeRecord.id,
    });

    try {

      // For FOK and FAK orders, use market order method
      // For LIMIT orders, use limit order method
      let orderResponse: any;
      let lastError: Error | null = null;

      // Retry loop for transient errors
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
            // Use market order for FOK/FAK (fill-or-kill / fill-and-kill)
            // Polymarket's createAndPostMarketOrder expects:
            //   - BUY: amount = USDC to spend
            //   - SELL: amount = number of shares to sell
            
            const clobOrderType = orderType === OrderType.FOK 
              ? ClobOrderType.FOK 
              : ClobOrderType.FAK;

            let orderAmount: number;
            
            if (side === TradeSide.BUY) {
              // For BUY: Convert shares to USDC amount = shares * price
              if (!price || parseFloat(price) <= 0 || parseFloat(price) > 1) {
                throw new Error('Price is required for BUY orders to calculate USDC amount.');
              }
              orderAmount = parseFloat(size) * parseFloat(price);
              
              // Polymarket requires minimum $1 for market BUY orders
              if (orderAmount < 1) {
                throw new Error(`Order amount too small ($${orderAmount.toFixed(2)}). Minimum order size is $1.`);
              }
              
              logger.info({
                message: 'Calculated BUY order amount',
                privyUserId,
                shares: size,
                price,
                usdcAmount: orderAmount,
              });
            } else {
              // For SELL: Use shares directly (not USDC)
              orderAmount = parseFloat(size);

              logger.info({
                message: 'Using shares for SELL order',
                privyUserId,
                shares: size,
                price,
                orderAmount,
              });
            }

            // Polymarket CLOB rejects prices outside 0.01-0.99.
            // For SELL market orders, clamp the price so sells aren't blocked on near-certain markets.
            // The clamped price acts as a floor — the order still fills at the actual book price.
            const marketOrderParams: any = {
              tokenID: marketInfo.clobTokenId,
              amount: orderAmount, // BUY: USDC amount | SELL: shares
              side: side === TradeSide.BUY ? Side.BUY : Side.SELL,
            };

            if (side === TradeSide.SELL && price) {
              const clampedPrice = Math.max(0.01, Math.min(0.99, parseFloat(price)));
              marketOrderParams.price = clampedPrice;

              if (clampedPrice !== parseFloat(price)) {
                logger.warn({
                  message: 'SELL order price clamped to CLOB valid range',
                  privyUserId,
                  originalPrice: price,
                  clampedPrice,
                });
              }
            }

            const orderStartTime = Date.now();
            orderResponse = await clobClient.createAndPostMarketOrder(
              marketOrderParams,
              {}, // Options (tickSize, negativeRisk, etc.)
              clobOrderType
            );
            timings.createMarketOrder = Date.now() - orderStartTime;
            
            logger.info({
              message: 'Market order created',
              privyUserId,
              orderType,
              clobOrderType,
              orderId: orderResponse?.orderID,
              attempt,
              orderTimeMs: timings.createMarketOrder,
            });

            // CLOB client returns error objects instead of throwing for HTTP 4xx/5xx.
            // When FOK fails with "couldn't be fully filled", fallback to GTC before retrying/failing.
            const returnedErrorStatus = typeof orderResponse?.status === 'number' && orderResponse.status >= 400;
            const errorMsg = orderResponse?.error ?? orderResponse?.data?.error;
            const fokNotFilledReturned =
              returnedErrorStatus &&
              typeof errorMsg === 'string' &&
              errorMsg.includes('fully filled');

            if (fokNotFilledReturned && side === TradeSide.SELL) {
              logger.info({
                message: 'FOK sell insufficient liquidity (returned) — falling back to GTC limit order',
                privyUserId,
                price,
                size,
                attempt,
              });

              try {
                orderResponse = await clobClient.createAndPostOrder({
                  tokenID: marketInfo.clobTokenId,
                  price: parseFloat(price),
                  size: parseFloat(size),
                  side: Side.SELL,
                });

                logger.info({
                  message: 'GTC limit sell order created (FOK fallback)',
                  privyUserId,
                  orderId: orderResponse?.orderID,
                });

                // GTC can also return error object — throw so we don't retry unnecessarily
                const gtcReturnedError =
                  typeof orderResponse?.status === 'number' && orderResponse.status >= 400;
                if (gtcReturnedError) {
                  const gtcErrMsg =
                    orderResponse?.error ??
                    orderResponse?.data?.error ??
                    `HTTP ${orderResponse.status}`;
                  throw new Error(gtcErrMsg);
                }
              } catch (gtcError: any) {
                logger.error({
                  message: 'GTC fallback also failed',
                  privyUserId,
                  error: gtcError?.message,
                });
                lastError = gtcError;
                throw gtcError;
              }
            }
          } else {
            // Use limit order for LIMIT/MARKET orders
            // Limit orders require a price
            if (!price || parseFloat(price) <= 0 || parseFloat(price) > 1) {
              throw new Error('Invalid price for limit order. Price must be between 0 and 1.');
            }

            orderResponse = await clobClient.createAndPostOrder({
              tokenID: marketInfo.clobTokenId,
              price: parseFloat(price),
              size: parseFloat(size),
              side: side === TradeSide.BUY ? Side.BUY : Side.SELL,
            });
            
            logger.info({
              message: 'Limit order created',
              privyUserId,
              price,
              orderId: orderResponse?.orderID,
              attempt,
            });
          }

          // If we got here without error, break the retry loop.
          // CLOB client returns { status: 400, error } for HTTP errors instead of throwing —
          // do NOT treat status >= 400 as success.
          const isSuccess =
            orderResponse?.orderID ||
            (orderResponse?.status &&
              (typeof orderResponse.status !== 'number' || orderResponse.status < 400));
          if (isSuccess) {
            break;
          }

          // No order ID returned - might be a silent failure
          if (!orderResponse?.orderID && attempt < MAX_RETRIES) {
            const respError = orderResponse?.error ?? orderResponse?.data?.error ?? '';
            const isOrderTooOld = typeof respError === 'string' && respError.includes('order too old');

            if (isOrderTooOld) {
              // Order too old is non-retryable — fail immediately
              throw new Error('order too old');
            }

            const isServiceNotReady = typeof respError === 'string' && respError.includes('service not ready');
            const retryDelay = isServiceNotReady ? 100 : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);

            logger.warn({
              message: 'Order response missing orderID, retrying',
              privyUserId,
              attempt,
              response: orderResponse,
              retryDelay,
            });
            await sleep(retryDelay);
            continue;
          }
        } catch (error: any) {
          lastError = error;

          // FOK sell failed due to insufficient liquidity — fallback to GTC limit order
          const fokNotFilled = error?.response?.status === 400 &&
            typeof error?.response?.data?.error === 'string' &&
            error.response.data.error.includes('fully filled');

          if (fokNotFilled && side === TradeSide.SELL && (orderType === OrderType.FOK || orderType === OrderType.FAK)) {
            logger.info({
              message: 'FOK sell insufficient liquidity — falling back to GTC limit order',
              privyUserId,
              price,
              size,
              attempt,
            });

            try {
              orderResponse = await clobClient.createAndPostOrder({
                tokenID: marketInfo.clobTokenId,
                price: parseFloat(price),
                size: parseFloat(size),
                side: Side.SELL,
              });

              logger.info({
                message: 'GTC limit sell order created (FOK fallback)',
                privyUserId,
                orderId: orderResponse?.orderID,
              });

              const gtcSuccess =
                orderResponse?.orderID ||
                (orderResponse?.status &&
                  (typeof orderResponse.status !== 'number' || orderResponse.status < 400));
              if (gtcSuccess) {
                break;
              }
              const gtcErrMsg =
                orderResponse?.error ??
                orderResponse?.data?.error ??
                `HTTP ${orderResponse?.status ?? 'unknown'}`;
              throw new Error(gtcErrMsg);
            } catch (gtcError: any) {
              logger.error({
                message: 'GTC fallback also failed',
                privyUserId,
                error: gtcError?.message,
              });
              lastError = gtcError;
              throw gtcError;
            }
          }

          if (isRetryableError(error) && attempt < MAX_RETRIES) {
            const errMsg = error?.response?.data?.error ?? error?.message ?? '';
            const isServiceNotReady = typeof errMsg === 'string' && errMsg.includes('service not ready');
            const delayMs = isServiceNotReady ? 100 : INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            logger.warn({
              message: 'Retryable error during order submission, retrying',
              privyUserId,
              attempt,
              maxRetries: MAX_RETRIES,
              delayMs,
              errorStatus: error?.response?.status,
              errorMessage: error?.message,
            });
            await sleep(delayMs);
            continue;
          }

          // Non-retryable error or max retries reached
          throw error;
        }
      }

      // If we still don't have an orderResponse after retries
      if (!orderResponse) {
        throw lastError || new Error('Failed to create order after retries');
      }

      logger.info({
        message: 'Order created via CLOB client',
        privyUserId,
        orderId: orderResponse.orderID,
        status: orderResponse.status,
      });

      // Check if response is an HTTP error (status is a number like 400, 500)
      // CLOB client returns { error, status } for HTTP errors instead of throwing
      if (typeof orderResponse.status === 'number' && orderResponse.status >= 400) {
        const errorMsg =
          orderResponse.error ??
          orderResponse.data?.error ??
          orderResponse.statusText ??
          `HTTP ${orderResponse.status}`;
        throw new Error(errorMsg);
      }

      // Determine the final status based on CLOB response
      // CLOB statuses: MATCHED, FILLED, EXECUTED, LIVE, OPEN, CANCELLED, REJECTED
      // Note: status might be a string (order status) or number (HTTP status code on error)
      const rawStatus = orderResponse.status;
      const clobStatus = typeof rawStatus === 'string' ? rawStatus.toUpperCase() : '';
      let finalStatus: string;
      
      // Log the full CLOB response for debugging
      logger.info({
        message: 'CLOB order response details',
        privyUserId,
        orderId: orderResponse.orderID,
        clobStatus,
        rawStatus,
        hasMatchedOrders: !!orderResponse.matchedOrders?.length,
        matchedOrdersCount: orderResponse.matchedOrders?.length || 0,
        sizeMatched: orderResponse.size_matched || orderResponse.sizeMatched,
        amountMatched: orderResponse.amount_matched || orderResponse.amountMatched,
        responseKeys: Object.keys(orderResponse),
      });
      
      if (clobStatus === 'MATCHED' || clobStatus === 'FILLED' || clobStatus === 'EXECUTED') {
        finalStatus = 'FILLED';
      } else if (clobStatus === 'LIVE' || clobStatus === 'OPEN') {
        // Limit order placed but not yet filled - keep as PENDING
        finalStatus = 'PENDING';
      } else if (clobStatus === 'CANCELLED' || clobStatus === 'REJECTED') {
        // Explicitly cancelled/rejected by CLOB
        finalStatus = 'CANCELLED';
      } else if (!orderResponse.orderID) {
        // No orderID and no valid status - likely an error
        throw new Error('Order failed: no orderID returned from CLOB');
      } else {
        // We have an orderID but unclear status
        // For FOK orders: if CLOB accepted the order (gave us an ID), it was filled
        // FOK is all-or-nothing - if not filled, CLOB would return CANCELLED/REJECTED
        // For FAK orders: same logic - partial fills are returned immediately
        // 
        // Trust the CLOB: if we got an orderID without explicit CANCELLED/REJECTED,
        // the order was accepted and processed
        
        // Check for explicit fill indicators as confirmation
        const hasMatchedOrders = orderResponse.matchedOrders && orderResponse.matchedOrders.length > 0;
        const hasSizeMatched = parseFloat(orderResponse.size_matched || orderResponse.sizeMatched || '0') > 0;
        const hasAmountMatched = parseFloat(orderResponse.amount_matched || orderResponse.amountMatched || '0') > 0;
        
        if (hasMatchedOrders || hasSizeMatched || hasAmountMatched) {
          logger.info({
            message: 'Order confirmed filled via response indicators',
            privyUserId,
            orderId: orderResponse.orderID,
            hasMatchedOrders,
            hasSizeMatched,
            hasAmountMatched,
          });
        }
        
        // For FOK/FAK: if we got an orderID and no CANCELLED/REJECTED, consider it filled
        // The transaction hash fetcher will verify and update async
        if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
          finalStatus = 'FILLED';
          logger.info({
            message: 'FOK/FAK order accepted by CLOB with orderID - marking as FILLED',
            privyUserId,
            orderId: orderResponse.orderID,
            orderType,
          });
        } else {
          // Limit orders without explicit status
          finalStatus = 'PENDING';
        }
      }

      // Calculate actual fee based on trade cost
      const actualCost = parseFloat(costUsdc);
      const feeAmount = actualCost * FEE_CONFIG.RATE;

      // Update trade record with order ID, final status, and fee info
      const updatedTrade = await updateTradeRecordById(tradeRecord.id, {
        orderId: orderResponse.orderID,
        status: finalStatus,
        feeRate: FEE_CONFIG.RATE,
        feeAmount: feeAmount.toFixed(18),
        feeStatus: finalStatus === 'FILLED' ? 'PENDING' : undefined, // Only charge fee if trade filled
      });

      logger.info({
        message: 'Trade record updated with CLOB response',
        privyUserId,
        tradeId: tradeRecord.id,
        orderId: orderResponse.orderID,
        clobStatus,
        finalStatus,
        feeAmount,
      });

      // ============ DETAILED FUND TRACKING LOG ============
      logger.info({
        message: '💰 FUND TRACKING - TRADE SUMMARY',
        privyUserId,
        tradeId: tradeRecord.id,
        side: side === TradeSide.BUY ? 'BUY' : 'SELL',
        orderType,
        // Order details
        requestedShares: parseFloat(size),
        pricePerShare: parseFloat(price),
        // Cost breakdown
        tradeCostUsdc: actualCost.toFixed(6),
        platformFeeRate: `${(FEE_CONFIG.RATE * 100).toFixed(2)}%`,
        platformFeeUsdc: feeAmount.toFixed(6),
        totalCostUsdc: (actualCost + feeAmount).toFixed(6),
        // For verification
        expectedSharesIfFilled: parseFloat(size),
        expectedUsdcSpentIfBuy: side === TradeSide.BUY ? (actualCost + feeAmount).toFixed(6) : 'N/A',
        expectedUsdcReceivedIfSell: side === TradeSide.SELL ? (actualCost - feeAmount).toFixed(6) : 'N/A',
        status: finalStatus,
      });

      // For FOK/FAK orders with DELAYED status: verify fill via tx hash before proceeding.
      // The CLOB always returns DELAYED — the only way to confirm a fill is the tx hash.
      // This blocks the response for ~2-9s but gives the user an accurate result.
      if (
        finalStatus === 'FILLED' &&
        orderResponse.orderID &&
        clobStatus === 'DELAYED' &&
        (orderType === OrderType.FOK || orderType === OrderType.FAK)
      ) {
        const tradeSide = side === TradeSide.BUY ? 'BUY' : 'SELL';
        const verification = await verifyFokFill(
          clobClient,
          orderResponse.orderID,
          privyUserId,
          tradeRecord.id,
        );

        if (verification.filled && verification.matchingTrade) {
          // Confirmed filled — apply actual fill data (tx hash, price, size)
          await applyFillData(
            verification.matchingTrade,
            tradeRecord.id,
            orderResponse.orderID,
            privyUserId,
            tradeSide,
            size,
          );
        } else {
          // Not filled — downgrade status
          finalStatus = 'NOT_FILLED';
          await updateTradeRecordById(tradeRecord.id, {
            status: 'NOT_FILLED',
            feeStatus: undefined,
          });
          logger.warn({
            message: 'FOK/FAK order not filled - no tx hash after verification',
            privyUserId,
            tradeId: tradeRecord.id,
            orderId: orderResponse.orderID,
            orderType,
            side: tradeSide,
          });
        }
      } else if (finalStatus === 'FILLED' && orderResponse.orderID) {
        // Non-FOK/FAK filled orders (e.g. explicit MATCHED status): fetch tx hash in background
        const tradeSide = side === TradeSide.BUY ? 'BUY' : 'SELL';
        fetchAndUpdateTransactionHash(clobClient, orderResponse.orderID, tradeRecord.id, privyUserId, tradeSide, size).catch((err) => {
          logger.warn({
            message: 'Failed to fetch transaction hash and fill data',
            privyUserId,
            tradeId: tradeRecord.id,
            orderId: orderResponse.orderID,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Transfer fee if trade was filled successfully (fire-and-forget; retry job covers failures)
      if (finalStatus === 'FILLED') {
        import('./fee.service').then(({ transferFee }) => {
          transferFee(privyUserId, feeAmount, tradeRecord.id)
            .then((result) => {
              if (result.success) {
                logger.info({
                  message: 'Fee transferred successfully',
                  privyUserId,
                  tradeId: tradeRecord.id,
                  feeAmount,
                  txHash: result.txHash,
                });
              } else {
                logger.warn({
                  message: 'Fee transfer failed, will retry via background job',
                  privyUserId,
                  tradeId: tradeRecord.id,
                  feeAmount,
                  error: result.error,
                });
              }
            })
            .catch((feeError) => {
              logger.error({
                message: 'Error during fee transfer',
                privyUserId,
                tradeId: tradeRecord.id,
                feeAmount,
                error: feeError instanceof Error ? feeError.message : String(feeError),
              });
            });
        });
      }

      // Fetch updated trade record with fee status
      const finalTrade = updatedTrade || tradeRecord;

      // Refresh positions, portfolio, and balance after successful trade
      if (finalStatus === 'FILLED') {
        // Refresh positions in background
        try {
          const { refreshPositions } = await import('../../positions/positions.service');
          refreshPositions(privyUserId).catch((refreshError) => {
            logger.warn({
              message: 'Failed to refresh positions after trade',
              privyUserId,
              tradeId: tradeRecord.id,
              error: refreshError instanceof Error ? refreshError.message : String(refreshError),
            });
          });
        } catch (importError) {
          logger.warn({
            message: 'Failed to import positions service for refresh',
            privyUserId,
            error: importError instanceof Error ? importError.message : String(importError),
          });
        }

        // Balance: Alchemy webhook updates wallet_balances when trade tx is confirmed.
        // Do not call refreshAndUpdateBalance here — it runs before the tx is mined and overwrites DB with stale balance.
      }

      // If FOK/FAK order was verified as not filled, return failure to user
      if (finalStatus === 'NOT_FILLED') {
        timings.total = Date.now() - tradeStartTime;
        return {
          success: false,
          orderId: orderResponse.orderID,
          status: 'NOT_FILLED',
          errorCode: 'NOT_FILLED',
          userMessage: 'Order could not be filled. There may not be enough liquidity at this price. Please try again.',
          message: 'Order was not filled - no matching liquidity found',
          retryable: true,
          trade: { ...finalTrade, status: 'NOT_FILLED' },
        };
      }

      // If order was explicitly CANCELLED by CLOB, return failure
      if (finalStatus === 'CANCELLED') {
        logger.warn({
          message: 'Order was explicitly cancelled/rejected by CLOB',
          privyUserId,
          tradeId: tradeRecord.id,
          orderId: orderResponse.orderID,
          clobStatus,
        });
        
        return {
          success: false,
          orderId: orderResponse.orderID,
          status: 'CANCELLED',
          errorCode: 'ORDER_REJECTED',
          userMessage: 'Order was rejected. There may not be enough liquidity at this price. Try a smaller amount or adjust your price.',
          message: `Order cancelled by CLOB: ${clobStatus}`,
          retryable: true,
          trade: { ...finalTrade, status: 'CANCELLED' },
        };
      }
      
      // Log total trade timing
      timings.total = Date.now() - tradeStartTime;
      logger.info({
        message: '⏱️ TRADE TIMING BREAKDOWN',
        privyUserId,
        side: side === TradeSide.BUY ? 'BUY' : 'SELL',
        status: finalStatus,
        timingsMs: timings,
        totalSeconds: (timings.total / 1000).toFixed(2),
      });
      
      return {
        success: finalStatus === 'FILLED',
        orderId: orderResponse.orderID,
        transactionHash: orderResponse.txHash,
        status: finalStatus,
        trade: finalTrade,
      };
    } catch (clobError: any) {
      // CLOB call failed - update trade record to FAILED
      const { code, message: userMessage } = mapErrorToUserFriendly(clobError);
      const errorMsg = clobError instanceof Error ? clobError.message : String(clobError);
      
      logger.error({
        message: 'CLOB order failed, updating trade record to FAILED',
        privyUserId,
        tradeId: tradeRecord.id,
        errorCode: code,
        errorMessage: errorMsg,
      });

      // Update trade record to FAILED status with error message
      await updateTradeRecordById(tradeRecord.id, {
        status: 'FAILED',
        errorMessage: errorMsg,
      });

      const isRetryable = isRetryableError(clobError);

      return {
        success: false,
        status: 'FAILED',
        errorCode: code,
        userMessage: userMessage,
        message: errorMsg,
        retryable: isRetryable,
        trade: { ...tradeRecord, status: 'FAILED' },
      };
    }
  } catch (error: any) {
    // Pre-CLOB validation error (user not found, no wallet, etc.)
    const { code, message: userMessage } = mapErrorToUserFriendly(error);
    const isRetryable = isRetryableError(error);
    
    logger.error({
      message: 'Failed to execute trade (pre-CLOB validation)',
      privyUserId,
      marketId: marketInfo.marketId,
      errorCode: code,
      userMessage,
      isRetryable,
      technicalError: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      success: false,
      status: 'FAILED',
      errorCode: code,
      userMessage: userMessage,
      message: error instanceof Error ? error.message : String(error),
      retryable: isRetryable,
    };
  }
}
