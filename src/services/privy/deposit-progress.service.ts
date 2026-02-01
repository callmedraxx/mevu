/**
 * Deposit Progress Service
 * Tracks the progress of deposits from MoonPay through the auto-transfer pipeline
 * Emits events for SSE broadcasting to frontend
 */

import { EventEmitter } from 'events';
import { logger } from '../../config/logger';
import { pool } from '../../config/database';
import {
  initRedisClusterBroadcast,
  publishDepositsProgress,
  subscribeToDepositsProgress,
  isRedisClusterBroadcastReady,
} from '../redis-cluster-broadcast.service';

export type DepositStatus = 
  | 'deposit_received'
  | 'swapping'
  | 'swap_complete'
  | 'transferring'
  | 'complete'
  | 'failed';

export interface DepositProgress {
  depositId: string;
  privyUserId: string;
  step: 1 | 2 | 3 | 4 | 5;
  status: DepositStatus;
  amount: string;
  amountOut?: string;
  txHashes: {
    deposit?: string;
    swap?: string;
    transfer?: string;
  };
  timestamps: {
    started: string;
    stepStarted: string;
  };
  error?: string;
}

export interface DepositProgressEvent {
  type: 'progress_update' | 'deposit_complete' | 'deposit_failed';
  depositId: string;
  privyUserId: string;
  step: 1 | 2 | 3 | 4 | 5;
  status: DepositStatus;
  amount: string;
  amountOut?: string;
  txHashes: {
    deposit?: string;
    swap?: string;
    transfer?: string;
  };
  timestamps: {
    started: string;
    stepStarted: string;
  };
  error?: string;
}

class DepositProgressService extends EventEmitter {
  // Map of depositId -> DepositProgress
  private activeDeposits: Map<string, DepositProgress> = new Map();
  // Map of privyUserId -> Set of depositIds
  private userDeposits: Map<string, Set<string>> = new Map();
  // Cleanup timeout for completed deposits (5 minutes)
  private readonly CLEANUP_DELAY_MS = 5 * 60 * 1000;

  constructor() {
    super();
    this.setMaxListeners(100); // Allow many SSE connections
  }

  /**
   * Generate a unique deposit ID
   */
  private generateDepositId(privyUserId: string, txHash: string): string {
    return `${privyUserId}:${txHash}:${Date.now()}`;
  }

  /**
   * Start tracking a new deposit
   */
  async startDeposit(
    privyUserId: string,
    amount: string,
    depositTxHash: string
  ): Promise<string> {
    const depositId = this.generateDepositId(privyUserId, depositTxHash);
    const now = new Date().toISOString();

    const progress: DepositProgress = {
      depositId,
      privyUserId,
      step: 1,
      status: 'deposit_received',
      amount,
      txHashes: {
        deposit: depositTxHash,
      },
      timestamps: {
        started: now,
        stepStarted: now,
      },
    };

    this.activeDeposits.set(depositId, progress);

    // Track by user
    if (!this.userDeposits.has(privyUserId)) {
      this.userDeposits.set(privyUserId, new Set());
    }
    this.userDeposits.get(privyUserId)!.add(depositId);

    // Save to database
    await this.saveToDatabase(progress);

    // Emit event
    this.emitProgressEvent(progress, 'progress_update');

    logger.info({
      message: '[DEPOSIT-PROGRESS] Deposit tracking started',
      depositId,
      privyUserId,
      amount,
      depositTxHash,
    });

    return depositId;
  }

  /**
   * Update deposit to swapping status
   */
  async updateToSwapping(depositId: string): Promise<void> {
    const progress = this.activeDeposits.get(depositId);
    if (!progress) {
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Deposit not found for swapping update',
        depositId,
      });
      return;
    }

    progress.step = 2;
    progress.status = 'swapping';
    progress.timestamps.stepStarted = new Date().toISOString();

    await this.saveToDatabase(progress);
    this.emitProgressEvent(progress, 'progress_update');

    logger.info({
      message: '[DEPOSIT-PROGRESS] Deposit status updated to swapping',
      depositId,
      privyUserId: progress.privyUserId,
    });
  }

  /**
   * Update deposit after swap completes
   */
  async updateSwapComplete(
    depositId: string,
    swapTxHash: string,
    amountOut: string
  ): Promise<void> {
    const progress = this.activeDeposits.get(depositId);
    if (!progress) {
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Deposit not found for swap complete update',
        depositId,
      });
      return;
    }

    progress.step = 3;
    progress.status = 'swap_complete';
    progress.txHashes.swap = swapTxHash;
    progress.amountOut = amountOut;
    progress.timestamps.stepStarted = new Date().toISOString();

    await this.saveToDatabase(progress);
    this.emitProgressEvent(progress, 'progress_update');

    logger.info({
      message: '[DEPOSIT-PROGRESS] Deposit swap completed',
      depositId,
      privyUserId: progress.privyUserId,
      swapTxHash,
      amountOut,
    });
  }

  /**
   * Update deposit to transferring status
   */
  async updateToTransferring(depositId: string): Promise<void> {
    const progress = this.activeDeposits.get(depositId);
    if (!progress) {
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Deposit not found for transferring update',
        depositId,
      });
      return;
    }

    progress.step = 4;
    progress.status = 'transferring';
    progress.timestamps.stepStarted = new Date().toISOString();

    await this.saveToDatabase(progress);
    this.emitProgressEvent(progress, 'progress_update');

    logger.info({
      message: '[DEPOSIT-PROGRESS] Deposit status updated to transferring',
      depositId,
      privyUserId: progress.privyUserId,
    });
  }

  /**
   * Mark deposit as complete
   */
  async completeDeposit(depositId: string, transferTxHash: string): Promise<void> {
    const progress = this.activeDeposits.get(depositId);
    if (!progress) {
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Deposit not found for completion',
        depositId,
      });
      return;
    }

    progress.step = 5;
    progress.status = 'complete';
    progress.txHashes.transfer = transferTxHash;
    progress.timestamps.stepStarted = new Date().toISOString();

    await this.saveToDatabase(progress);
    this.emitProgressEvent(progress, 'deposit_complete');

    logger.info({
      message: '[DEPOSIT-PROGRESS] Deposit completed successfully',
      depositId,
      privyUserId: progress.privyUserId,
      transferTxHash,
    });

    // Schedule cleanup
    this.scheduleCleanup(depositId, progress.privyUserId);
  }

  /**
   * Mark deposit as failed
   */
  async failDeposit(depositId: string, error: string): Promise<void> {
    const progress = this.activeDeposits.get(depositId);
    if (!progress) {
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Deposit not found for failure',
        depositId,
      });
      return;
    }

    progress.status = 'failed';
    progress.error = error;
    progress.timestamps.stepStarted = new Date().toISOString();

    await this.saveToDatabase(progress);
    this.emitProgressEvent(progress, 'deposit_failed');

    logger.error({
      message: '[DEPOSIT-PROGRESS] Deposit failed',
      depositId,
      privyUserId: progress.privyUserId,
      error,
    });

    // Schedule cleanup
    this.scheduleCleanup(depositId, progress.privyUserId);
  }

  /**
   * Get active deposits for a user
   */
  getActiveDepositsForUser(privyUserId: string): DepositProgress[] {
    const depositIds = this.userDeposits.get(privyUserId);
    if (!depositIds) return [];

    const deposits: DepositProgress[] = [];
    for (const depositId of depositIds) {
      const progress = this.activeDeposits.get(depositId);
      if (progress && progress.status !== 'complete' && progress.status !== 'failed') {
        deposits.push(progress);
      }
    }
    return deposits;
  }

  /**
   * Get all deposits for a user (including recent completed)
   */
  getAllDepositsForUser(privyUserId: string): DepositProgress[] {
    const depositIds = this.userDeposits.get(privyUserId);
    if (!depositIds) return [];

    const deposits: DepositProgress[] = [];
    for (const depositId of depositIds) {
      const progress = this.activeDeposits.get(depositId);
      if (progress) {
        deposits.push(progress);
      }
    }
    return deposits;
  }

  /**
   * Find deposit by transaction hash
   */
  findDepositByTxHash(privyUserId: string, txHash: string): DepositProgress | undefined {
    const depositIds = this.userDeposits.get(privyUserId);
    if (!depositIds) return undefined;

    for (const depositId of depositIds) {
      const progress = this.activeDeposits.get(depositId);
      if (progress && progress.txHashes.deposit === txHash) {
        return progress;
      }
    }
    return undefined;
  }

  /**
   * Get the most recent active deposit for a user
   */
  getMostRecentActiveDeposit(privyUserId: string): DepositProgress | undefined {
    const deposits = this.getActiveDepositsForUser(privyUserId);
    if (deposits.length === 0) return undefined;

    // Sort by started timestamp descending
    deposits.sort((a, b) => 
      new Date(b.timestamps.started).getTime() - new Date(a.timestamps.started).getTime()
    );

    return deposits[0];
  }

  /**
   * Emit progress event to listeners (or publish to Redis for cluster-wide delivery)
   */
  private emitProgressEvent(
    progress: DepositProgress,
    type: 'progress_update' | 'deposit_complete' | 'deposit_failed'
  ): void {
    const event: DepositProgressEvent = {
      type,
      ...progress,
    };

    if (isRedisClusterBroadcastReady()) {
      publishDepositsProgress(progress.privyUserId, event);
      return;
    }

    this.emit(`progress:${progress.privyUserId}`, event);
    this.emit('progress', event);
  }

  /**
   * Schedule cleanup of completed deposit
   */
  private scheduleCleanup(depositId: string, privyUserId: string): void {
    setTimeout(() => {
      this.activeDeposits.delete(depositId);
      const userDeposits = this.userDeposits.get(privyUserId);
      if (userDeposits) {
        userDeposits.delete(depositId);
        if (userDeposits.size === 0) {
          this.userDeposits.delete(privyUserId);
        }
      }

      logger.debug({
        message: '[DEPOSIT-PROGRESS] Cleaned up completed deposit',
        depositId,
        privyUserId,
      });
    }, this.CLEANUP_DELAY_MS);
  }

  /**
   * Save progress to database
   */
  private async saveToDatabase(progress: DepositProgress): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO deposit_progress 
         (id, privy_user_id, status, step, amount_usdc, amount_out, deposit_tx_hash, swap_tx_hash, transfer_tx_hash, error_message, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (id) DO UPDATE SET
           status = $3,
           step = $4,
           amount_out = $6,
           swap_tx_hash = $8,
           transfer_tx_hash = $9,
           error_message = $10,
           updated_at = NOW()`,
        [
          progress.depositId,
          progress.privyUserId,
          progress.status,
          progress.step,
          progress.amount,
          progress.amountOut || null,
          progress.txHashes.deposit || null,
          progress.txHashes.swap || null,
          progress.txHashes.transfer || null,
          progress.error || null,
          progress.timestamps.started,
        ]
      );
    } catch (error) {
      logger.error({
        message: '[DEPOSIT-PROGRESS] Failed to save progress to database',
        depositId: progress.depositId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Load recent deposits from database on startup
   */
  async loadFromDatabase(privyUserId?: string): Promise<void> {
    try {
      const query = privyUserId
        ? `SELECT * FROM deposit_progress WHERE privy_user_id = $1 AND status NOT IN ('complete', 'failed') ORDER BY created_at DESC LIMIT 10`
        : `SELECT * FROM deposit_progress WHERE status NOT IN ('complete', 'failed') AND created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at DESC`;
      
      const params = privyUserId ? [privyUserId] : [];
      const result = await pool.query(query, params);

      for (const row of result.rows) {
        const progress: DepositProgress = {
          depositId: row.id,
          privyUserId: row.privy_user_id,
          step: row.step,
          status: row.status,
          amount: row.amount_usdc?.toString() || '0',
          amountOut: row.amount_out?.toString(),
          txHashes: {
            deposit: row.deposit_tx_hash,
            swap: row.swap_tx_hash,
            transfer: row.transfer_tx_hash,
          },
          timestamps: {
            started: row.created_at.toISOString(),
            stepStarted: row.updated_at.toISOString(),
          },
          error: row.error_message,
        };

        this.activeDeposits.set(progress.depositId, progress);

        if (!this.userDeposits.has(progress.privyUserId)) {
          this.userDeposits.set(progress.privyUserId, new Set());
        }
        this.userDeposits.get(progress.privyUserId)!.add(progress.depositId);
      }

      logger.info({
        message: '[DEPOSIT-PROGRESS] Loaded deposits from database',
        count: result.rows.length,
        privyUserId: privyUserId || 'all',
      });
    } catch (error) {
      // Table might not exist yet
      logger.warn({
        message: '[DEPOSIT-PROGRESS] Could not load from database (table may not exist yet)',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Export singleton instance
export const depositProgressService = new DepositProgressService();
