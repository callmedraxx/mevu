/**
 * Trading Types
 * Type definitions for Polymarket CLOB trading
 */

export enum TradeSide {
  BUY = 'BUY',
  SELL = 'SELL',
}

export enum OrderType {
  FOK = 'FOK', // Fill or Kill
  FAK = 'FAK', // Fill and Kill
  LIMIT = 'LIMIT',
  MARKET = 'MARKET',
}

/**
 * Fee configuration
 */
export const FEE_CONFIG = {
  RATE: 0.01, // 1%
  WALLET: '0x23895DdD9D2a22215080C0529614e471e1006BDf',
  MAX_RETRIES: 5,
};

/**
 * Fee payment status
 */
export type FeeStatus = 'PENDING' | 'PAID' | 'FAILED' | 'RETRYING';

export interface MarketInfo {
  marketId: string;
  marketQuestion?: string;
  clobTokenId: string;
  outcome: string;
  metadata?: Record<string, any>;
}

export interface CreateTradeRequest {
  privyUserId: string;
  userJwt?: string; // Optional: User JWT for session signer
  marketInfo: MarketInfo;
  side: TradeSide;
  orderType: OrderType;
  size: string; // Number of shares as string to handle large numbers
  price: string; // Price per share as string
}

export interface CreateTradeResponse {
  success: boolean;
  orderId?: string;
  transactionHash?: string;
  status: string;
  message?: string;
  errorCode?: string; // Error code for frontend handling
  userMessage?: string; // User-friendly error message for display
  retryable?: boolean; // Whether the error is retryable
  trade?: TradeRecord;
}

export interface TradeRecord {
  id: string;
  privyUserId: string;
  proxyWalletAddress: string;
  marketId: string;
  marketQuestion?: string;
  clobTokenId: string;
  outcome: string;
  side: TradeSide;
  orderType: OrderType;
  size: string;
  price: string;
  costUsdc: string;
  feeUsdc: string;
  feeRate?: number;
  feeAmount?: string;
  feeStatus?: FeeStatus;
  feeTxHash?: string;
  feeRetryCount?: number;
  feeLastRetry?: Date;
  orderId?: string;
  transactionHash?: string;
  blockNumber?: number;
  blockTimestamp?: Date;
  status: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeHistoryQuery {
  privyUserId: string;
  limit?: number;
  offset?: number;
  side?: TradeSide;
  marketId?: string;
  status?: string;
}
