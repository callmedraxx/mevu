/**
 * Fee Service
 * Handles trading fee collection and retry logic
 * Uses RelayerClient for gasless USDC transfers
 */

import { ethers } from 'ethers';
import { logger } from '../../../config/logger';
import { privyConfig } from '../../privy/privy.config';
import { getUserByPrivyId } from '../../privy/user.service';
import { FEE_CONFIG, FeeStatus } from './trading.types';
import { updateTradeRecordById } from './trades-history.service';
import { pool, getDatabaseConfig } from '../../../config/database';

// Import RelayerClient utilities from wallet-deployment service
// We'll reuse the same pattern for creating RelayerClient instances
let relayerClientCache: Map<string, any> = new Map();

/**
 * Get or create RelayerClient for fee transfers
 */
async function getRelayerClientForFee(privyUserId: string): Promise<any> {
  const cached = relayerClientCache.get(privyUserId);
  if (cached) {
    return cached.relayerClient;
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user || !user.proxyWalletAddress) {
    throw new Error('User not found or no proxy wallet');
  }

  // Import RelayerClient and utilities
  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
  const { createViemWalletForRelayer } = await import('../../privy/wallet-deployment.service');
  const { privyService } = await import('../../privy/privy.service');

  const walletId = await privyService.getWalletIdByAddress(privyUserId, user.embeddedWalletAddress);
  const { wallet, builderConfig } = await createViemWalletForRelayer(
    privyUserId,
    user.embeddedWalletAddress,
    walletId || undefined
  );

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
 * Transfer fee from proxy wallet to fee wallet
 * @param privyUserId - User ID
 * @param feeAmountUsdc - Fee amount in USDC (as number, e.g., 0.005)
 * @param tradeId - Trade record ID
 * @returns Transaction hash if successful
 */
export async function transferFee(
  privyUserId: string,
  feeAmountUsdc: number,
  tradeId: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user || !user.proxyWalletAddress) {
      throw new Error('User not found or no proxy wallet');
    }

    logger.info({
      message: 'Transferring trading fee',
      privyUserId,
      tradeId,
      feeAmountUsdc,
      fromWallet: user.proxyWalletAddress,
      toWallet: FEE_CONFIG.WALLET,
    });

    // Get RelayerClient
    const relayerClient = await getRelayerClientForFee(privyUserId);

    // Encode USDC transfer
    // USDC uses 6 decimals
    const feeAmountWei = ethers.utils.parseUnits(feeAmountUsdc.toFixed(6), 6);

    const { encodeFunctionData } = await import('viem');
    const transferData = encodeFunctionData({
      abi: [{
        name: 'transfer',
        type: 'function',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' }
        ],
        outputs: [{ type: 'bool' }]
      }],
      functionName: 'transfer',
      args: [FEE_CONFIG.WALLET as `0x${string}`, BigInt(feeAmountWei.toString())]
    });

    const transaction = {
      to: privyConfig.contracts.usdc,
      data: transferData,
      value: '0',
    };

    // Execute via RelayerClient (gasless)
    const response = await relayerClient.execute(
      [transaction],
      `Trading fee: ${feeAmountUsdc} USDC`
    );

    const result = await response.wait();

    if (!result || !result.transactionHash) {
      throw new Error('Fee transfer transaction failed');
    }

    logger.info({
      message: 'Fee transfer successful',
      privyUserId,
      tradeId,
      feeAmountUsdc,
      txHash: result.transactionHash,
    });

    // Update trade record
    await updateTradeRecordById(tradeId, {
      feeStatus: 'PAID',
      feeTxHash: result.transactionHash,
    });

    return {
      success: true,
      txHash: result.transactionHash,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({
      message: 'Fee transfer failed',
      privyUserId,
      tradeId,
      feeAmountUsdc,
      error: errorMessage,
    });

    // Update trade record to FAILED
    await updateTradeRecordById(tradeId, {
      feeStatus: 'FAILED',
    }).catch((updateError) => {
      logger.error({
        message: 'Failed to update trade record with fee failure',
        tradeId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Retry pending or failed fee transfers
 * Called by background job
 */
export async function retryPendingFees(): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // In-memory mode - skip retry
    return;
  }

  const client = await pool.connect();

  try {
    // Find trades with pending or failed fees that haven't exceeded max retries
    const result = await client.query(
      `SELECT id, privy_user_id, cost_usdc, fee_amount, fee_retry_count
       FROM trades_history
       WHERE fee_status IN ('PENDING', 'FAILED', 'RETRYING')
         AND fee_retry_count < $1
         AND status = 'FILLED'
         AND (fee_last_retry IS NULL OR fee_last_retry < NOW() - INTERVAL '5 minutes')
       ORDER BY created_at ASC
       LIMIT 10`,
      [FEE_CONFIG.MAX_RETRIES]
    );

    if (result.rows.length === 0) {
      return;
    }

    logger.info({
      message: 'Retrying pending fee transfers',
      count: result.rows.length,
    });

    for (const row of result.rows) {
      const tradeId = row.id;
      const privyUserId = row.privy_user_id;
      const costUsdc = parseFloat(row.cost_usdc);
      const feeAmount = row.fee_amount ? parseFloat(row.fee_amount) : costUsdc * FEE_CONFIG.RATE;
      const retryCount = row.fee_retry_count || 0;

      try {
        // Update status to RETRYING
        await updateTradeRecordById(tradeId, {
          feeStatus: 'RETRYING',
          feeRetryCount: retryCount + 1,
          feeLastRetry: new Date(),
        });

        // Attempt transfer
        const result = await transferFee(privyUserId, feeAmount, tradeId);

        if (result.success) {
          logger.info({
            message: 'Fee retry successful',
            tradeId,
            retryCount: retryCount + 1,
            txHash: result.txHash,
          });
        } else {
          logger.warn({
            message: 'Fee retry failed',
            tradeId,
            retryCount: retryCount + 1,
            error: result.error,
          });
        }
      } catch (error) {
        logger.error({
          message: 'Error during fee retry',
          tradeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Small delay between retries
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logger.error({
      message: 'Error in retryPendingFees',
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.release();
  }
}
