/**
 * Kalshi Trade Validation
 * Validates buy/sell request parameters for Kalshi trading via DFlow
 */

export type KalshiTradeOutcome = 'YES' | 'NO';

export interface KalshiBuyRequest {
  kalshiTicker: string;
  outcome: KalshiTradeOutcome;
  usdcAmount: string;
  slippageBps?: number;
}

export interface KalshiSellRequest {
  kalshiTicker: string;
  outcome: KalshiTradeOutcome;
  tokenAmount: string;
  slippageBps?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/** Minimum USDC amount (6 decimals): 0.01 USDC */
const MIN_USDC_AMOUNT = '10000';
/** Maximum slippage basis points (10%) */
const MAX_SLIPPAGE_BPS = 1000;
/** Valid ticker pattern: KXNBAGAME-26FEB05CHAHOU-CHA or KXUFCFIGHT-26FEB01FIG1FIG2 */
const TICKER_REGEX = /^KX[A-Z]+-\d{2}[A-Z]{3}\d{2}[A-Z0-9]+(-[A-Z0-9]+)?$/;

function isPositiveIntegerString(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed.startsWith('-')) return false;
  return /^\d+$/.test(trimmed);
}

export function validateKalshiBuyRequest(req: Partial<KalshiBuyRequest>): ValidationResult {
  if (!req.kalshiTicker || typeof req.kalshiTicker !== 'string') {
    return { valid: false, error: 'Missing or invalid kalshiTicker' };
  }
  const ticker = req.kalshiTicker.trim();
  if (!TICKER_REGEX.test(ticker)) {
    return { valid: false, error: 'Invalid kalshiTicker format' };
  }

  if (!req.outcome || (req.outcome !== 'YES' && req.outcome !== 'NO')) {
    return { valid: false, error: 'outcome must be "YES" or "NO"' };
  }

  if (!req.usdcAmount || typeof req.usdcAmount !== 'string') {
    return { valid: false, error: 'Missing or invalid usdcAmount' };
  }
  if (!isPositiveIntegerString(req.usdcAmount)) {
    return { valid: false, error: 'usdcAmount must be a positive integer (scaled 6 decimals)' };
  }
  if (req.usdcAmount === '0' || BigInt(req.usdcAmount) < BigInt(MIN_USDC_AMOUNT)) {
    return { valid: false, error: 'usdcAmount below minimum (0.01 USDC)' };
  }

  if (req.slippageBps !== undefined) {
    if (typeof req.slippageBps !== 'number' || req.slippageBps < 0 || req.slippageBps > MAX_SLIPPAGE_BPS) {
      return { valid: false, error: `slippageBps must be 0-${MAX_SLIPPAGE_BPS}` };
    }
  }

  return { valid: true };
}

export function validateKalshiSellRequest(req: Partial<KalshiSellRequest>): ValidationResult {
  if (!req.kalshiTicker || typeof req.kalshiTicker !== 'string') {
    return { valid: false, error: 'Missing or invalid kalshiTicker' };
  }
  const ticker = req.kalshiTicker.trim();
  if (!TICKER_REGEX.test(ticker)) {
    return { valid: false, error: 'Invalid kalshiTicker format' };
  }

  if (!req.outcome || (req.outcome !== 'YES' && req.outcome !== 'NO')) {
    return { valid: false, error: 'outcome must be "YES" or "NO"' };
  }

  if (!req.tokenAmount || typeof req.tokenAmount !== 'string') {
    return { valid: false, error: 'Missing or invalid tokenAmount' };
  }
  if (!isPositiveIntegerString(req.tokenAmount) || req.tokenAmount === '0') {
    return { valid: false, error: 'tokenAmount must be a positive integer' };
  }

  if (req.slippageBps !== undefined) {
    if (typeof req.slippageBps !== 'number' || req.slippageBps < 0 || req.slippageBps > MAX_SLIPPAGE_BPS) {
      return { valid: false, error: `slippageBps must be 0-${MAX_SLIPPAGE_BPS}` };
    }
  }

  return { valid: true };
}
