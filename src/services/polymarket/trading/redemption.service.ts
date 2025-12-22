/**
 * Redemption Service
 * Handles redeeming winning positions on Polymarket via RelayerClient
 * Supports both standard and negative risk markets
 */

import { encodeFunctionData } from 'viem';
import { pool } from '../../../config/database';
import { logger } from '../../../config/logger';
import { getUserByPrivyId } from '../../privy/user.service';
import { privyConfig } from '../../privy/privy.config';
import { saveTradeRecord, updateTradeRecordById } from './trades-history.service';
import { refreshAndUpdateBalance } from '../../alchemy/balance.service';
import { refreshPositions } from '../../positions/positions.service';

// Contract addresses
const CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Parent collection ID is always null (0x00...00) for Polymarket binary markets
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// Index sets for binary markets: [1, 2] means both outcomes
const INDEX_SETS = [BigInt(1), BigInt(2)];

// CTF redeemPositions ABI (standard markets)
const REDEEM_POSITIONS_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSets', type: 'uint256[]' }
  ],
  outputs: []
}] as const;

// Neg Risk Adapter redeemPositions ABI (negative risk markets)
// The adapter wraps CTF redemption with negative risk handling
const NEG_RISK_REDEEM_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  inputs: [
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSets', type: 'uint256[]' },
    { name: 'amounts', type: 'uint256[]' }
  ],
  outputs: []
}] as const;

// Cache for RelayerClient instances
const relayerClientCache = new Map<string, { relayerClient: any; wallet: any; builderConfig: any }>();

export interface RedeemablePosition {
  asset: string;
  conditionId: string;
  size: string;
  curPrice: string;
  currentValue: string;
  title: string;
  outcome: string;
  eventId: string;
}

export interface RedemptionResult {
  success: boolean;
  transactionHash?: string;
  redemptionId?: string;
  redeemedAmount?: string;
  error?: string;
}

export interface BatchRedemptionResult {
  success: boolean;
  totalRedeemed: number;
  totalAmount: string;
  results: {
    conditionId: string;
    title: string;
    outcome: string;
    success: boolean;
    transactionHash?: string;
    redemptionId?: string;
    redeemedAmount?: string;
    error?: string;
  }[];
}

/**
 * Get or create RelayerClient for user
 */
async function getRelayerClient(privyUserId: string, embeddedWalletAddress: string): Promise<any> {
  const cached = relayerClientCache.get(privyUserId);
  if (cached) {
    return cached.relayerClient;
  }

  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
  const { createViemWalletForRelayer } = await import('../../privy/wallet-deployment.service');
  const { privyService } = await import('../../privy/privy.service');

  // Get wallet ID for the user (optional - used to speed up signing)
  let walletId: string | undefined = undefined;
  try {
    const fetchedWalletId = await privyService.getWalletIdByAddress(privyUserId, embeddedWalletAddress);
    if (fetchedWalletId) {
      walletId = fetchedWalletId;
    }
  } catch {
    logger.warn({
      message: 'Could not get wallet ID, will look up during signing',
      privyUserId,
    });
  }
  
  // Create viem wallet client and builder config
  // Signature: createViemWalletForRelayer(privyUserId, embeddedWalletAddress, walletId?)
  const { wallet, builderConfig } = await createViemWalletForRelayer(
    privyUserId,
    embeddedWalletAddress,
    walletId || undefined
  );

  // Create RelayerClient
  const relayerClient = new RelayClient(
    privyConfig.relayerUrl,
    privyConfig.chainId,
    wallet,
    builderConfig,
    RelayerTxType.SAFE
  );

  relayerClientCache.set(privyUserId, { relayerClient, wallet, builderConfig });
  return relayerClient;
}

/**
 * Get redeemable positions for a user
 */
export async function getRedeemablePositions(privyUserId: string): Promise<RedeemablePosition[]> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT asset, condition_id, size, cur_price, current_value, title, outcome, event_id
       FROM user_positions
       WHERE privy_user_id = $1 AND redeemable = true AND CAST(size AS DECIMAL) > 0
       ORDER BY current_value DESC`,
      [privyUserId]
    );

    return result.rows.map(row => ({
      asset: row.asset,
      conditionId: row.condition_id,
      size: String(row.size),
      curPrice: String(row.cur_price),
      currentValue: String(row.current_value),
      title: row.title,
      outcome: row.outcome,
      eventId: row.event_id,
    }));
  } finally {
    client.release();
  }
}

/**
 * Redeem a single position
 */
export async function redeemPosition(
  privyUserId: string,
  conditionId: string
): Promise<RedemptionResult> {
  logger.info({
    message: 'Starting position redemption',
    privyUserId,
    conditionId,
  });

  // Get user
  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (!user.proxyWalletAddress) {
    return { success: false, error: 'User does not have a proxy wallet' };
  }

  if (!user.embeddedWalletAddress) {
    return { success: false, error: 'User does not have an embedded wallet' };
  }

  // Get position details from database (including negative_risk flag and outcome_index)
  const client = await pool.connect();
  let position: any;

  try {
    const result = await client.query(
      `SELECT asset, condition_id, size, cur_price, current_value, title, outcome, event_id, negative_risk, outcome_index
       FROM user_positions
       WHERE privy_user_id = $1 AND condition_id = $2`,
      [privyUserId, conditionId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Position not found' };
    }

    position = result.rows[0];

    if (parseFloat(position.size) <= 0) {
      return { success: false, error: 'Position has no tokens to redeem' };
    }
  } finally {
    client.release();
  }

  // Determine if this is a negative risk market
  const isNegativeRisk = position.negative_risk || false;

  // Calculate expected redemption amount (winning positions redeem at $1 per share)
  const redeemAmount = parseFloat(position.size); // In USDC

  // Save redemption record to trades history
  const redemptionRecord = await saveTradeRecord({
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
    marketId: position.event_id || 'unknown',
    marketQuestion: position.title,
    clobTokenId: position.asset,
    outcome: position.outcome,
    side: 'REDEEM',
    orderType: 'REDEEM',
    size: position.size,
    price: '1.000000', // Redemption is always at $1
    costUsdc: '0', // No cost for redemption
    feeUsdc: '0',
    status: 'PENDING',
    metadata: {
      conditionId,
      redeemAmount: redeemAmount.toFixed(6),
      type: 'redemption',
      negativeRisk: isNegativeRisk,
    },
  });

  try {
    // Get RelayerClient
    const relayerClient = await getRelayerClient(privyUserId, user.embeddedWalletAddress);

    let redeemData: `0x${string}`;
    let targetContract: string;

    if (isNegativeRisk) {
      // Negative risk markets: use the Neg Risk Adapter
      // Convert size to raw amount (6 decimals for USDC-based tokens)
      const rawAmount = BigInt(Math.floor(parseFloat(position.size) * 1e6));
      
      // For binary markets: outcome_index 0 = index set 1, outcome_index 1 = index set 2
      // The Neg Risk Adapter requires amounts for both index sets
      // We provide the amount for the outcome we have, and 0 for the other
      const outcomeIndex = position.outcome_index ?? 0; // Default to 0 if not set
      const indexSet1Amount = outcomeIndex === 0 ? rawAmount : BigInt(0);
      const indexSet2Amount = outcomeIndex === 1 ? rawAmount : BigInt(0);
      
      logger.info({
        message: 'Using Neg Risk Adapter for redemption',
        privyUserId,
        conditionId,
        outcomeIndex,
        rawAmount: rawAmount.toString(),
        indexSet1Amount: indexSet1Amount.toString(),
        indexSet2Amount: indexSet2Amount.toString(),
      });
      
      redeemData = encodeFunctionData({
        abi: NEG_RISK_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [
          conditionId as `0x${string}`,
          INDEX_SETS,
          [indexSet1Amount, indexSet2Amount], // amounts for [index1, index2]
        ],
      });
      targetContract = NEG_RISK_ADAPTER_ADDRESS;
    } else {
      // Standard markets: use the CTF contract directly
      redeemData = encodeFunctionData({
        abi: REDEEM_POSITIONS_ABI,
        functionName: 'redeemPositions',
        args: [
          USDC_CONTRACT_ADDRESS as `0x${string}`,
          PARENT_COLLECTION_ID,
          conditionId as `0x${string}`,
          INDEX_SETS,
        ],
      });
      targetContract = CTF_CONTRACT_ADDRESS;
    }

    const transaction = {
      to: targetContract,
      data: redeemData,
      value: '0',
    };

    logger.info({
      message: 'Executing redemption via relayer',
      privyUserId,
      conditionId,
      targetContract,
      isNegativeRisk,
    });

    // Execute via RelayerClient
    const response = await relayerClient.execute(
      [transaction],
      `Redeem ${position.outcome} position: ${position.title}`
    );

    logger.info({
      message: 'Relayer execute response received',
      privyUserId,
      conditionId,
      responseType: typeof response,
      responseKeys: response ? Object.keys(response) : null,
      hasWait: response && typeof response.wait === 'function',
    });

    // Wait for transaction confirmation
    let txResult: any;
    try {
      txResult = await response.wait();
      
      logger.info({
        message: 'Transaction wait completed',
        privyUserId,
        conditionId,
        txResultType: typeof txResult,
        txResultKeys: txResult ? Object.keys(txResult) : null,
        txResultValue: txResult ? JSON.stringify(txResult, null, 2) : null,
        hasTransactionHash: txResult && 'transactionHash' in txResult,
        transactionHash: txResult?.transactionHash,
        state: txResult?.state,
        status: txResult?.status,
      });
    } catch (waitError) {
      logger.error({
        message: 'Error waiting for transaction',
        privyUserId,
        conditionId,
        error: waitError instanceof Error ? waitError.message : String(waitError),
        errorStack: waitError instanceof Error ? waitError.stack : undefined,
      });
      throw waitError;
    }

    // Check for transaction hash in various possible fields
    const transactionHash = txResult?.transactionHash || txResult?.hash || txResult?.txHash || txResult?.tx?.hash;
    
    // Check if transaction failed (relayer may return hash even if transaction failed on-chain)
    const transactionState = txResult?.state;
    const transactionStatus = txResult?.status;
    const isFailed = transactionState === 'FAILED' || 
                     transactionState === 'REVERTED' ||
                     transactionStatus === 'FAILED' ||
                     transactionStatus === 'REVERTED' ||
                     (txResult && 'failed' in txResult && txResult.failed === true);
    
    if (!txResult || !transactionHash) {
      logger.error({
        message: 'Transaction failed - no hash returned',
        privyUserId,
        conditionId,
        txResult,
        isNegativeRisk,
      });
      throw new Error('Transaction failed - no hash returned');
    }
    
    if (isFailed) {
      logger.error({
        message: 'Transaction failed on-chain',
        privyUserId,
        conditionId,
        transactionHash,
        state: transactionState,
        status: transactionStatus,
        isNegativeRisk,
      });
      throw new Error(`Transaction failed on-chain. Hash: ${transactionHash}. This may indicate the redemption contract call reverted. For negative risk markets, ensure you have the correct outcome and sufficient balance.`);
    }

    logger.info({
      message: 'Redemption transaction confirmed',
      privyUserId,
      conditionId,
      transactionHash,
    });

    // Update redemption record
    await updateTradeRecordById(redemptionRecord.id, {
      transactionHash,
      status: 'FILLED',
    });

    // Refresh balance from Alchemy (the webhook might also trigger, but we do it explicitly)
    try {
      await refreshAndUpdateBalance(user.proxyWalletAddress, privyUserId);
      logger.info({
        message: 'Balance refreshed after redemption',
        privyUserId,
      });
    } catch (balanceError) {
      logger.warn({
        message: 'Failed to refresh balance after redemption',
        privyUserId,
        error: balanceError instanceof Error ? balanceError.message : String(balanceError),
      });
    }

    // Refresh positions to update the database
    try {
      await refreshPositions(privyUserId);
      logger.info({
        message: 'Positions refreshed after redemption',
        privyUserId,
      });
    } catch (positionsError) {
      logger.warn({
        message: 'Failed to refresh positions after redemption',
        privyUserId,
        error: positionsError instanceof Error ? positionsError.message : String(positionsError),
      });
    }

    return {
      success: true,
      transactionHash,
      redemptionId: redemptionRecord.id,
      redeemedAmount: redeemAmount.toFixed(6),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({
      message: 'Redemption failed',
      privyUserId,
      conditionId,
      error: errorMessage,
    });

    // Update redemption record to failed
    await updateTradeRecordById(redemptionRecord.id, {
      status: 'FAILED',
      errorMessage,
    });

    return {
      success: false,
      redemptionId: redemptionRecord.id,
      error: errorMessage,
    };
  }
}

/**
 * Redeem all redeemable positions for a user
 */
export async function redeemAllPositions(privyUserId: string): Promise<BatchRedemptionResult> {
  logger.info({
    message: 'Starting batch redemption',
    privyUserId,
  });

  // Get all redeemable positions
  const positions = await getRedeemablePositions(privyUserId);

  if (positions.length === 0) {
    return {
      success: true,
      totalRedeemed: 0,
      totalAmount: '0',
      results: [],
    };
  }

  const results: BatchRedemptionResult['results'] = [];
  let totalRedeemed = 0;
  let totalAmount = 0;

  // Redeem each position sequentially
  for (const position of positions) {
    const result = await redeemPosition(privyUserId, position.conditionId);

    results.push({
      conditionId: position.conditionId,
      title: position.title,
      outcome: position.outcome,
      success: result.success,
      transactionHash: result.transactionHash,
      redemptionId: result.redemptionId,
      redeemedAmount: result.redeemedAmount,
      error: result.error,
    });

    if (result.success && result.redeemedAmount) {
      totalRedeemed++;
      totalAmount += parseFloat(result.redeemedAmount);
    }
  }

  logger.info({
    message: 'Batch redemption completed',
    privyUserId,
    totalPositions: positions.length,
    totalRedeemed,
    totalAmount: totalAmount.toFixed(6),
  });

  return {
    success: totalRedeemed > 0,
    totalRedeemed,
    totalAmount: totalAmount.toFixed(6),
    results,
  };
}

/**
 * Check if a position is redeemable on-chain (optional verification)
 */
export async function checkRedeemableOnChain(
  proxyWalletAddress: string,
  conditionId: string
): Promise<boolean> {
  // This would require reading the CTF contract state
  // For now, we trust the Polymarket API's redeemable flag
  // TODO: Implement on-chain verification if needed
  return true;
}
