/**
 * Auto-Transfer Service
 * Automatically transfers USDC from embedded wallet to proxy wallet when deposits are detected
 * Listens to balance increase events from embedded wallet balance service
 */

import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getUserByPrivyId } from './user.service';
import { embeddedWalletBalanceService, EmbeddedBalanceUpdate } from './embedded-wallet-balance.service';
import { transferFromEmbeddedToProxy, TransferRequest } from './embedded-to-proxy-transfer.service';

class AutoTransferService {
  private isInitialized: boolean = false;
  private balanceIncreaseListener: ((update: EmbeddedBalanceUpdate) => void) | null = null;

  /**
   * Initialize the auto-transfer service
   * Sets up listener for balance increase events
   */
  initialize(): void {
    if (this.isInitialized) {
      logger.warn({
        message: 'Auto-transfer service already initialized',
      });
      return;
    }

    logger.info({
      message: 'Initializing auto-transfer service',
    });

    // Set up listener for balance increase events
    this.balanceIncreaseListener = async (update: EmbeddedBalanceUpdate) => {
      await this.handleBalanceIncrease(update);
    };

    embeddedWalletBalanceService.on('balanceIncrease', this.balanceIncreaseListener);

    this.isInitialized = true;
    logger.info({
      message: 'Auto-transfer service initialized successfully',
    });
  }

  /**
   * Handle balance increase event - check if auto-transfer should be triggered
   */
  private async handleBalanceIncrease(update: EmbeddedBalanceUpdate): Promise<void> {
    const { privyUserId, humanBalanceIncrease, embeddedWalletAddress } = update;

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Step 6: AutoTransferService received balanceIncrease event',
      flowStep: 'AUTO_TRANSFER_RECEIVED',
      privyUserId,
      embeddedWalletAddress,
      balanceIncrease: humanBalanceIncrease + ' USDC',
    });

    try {
      // Get user's auto-transfer preferences from database
      const autoTransferConfig = await this.getAutoTransferConfig(privyUserId);

      if (!autoTransferConfig) {
        // User not found or no preferences set - skip
        logger.warn({
          message: '[AUTO-TRANSFER-FLOW] BLOCKED: User not found in database',
          flowStep: 'BLOCKED_USER_NOT_FOUND',
          privyUserId,
          reason: 'User record not found or no auto-transfer preferences',
        });
        return;
      }

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 7: Checking auto-transfer configuration',
        flowStep: 'CHECKING_CONFIG',
        privyUserId,
        autoTransferEnabled: autoTransferConfig.enabled,
        minAmount: autoTransferConfig.minAmount,
      });

      if (!autoTransferConfig.enabled) {
        // Auto-transfer disabled for this user
        logger.warn({
          message: '[AUTO-TRANSFER-FLOW] BLOCKED: Auto-transfer disabled for user',
          flowStep: 'BLOCKED_DISABLED',
          privyUserId,
          reason: 'auto_transfer_enabled = false in database',
        });
        return;
      }

      // Check if user has a proxy wallet
      const user = await getUserByPrivyId(privyUserId);
      if (!user || !user.proxyWalletAddress) {
        logger.warn({
          message: '[AUTO-TRANSFER-FLOW] BLOCKED: User has no proxy wallet',
          flowStep: 'BLOCKED_NO_PROXY_WALLET',
          privyUserId,
          hasUser: !!user,
          hasProxyWallet: !!user?.proxyWalletAddress,
          reason: 'Cannot transfer without a proxy wallet destination',
        });
        return;
      }

      // Check minimum amount threshold
      const balanceIncreaseAmount = parseFloat(humanBalanceIncrease);
      if (autoTransferConfig.minAmount > 0 && balanceIncreaseAmount < autoTransferConfig.minAmount) {
        logger.warn({
          message: '[AUTO-TRANSFER-FLOW] BLOCKED: Balance increase below minimum threshold',
          flowStep: 'BLOCKED_BELOW_MINIMUM',
          privyUserId,
          balanceIncrease: balanceIncreaseAmount,
          minAmount: autoTransferConfig.minAmount,
          reason: `Deposit ${balanceIncreaseAmount} USDC is less than minimum ${autoTransferConfig.minAmount} USDC`,
        });
        return;
      }

      // All checks passed - execute auto-transfer
      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 8: All checks passed - INITIATING TRANSFER',
        flowStep: 'INITIATING_TRANSFER',
        privyUserId,
        embeddedWalletAddress: user.embeddedWalletAddress,
        proxyWalletAddress: user.proxyWalletAddress,
        balanceIncrease: balanceIncreaseAmount + ' USDC',
        minAmount: autoTransferConfig.minAmount,
      });

      // Transfer the entire current balance (not just the increase, in case previous transfers failed)
      const transferRequest: TransferRequest = {
        privyUserId,
        // Don't specify amount - transfer all available balance
      };

      const result = await transferFromEmbeddedToProxy(transferRequest);

      if (result.success) {
        logger.info({
          message: '[AUTO-TRANSFER-FLOW] ✅ SUCCESS: Auto-transfer completed successfully!',
          flowStep: 'TRANSFER_SUCCESS',
          privyUserId,
          transactionHash: result.transactionHash,
          amountTransferred: result.amountUsdc + ' USDC',
          fromAddress: result.fromAddress,
          toAddress: result.toAddress,
        });
      } else {
        logger.error({
          message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: Auto-transfer failed',
          flowStep: 'TRANSFER_FAILED',
          privyUserId,
          error: result.error,
          fromAddress: result.fromAddress,
          toAddress: result.toAddress,
        });
      }
    } catch (error) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ ERROR: Exception during auto-transfer',
        flowStep: 'TRANSFER_EXCEPTION',
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  /**
   * Get auto-transfer configuration for a user
   */
  private async getAutoTransferConfig(
    privyUserId: string
  ): Promise<{ enabled: boolean; minAmount: number } | null> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT auto_transfer_enabled, auto_transfer_min_amount FROM users
         WHERE privy_user_id = $1`,
        [privyUserId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      return {
        enabled: row.auto_transfer_enabled || false,
        minAmount: parseFloat(row.auto_transfer_min_amount || '0'),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Cleanup and disconnect
   */
  shutdown(): void {
    if (this.balanceIncreaseListener) {
      embeddedWalletBalanceService.off('balanceIncrease', this.balanceIncreaseListener);
      this.balanceIncreaseListener = null;
    }

    this.isInitialized = false;
    logger.info({
      message: 'Auto-transfer service shut down',
    });
  }
}

// Export singleton instance
export const autoTransferService = new AutoTransferService();

