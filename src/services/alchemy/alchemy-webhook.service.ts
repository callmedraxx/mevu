/**
 * Alchemy Webhook Service
 * Manages Alchemy Notify webhooks for USDC.e balance tracking on Polygon
 * Provides real-time deposit notifications to frontend via SSE
 */

import axios from 'axios';
import crypto from 'crypto';
import { pool } from '../../config/database';
import { logger } from '../../config/logger';
import { EventEmitter } from 'events';

// Alchemy API configuration
const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const POLYGON_NETWORK = 'MATIC_MAINNET'; // Polygon mainnet network ID for Alchemy

// USDC Contract Addresses on Polygon
const USDC_E_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged)
const USDC_NATIVE_CONTRACT_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC (MoonPay deposits here)

// Keep backwards compatibility
const USDC_CONTRACT_ADDRESS = USDC_E_CONTRACT_ADDRESS;

// Environment variables
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN; // Auth token from Alchemy dashboard
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID; // Existing webhook ID (optional)
const ALCHEMY_SIGNING_KEY = process.env.ALCHEMY_SIGNING_KEY; // Webhook signing key for verification
const WEBHOOK_URL = process.env.ALCHEMY_WEBHOOK_URL; // Your server's webhook endpoint

/**
 * Alchemy Webhook Payload format (from actual webhook)
 */
interface AlchemyWebhookPayload {
  webhookId: string;
  id: string;
  createdAt: string;
  type: 'ADDRESS_ACTIVITY';
  event: {
    network: string;
    activity: AlchemyActivity[];
  };
}

interface AlchemyActivity {
  blockNum: string; // Hex string like "0xdf34a3"
  hash: string; // Transaction hash
  fromAddress: string;
  toAddress: string;
  value: number; // Decimal value (e.g., 293.092129)
  asset: string; // "USDC", "ETH", etc.
  category: 'token' | 'erc20' | 'erc721' | 'erc1155' | 'external' | 'internal';
  erc1155Metadata: any;
  erc721TokenId: string | null;
  typeTraceAddress: string | null;
  rawContract: {
    rawValue: string; // Hex value like "0x0000...11783b21"
    address: string; // Contract address
    decimals: number; // Token decimals (6 for USDC)
  };
  log?: {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
    transactionIndex: string;
    blockHash: string;
    logIndex: string;
    removed: boolean;
  };
}

/**
 * Balance change notification sent to frontend
 */
export interface BalanceNotification {
  type: 'deposit' | 'withdrawal' | 'balance_update';
  privyUserId: string;
  proxyWalletAddress: string;
  amount: string; // Human-readable amount
  amountRaw: string; // Raw amount
  fromAddress: string;
  toAddress: string;
  txHash: string;
  blockNumber: number;
  timestamp: string;
  newBalance: string; // Updated balance after transfer
  previousBalance?: string;
}

// Keep backwards compatibility
export type DepositNotification = BalanceNotification;

/**
 * Listener for balance change notifications
 */
type BalanceListener = (notification: BalanceNotification) => void;
type DepositListener = BalanceListener; // Alias for backwards compatibility

class AlchemyWebhookService extends EventEmitter {
  private webhookId: string | null = null;
  private isInitialized: boolean = false;
  private depositListeners: Map<string, Set<DepositListener>> = new Map(); // privyUserId -> listeners

  constructor() {
    super();
  }

  /**
   * Subscribe to deposit notifications for a specific user
   * Returns an unsubscribe function
   */
  subscribeToDeposits(privyUserId: string, listener: DepositListener): () => void {
    if (!this.depositListeners.has(privyUserId)) {
      this.depositListeners.set(privyUserId, new Set());
    }
    this.depositListeners.get(privyUserId)!.add(listener);

    logger.info({
      message: 'User subscribed to deposit notifications',
      privyUserId,
      listenerCount: this.depositListeners.get(privyUserId)!.size,
    });

    // Return unsubscribe function
    return () => {
      const listeners = this.depositListeners.get(privyUserId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.depositListeners.delete(privyUserId);
        }
      }
      logger.info({
        message: 'User unsubscribed from deposit notifications',
        privyUserId,
      });
    };
  }

  /**
   * Notify listeners about a deposit
   */
  private notifyDeposit(notification: DepositNotification): void {
    // Emit global event
    this.emit('deposit', notification);

    // Notify specific user listeners
    const listeners = this.depositListeners.get(notification.privyUserId);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(notification);
        } catch (error) {
          logger.error({
            message: 'Error in deposit listener',
            privyUserId: notification.privyUserId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }

  /**
   * Initialize the webhook service
   */
  async initialize(): Promise<void> {
    if (!ALCHEMY_AUTH_TOKEN) {
      logger.warn({
        message: 'ALCHEMY_AUTH_TOKEN not set, webhook service disabled',
      });
      return;
    }

    try {
      // Check if we have an existing webhook
      if (ALCHEMY_WEBHOOK_ID) {
        this.webhookId = ALCHEMY_WEBHOOK_ID;
        logger.info({
          message: 'Using existing Alchemy webhook',
          webhookId: this.webhookId,
        });
      } else if (WEBHOOK_URL) {
        // Create a new webhook
        await this.createWebhook();
      } else {
        logger.warn({
          message: 'ALCHEMY_WEBHOOK_URL not set, cannot create webhook',
        });
        return;
      }

      // Sync all existing user addresses to the webhook
      await this.syncAllAddresses();
      
      this.isInitialized = true;
      logger.info({
        message: 'Alchemy webhook service initialized',
        webhookId: this.webhookId,
      });
    } catch (error) {
      logger.error({
        message: 'Failed to initialize Alchemy webhook service',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create a new Address Activity webhook
   */
  private async createWebhook(): Promise<void> {
    try {
      const response = await axios.post(
        `${ALCHEMY_API_URL}/create-webhook`,
        {
          network: POLYGON_NETWORK,
          webhook_type: 'ADDRESS_ACTIVITY',
          webhook_url: WEBHOOK_URL,
          addresses: [], // Start empty, add addresses later
        },
        {
          headers: {
            'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );

      this.webhookId = response.data.data.id;
      logger.info({
        message: 'Created Alchemy webhook',
        webhookId: this.webhookId,
        webhookUrl: WEBHOOK_URL,
      });
    } catch (error: any) {
      logger.error({
        message: 'Failed to create Alchemy webhook',
        error: error.response?.data || error.message,
      });
      throw error;
    }
  }

  /**
   * Add addresses to the webhook
   */
  async addAddresses(addresses: string[]): Promise<void> {
    if (!this.webhookId || !ALCHEMY_AUTH_TOKEN) {
      logger.warn({
        message: 'Webhook not configured, skipping address addition',
        addressCount: addresses.length,
      });
      return;
    }

    if (addresses.length === 0) return;

    try {
      // Alchemy API allows batch updates
      await axios.patch(
        `${ALCHEMY_API_URL}/update-webhook-addresses`,
        {
          webhook_id: this.webhookId,
          addresses_to_add: addresses.map(a => a.toLowerCase()),
          addresses_to_remove: [],
        },
        {
          headers: {
            'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info({
        message: 'Added addresses to Alchemy webhook',
        webhookId: this.webhookId,
        addressCount: addresses.length,
      });
    } catch (error: any) {
      logger.error({
        message: 'Failed to add addresses to Alchemy webhook',
        error: error.name || 'Error',
        errorMessage: error.message,
        statusCode: error.response?.status,
        responseData: error.response?.data,
        errorCode: error.code, // Network errors have a code like ECONNREFUSED, ENOTFOUND
        webhookId: this.webhookId,
        addresses: addresses.slice(0, 5), // Log first 5 for debugging
      });
    }
  }

  /**
   * Remove addresses from the webhook
   */
  async removeAddresses(addresses: string[]): Promise<void> {
    if (!this.webhookId || !ALCHEMY_AUTH_TOKEN) return;
    if (addresses.length === 0) return;

    try {
      await axios.patch(
        `${ALCHEMY_API_URL}/update-webhook-addresses`,
        {
          webhook_id: this.webhookId,
          addresses_to_add: [],
          addresses_to_remove: addresses.map(a => a.toLowerCase()),
        },
        {
          headers: {
            'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );

      logger.info({
        message: 'Removed addresses from Alchemy webhook',
        webhookId: this.webhookId,
        addressCount: addresses.length,
      });
    } catch (error: any) {
      logger.error({
        message: 'Failed to remove addresses from Alchemy webhook',
        error: error.response?.data || error.message,
      });
    }
  }

  /**
   * Sync all existing user proxy wallet addresses to the webhook
   */
  async syncAllAddresses(): Promise<void> {
    if (!this.webhookId) return;

    try {
      const result = await pool.query(`
        SELECT proxy_wallet_address 
        FROM users 
        WHERE proxy_wallet_address IS NOT NULL
      `);

      const addresses = result.rows.map(row => row.proxy_wallet_address);
      
      if (addresses.length > 0) {
        await this.addAddresses(addresses);
        logger.info({
          message: 'Synced all user addresses to Alchemy webhook',
          addressCount: addresses.length,
        });
      }
    } catch (error) {
      logger.error({
        message: 'Failed to sync addresses to Alchemy webhook',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Verify webhook signature
   */
  verifySignature(body: string, signature: string): boolean {
    if (!ALCHEMY_SIGNING_KEY) {
      logger.warn({
        message: 'ALCHEMY_SIGNING_KEY not set, skipping signature verification',
      });
      return true; // Allow if no signing key configured
    }

    const hmac = crypto.createHmac('sha256', ALCHEMY_SIGNING_KEY);
    hmac.update(body, 'utf8');
    const digest = hmac.digest('hex');
    
    return signature === digest;
  }

  /**
   * Process webhook payload and update balances
   */
  async processWebhook(payload: AlchemyWebhookPayload): Promise<void> {
    const { event } = payload;
    
    if (!event?.activity) {
      logger.warn({
        message: 'Webhook payload missing activity data',
        webhookId: payload.webhookId,
      });
      return;
    }

    for (const activity of event.activity) {
      const contractAddress = activity.rawContract?.address?.toLowerCase();
      
      // Process both USDC.e and Native USDC transfers
      const isUsdcE = contractAddress === USDC_E_CONTRACT_ADDRESS.toLowerCase();
      const isUsdcNative = contractAddress === USDC_NATIVE_CONTRACT_ADDRESS.toLowerCase();
      
      if (!isUsdcE && !isUsdcNative) {
        continue;
      }

      const tokenType = isUsdcE ? 'USDC.e' : 'Native USDC';
      const fromAddress = activity.fromAddress?.toLowerCase();
      const toAddress = activity.toAddress?.toLowerCase();
      const rawValue = activity.rawContract?.rawValue || '0';
      const value = parseInt(rawValue, 16); // Convert hex to decimal
      const txHash = activity.hash;
      const blockNumber = parseInt(activity.blockNum, 16);

      logger.info({
        message: `[AUTO-TRANSFER-FLOW] Step 1: Alchemy webhook received ${tokenType} transfer`,
        flowStep: 'WEBHOOK_RECEIVED',
        tokenType,
        fromAddress,
        toAddress,
        valueRaw: value,
        valueHuman: (value / 1e6).toFixed(6) + ' USDC',
        txHash,
        blockNumber,
        contractAddress,
      });

      // Update balance for recipient (incoming transfer)
      if (toAddress) {
        await this.updateBalanceForAddress(toAddress, 'in', value, txHash, blockNumber, fromAddress, tokenType);
      }

      // Update balance for sender (outgoing transfer)
      if (fromAddress) {
        await this.updateBalanceForAddress(fromAddress, 'out', value, txHash, blockNumber, toAddress, tokenType);
      }
    }
  }

  /**
   * Update balance for an address after a transfer
   * Handles both proxy wallets and embedded wallets
   * Handles both USDC.e and Native USDC
   */
  private async updateBalanceForAddress(
    address: string,
    transferType: 'in' | 'out',
    amount: number,
    txHash: string,
    blockNumber: number,
    counterparty: string,
    tokenType: string = 'USDC.e'
  ): Promise<void> {
    const client = await pool.connect();
    
    try {
      // Check if this address belongs to one of our users (proxy wallet OR embedded wallet)
      const userResult = await client.query(
        `SELECT privy_user_id, proxy_wallet_address, embedded_wallet_address 
         FROM users 
         WHERE LOWER(proxy_wallet_address) = LOWER($1) 
            OR LOWER(embedded_wallet_address) = LOWER($1)`,
        [address]
      );

      if (userResult.rows.length === 0) {
        // Not one of our users, skip
        return;
      }

      const privyUserId = userResult.rows[0].privy_user_id;
      const isProxyWallet = userResult.rows[0].proxy_wallet_address?.toLowerCase() === address.toLowerCase();
      const isEmbeddedWallet = userResult.rows[0].embedded_wallet_address?.toLowerCase() === address.toLowerCase();

      // Get current balance using Alchemy's alchemy_getTokenBalances API
      // Fetch BOTH USDC.e and Native USDC balances
      const { ethers } = await import('ethers');
      const alchemyApiKey = process.env.ALCHEMY_API_KEY;
      const alchemyUrl = `https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`;
      
      const balanceResponse = await axios.post(alchemyUrl, {
        id: 1,
        jsonrpc: '2.0',
        method: 'alchemy_getTokenBalances',
        params: [address, [USDC_E_CONTRACT_ADDRESS, USDC_NATIVE_CONTRACT_ADDRESS]],
      });

      let usdceBalanceRaw = BigInt(0);
      let nativeBalanceRaw = BigInt(0);

      if (balanceResponse.data?.result?.tokenBalances) {
        for (const tokenBalance of balanceResponse.data.result.tokenBalances) {
          if (tokenBalance.tokenBalance && tokenBalance.tokenBalance !== '0x') {
            const balance = BigInt(tokenBalance.tokenBalance);
            if (tokenBalance.contractAddress?.toLowerCase() === USDC_E_CONTRACT_ADDRESS.toLowerCase()) {
              usdceBalanceRaw = balance;
            } else if (tokenBalance.contractAddress?.toLowerCase() === USDC_NATIVE_CONTRACT_ADDRESS.toLowerCase()) {
              nativeBalanceRaw = balance;
            }
          }
        }
      }

      // Total balance is sum of both USDC types
      const totalBalanceRaw = usdceBalanceRaw + nativeBalanceRaw;
      const totalBalanceHuman = ethers.utils.formatUnits(totalBalanceRaw.toString(), 6);

      logger.info({
        message: `[AUTO-TRANSFER-FLOW] Fetched USDC balances from Alchemy`,
        flowStep: 'BALANCE_FETCHED',
        address,
        walletType: isProxyWallet ? 'proxy' : 'embedded',
        tokenType,
        usdceBalance: ethers.utils.formatUnits(usdceBalanceRaw.toString(), 6),
        nativeBalance: ethers.utils.formatUnits(nativeBalanceRaw.toString(), 6),
        totalBalance: totalBalanceHuman,
      });

      await client.query('BEGIN');

      if (isProxyWallet) {
        // Update wallet_balances table for proxy wallets
        await client.query(
          `INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (proxy_wallet_address) 
           DO UPDATE SET 
             balance_raw = $3,
             balance_human = $4,
             last_updated_at = NOW()`,
          [address, privyUserId, totalBalanceRaw.toString(), totalBalanceHuman]
        );

        // Record the transfer
        const humanAmount = ethers.utils.formatUnits(amount.toString(), 6);
        await client.query(
          `INSERT INTO wallet_usdc_transfers 
           (proxy_wallet_address, privy_user_id, transfer_type, from_address, to_address, 
            amount_raw, amount_human, transaction_hash, block_number)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (transaction_hash, proxy_wallet_address) DO NOTHING`,
          [
            address,
            privyUserId,
            transferType,
            transferType === 'in' ? counterparty : address,
            transferType === 'out' ? counterparty : address,
            amount.toString(),
            humanAmount,
            txHash,
            blockNumber,
          ]
        );

        await client.query('COMMIT');

        logger.info({
          message: '[AUTO-TRANSFER-FLOW] Updated proxy wallet balance',
          flowStep: 'PROXY_BALANCE_UPDATED',
          privyUserId,
          proxyWalletAddress: address,
          transferType,
          tokenType,
          amount: humanAmount,
          newBalance: totalBalanceHuman,
          txHash,
        });

        // Emit notification for proxy wallet balance changes
        const notification: BalanceNotification = {
          type: transferType === 'in' ? 'deposit' : 'withdrawal',
          privyUserId,
          proxyWalletAddress: address,
          amount: ethers.utils.formatUnits(amount.toString(), 6),
          amountRaw: amount.toString(),
          fromAddress: transferType === 'in' ? counterparty : address,
          toAddress: transferType === 'out' ? counterparty : address,
          txHash,
          blockNumber,
          timestamp: new Date().toISOString(),
          newBalance: totalBalanceHuman,
        };

        this.notifyDeposit(notification);
      } else if (isEmbeddedWallet) {
        // Update embedded_wallet_balances table
        await client.query(
          `INSERT INTO embedded_wallet_balances (privy_user_id, embedded_wallet_address, balance_raw, balance_human, last_updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (privy_user_id) 
           DO UPDATE SET 
             balance_raw = $3,
             balance_human = $4,
             last_updated_at = NOW(),
             embedded_wallet_address = $2`,
          [privyUserId, address, totalBalanceRaw.toString(), totalBalanceHuman]
        );

        await client.query('COMMIT');

        logger.info({
          message: `[AUTO-TRANSFER-FLOW] Step 2: Embedded wallet balance updated - ${transferType === 'in' ? 'DEPOSIT DETECTED' : 'withdrawal'}`,
          flowStep: transferType === 'in' ? 'DEPOSIT_DETECTED' : 'WITHDRAWAL_DETECTED',
          privyUserId,
          embeddedWalletAddress: address,
          transferType,
          tokenType,
          amountHuman: ethers.utils.formatUnits(amount.toString(), 6) + ' USDC',
          newBalanceHuman: totalBalanceHuman + ' USDC',
          txHash,
          willTriggerAutoTransfer: transferType === 'in',
        });

        // Emit embedded wallet balance change event for auto-transfer service
        if (transferType === 'in') {
          logger.info({
            message: '[AUTO-TRANSFER-FLOW] Step 3: Emitting embeddedWalletBalanceChange event',
            flowStep: 'EMITTING_BALANCE_CHANGE_EVENT',
            privyUserId,
            embeddedWalletAddress: address,
            balanceIncrease: ethers.utils.formatUnits(amount.toString(), 6) + ' USDC',
            tokenType,
          });
        }
        
        this.emit('embeddedWalletBalanceChange', {
          privyUserId,
          embeddedWalletAddress: address,
          previousBalance: (totalBalanceRaw - BigInt(amount)).toString(),
          newBalance: totalBalanceRaw.toString(),
          previousHumanBalance: ethers.utils.formatUnits((totalBalanceRaw - BigInt(amount)).toString(), 6),
          newHumanBalance: totalBalanceHuman,
          balanceIncrease: transferType === 'in' ? amount.toString() : '0',
          humanBalanceIncrease: transferType === 'in' ? ethers.utils.formatUnits(amount.toString(), 6) : '0',
          timestamp: new Date(),
          txHash,
          blockNumber,
          tokenType,
        });
      }

      logger.info({
        message: `[AUTO-TRANSFER-FLOW] ${transferType === 'in' ? 'Deposit' : 'Withdrawal'} processed`,
        flowStep: 'TRANSFER_PROCESSED',
        privyUserId,
        walletType: isProxyWallet ? 'proxy' : 'embedded',
        tokenType,
        amount: ethers.utils.formatUnits(amount.toString(), 6),
        newBalance: totalBalanceHuman,
        txHash,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({
        message: 'Failed to update balance from webhook',
        address,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client.release();
    }
  }

  /**
   * Add a new user's proxy wallet address to the webhook
   * Call this when a new user deploys a proxy wallet
   */
  async addUserAddress(proxyWalletAddress: string, privyUserId: string): Promise<void> {
    logger.info({
      message: 'Adding proxy wallet address to Alchemy webhook',
      privyUserId,
      proxyWalletAddress,
    });

    await this.addAddresses([proxyWalletAddress]);
  }

  /**
   * Add a user's embedded wallet address to the webhook
   * Call this when monitoring embedded wallets for MoonPay deposits
   */
  async addEmbeddedWalletAddress(embeddedWalletAddress: string, privyUserId: string): Promise<void> {
    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Adding embedded wallet address to Alchemy webhook',
      flowStep: 'ADDING_EMBEDDED_WALLET',
      privyUserId,
      embeddedWalletAddress,
    });

    await this.addAddresses([embeddedWalletAddress]);
  }

  /**
   * Check if service is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const alchemyWebhookService = new AlchemyWebhookService();
