/**
 * Unit Tests for Kalshi Trade Validation
 * Tests buy/sell request validation logic
 */

import { describe, it, expect } from 'vitest';
import {
  validateKalshiBuyRequest,
  validateKalshiSellRequest,
  type KalshiBuyRequest,
  type KalshiSellRequest,
} from './kalshi-trade-validation';

describe('Kalshi Trade Validation', () => {
  describe('validateKalshiBuyRequest', () => {
    const validBuy: KalshiBuyRequest = {
      kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
      outcome: 'YES',
      usdcAmount: '1000000', // 1 USDC
    };

    it('should accept valid buy request', () => {
      expect(validateKalshiBuyRequest(validBuy)).toEqual({ valid: true });
    });

    it('should accept valid request with slippage', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, slippageBps: 50 })).toEqual({ valid: true });
    });

    it('should accept UFC ticker format', () => {
      expect(
        validateKalshiBuyRequest({
          ...validBuy,
          kalshiTicker: 'KXUFCFIGHT-26FEB01MIC1MAR14',
        })
      ).toEqual({ valid: true });
    });

    it('should reject missing kalshiTicker', () => {
      const result = validateKalshiBuyRequest({ ...validBuy, kalshiTicker: '' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('kalshiTicker');
    });

    it('should reject invalid ticker format', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, kalshiTicker: 'invalid' })).toEqual({
        valid: false,
        error: 'Invalid kalshiTicker format',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, kalshiTicker: 'KXNBAGAME' })).toEqual({
        valid: false,
        error: 'Invalid kalshiTicker format',
      });
    });

    it('should reject invalid outcome', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, outcome: 'MAYBE' as any })).toEqual({
        valid: false,
        error: 'outcome must be "YES" or "NO"',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, outcome: '' as any })).toEqual({
        valid: false,
        error: 'outcome must be "YES" or "NO"',
      });
    });

    it('should reject missing or invalid usdcAmount', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, usdcAmount: '' })).toEqual({
        valid: false,
        error: 'Missing or invalid usdcAmount',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, usdcAmount: '-100' })).toEqual({
        valid: false,
        error: 'usdcAmount must be a positive integer (scaled 6 decimals)',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, usdcAmount: '1.5' })).toEqual({
        valid: false,
        error: 'usdcAmount must be a positive integer (scaled 6 decimals)',
      });
    });

    it('should reject usdcAmount below minimum (0.01 USDC = 10000)', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, usdcAmount: '9999' })).toEqual({
        valid: false,
        error: 'usdcAmount below minimum (0.01 USDC)',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, usdcAmount: '10000' })).toEqual({ valid: true });
    });

    it('should reject invalid slippageBps', () => {
      expect(validateKalshiBuyRequest({ ...validBuy, slippageBps: -1 })).toEqual({
        valid: false,
        error: 'slippageBps must be 0-1000',
      });
      expect(validateKalshiBuyRequest({ ...validBuy, slippageBps: 1001 })).toEqual({
        valid: false,
        error: 'slippageBps must be 0-1000',
      });
    });
  });

  describe('validateKalshiSellRequest', () => {
    const validSell: KalshiSellRequest = {
      kalshiTicker: 'KXNBAGAME-26FEB05CHAHOU-CHA',
      outcome: 'NO',
      tokenAmount: '1000000',
    };

    it('should accept valid sell request', () => {
      expect(validateKalshiSellRequest(validSell)).toEqual({ valid: true });
    });

    it('should reject missing kalshiTicker', () => {
      const result = validateKalshiSellRequest({ ...validSell, kalshiTicker: '' });
      expect(result.valid).toBe(false);
    });

    it('should reject invalid ticker format', () => {
      expect(validateKalshiSellRequest({ ...validSell, kalshiTicker: 'x' })).toEqual({
        valid: false,
        error: 'Invalid kalshiTicker format',
      });
    });

    it('should reject invalid tokenAmount', () => {
      expect(validateKalshiSellRequest({ ...validSell, tokenAmount: '' })).toEqual({
        valid: false,
        error: 'Missing or invalid tokenAmount',
      });
      expect(validateKalshiSellRequest({ ...validSell, tokenAmount: '0' })).toEqual({
        valid: false,
        error: 'tokenAmount must be a positive integer',
      });
    });

    it('should accept NO outcome', () => {
      expect(validateKalshiSellRequest({ ...validSell, outcome: 'NO' })).toEqual({ valid: true });
    });
  });
});
