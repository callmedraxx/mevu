/**
 * Unit Tests for Geo Region Utility
 * Tests country-to-region mapping for Kalshi (US) vs Polymarket (international)
 */

import { describe, it, expect } from 'vitest';
import {
  getRegionFromCountryCode,
  isKalshiRegion,
  isPolymarketRegion,
  type TradingRegion,
} from './geo-region';

describe('Geo Region Utility', () => {
  describe('getRegionFromCountryCode', () => {
    it('should return "us" for US country code', () => {
      expect(getRegionFromCountryCode('US')).toBe('us');
      expect(getRegionFromCountryCode('us')).toBe('us');
      expect(getRegionFromCountryCode('Us')).toBe('us');
    });

    it('should return "international" for non-US countries', () => {
      expect(getRegionFromCountryCode('GB')).toBe('international');
      expect(getRegionFromCountryCode('CA')).toBe('international');
      expect(getRegionFromCountryCode('DE')).toBe('international');
      expect(getRegionFromCountryCode('FR')).toBe('international');
      expect(getRegionFromCountryCode('JP')).toBe('international');
      expect(getRegionFromCountryCode('MX')).toBe('international');
    });

    it('should handle empty and invalid input', () => {
      expect(getRegionFromCountryCode('')).toBe('international');
      expect(getRegionFromCountryCode(null)).toBe('international');
      expect(getRegionFromCountryCode(undefined)).toBe('international');
      expect(getRegionFromCountryCode('  ')).toBe('international');
    });

    it('should trim whitespace', () => {
      expect(getRegionFromCountryCode('  US  ')).toBe('us');
      expect(getRegionFromCountryCode('  GB  ')).toBe('international');
    });
  });

  describe('isKalshiRegion', () => {
    it('should return true only for "us"', () => {
      expect(isKalshiRegion('us')).toBe(true);
      expect(isKalshiRegion('international')).toBe(false);
    });
  });

  describe('isPolymarketRegion', () => {
    it('should return true only for "international"', () => {
      expect(isPolymarketRegion('international')).toBe(true);
      expect(isPolymarketRegion('us')).toBe(false);
    });
  });

  describe('TradingRegion type', () => {
    it('should accept valid region values', () => {
      const us: TradingRegion = 'us';
      const intl: TradingRegion = 'international';
      expect(getRegionFromCountryCode('US')).toBe(us);
      expect(getRegionFromCountryCode('GB')).toBe(intl);
    });
  });
});
