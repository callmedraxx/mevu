/**
 * DFlow Trading API Client
 * Wraps the DFlow Trading API for prediction market outcome token trades
 */

import axios, { AxiosInstance } from 'axios';

const DFLOW_TRADE_API_URL =
  process.env.DFLOW_TRADE_API_URL || 'https://quote-api.dflow.net';
const DFLOW_API_KEY = process.env.DFLOW_API_KEY || '';

export interface DFlowOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps?: number;
  platformFeeBps?: number;
}

export interface DFlowOrderResponse {
  transaction: string;
  inputMint?: string;
  inAmount?: string;
  outputMint?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  minOutAmount?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  lastValidBlockHeight?: number;
  executionMode?: string;
}

export interface DFlowOrderStatusResponse {
  status: 'pending' | 'expired' | 'failed' | 'open' | 'pendingClose' | 'closed';
  inAmount?: string;
  outAmount?: string;
  fills?: Array<{ signature: string; inputMint: string; inAmount: string; outputMint: string; outAmount: string }>;
  reverts?: Array<{ signature: string; inputMint: string; inAmount: string; outputMint: string; outAmount: string }>;
  error?: string;
}

class DFlowClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: DFLOW_TRADE_API_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        ...(DFLOW_API_KEY && { 'x-api-key': DFLOW_API_KEY }),
      },
    });
  }

  async getBuyOrder(params: DFlowOrderParams): Promise<DFlowOrderResponse> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amount,
      userPublicKey: params.userPublicKey,
      ...(params.slippageBps != null && { slippageBps: String(params.slippageBps) }),
      ...(params.platformFeeBps != null && { platformFeeBps: String(params.platformFeeBps) }),
    });
    const response = await this.client.get<DFlowOrderResponse>('/order?' + query.toString());
    return response.data;
  }

  async getSellOrder(params: DFlowOrderParams): Promise<DFlowOrderResponse> {
    return this.getBuyOrder({
      ...params,
      inputMint: params.outputMint,
      outputMint: params.inputMint,
    });
  }

  async getOrderStatus(signature: string, lastValidBlockHeight?: number): Promise<DFlowOrderStatusResponse> {
    const params = new URLSearchParams({ signature });
    if (lastValidBlockHeight != null) {
      params.set('lastValidBlockHeight', String(lastValidBlockHeight));
    }
    const response = await this.client.get<DFlowOrderStatusResponse>(
      '/order-status?' + params.toString()
    );
    return response.data;
  }

  isConfigured(): boolean {
    return !!DFLOW_API_KEY;
  }
}

export const dflowClient = new DFlowClient();
