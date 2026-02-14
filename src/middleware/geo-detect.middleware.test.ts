/**
 * Unit Tests for Geo Detect Middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { geoDetectMiddleware, requireKalshiRegion } from './geo-detect.middleware';

const getClientIpMock = vi.fn();
const geoipLookupMock = vi.fn();

vi.mock('request-ip', () => ({
  default: { getClientIp: (...args: unknown[]) => getClientIpMock(...args) },
}));

vi.mock('geoip-lite', () => ({
  default: { lookup: (...args: unknown[]) => geoipLookupMock(...args) },
}));

vi.mock('../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Geo Detect Middleware', () => {
  const mockNext = vi.fn();
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReq = { headers: {} };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
  });

  describe('geoDetectMiddleware', () => {
    it('should set userRegion and userCountryCode from cf-ipcountry when present', () => {
      mockReq.headers['cf-ipcountry'] = 'US';
      geoDetectMiddleware(mockReq, mockRes, mockNext);
      expect(mockReq.userRegion).toBe('us');
      expect(mockReq.userCountryCode).toBe('US');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should set userRegion to international for non-US cf-ipcountry', () => {
      mockReq.headers['cf-ipcountry'] = 'GB';
      geoDetectMiddleware(mockReq, mockRes, mockNext);
      expect(mockReq.userRegion).toBe('international');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should use geoip when cf-ipcountry not present', () => {
      getClientIpMock.mockReturnValue('8.8.8.8');
      geoipLookupMock.mockReturnValue({ country: 'US' } as any);
      geoDetectMiddleware(mockReq, mockRes, mockNext);
      expect(mockReq.userRegion).toBe('us');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should default to international for localhost', () => {
      getClientIpMock.mockReturnValue('127.0.0.1');
      geoDetectMiddleware(mockReq, mockRes, mockNext);
      expect(mockReq.userRegion).toBe('international');
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('requireKalshiRegion', () => {
    it('should call next when GEO_ENFORCEMENT_ENABLED is false', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'false');
      mockReq.userRegion = 'international';
      mockReq.userCountryCode = 'GB';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should call next when userRegion is us (empty blocklist, backward compat)', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', '');
      mockReq.userRegion = 'us';
      mockReq.userCountryCode = 'US';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 403 when userRegion is international and blocklist empty (backward compat)', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', '');
      mockReq.userRegion = 'international';
      mockReq.userCountryCode = 'GB';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('United States'),
        })
      );
    });

    it('should allow whitelisted user from blocked country', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', 'CN,RU');
      vi.stubEnv('GEO_WHITELIST_PRIVY_IDS', 'did:privy:whitelisted-user');
      mockReq.userRegion = 'international';
      mockReq.userCountryCode = 'CN';
      mockReq.query = { privyUserId: 'did:privy:whitelisted-user' };
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should block non-whitelisted user from blocklisted country', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', 'CN,RU');
      vi.stubEnv('GEO_WHITELIST_PRIVY_IDS', '');
      mockReq.userRegion = 'international';
      mockReq.userCountryCode = 'CN';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('not available'),
          userCountryCode: 'CN',
        })
      );
    });

    it('should allow non-blocklisted country when blocklist is set', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', 'CN,RU');
      mockReq.userRegion = 'us';
      mockReq.userCountryCode = 'US';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should bypass geo for webhook paths', () => {
      vi.stubEnv('GEO_ENFORCEMENT_ENABLED', 'true');
      vi.stubEnv('GEO_BLOCKLIST_COUNTRIES', '');
      mockReq.path = '/deposit/webhook';
      mockReq.userRegion = 'international';
      mockReq.userCountryCode = 'GB';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });
});
