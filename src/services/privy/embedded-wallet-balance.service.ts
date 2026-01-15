/**
 * Embedded Wallet Balance Service
 * Monitors USDC balance in embedded wallets to detect MoonPay purchases
 * Uses Alchemy webhooks for real-time balance detection (no polling)
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import { getUserByPrivyId } from './user.service';
import { EventEmitter } from 'events';
import { alchemyWebhookService } from '../alchemy/alchemy-webhook.service';

// USDC contract addresses on Polygon
// Native USDC (newer, used by MoonPay and most services)
const USDC_NATIVE_CONTRACT_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// USDC.e (bridged, legacy)
const USDC_E_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
// Use native USDC as primary (MoonPay deposits here)
const USDC_CONTRACT_ADDRESS = USDC_NATIVE_CONTRACT_ADDRESS;
const USDC_DECIMALS = 6; // Both USDC and USDC.e use 6 decimals

export interface EmbeddedBalanceUpdate {
  privyUserId: string;
  embeddedWalletAddress: string;
  previousBalance: string;
  newBalance: string;
  previousHumanBalance: string;
  newHumanBalance: string;
  balanceIncrease: string;
  humanBalanceIncrease: string;
  timestamp: Date;
}

interface WatchedEmbeddedWallet {
  privyUserId: string;
  embeddedWalletAddress: string;
  lastKnownBalance: bigint;
  listeners: Set<(update: EmbeddedBalanceUpdate) => void>;
  lastCheckedAt: Date;
}

class EmbeddedWalletBalanceService extends EventEmitter {
  private watchedWallets: Map<string, WatchedEmbeddedWallet> = new Map();
  private alchemyApiKey: string | null = null;
  private webhookListener: ((data: any) => void) | null = null;

  constructor() {
    super();
    this.alchemyApiKey = process.env.ALCHEMY_API_KEY || null;
  }

  /**
   * Initialize the service
   * Sets up webhook listener for embedded wallet balance changes
   */
  async initialize(): Promise<void> {
    if (!this.alchemyApiKey) {
      logger.warn({
        message: 'ALCHEMY_API_KEY not configured - embedded wallet balance monitoring may be limited',
      });
    }

    // Listen to Alchemy webhook events for embedded wallet balance changes
    this.webhookListener = (data: any) => {
      this.handleWebhookBalanceChange(data).catch((error) => {
        logger.error({
          message: 'Error handling webhook balance change',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    alchemyWebhookService.on('embeddedWalletBalanceChange', this.webhookListener);

    // Sync all existing embedded wallets to Alchemy webhook
    await this.syncAllEmbeddedWalletsToWebhook();

    logger.info({
      message: 'Embedded wallet balance service initialized (using Alchemy webhooks)',
    });
  }

  /**
   * Handle balance change from Alchemy webhook
   */
  private async handleWebhookBalanceChange(data: {
    privyUserId: string;
    embeddedWalletAddress: string;
    previousBalance: string;
    newBalance: string;
    previousHumanBalance: string;
    newHumanBalance: string;
    balanceIncrease: string;
    humanBalanceIncrease: string;
    timestamp: Date;
    txHash: string;
    blockNumber: number;
    tokenType: string;
  }): Promise<void> {
    const {
      privyUserId,
      embeddedWalletAddress,
      previousBalance,
      newBalance,
      previousHumanBalance,
      newHumanBalance,
      balanceIncrease,
      humanBalanceIncrease,
      timestamp,
    } = data;

    // Only emit if balance actually increased (deposit detected)
    if (BigInt(balanceIncrease) > BigInt(0)) {
      const normalizedAddress = embeddedWalletAddress.toLowerCase();
      const key = `${privyUserId}:${normalizedAddress}`;

      // Update last known balance
      const watched = this.watchedWallets.get(key);
      if (watched) {
        watched.lastKnownBalance = BigInt(newBalance);
        watched.lastCheckedAt = timestamp;
      }

      // Create balance update event
      const update: EmbeddedBalanceUpdate = {
        privyUserId,
        embeddedWalletAddress: normalizedAddress,
        previousBalance,
        newBalance,
        previousHumanBalance,
        newHumanBalance,
        balanceIncrease,
        humanBalanceIncrease,
        timestamp,
      };

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 4: EmbeddedWalletBalanceService received balance change',
        flowStep: 'BALANCE_SERVICE_RECEIVED',
        privyUserId,
        embeddedWalletAddress: normalizedAddress,
        previousBalance: previousHumanBalance + ' USDC',
        newBalance: newHumanBalance + ' USDC',
        increase: humanBalanceIncrease + ' USDC',
        txHash: data.txHash,
        tokenType: data.tokenType,
      });

      // Emit balance increase event for auto-transfer service
      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 5: Emitting balanceIncrease event to AutoTransferService',
        flowStep: 'EMITTING_TO_AUTO_TRANSFER',
        privyUserId,
        balanceIncrease: humanBalanceIncrease + ' USDC',
      });
      
      this.emit('balanceIncrease', update);
    } else {
      logger.debug({
        message: '[AUTO-TRANSFER-FLOW] Balance change received but no increase (withdrawal or zero change)',
        flowStep: 'NO_BALANCE_INCREASE',
        privyUserId,
        embeddedWalletAddress,
        balanceIncrease,
      });
    }
  }

  /**
   * Sync all existing embedded wallets to Alchemy webhook
   */
  private async syncAllEmbeddedWalletsToWebhook(): Promise<void> {
    try {
      const result = await pool.query(`
        SELECT privy_user_id, embedded_wallet_address 
        FROM users 
        WHERE embedded_wallet_address IS NOT NULL
      `);

      const addresses = result.rows
        .map(row => row.embedded_wallet_address)
        .filter(addr => addr); // Filter out nulls

      if (addresses.length > 0) {
        // Add all embedded wallets to Alchemy webhook
        for (const row of result.rows) {
          if (row.embedded_wallet_address) {
            await alchemyWebhookService.addEmbeddedWalletAddress(
              row.embedded_wallet_address,
              row.privy_user_id
            );
          }
        }

        logger.info({
          message: 'Synced all embedded wallets to Alchemy webhook',
          addressCount: addresses.length,
        });
      }
    } catch (error) {
      logger.error({
        message: 'Failed to sync embedded wallets to Alchemy webhook',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Watch an embedded wallet for balance changes
   * Adds wallet to Alchemy webhook monitoring
   */
  async watchEmbeddedWallet(
    privyUserId: string,
    embeddedWalletAddress: string
  ): Promise<void> {
    const normalizedAddress = embeddedWalletAddress.toLowerCase();
    const key = `${privyUserId}:${normalizedAddress}`;

    // Check if already watching
    if (this.watchedWallets.has(key)) {
      logger.debug({
        message: 'Embedded wallet already being watched',
        privyUserId,
        embeddedWalletAddress: normalizedAddress,
      });
      return;
    }

    // Get initial balance
    const initialBalance = await this.getEmbeddedWalletBalance(embeddedWalletAddress);
    const lastKnownBalance = BigInt(initialBalance.balanceRaw || '0');

    // Store watched wallet
    this.watchedWallets.set(key, {
      privyUserId,
      embeddedWalletAddress: normalizedAddress,
      lastKnownBalance,
      listeners: new Set(),
      lastCheckedAt: new Date(),
    });

    // Store balance in database
    await this.updateBalanceInDatabase(
      privyUserId,
      embeddedWalletAddress,
      initialBalance.balanceRaw,
      initialBalance.balanceHuman
    );

    // Add to Alchemy webhook for real-time monitoring
    await alchemyWebhookService.addEmbeddedWalletAddress(
      embeddedWalletAddress,
      privyUserId
    );

    logger.info({
      message: 'Started watching embedded wallet (via Alchemy webhook)',
      privyUserId,
      embeddedWalletAddress: normalizedAddress,
      initialBalance: initialBalance.balanceHuman,
    });
  }

  /**
   * Stop watching an embedded wallet
   */
  unwatchEmbeddedWallet(privyUserId: string, embeddedWalletAddress: string): void {
    const normalizedAddress = embeddedWalletAddress.toLowerCase();
    const key = `${privyUserId}:${normalizedAddress}`;

    if (this.watchedWallets.delete(key)) {
      logger.info({
        message: 'Stopped watching embedded wallet',
        privyUserId,
        embeddedWalletAddress: normalizedAddress,
      });
    }
  }

  /**
   * Subscribe to balance change events for a specific embedded wallet
   */
  subscribeToBalanceChanges(
    privyUserId: string,
    embeddedWalletAddress: string,
    listener: (update: EmbeddedBalanceUpdate) => void
  ): () => void {
    const normalizedAddress = embeddedWalletAddress.toLowerCase();
    const key = `${privyUserId}:${normalizedAddress}`;

    let watched = this.watchedWallets.get(key);
    if (!watched) {
      // Auto-watch if not already watching
      this.watchEmbeddedWallet(privyUserId, embeddedWalletAddress).catch((error) => {
        logger.error({
          message: 'Failed to auto-watch embedded wallet',
          privyUserId,
          embeddedWalletAddress: normalizedAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      watched = this.watchedWallets.get(key);
      if (!watched) {
        throw new Error('Failed to watch embedded wallet');
      }
    }

    watched.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      const w = this.watchedWallets.get(key);
      if (w) {
        w.listeners.delete(listener);
        if (w.listeners.size === 0) {
          // Optionally unwatch if no listeners (keep watching for now)
        }
      }
    };
  }

  /**
   * Get current USDC balance for an embedded wallet
   */
  async getEmbeddedWalletBalance(
    embeddedWalletAddress: string
  ): Promise<{ balanceRaw: string; balanceHuman: string }> {
    // Use Alchemy API if available, otherwise use RPC provider
    if (this.alchemyApiKey) {
      try {
        return await this.fetchBalanceFromAlchemy(embeddedWalletAddress);
      } catch (error) {
        logger.warn({
          message: 'Failed to fetch balance from Alchemy, falling back to RPC',
          embeddedWalletAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback to RPC provider
    return await this.fetchBalanceFromRpc(embeddedWalletAddress);
  }

  /**
   * Fetch balance from Alchemy API
   * Checks both Native USDC and USDC.e to handle all cases
   */
  private async fetchBalanceFromAlchemy(
    address: string
  ): Promise<{ balanceRaw: string; balanceHuman: string }> {
    if (!this.alchemyApiKey) {
      throw new Error('ALCHEMY_API_KEY not configured');
    }

    // Check both Native USDC (primary) and USDC.e (fallback)
    const response = await axios.post(
      `https://polygon-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`,
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getTokenBalances',
        params: [address, [USDC_NATIVE_CONTRACT_ADDRESS, USDC_E_CONTRACT_ADDRESS]],
      },
      {
        timeout: 10000,
      }
    );

    let balanceRaw = '0';
    let balanceHuman = '0';
    let totalBalance = BigInt(0);

    if (response.data?.result?.tokenBalances) {
      // Sum balances from both contracts
      for (const tokenBalance of response.data.result.tokenBalances) {
        if (tokenBalance.tokenBalance && tokenBalance.tokenBalance !== '0x') {
          const balanceBigInt = BigInt(tokenBalance.tokenBalance);
          totalBalance += balanceBigInt;
        }
      }
      
      if (totalBalance > 0) {
        balanceRaw = totalBalance.toString();
        balanceHuman = ethers.utils.formatUnits(totalBalance.toString(), USDC_DECIMALS);
      }
    }

    return { balanceRaw, balanceHuman };
  }

  /**
   * Fetch balance from RPC provider (fallback)
   * Checks both Native USDC and USDC.e to handle all cases
   */
  private async fetchBalanceFromRpc(
    address: string
  ): Promise<{ balanceRaw: string; balanceHuman: string }> {
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

    const usdcAbi = [
      'function balanceOf(address owner) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ];

    let totalBalance = BigInt(0);

    try {
      // Check Native USDC (primary - MoonPay deposits here)
      const usdcNativeContract = new ethers.Contract(USDC_NATIVE_CONTRACT_ADDRESS, usdcAbi, provider);
      const balanceNative = await usdcNativeContract.balanceOf(address);
      totalBalance += BigInt(balanceNative.toString());

      // Check USDC.e (bridged - legacy)
      const usdcEContract = new ethers.Contract(USDC_E_CONTRACT_ADDRESS, usdcAbi, provider);
      const balanceE = await usdcEContract.balanceOf(address);
      totalBalance += BigInt(balanceE.toString());

      const balanceRaw = totalBalance.toString();
      const balanceHuman = ethers.utils.formatUnits(totalBalance, USDC_DECIMALS);

      return { balanceRaw, balanceHuman };
    } catch (error) {
      logger.error({
        message: 'Failed to fetch balance from RPC',
        address,
        error: error instanceof Error ? error.message : String(error),
      });
      return { balanceRaw: '0', balanceHuman: '0' };
    }
  }


  /**
   * Update balance in database
   */
  private async updateBalanceInDatabase(
    privyUserId: string,
    embeddedWalletAddress: string,
    balanceRaw: string,
    balanceHuman: string
  ): Promise<void> {
    const client = await pool.connect();

    try {
      // Update embedded_wallet_balances table
      await client.query(
        `INSERT INTO embedded_wallet_balances (
          privy_user_id, embedded_wallet_address, balance_raw, balance_human, last_updated_at
        ) VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (privy_user_id) DO UPDATE SET
          balance_raw = $3,
          balance_human = $4,
          last_updated_at = NOW(),
          embedded_wallet_address = $2`,
        [privyUserId, embeddedWalletAddress.toLowerCase(), balanceRaw, balanceHuman]
      );

      // Also update users table for quick access
      await client.query(
        `UPDATE users SET
          embedded_wallet_balance_raw = $1,
          embedded_wallet_balance_human = $2,
          embedded_balance_last_updated = NOW()
        WHERE privy_user_id = $3`,
        [balanceRaw, balanceHuman, privyUserId]
      );
    } catch (error) {
      logger.error({
        message: 'Failed to update embedded wallet balance in database',
        privyUserId,
        embeddedWalletAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - balance tracking shouldn't break the app
    } finally {
      client.release();
    }
  }

  /**
   * Get balance from database only (no API call)
   */
  async getBalanceFromDatabase(privyUserId: string): Promise<{
    balanceRaw: string;
    balanceHuman: string;
  } | null> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT balance_raw, balance_human FROM embedded_wallet_balances
         WHERE privy_user_id = $1`,
        [privyUserId]
      );

      if (result.rows.length === 0) return null;

      return {
        balanceRaw: result.rows[0].balance_raw,
        balanceHuman: result.rows[0].balance_human.toString(),
      };
    } finally {
      client.release();
    }
  }

  /**
   * Cleanup and disconnect
   */
  async disconnect(): Promise<void> {
    // Remove webhook listener
    if (this.webhookListener) {
      alchemyWebhookService.off('embeddedWalletBalanceChange', this.webhookListener);
      this.webhookListener = null;
    }

    this.watchedWallets.clear();
    logger.info({ message: 'Embedded wallet balance service disconnected' });
  }
}

// Export singleton instance
export const embeddedWalletBalanceService = new EmbeddedWalletBalanceService();

