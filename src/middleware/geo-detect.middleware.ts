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
      userCountryCode?: string;
    }
  }
}

function getGeoBlocklist(): string[] {
  return (process.env.GEO_BLOCKLIST_COUNTRIES ?? '')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
}

function getGeoWhitelist(): Set<string> {
  return new Set(
    (process.env.GEO_WHITELIST_PRIVY_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
  );
}

/**
 * Middleware that detects region from IP and sets req.userRegion, req.userCountryCode.
 * Supports Cloudflare cf-ipcountry header when behind Cloudflare.
 */
export function geoDetectMiddleware(req: Request, _res: Response, next: NextFunction): void {
  try {
    // Prefer Cloudflare header when available (more reliable)
    const cfCountry = req.headers['cf-ipcountry'] as string | undefined;
    if (cfCountry && cfCountry.length === 2 && cfCountry !== 'XX') {
      req.userCountryCode = cfCountry.toUpperCase();
      req.userRegion = getRegionFromCountryCode(cfCountry);
      return next();
    }

    const clientIp = requestIp.getClientIp(req);
    if (!clientIp || clientIp === '::1' || clientIp === '127.0.0.1') {
      req.userRegion = 'international'; // Default for localhost
      req.userCountryCode = undefined;
      return next();
    }

    const geo = geoip.lookup(clientIp);
    const countryCode = geo?.country ?? undefined;
    req.userCountryCode = countryCode?.toUpperCase();
    req.userRegion = getRegionFromCountryCode(countryCode);
    next();
  } catch (error) {
    logger.warn({
      message: 'Geo detection failed, defaulting to international',
      error: error instanceof Error ? error.message : String(error),
    });
    req.userRegion = 'international';
    req.userCountryCode = undefined;
    next();
  }
}

/**
 * Middleware that enforces geo restrictions for Kalshi trading routes.
 * - GEO_ENFORCEMENT_ENABLED=false: allow all users
 * - GEO_ENFORCEMENT_ENABLED=true: block countries in GEO_BLOCKLIST_COUNTRIES,
 *   except users in GEO_WHITELIST_PRIVY_IDS.
 * - If GEO_BLOCKLIST_COUNTRIES is empty: backward compat, block non-US only.
 * - Webhook paths are bypassed (server-to-server, no user geo applies).
 */
export function requireKalshiRegion(req: Request, res: Response, next: NextFunction): void {
  if (process.env.GEO_ENFORCEMENT_ENABLED !== 'true') {
    return next();
  }

  if (req.path?.includes('/webhook')) {
    return next();
  }

  const privyUserId = (req.body?.privyUserId ?? req.query?.privyUserId) as string | undefined;
  if (privyUserId && getGeoWhitelist().has(privyUserId.trim())) {
    return next();
  }

  const country = req.userCountryCode ?? '';
  const blocklist = getGeoBlocklist();

  if (blocklist.length > 0) {
    if (blocklist.includes(country)) {
      res.status(403).json({
        success: false,
        error: 'Kalshi trading is not available in your region',
        userCountryCode: country || 'unknown',
      });
      return;
    }
    return next();
  }

  // Backward compat: empty blocklist = US-only (legacy behavior)
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
