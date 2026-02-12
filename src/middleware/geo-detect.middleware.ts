/**
 * Geo Detection Middleware
 * Detects user region from IP for Kalshi (US) vs Polymarket (international) routing
 */

import { Request, Response, NextFunction } from 'express';
import requestIp from 'request-ip';
import geoip from 'geoip-lite';
import { getRegionFromCountryCode, type TradingRegion } from '../utils/geo-region';
import { logger } from '../config/logger';

declare global {
  namespace Express {
    interface Request {
      userRegion?: TradingRegion;
    }
  }
}

const GEO_ENFORCEMENT_ENABLED = process.env.GEO_ENFORCEMENT_ENABLED === 'true';

/**
 * Middleware that detects region from IP and sets req.userRegion.
 * Supports Cloudflare cf-ipcountry header when behind Cloudflare.
 */
export function geoDetectMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    // Prefer Cloudflare header when available (more reliable)
    const cfCountry = req.headers['cf-ipcountry'] as string | undefined;
    if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX') {
      req.userRegion = getRegionFromCountryCode(cfCountry);
      return next();
    }

    const clientIp = requestIp.getClientIp(req);
    if (!clientIp || clientIp === '::1' || clientIp === '127.0.0.1') {
      req.userRegion = 'international'; // Default for localhost
      return next();
    }

    const geo = geoip.lookup(clientIp);
    const countryCode = geo?.country ?? undefined;
    req.userRegion = getRegionFromCountryCode(countryCode);
    next();
  } catch (error) {
    logger.warn({
      message: 'Geo detection failed, defaulting to international',
      error: error instanceof Error ? error.message : String(error),
    });
    req.userRegion = 'international';
    next();
  }
}

/**
 * Middleware that enforces US-only access for Kalshi trading routes.
 * Returns 403 if user is not in US region (when GEO_ENFORCEMENT_ENABLED).
 */
export function requireKalshiRegion(req: Request, res: Response, next: NextFunction): void {
  if (!GEO_ENFORCEMENT_ENABLED) {
    return next();
  }
  if (req.userRegion !== 'us') {
    res.status(403).json({
      success: false,
      error: 'Kalshi trading is only available to users in the United States',
      userRegion: req.userRegion ?? 'unknown',
    });
    return;
  }
  next();
}
