/**
 * Unit Tests for DFlow Order Validation
 * Tests order parameter validation for DFlow Trading API
 */

import { describe, it, expect } from 'vitest';
import {
  validateDFlowBuyOrder,
  validateDFlowSellOrder,
  SOLANA_USDC_MINT,
  type DFlowOrderParams,
} from './dflow-order-validation';

const VALID_SOLANA_ADDR = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const VALID_OUTCOME_MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('DFlow Order Validation', () => {
  describe('validateDFlowBuyOrder', () => {
    const validBuy: DFlowOrderParams = {
      inputMint: SOLANA_USDC_MINT,
      outputMint: VALID_OUTCOME_MINT,
      amount: '1000000',
      userPublicKey: VALID_SOLANA_ADDR,
    };

    it('should accept valid buy order params', () => {
      expect(validateDFlowBuyOrder(validBuy)).toEqual({ valid: true });
    });

    it('should reject wrong inputMint (must be USDC)', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, inputMint: 'wrong' })).toEqual({
        valid: false,
        error: 'inputMint must be USDC on Solana',
      });
    });

    it('should reject invalid outputMint', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, outputMint: '' })).toEqual({
        valid: false,
        error: 'Missing or invalid outputMint (outcome token)',
      });
      expect(validateDFlowBuyOrder({ ...validBuy, outputMint: 'short' })).toEqual({
        valid: false,
        error: 'outputMint must be a valid Solana address',
      });
    });

    it('should reject invalid amount', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, amount: '' })).toEqual({
        valid: false,
        error: 'amount must be a positive integer (USDC scaled 6 decimals)',
      });
      expect(validateDFlowBuyOrder({ ...validBuy, amount: '-1' })).toEqual({
        valid: false,
        error: 'amount must be a positive integer (USDC scaled 6 decimals)',
      });
      expect(validateDFlowBuyOrder({ ...validBuy, amount: '9999' })).toEqual({
        valid: false,
        error: 'amount below minimum (0.01 USDC)',
      });
    });

    it('should reject invalid userPublicKey', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, userPublicKey: '' })).toEqual({
        valid: false,
        error: 'userPublicKey must be a valid Solana wallet address',
      });
    });

    it('should accept valid slippageBps', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, slippageBps: 50 })).toEqual({ valid: true });
      expect(validateDFlowBuyOrder({ ...validBuy, slippageBps: 1000 })).toEqual({ valid: true });
    });

    it('should reject invalid slippageBps', () => {
      expect(validateDFlowBuyOrder({ ...validBuy, slippageBps: -1 })).toEqual({
        valid: false,
        error: 'slippageBps must be 0-1000',
      });
      expect(validateDFlowBuyOrder({ ...validBuy, slippageBps: 1001 })).toEqual({
        valid: false,
        error: 'slippageBps must be 0-1000',
      });
    });
  });

  describe('validateDFlowSellOrder', () => {
    const validSell: DFlowOrderParams = {
      inputMint: VALID_OUTCOME_MINT,
      outputMint: SOLANA_USDC_MINT,
      amount: '1000000',
      userPublicKey: VALID_SOLANA_ADDR,
    };

    it('should accept valid sell order params', () => {
      expect(validateDFlowSellOrder(validSell)).toEqual({ valid: true });
    });

    it('should reject wrong outputMint (must be USDC)', () => {
      expect(validateDFlowSellOrder({ ...validSell, outputMint: 'wrong' })).toEqual({
        valid: false,
        error: 'outputMint must be USDC on Solana',
      });
    });

    it('should reject invalid inputMint', () => {
      expect(validateDFlowSellOrder({ ...validSell, inputMint: '' })).toEqual({
        valid: false,
        error: 'Missing or invalid inputMint (outcome token)',
      });
    });

    it('should reject invalid amount', () => {
      expect(validateDFlowSellOrder({ ...validSell, amount: '0' })).toEqual({
        valid: false,
        error: 'amount must be a positive integer (token amount)',
      });
    });
  });

  describe('SOLANA_USDC_MINT', () => {
    it('should match expected USDC mint', () => {
      expect(SOLANA_USDC_MINT).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    });
  });
});
