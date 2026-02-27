/**
 * DFlow Trading API Client
 * Wraps the DFlow Trading API for prediction market outcome token trades
 */

import axios, { AxiosInstance } from 'axios';

const DFLOW_TRADE_API_URL =
  process.env.DFLOW_TRADE_API_URL || 'https://d.quote-api.dflow.net';
const DFLOW_API_KEY = process.env.DFLOW_API_KEY || '';

export interface DFlowOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps?: number;
  platformFeeBps?: number;
  /** USDC token account (SPL) that receives platform fees. Required when platformFeeBps > 0. */
  feeAccount?: string;
  /** For prediction market orders (sell/redemption): max slippage. Redemption may require this. */
  predictionMarketSlippageBps?: number;
}

export interface DFlowPlatformFee {
  amount: string;
  feeBps: number;
  feeAccount: string;
  segmenterFeeAmount?: string;
  segmenterFeePct?: number;
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
  /** Platform fee applied to the quote, if any. Include in total cost for avg entry. */
  platformFee?: DFlowPlatformFee | null;
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
      ...(params.feeAccount && { feeAccount: params.feeAccount }),
      ...(params.predictionMarketSlippageBps != null && {
        predictionMarketSlippageBps: String(params.predictionMarketSlippageBps),
      }),
    });
    try {
      const response = await this.client.get<DFlowOrderResponse>('/order?' + query.toString());
      return response.data;
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const msg = err?.response?.data?.message ?? err?.response?.data?.error ?? (typeof body === 'string' ? body : body ? JSON.stringify(body) : null);
      const apiMsg = `DFlow API ${status ?? 'error'}: ${msg || err?.message || 'Unknown error'}`.trim();
      const e = new Error(apiMsg);
      (e as any).cause = err;
      throw e;
    }
  }

  /**
   * Get a sell order (outcome tokens → settlement mint).
   * DFlow expects inputMint=outcomeMint, outputMint=settlementMint for decrease/sell.
   * Do NOT swap — pass params through. See: https://pond.dflow.net/build/recipes/prediction-markets/decrease-position
   */
  async getSellOrder(params: DFlowOrderParams): Promise<DFlowOrderResponse> {
    return this.getBuyOrder(params);
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
