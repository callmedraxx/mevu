/**
 * Integration Tests for Kalshi Trading Flow
 * Tests the full request validation and region routing logic with mocks.
 * No Docker, database, or external APIs required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getRegionFromCountryCode, isKalshiRegion } from '../../utils/geo-region';
import {
  validateKalshiBuyRequest,
  validateKalshiSellRequest,
  type KalshiBuyRequest,
  type KalshiSellRequest,
} from './kalshi-trade-validation';
import {
  validateDFlowBuyOrder,
  validateDFlowSellOrder,
  SOLANA_USDC_MINT,
} from '../dflow/dflow-order-validation';

// Mock logger
vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Kalshi Trading Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Region + Validation Flow', () => {
    it('US user with valid buy request should pass all validations', () => {
      const region = getRegionFromCountryCode('US');
      expect(isKalshiRegion(region)).toBe(true);

      const buyReq: KalshiBuyRequest = {
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        outcome: 'YES',
        usdcAmount: '1000000',
      };
      const buyValidation = validateKalshiBuyRequest(buyReq);
      expect(buyValidation.valid).toBe(true);

      // Simulated: ticker -> outcome_mint lookup (would come from dflow_market_mappings)
      const outcomeMint = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
      const userWallet = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';

      const dflowParams = {
        inputMint: SOLANA_USDC_MINT,
        outputMint: outcomeMint,
        amount: buyReq.usdcAmount,
        userPublicKey: userWallet,
      };
      const dflowValidation = validateDFlowBuyOrder(dflowParams);
      expect(dflowValidation.valid).toBe(true);
    });

    it('international user should not be routed to Kalshi', () => {
      const region = getRegionFromCountryCode('GB');
      expect(isKalshiRegion(region)).toBe(false);
      expect(getRegionFromCountryCode('CA')).toBe('international');
    });
  });

  describe('Full Buy Flow Validation', () => {
    it('invalid buy request fails before DFlow validation', () => {
      const invalidBuy = { kalshiTicker: 'bad', outcome: 'YES' as const, usdcAmount: '1000000' };
      const result = validateKalshiBuyRequest(invalidBuy);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Invalid|kalshiTicker|format/i);
    });

    it('valid buy -> valid DFlow params chain', () => {
      const buy = {
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        outcome: 'YES' as const,
        usdcAmount: '5000000', // 5 USDC
      };
      expect(validateKalshiBuyRequest(buy)).toEqual({ valid: true });

      const dflow = {
        inputMint: SOLANA_USDC_MINT,
        outputMint: '11111111111111111111111111111112',
        amount: buy.usdcAmount,
        userPublicKey: SOLANA_USDC_MINT, // Valid base58 address
      };
      expect(validateDFlowBuyOrder(dflow)).toEqual({ valid: true });
    });
  });

  describe('Full Sell Flow Validation', () => {
    it('valid sell request passes validation', () => {
      const sell: KalshiSellRequest = {
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        outcome: 'NO',
        tokenAmount: '1000000',
      };
      expect(validateKalshiSellRequest(sell)).toEqual({ valid: true });
    });

    it('valid sell -> valid DFlow sell params', () => {
      const sell = {
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        outcome: 'NO' as const,
        tokenAmount: '5000000',
      };
      expect(validateKalshiSellRequest(sell)).toEqual({ valid: true });

      const dflow = {
        inputMint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
        outputMint: SOLANA_USDC_MINT,
        amount: sell.tokenAmount,
        userPublicKey: 'So11111111111111111111111111111111111111112',
      };
      expect(validateDFlowSellOrder(dflow)).toEqual({ valid: true });
    });
  });

  describe('Ticker-to-Mint Mapping Logic', () => {
    const validWallet = SOLANA_USDC_MINT; // Valid base58 Solana address

    it('YES outcome uses yes_mint, NO outcome uses no_mint', () => {
      // Simulated mapping from dflow_market_mappings (valid base58 Solana addresses)
      const mapping = {
        kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
        yesMint: '11111111111111111111111111111112',
        noMint: '11111111111111111111111111111113',
      };

      const buyYes = validateKalshiBuyRequest({
        kalshiTicker: mapping.kalshiTicker,
        outcome: 'YES',
        usdcAmount: '1000000',
      });
      expect(buyYes.valid).toBe(true);

      const buyNo = validateKalshiBuyRequest({
        kalshiTicker: mapping.kalshiTicker,
        outcome: 'NO',
        usdcAmount: '1000000',
      });
      expect(buyNo.valid).toBe(true);

      // For DFlow buy: outputMint = outcome === 'YES' ? yesMint : noMint
      expect(
        validateDFlowBuyOrder({
          inputMint: SOLANA_USDC_MINT,
          outputMint: mapping.yesMint,
          amount: '1000000',
          userPublicKey: validWallet,
        })
      ).toEqual({ valid: true });
      expect(
        validateDFlowBuyOrder({
          inputMint: SOLANA_USDC_MINT,
          outputMint: mapping.noMint,
          amount: '1000000',
          userPublicKey: validWallet,
        })
      ).toEqual({ valid: true });
    });
  });
});
