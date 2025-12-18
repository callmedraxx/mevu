/**
 * Trades History Service
 * Handles trade history storage and retrieval
 */

import { pool, memoryStore, getDatabaseConfig } from '../../../config/database';
import { logger } from '../../../config/logger';
import { TradeRecord, TradeHistoryQuery } from './trading.types';

/**
 * Save a trade record to database
 */
export async function saveTradeRecord(trade: {
  privyUserId: string;
  proxyWalletAddress: string;
  marketId: string;
  marketQuestion?: string;
  clobTokenId: string;
  outcome: string;
  side: string;
  orderType: string;
  size: string;
  price: string;
  costUsdc: string;
  feeUsdc: string;
  feeRate?: number;
  feeAmount?: string;
  feeStatus?: string;
  orderId?: string;
  transactionHash?: string;
  blockNumber?: number;
  blockTimestamp?: Date;
  status: string;
  metadata?: Record<string, any>;
}): Promise<TradeRecord> {
  const dbConfig = getDatabaseConfig();

  if (dbConfig.type !== 'postgres') {
    // In-memory storage for development
    const id = `trade_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const tradeRecord: TradeRecord = {
      id,
      privyUserId: trade.privyUserId,
      proxyWalletAddress: trade.proxyWalletAddress,
      marketId: trade.marketId,
      marketQuestion: trade.marketQuestion,
      clobTokenId: trade.clobTokenId,
      outcome: trade.outcome,
      side: trade.side as any,
      orderType: trade.orderType as any,
      size: trade.size,
      price: trade.price,
      costUsdc: trade.costUsdc,
      feeUsdc: trade.feeUsdc,
      orderId: trade.orderId,
      transactionHash: trade.transactionHash,
      blockNumber: trade.blockNumber,
      blockTimestamp: trade.blockTimestamp,
      status: trade.status,
      metadata: trade.metadata,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    memoryStore.set(`trade:${id}`, tradeRecord);
    memoryStore.set(`trade:user:${trade.privyUserId}`, tradeRecord);

    return tradeRecord;
  }

  const client = await pool.connect();

  try {
    const result = await client.query(
      `INSERT INTO trades_history (
        privy_user_id, proxy_wallet_address, market_id, market_question,
        clob_token_id, outcome, side, order_type, size, price,
        cost_usdc, fee_usdc, fee_rate, fee_amount, fee_status,
        order_id, transaction_hash, block_number,
        block_timestamp, status, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING id, privy_user_id, proxy_wallet_address, market_id, market_question,
                clob_token_id, outcome, side, order_type, size, price,
                cost_usdc, fee_usdc, fee_rate, fee_amount, fee_status, fee_tx_hash,
                fee_retry_count, fee_last_retry,
                order_id, transaction_hash, block_number,
                block_timestamp, status, metadata, created_at, updated_at`,
      [
        trade.privyUserId,
        trade.proxyWalletAddress.toLowerCase(),
        trade.marketId,
        trade.marketQuestion || null,
        trade.clobTokenId,
        trade.outcome,
        trade.side,
        trade.orderType,
        trade.size,
        trade.price,
        trade.costUsdc,
        trade.feeUsdc,
        trade.feeRate || null,
        trade.feeAmount || null,
        trade.feeStatus || null,
        trade.orderId || null,
        trade.transactionHash || null,
        trade.blockNumber || null,
        trade.blockTimestamp || null,
        trade.status,
        trade.metadata ? JSON.stringify(trade.metadata) : null,
      ]
    );

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      proxyWalletAddress: row.proxy_wallet_address,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      clobTokenId: row.clob_token_id,
      outcome: row.outcome,
      side: row.side as any,
      orderType: row.order_type as any,
      size: row.size,
      price: row.price,
      costUsdc: row.cost_usdc,
      feeUsdc: row.fee_usdc,
      orderId: row.order_id,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      blockTimestamp: row.block_timestamp ? new Date(row.block_timestamp) : undefined,
      status: row.status,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update a trade record by order ID
 */
export async function updateTradeRecord(
  orderId: string,
  updates: {
    status?: string;
    transactionHash?: string;
    blockNumber?: number;
    blockTimestamp?: Date;
    feeUsdc?: string;
  }
): Promise<TradeRecord | null> {
  const dbConfig = getDatabaseConfig();

  if (dbConfig.type !== 'postgres') {
    // Find in memory store
    const trade = Array.from(memoryStore.values()).find(
      (t: any) => t.orderId === orderId
    ) as TradeRecord | undefined;

    if (!trade) return null;

    Object.assign(trade, updates, { updatedAt: new Date() });
    return trade;
  }

  const client = await pool.connect();

  try {
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      updateValues.push(updates.status);
    }
    if (updates.transactionHash !== undefined) {
      updateFields.push(`transaction_hash = $${paramIndex++}`);
      updateValues.push(updates.transactionHash);
    }
    if (updates.blockNumber !== undefined) {
      updateFields.push(`block_number = $${paramIndex++}`);
      updateValues.push(updates.blockNumber);
    }
    if (updates.blockTimestamp !== undefined) {
      updateFields.push(`block_timestamp = $${paramIndex++}`);
      updateValues.push(updates.blockTimestamp);
    }
    if (updates.feeUsdc !== undefined) {
      updateFields.push(`fee_usdc = $${paramIndex++}`);
      updateValues.push(updates.feeUsdc);
    }

    if (updateFields.length === 0) {
      return null;
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(orderId);

    const result = await client.query(
      `UPDATE trades_history 
       SET ${updateFields.join(', ')}
       WHERE order_id = $${paramIndex}
       RETURNING id, privy_user_id, proxy_wallet_address, market_id, market_question,
                 clob_token_id, outcome, side, order_type, size, price,
                 cost_usdc, fee_usdc, fee_rate, fee_amount, fee_status, fee_tx_hash,
                 fee_retry_count, fee_last_retry,
                 order_id, transaction_hash, block_number,
                 block_timestamp, status, metadata, created_at, updated_at`,
      updateValues
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      proxyWalletAddress: row.proxy_wallet_address,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      clobTokenId: row.clob_token_id,
      outcome: row.outcome,
      side: row.side as any,
      orderType: row.order_type as any,
      size: row.size,
      price: row.price,
      costUsdc: row.cost_usdc,
      feeUsdc: row.fee_usdc,
      feeRate: row.fee_rate ? parseFloat(row.fee_rate) : undefined,
      feeAmount: row.fee_amount,
      feeStatus: row.fee_status as any,
      feeTxHash: row.fee_tx_hash,
      feeRetryCount: row.fee_retry_count,
      feeLastRetry: row.fee_last_retry ? new Date(row.fee_last_retry) : undefined,
      orderId: row.order_id,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      blockTimestamp: row.block_timestamp ? new Date(row.block_timestamp) : undefined,
      status: row.status,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Update a trade record by database ID
 * Used when we don't have an order ID yet (e.g., before CLOB call or on failure)
 */
export async function updateTradeRecordById(
  tradeId: string,
  updates: {
    status?: string;
    orderId?: string;
    transactionHash?: string;
    blockNumber?: number;
    blockTimestamp?: Date;
    feeUsdc?: string;
    feeRate?: number;
    feeAmount?: string;
    feeStatus?: string;
    feeTxHash?: string;
    feeRetryCount?: number;
    feeLastRetry?: Date;
    errorMessage?: string;
  }
): Promise<TradeRecord | null> {
  const dbConfig = getDatabaseConfig();

  if (dbConfig.type !== 'postgres') {
    // Find in memory store by ID
    const trade = memoryStore.get(`trade:${tradeId}`) as TradeRecord | undefined;

    if (!trade) return null;

    Object.assign(trade, updates, { updatedAt: new Date() });
    return trade;
  }

  const client = await pool.connect();

  try {
    const updateFields: string[] = [];
    const updateValues: any[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      updateFields.push(`status = $${paramIndex++}`);
      updateValues.push(updates.status);
    }
    if (updates.orderId !== undefined) {
      updateFields.push(`order_id = $${paramIndex++}`);
      updateValues.push(updates.orderId);
    }
    if (updates.transactionHash !== undefined) {
      updateFields.push(`transaction_hash = $${paramIndex++}`);
      updateValues.push(updates.transactionHash);
    }
    if (updates.blockNumber !== undefined) {
      updateFields.push(`block_number = $${paramIndex++}`);
      updateValues.push(updates.blockNumber);
    }
    if (updates.blockTimestamp !== undefined) {
      updateFields.push(`block_timestamp = $${paramIndex++}`);
      updateValues.push(updates.blockTimestamp);
    }
    if (updates.feeUsdc !== undefined) {
      updateFields.push(`fee_usdc = $${paramIndex++}`);
      updateValues.push(updates.feeUsdc);
    }
    if (updates.errorMessage !== undefined) {
      // Store error message in metadata
      updateFields.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${paramIndex++}::jsonb`);
      updateValues.push(JSON.stringify({ errorMessage: updates.errorMessage }));
    }

    if (updateFields.length === 0) {
      return null;
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(tradeId);

    const result = await client.query(
      `UPDATE trades_history 
       SET ${updateFields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id, privy_user_id, proxy_wallet_address, market_id, market_question,
                 clob_token_id, outcome, side, order_type, size, price,
                 cost_usdc, fee_usdc, fee_rate, fee_amount, fee_status, fee_tx_hash,
                 fee_retry_count, fee_last_retry,
                 order_id, transaction_hash, block_number,
                 block_timestamp, status, metadata, created_at, updated_at`,
      updateValues
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      id: row.id,
      privyUserId: row.privy_user_id,
      proxyWalletAddress: row.proxy_wallet_address,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      clobTokenId: row.clob_token_id,
      outcome: row.outcome,
      side: row.side as any,
      orderType: row.order_type as any,
      size: row.size,
      price: row.price,
      costUsdc: row.cost_usdc,
      feeUsdc: row.fee_usdc,
      orderId: row.order_id,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      blockTimestamp: row.block_timestamp ? new Date(row.block_timestamp) : undefined,
      status: row.status,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  } finally {
    client.release();
  }
}

/**
 * Get trade history for a user
 */
export async function getTradeHistory(
  query: TradeHistoryQuery
): Promise<TradeRecord[]> {
  const dbConfig = getDatabaseConfig();
  const limit = query.limit || 100;
  const offset = query.offset || 0;

  if (dbConfig.type !== 'postgres') {
    // In-memory storage
    const trades = Array.from(memoryStore.values()).filter(
      (t: any) => t.privyUserId === query.privyUserId
    ) as TradeRecord[];

    let filtered = trades;
    if (query.side) {
      filtered = filtered.filter((t) => t.side === query.side);
    }
    if (query.marketId) {
      filtered = filtered.filter((t) => t.marketId === query.marketId);
    }
    if (query.status) {
      filtered = filtered.filter((t) => t.status === query.status);
    }

    return filtered
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(offset, offset + limit);
  }

  const client = await pool.connect();

  try {
    const conditions: string[] = ['privy_user_id = $1'];
    const values: any[] = [query.privyUserId];
    let paramIndex = 2;

    if (query.side) {
      conditions.push(`side = $${paramIndex++}`);
      values.push(query.side);
    }
    if (query.marketId) {
      conditions.push(`market_id = $${paramIndex++}`);
      values.push(query.marketId);
    }
    if (query.status) {
      conditions.push(`status = $${paramIndex++}`);
      values.push(query.status);
    }

    values.push(limit, offset);

    const result = await client.query(
      `SELECT id, privy_user_id, proxy_wallet_address, market_id, market_question,
              clob_token_id, outcome, side, order_type, size, price,
              cost_usdc, fee_usdc, fee_rate, fee_amount, fee_status, fee_tx_hash,
              fee_retry_count, fee_last_retry,
              order_id, transaction_hash, block_number,
              block_timestamp, status, metadata, created_at, updated_at
       FROM trades_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      values
    );

    return result.rows.map((row) => ({
      id: row.id,
      privyUserId: row.privy_user_id,
      proxyWalletAddress: row.proxy_wallet_address,
      marketId: row.market_id,
      marketQuestion: row.market_question,
      clobTokenId: row.clob_token_id,
      outcome: row.outcome,
      side: row.side as any,
      orderType: row.order_type as any,
      size: row.size,
      price: row.price,
      costUsdc: row.cost_usdc,
      feeUsdc: row.fee_usdc,
      feeRate: row.fee_rate ? parseFloat(row.fee_rate) : undefined,
      feeAmount: row.fee_amount,
      feeStatus: row.fee_status as any,
      feeTxHash: row.fee_tx_hash,
      feeRetryCount: row.fee_retry_count,
      feeLastRetry: row.fee_last_retry ? new Date(row.fee_last_retry) : undefined,
      orderId: row.order_id,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      blockTimestamp: row.block_timestamp ? new Date(row.block_timestamp) : undefined,
      status: row.status,
      metadata: row.metadata,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));
  } finally {
    client.release();
  }
}
