/**
 * Polygon USDC.e Balance Watcher Service
 * Tracks USDC.e balances and transfers for proxy wallets in real-time using QuickNode WebSocket
 */

import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';

// USDC.e contract address on Polygon
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_DECIMALS = 6; // USDC has 6 decimals

// USDC.e Transfer event signature: Transfer(address indexed, address indexed, uint256)
const TRANSFER_EVENT_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

interface BalanceUpdate {
  type: 'snapshot' | 'in' | 'out';
  balance: string; // Raw balance (string to handle large numbers)
  humanBalance: string; // Human-readable balance
  amount?: string; // For in/out transfers
  humanAmount?: string;
  txHash?: string;
  blockNumber?: number;
  timestamp?: number;
  from?: string;
  to?: string;
}

interface WatchedAddress {
  proxyWalletAddress: string;
  privyUserId: string;
  balance: bigint;
  listeners: Set<(update: BalanceUpdate) => void>;
  lastSyncedAt: Date;
}

export class PolygonUsdcBalanceService {
  private provider: ethers.providers.WebSocketProvider | null = null;
  private httpProvider: ethers.providers.JsonRpcProvider | null = null; // HTTP provider for balance queries
  private contract: ethers.Contract | null = null;
  private httpContract: ethers.Contract | null = null; // HTTP contract for balance queries
  private watchedAddresses: Map<string, WatchedAddress> = new Map();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000; // 5 seconds
  private pollingInterval: NodeJS.Timeout | null = null; // Polling interval for balance checks
  private pollingIntervalMs: number = 2000; // Poll every 2 seconds
  private rateLimitBackoffUntil: Date | null = null; // When to resume polling after rate limit
  private consecutiveRateLimitErrors: number = 0; // Track consecutive rate limit errors
  private maxPollingIntervalMs: number = 600000; // Max 10 minutes between polls

  /**
   * Initialize the service with QuickNode WebSocket connection
   */
  async initialize(): Promise<void> {
    const wssUrl = process.env.QUICKNODE_WSS_URL;
    const apiUrl = process.env.QUICKNODE_API_URL;
    // Use polygon-rpc for balance queries (more reliable than QuickNode when rate limited)
    const fallbackRpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';

    if (!wssUrl) {
      throw new Error('QUICKNODE_WSS_URL environment variable is required');
    }

    try {
      // logger.info({
      //   message: 'Initializing Polygon USDC balance watcher',
      //   wssUrl: wssUrl.substring(0, 30) + '...', // Log partial URL for security
      // });

      // Create WebSocket provider for event listening
      this.provider = new ethers.providers.WebSocketProvider(wssUrl);

      // Use polygon-rpc for balance queries (more reliable, no rate limits)
      // Always use polygon-rpc instead of QuickNode API to avoid rate limiting
      const rpcUrl = fallbackRpcUrl;
      // Use StaticJsonRpcProvider for public RPCs to avoid network detection issues
      // Specify Polygon network explicitly: chainId 137, name 'polygon'
      const polygonNetwork = {
        name: 'polygon',
        chainId: 137,
      };
      this.httpProvider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, polygonNetwork);
      // logger.info({
      //   message: 'HTTP provider initialized for balance queries',
      //   rpcUrl: 'polygon-rpc.com',
      // });

      // Create USDC contract instance
      const usdcAbi = [
        'function balanceOf(address owner) view returns (uint256)',
        'function decimals() view returns (uint8)',
        'event Transfer(address indexed from, address indexed to, uint256 value)',
      ];

      this.contract = new ethers.Contract(USDC_CONTRACT_ADDRESS, usdcAbi, this.provider);
      
      // Create HTTP contract for balance queries (fallback)
      if (this.httpProvider) {
        this.httpContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, usdcAbi, this.httpProvider);
      }

      // Setup provider event handlers (for WebSocket connection monitoring)
      this.setupProviderHandlers();

      // Start polling for balance updates instead of WebSocket events
      // WebSocket events are unreliable, so we poll every 2 seconds
      this.startBalancePolling();

      this.isConnected = true;
      // logger.info({
      //   message: 'Polygon USDC balance watcher initialized successfully',
      //   mode: 'polling',
      //   intervalMs: this.pollingIntervalMs,
      // });
    } catch (error) {
      logger.error({
        message: 'Failed to initialize Polygon USDC balance watcher',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Setup WebSocket provider event handlers
   */
  private setupProviderHandlers(): void {
    if (!this.provider || !this.provider._websocket) return;

    // Remove any existing listeners first
    this.provider.removeAllListeners('error');
    if (this.provider._websocket) {
      this.provider._websocket.removeAllListeners('close');
      this.provider._websocket.removeAllListeners('open');
      this.provider._websocket.removeAllListeners('error');
    }

    this.provider.on('error', (error) => {
      logger.error({
        message: 'WebSocket provider error',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.isConnected = false;
      // Don't reconnect immediately - let the close handler do it
    });

    if (this.provider._websocket) {
      this.provider._websocket.on('error', (error: Error) => {
        logger.error({
          message: 'WebSocket error',
          error: error instanceof Error ? error.message : String(error),
        });
        this.isConnected = false;
      });

      this.provider._websocket.on('close', (code: number, reason: string) => {
        const ws = this.provider?._websocket;
        logger.warn({
          message: '❌ QuickNode WebSocket connection closed',
          code,
          reason: reason || 'No reason provided',
          readyState: ws?.readyState,
        });
        this.isConnected = false;
        this.attemptReconnect();
      });

      this.provider._websocket.on('open', () => {
        // logger.info({
        //   message: 'WebSocket connection opened',
        // });
        this.isConnected = true;
        this.reconnectAttempts = 0;
      });
    }
  }

  /**
   * Attempt to reconnect to WebSocket
   */
  private async attemptReconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error({
        message: 'Max reconnection attempts reached, giving up',
        attempts: this.reconnectAttempts,
      });
      return;
    }

    this.reconnectAttempts++;
    // logger.info({
    //   message: 'Attempting to reconnect WebSocket',
    //   attempt: this.reconnectAttempts,
    //   maxAttempts: this.maxReconnectAttempts,
    // });

    // Wait before reconnecting
    await new Promise((resolve) => setTimeout(resolve, this.reconnectDelay));

    try {
      await this.initialize();
    } catch (error) {
      logger.error({
        message: 'Reconnection attempt failed',
        attempt: this.reconnectAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      // Will retry on next close/error event
    }
  }

  /**
   * Start polling for balance updates every 2 seconds
   * This replaces WebSocket event listening which was unreliable
   */
  private startBalancePolling(): void {
    if (!this.httpContract) {
      throw new Error('HTTP contract not initialized');
    }

    // Clear any existing polling interval
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }

    // logger.info({
    //   message: 'Starting balance polling',
    //   intervalMs: this.pollingIntervalMs,
    //   contractAddress: USDC_CONTRACT_ADDRESS,
    // });

    // Poll every 2 seconds
    this.pollingInterval = setInterval(async () => {
      await this.pollBalances();
    }, this.pollingIntervalMs);
  }

  /**
   * Check if we're currently rate limited
   */
  private isRateLimited(): boolean {
    if (!this.rateLimitBackoffUntil) {
      return false;
    }
    if (new Date() >= this.rateLimitBackoffUntil) {
      // Backoff period expired, reset
      this.rateLimitBackoffUntil = null;
      this.consecutiveRateLimitErrors = 0;
      // Reset polling interval to default
      if (this.pollingIntervalMs > 2000) {
        this.pollingIntervalMs = 2000;
        this.restartPolling();
      }
      return false;
    }
    return true;
  }

  /**
   * Handle rate limit error - implement exponential backoff
   */
  private handleRateLimitError(retryAfterSeconds?: number): void {
    this.consecutiveRateLimitErrors++;
    
    // Use retry-after from error if provided, otherwise calculate exponential backoff
    const backoffSeconds = retryAfterSeconds || Math.min(
      Math.pow(2, this.consecutiveRateLimitErrors) * 60, // Exponential: 1min, 2min, 4min, 8min...
      this.maxPollingIntervalMs / 1000 // Cap at max polling interval
    );
    
    this.rateLimitBackoffUntil = new Date(Date.now() + backoffSeconds * 1000);
    
    // Increase polling interval to reduce future rate limit hits
    const newIntervalMs = Math.min(
      this.pollingIntervalMs * 2,
      this.maxPollingIntervalMs
    );
    
    if (newIntervalMs !== this.pollingIntervalMs) {
      this.pollingIntervalMs = newIntervalMs;
      this.restartPolling();
    }
    
    logger.warn({
      message: 'Rate limit detected - backing off',
      consecutiveErrors: this.consecutiveRateLimitErrors,
      backoffSeconds,
      resumeAt: this.rateLimitBackoffUntil.toISOString(),
      newPollingIntervalMs: this.pollingIntervalMs,
    });
  }

  /**
   * Restart polling with new interval
   */
  private restartPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    this.startBalancePolling();
  }

  /**
   * Check if error is a rate limit error
   */
  private isRateLimitError(error: any): boolean {
    if (!error) return false;
    
    const errorMessage = error.message || error.toString() || '';
    const errorCode = error.code || error.error?.code;
    
    // Check for rate limit indicators
    return (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('Too many requests') ||
      errorCode === -32090 ||
      errorCode === 429 ||
      (error.error && error.error.code === -32090)
    );
  }

  /**
   * Extract retry-after seconds from error
   */
  private extractRetryAfter(error: any): number | undefined {
    try {
      const errorMessage = error.message || error.toString() || '';
      // Look for "retry in 10m0s" pattern
      const match = errorMessage.match(/retry in (\d+)m(\d+)s/i) || 
                   errorMessage.match(/retry in (\d+)s/i);
      if (match) {
        if (match[2] !== undefined) {
          // "10m0s" format
          return parseInt(match[1]) * 60 + parseInt(match[2]);
        } else {
          // "10s" format
          return parseInt(match[1]);
        }
      }
      
      // Check error body for retry-after
      if (error.error?.data?.retryAfter) {
        return error.error.data.retryAfter;
      }
    } catch {
      // Ignore parsing errors
    }
    return undefined;
  }

  /**
   * Poll all watched addresses for balance changes
   */
  private async pollBalances(): Promise<void> {
    if (!this.httpContract) {
      logger.warn({
        message: 'Cannot poll balances: HTTP contract not initialized',
      });
      return;
    }

    // Check if we're rate limited
    if (this.isRateLimited()) {
      // logger.debug({
      //   message: 'Skipping poll - rate limited',
      //   resumeAt: this.rateLimitBackoffUntil?.toISOString(),
      // });
      return;
    }

    if (this.watchedAddresses.size === 0) {
      // logger.debug({
      //   message: 'No addresses to poll',
      //   watchedCount: 0,
      // });
      return;
    }

    const addresses = Array.from(this.watchedAddresses.keys());
    // logger.debug({
    //   message: 'Polling balances',
    //   addressCount: addresses.length,
    // });
    
    // Poll addresses sequentially with delay to avoid rate limits
    // Only poll a few addresses per cycle to reduce load
    const addressesToPoll = addresses.slice(0, Math.min(5, addresses.length)); // Max 5 per cycle
    
    // Poll addresses sequentially with small delay between each
    for (const addressLower of addressesToPoll) {
      const watched = this.watchedAddresses.get(addressLower);
      if (!watched) continue;

      try {
        // Small delay between requests to avoid rate limits
        if (addressesToPoll.indexOf(addressLower) > 0) {
          await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between requests
        }

        // Fetch current balance
        const balancePromise = this.httpContract!.balanceOf(watched.proxyWalletAddress);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Balance fetch timeout')), 5000);
        });
        
        const balanceBN = await Promise.race([balancePromise, timeoutPromise]);
        const currentBalance = BigInt(balanceBN.toString());
        const previousBalance = watched.balance;

        // Reset consecutive errors on success
        if (this.consecutiveRateLimitErrors > 0) {
          this.consecutiveRateLimitErrors = 0;
        }

        // Always update lastSyncedAt to track polling activity
        watched.lastSyncedAt = new Date();

        // Always update database to keep it in sync (even if balance hasn't changed)
        // This ensures the database reflects the current on-chain balance
        await this.updateBalance(
          watched.proxyWalletAddress,
          watched.privyUserId,
          currentBalance.toString()
        );

        // Check if balance changed
        if (currentBalance !== previousBalance) {
          const difference = currentBalance - previousBalance;
          const isIncoming = difference > 0;
          
          // logger.info({
          //   message: 'Balance change detected',
          //   proxyWalletAddress: watched.proxyWalletAddress,
          //   privyUserId: watched.privyUserId,
          //   previousBalance: previousBalance.toString(),
          //   currentBalance: currentBalance.toString(),
          //   difference: difference.toString(),
          //   type: isIncoming ? 'in' : 'out',
          // });

          // Update watched balance
          watched.balance = currentBalance;
          
          // logger.info({
          //   message: 'Balance updated in memory and database',
          //   proxyWalletAddress: watched.proxyWalletAddress,
          //   newBalance: currentBalance.toString(),
          // });

          // Persist transfer record
          const humanAmount = ethers.utils.formatUnits(difference > 0 ? difference : -difference, USDC_DECIMALS);
          await this.persistTransfer(
            watched.proxyWalletAddress,
            watched.privyUserId,
            isIncoming ? 'in' : 'out',
            isIncoming ? '0x0000000000000000000000000000000000000000' : watched.proxyWalletAddress,
            isIncoming ? watched.proxyWalletAddress : '0x0000000000000000000000000000000000000000',
            difference > 0 ? difference.toString() : (-difference).toString(),
            humanAmount,
            '', // No tx hash from polling
            0, // No block number from polling
            undefined, // No timestamp from polling
            null // No log index from polling
          );

          // Notify listeners
          const update: BalanceUpdate = {
            type: isIncoming ? 'in' : 'out',
            balance: currentBalance.toString(),
            humanBalance: ethers.utils.formatUnits(currentBalance.toString(), USDC_DECIMALS),
            amount: difference > 0 ? difference.toString() : (-difference).toString(),
            humanAmount,
          };

          watched.listeners.forEach((listener) => {
            try {
              listener(update);
            } catch (error) {
              logger.error({
                message: 'Error in balance update listener',
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        }
      } catch (error) {
        // Check if this is a rate limit error
        if (this.isRateLimitError(error)) {
          const retryAfter = this.extractRetryAfter(error);
          this.handleRateLimitError(retryAfter);
          
          // logger.warn({
          //   message: 'Rate limit error while polling balance',
          //   proxyWalletAddress: watched.proxyWalletAddress,
          //   privyUserId: watched.privyUserId,
          //   retryAfterSeconds: retryAfter,
          //   consecutiveErrors: this.consecutiveRateLimitErrors,
          // });
          
          // Stop polling this cycle - will resume after backoff
          break;
        } else {
          logger.warn({
            message: 'Error polling balance for address',
            proxyWalletAddress: watched.proxyWalletAddress,
            privyUserId: watched.privyUserId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    }
  }

  /**
   * Handle a Transfer event
   */
  private async handleTransfer(
    from: string,
    to: string,
    value: ethers.BigNumber,
    event: ethers.Event
  ): Promise<void> {
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const amount = value.toString();
    const humanAmount = ethers.utils.formatUnits(value, USDC_DECIMALS);

    // Check if this transfer involves any watched addresses
    const fromWatched = this.watchedAddresses.get(fromLower);
    const toWatched = this.watchedAddresses.get(toLower);

    // Get block timestamp if available
    let blockTimestamp: number | undefined;
    try {
      if (event.blockNumber && this.provider) {
        const block = await this.provider.getBlock(event.blockNumber);
        blockTimestamp = block.timestamp;
      }
    } catch (error) {
      // Ignore timestamp fetch errors - don't block transfer processing
      logger.debug({
        message: 'Failed to fetch block timestamp for transfer',
        blockNumber: event.blockNumber,
      });
    }
    
    // Extract event properties safely
    const txHash = event.transactionHash || event.args?.transactionHash || '';
    const blockNumber = event.blockNumber || 0;
    const logIndex = event.logIndex !== undefined ? event.logIndex : null;

    // Handle outgoing transfer
    if (fromWatched) {
      const newBalance = fromWatched.balance - BigInt(amount);
      fromWatched.balance = newBalance;

      // Persist transfer to database
      await this.persistTransfer(
        fromWatched.proxyWalletAddress,
        fromWatched.privyUserId,
        'out',
        from,
        to,
        amount,
        humanAmount,
        txHash,
        blockNumber,
        blockTimestamp,
        logIndex
      );

      // Update balance in database
      await this.updateBalance(
        fromWatched.proxyWalletAddress,
        fromWatched.privyUserId,
        newBalance.toString()
      );

      // Notify listeners
      const update: BalanceUpdate = {
        type: 'out',
        balance: newBalance.toString(),
        humanBalance: ethers.utils.formatUnits(newBalance.toString(), USDC_DECIMALS),
        amount,
        humanAmount,
        txHash: event.transactionHash,
        blockNumber: event.blockNumber,
        timestamp: blockTimestamp,
        from,
        to,
      };

      fromWatched.listeners.forEach((listener) => {
        try {
          listener(update);
        } catch (error) {
          logger.error({
            message: 'Error in balance update listener',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }

    // Handle incoming transfer
    if (toWatched) {
      const newBalance = toWatched.balance + BigInt(amount);
      toWatched.balance = newBalance;

      // Persist transfer to database
      await this.persistTransfer(
        toWatched.proxyWalletAddress,
        toWatched.privyUserId,
        'in',
        from,
        to,
        amount,
        humanAmount,
        txHash,
        blockNumber,
        blockTimestamp,
        logIndex
      );

      // Update balance in database
      await this.updateBalance(
        toWatched.proxyWalletAddress,
        toWatched.privyUserId,
        newBalance.toString()
      );

      // Notify listeners
      const update: BalanceUpdate = {
        type: 'in',
        balance: newBalance.toString(),
        humanBalance: ethers.utils.formatUnits(newBalance.toString(), USDC_DECIMALS),
        amount,
        humanAmount,
        txHash,
        blockNumber,
        timestamp: blockTimestamp,
        from,
        to,
      };

      toWatched.listeners.forEach((listener) => {
        try {
          listener(update);
        } catch (error) {
          logger.error({
            message: 'Error in balance update listener',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  }

  /**
   * Watch a proxy wallet address and start tracking its balance
   */
  async watchAddress(proxyWalletAddress: string, privyUserId: string): Promise<string> {
    const addressLower = proxyWalletAddress.toLowerCase();

    // Check if already watching
    if (this.watchedAddresses.has(addressLower)) {
      const watched = this.watchedAddresses.get(addressLower)!;
      // logger.info({
      //   message: 'Address already being watched',
      //   proxyWalletAddress,
      //   privyUserId,
      //   currentBalance: watched.balance.toString(),
      // });
      return watched.balance.toString();
    }

    if (!this.contract || !this.provider) {
      throw new Error('Service not initialized. Call initialize() first.');
    }

    // logger.info({
    //   message: 'Starting to watch proxy wallet address',
    //   proxyWalletAddress,
    //   privyUserId,
    // });

    // Fetch initial balance with timeout and fallback
    let balance: bigint = BigInt(0); // Default to 0 if fetch fails
    let balanceFetched = false;
    
    // Try HTTP provider first (more reliable)
    if (this.httpContract) {
      try {
        // logger.info({
        //   message: 'Fetching balance via HTTP provider',
        //   proxyWalletAddress,
        // });
        const balancePromise = this.httpContract.balanceOf(proxyWalletAddress);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Balance fetch timeout after 5 seconds')), 5000);
        });
        
        const balanceBN = await Promise.race([balancePromise, timeoutPromise]);
        balance = BigInt(balanceBN.toString());
        balanceFetched = true;
        
        // logger.info({
        //   message: 'Successfully fetched initial balance via HTTP',
        //   proxyWalletAddress,
        //   balance: balance.toString(),
        // });
      } catch (httpError) {
        // Check if this is a rate limit error
        if (this.isRateLimitError(httpError)) {
          const retryAfter = this.extractRetryAfter(httpError);
          this.handleRateLimitError(retryAfter);
          
          logger.warn({
            message: 'Rate limit error while fetching initial balance - will use 0 and retry later',
            proxyWalletAddress,
            retryAfterSeconds: retryAfter,
          });
        } else {
          logger.warn({
            message: 'HTTP balance fetch failed, will try WebSocket or use 0',
            proxyWalletAddress,
            error: httpError instanceof Error ? httpError.message : String(httpError),
          });
        }
      }
    }
    
    // Fallback to WebSocket provider if HTTP failed
    if (!balanceFetched && this.contract) {
      try {
        // logger.info({
        //   message: 'Fetching balance via WebSocket provider',
        //   proxyWalletAddress,
        // });
        const balancePromise = this.contract.balanceOf(proxyWalletAddress);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Balance fetch timeout after 5 seconds')), 5000);
        });
        
        const balanceBN = await Promise.race([balancePromise, timeoutPromise]);
        balance = BigInt(balanceBN.toString());
        balanceFetched = true;
        
        // logger.info({
        //   message: 'Successfully fetched initial balance via WebSocket',
        //   proxyWalletAddress,
        //   balance: balance.toString(),
        // });
      } catch (wsError) {
        logger.warn({
          message: 'WebSocket balance fetch failed, will use 0 and rely on transfer events',
          proxyWalletAddress,
          error: wsError instanceof Error ? wsError.message : String(wsError),
        });
        // Don't throw - allow watching with 0 balance, transfer events will update it
      }
    }
    
    if (!balanceFetched) {
      logger.warn({
        message: 'Could not fetch initial balance, starting watch with 0 balance. Transfer events will update it.',
        proxyWalletAddress,
        privyUserId,
      });
    }

    // Create watched address entry
    const watched: WatchedAddress = {
      proxyWalletAddress,
      privyUserId,
      balance,
      listeners: new Set(),
      lastSyncedAt: new Date(),
    };

    this.watchedAddresses.set(addressLower, watched);

    // Persist initial balance to database
    await this.updateBalance(proxyWalletAddress, privyUserId, balance.toString());

    // logger.info({
    //   message: 'Started watching proxy wallet address',
    //   proxyWalletAddress,
    //   privyUserId,
    //   initialBalance: balance.toString(),
    //   humanBalance: ethers.utils.formatUnits(balance.toString(), USDC_DECIMALS),
    // });

    return balance.toString();
  }

  /**
   * Subscribe to balance updates for a proxy wallet
   */
  subscribe(
    proxyWalletAddress: string,
    listener: (update: BalanceUpdate) => void
  ): () => void {
    const addressLower = proxyWalletAddress.toLowerCase();
    const watched = this.watchedAddresses.get(addressLower);

    if (!watched) {
      throw new Error(`Address ${proxyWalletAddress} is not being watched. Call watchAddress() first.`);
    }

    watched.listeners.add(listener);

    // Return unsubscribe function
    return () => {
      watched.listeners.delete(listener);
    };
  }

  /**
   * Get current balance for a proxy wallet
   */
  async getBalance(proxyWalletAddress: string): Promise<{ balance: string; humanBalance: string } | null> {
    const addressLower = proxyWalletAddress.toLowerCase();
    const watched = this.watchedAddresses.get(addressLower);

    if (watched) {
      return {
        balance: watched.balance.toString(),
        humanBalance: ethers.utils.formatUnits(watched.balance.toString(), USDC_DECIMALS),
      };
    }

    // If not watched, fetch from database
    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT balance_raw, balance_human FROM wallet_balances WHERE proxy_wallet_address = $1',
        [proxyWalletAddress.toLowerCase()]
      );

      if (result.rows.length > 0) {
        return {
          balance: result.rows[0].balance_raw,
          humanBalance: result.rows[0].balance_human,
        };
      }
    } finally {
      client.release();
    }

    return null;
  }

  /**
   * Update balance in database
   */
  private async updateBalance(
    proxyWalletAddress: string,
    privyUserId: string,
    balanceRaw: string
  ): Promise<void> {
    const humanBalance = ethers.utils.formatUnits(balanceRaw, USDC_DECIMALS);
    const client = await pool.connect();

    try {
      await client.query(
        `INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (proxy_wallet_address) 
         DO UPDATE SET 
           balance_raw = EXCLUDED.balance_raw,
           balance_human = EXCLUDED.balance_human,
           last_updated_at = CURRENT_TIMESTAMP`,
        [proxyWalletAddress.toLowerCase(), privyUserId, balanceRaw, humanBalance]
      );
    } catch (error) {
      logger.error({
        message: 'Failed to update balance in database',
        proxyWalletAddress,
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - balance tracking shouldn't break the app
    } finally {
      client.release();
    }
  }

  /**
   * Persist transfer to database
   */
  private async persistTransfer(
    proxyWalletAddress: string,
    privyUserId: string,
    transferType: 'in' | 'out',
    from: string,
    to: string,
    amountRaw: string,
    amountHuman: string,
    txHash: string,
    blockNumber: number,
    blockTimestamp: number | undefined,
    logIndex: number | undefined | null
  ): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query(
        `INSERT INTO wallet_usdc_transfers (
          proxy_wallet_address, privy_user_id, transfer_type, from_address, to_address,
          amount_raw, amount_human, transaction_hash, block_number, block_timestamp, log_index
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (transaction_hash, log_index) DO NOTHING`,
        [
          proxyWalletAddress.toLowerCase(),
          privyUserId,
          transferType,
          from.toLowerCase(),
          to.toLowerCase(),
          amountRaw,
          amountHuman,
          txHash,
          blockNumber,
          blockTimestamp ? new Date(blockTimestamp * 1000) : null,
          logIndex !== undefined ? logIndex : null,
        ]
      );
    } catch (error) {
      logger.error({
        message: 'Failed to persist transfer to database',
        proxyWalletAddress,
        privyUserId,
        txHash,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - transfer tracking shouldn't break the app
    } finally {
      client.release();
    }
  }

  /**
   * Get transfer history for a proxy wallet
   */
  async getTransferHistory(
    proxyWalletAddress: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<any[]> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT 
          transfer_type, from_address, to_address, amount_raw, amount_human,
          transaction_hash, block_number, block_timestamp, log_index, created_at
         FROM wallet_usdc_transfers
         WHERE proxy_wallet_address = $1
         ORDER BY created_at DESC, block_number DESC, log_index DESC
         LIMIT $2 OFFSET $3`,
        [proxyWalletAddress.toLowerCase(), limit, offset]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get deposit history (incoming transfers only) for a proxy wallet
   */
  async getDepositHistory(
    proxyWalletAddress: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<any[]> {
    const client = await pool.connect();

    try {
      const result = await client.query(
        `SELECT 
          transfer_type, from_address, to_address, amount_raw, amount_human,
          transaction_hash, block_number, block_timestamp, log_index, created_at
         FROM wallet_usdc_transfers
         WHERE proxy_wallet_address = $1 AND transfer_type = 'in'
         ORDER BY created_at DESC, block_number DESC, log_index DESC
         LIMIT $2 OFFSET $3`,
        [proxyWalletAddress.toLowerCase(), limit, offset]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Cleanup and disconnect
   */
  async disconnect(): Promise<void> {
    // Stop polling
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    if (this.contract) {
      this.contract.removeAllListeners();
    }

    if (this.provider) {
      await this.provider.destroy();
    }

    this.watchedAddresses.clear();
    this.isConnected = false;

    logger.info({
      message: 'Polygon USDC balance watcher disconnected',
    });
  }
}

// Export singleton instance
export const polygonUsdcBalanceService = new PolygonUsdcBalanceService();
