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
    it('should set userRegion from cf-ipcountry when present', () => {
      mockReq.headers['cf-ipcountry'] = 'US';
      geoDetectMiddleware(mockReq, mockRes, mockNext);
      expect(mockReq.userRegion).toBe('us');
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
    it('should call next when userRegion is us', () => {
      mockReq.userRegion = 'us';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return 403 when userRegion is international and enforcement enabled', () => {
      const orig = process.env.GEO_ENFORCEMENT_ENABLED;
      process.env.GEO_ENFORCEMENT_ENABLED = 'true';
      mockReq.userRegion = 'international';
      requireKalshiRegion(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('United States'),
        })
      );
      process.env.GEO_ENFORCEMENT_ENABLED = orig;
    });
  });
});
