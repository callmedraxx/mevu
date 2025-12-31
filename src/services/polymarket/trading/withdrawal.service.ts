/**
 * Withdrawal Service
 * Handles USDC.e withdrawals from proxy wallet to any address on Polygon POS
 * Uses RelayerClient for gasless transactions (signed via Privy)
 */

import { ethers } from 'ethers';
import { logger } from '../../../config/logger';
import { privyConfig } from '../../privy/privy.config';
import { getUserByPrivyId } from '../../privy/user.service';
import { pool, getDatabaseConfig } from '../../../config/database';

// Cache for RelayerClient instances
const relayerClientCache = new Map<string, { relayerClient: any; wallet: any; builderConfig: any }>();

/**
 * Withdrawal request interface
 */
export interface WithdrawalRequest {
  privyUserId: string;
  toAddress: string;
  amountUsdc: string; // Amount in USDC (e.g., "10.5")
}

/**
 * Withdrawal result interface
 */
export interface WithdrawalResult {
  success: boolean;
  transactionHash?: string;
  fromAddress?: string;
  toAddress?: string;
  amountUsdc?: string;
  error?: string;
}

/**
 * Get or create RelayerClient for withdrawal transfers
 */
async function getRelayerClientForWithdrawal(privyUserId: string): Promise<any> {
  const cached = relayerClientCache.get(privyUserId);
  if (cached) {
    return cached.relayerClient;
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user || !user.proxyWalletAddress) {
    throw new Error('User not found or no proxy wallet deployed');
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
 * Validate Ethereum address
 */
function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Withdraw USDC.e from proxy wallet to specified address
 * @param request - Withdrawal request containing user ID, destination address, and amount
 * @returns Withdrawal result with transaction hash or error
 */
export async function withdrawUsdc(request: WithdrawalRequest): Promise<WithdrawalResult> {
  const { privyUserId, toAddress, amountUsdc } = request;

  try {
    // Validate destination address
    if (!isValidEthereumAddress(toAddress)) {
      return {
        success: false,
        error: 'Invalid destination address format',
      };
    }

    // Parse and validate amount
    const amount = parseFloat(amountUsdc);
    if (isNaN(amount) || amount <= 0) {
      return {
        success: false,
        error: 'Amount must be a positive number',
      };
    }

    // Get user and verify proxy wallet exists
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return {
        success: false,
        error: 'User not found',
      };
    }

    if (!user.proxyWalletAddress) {
      return {
        success: false,
        error: 'No proxy wallet deployed for this user',
      };
    }

    logger.info({
      message: 'Initiating USDC.e withdrawal',
      privyUserId,
      fromWallet: user.proxyWalletAddress,
      toAddress,
      amountUsdc,
    });

    // Get RelayerClient
    const relayerClient = await getRelayerClientForWithdrawal(privyUserId);

    // Encode USDC transfer
    // USDC uses 6 decimals
    const amountWei = ethers.utils.parseUnits(amount.toFixed(6), 6);

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
      args: [toAddress as `0x${string}`, BigInt(amountWei.toString())]
    });

    const transaction = {
      to: privyConfig.contracts.usdc,
      data: transferData,
      value: '0',
    };

    // Execute via RelayerClient (gasless)
    logger.info({
      message: 'Executing withdrawal via RelayerClient',
      privyUserId,
      toAddress,
      amountUsdc,
      usdcContract: privyConfig.contracts.usdc,
    });

    const response = await relayerClient.execute(
      [transaction],
      `Withdrawal: ${amountUsdc} USDC.e to ${toAddress}`
    );

    const result = await response.wait();

    if (!result || !result.transactionHash) {
      throw new Error('Withdrawal transaction failed - no transaction hash received');
    }

    logger.info({
      message: 'USDC.e withdrawal successful',
      privyUserId,
      fromWallet: user.proxyWalletAddress,
      toAddress,
      amountUsdc,
      txHash: result.transactionHash,
    });

    // Log withdrawal to database
    await logWithdrawal({
      privyUserId,
      fromAddress: user.proxyWalletAddress,
      toAddress,
      amountUsdc,
      transactionHash: result.transactionHash,
      status: 'SUCCESS',
    });

    return {
      success: true,
      transactionHash: result.transactionHash,
      fromAddress: user.proxyWalletAddress,
      toAddress,
      amountUsdc,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({
      message: 'USDC.e withdrawal failed',
      privyUserId,
      toAddress,
      amountUsdc,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Log failed withdrawal attempt
    const user = await getUserByPrivyId(privyUserId).catch(() => null);
    if (user?.proxyWalletAddress) {
      await logWithdrawal({
        privyUserId,
        fromAddress: user.proxyWalletAddress,
        toAddress,
        amountUsdc,
        status: 'FAILED',
        error: errorMessage,
      }).catch((logError) => {
        logger.error({
          message: 'Failed to log withdrawal failure',
          error: logError instanceof Error ? logError.message : String(logError),
        });
      });
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Log withdrawal to database
 */
interface WithdrawalLogEntry {
  privyUserId: string;
  fromAddress: string;
  toAddress: string;
  amountUsdc: string;
  transactionHash?: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  error?: string;
}

async function logWithdrawal(entry: WithdrawalLogEntry): Promise<void> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    // Skip logging in non-postgres mode
    return;
  }

  try {
    await pool.query(
      `INSERT INTO withdrawals (privy_user_id, from_address, to_address, amount_usdc, transaction_hash, status, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        entry.privyUserId,
        entry.fromAddress.toLowerCase(),
        entry.toAddress.toLowerCase(),
        entry.amountUsdc,
        entry.transactionHash || null,
        entry.status,
        entry.error || null,
      ]
    );
  } catch (error) {
    // Table might not exist, log warning but don't fail
    logger.warn({
      message: 'Failed to log withdrawal to database (table may not exist)',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get withdrawal history for a user
 */
export async function getWithdrawalHistory(privyUserId: string, limit: number = 50): Promise<any[]> {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    return [];
  }

  try {
    const result = await pool.query(
      `SELECT id, from_address, to_address, amount_usdc, transaction_hash, status, error, created_at
       FROM withdrawals
       WHERE privy_user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [privyUserId, limit]
    );

    return result.rows.map(row => ({
      id: row.id,
      fromAddress: row.from_address,
      toAddress: row.to_address,
      amountUsdc: row.amount_usdc,
      transactionHash: row.transaction_hash,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
    }));
  } catch (error) {
    logger.warn({
      message: 'Failed to get withdrawal history (table may not exist)',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
