/**
 * DFlow Order Validation
 * Validates parameters for DFlow Trading API orders (prediction market outcome tokens)
 */

/** USDC mint on Solana */
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Solana address format: base58, 32-44 chars */
const SOLANA_ADDRESS_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface DFlowOrderParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  userPublicKey: string;
  slippageBps?: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

function isPositiveIntegerString(s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed === '' || trimmed.startsWith('-')) return false;
  return /^\d+$/.test(trimmed);
}

function isValidSolanaAddress(addr: string): boolean {
  return typeof addr === 'string' && SOLANA_ADDRESS_REGEX.test(addr.trim());
}

/**
 * Validates parameters for a DFlow buy order (USDC -> outcome token).
 */
export function validateDFlowBuyOrder(params: Partial<DFlowOrderParams>): ValidationResult {
  if (!params.inputMint || params.inputMint !== SOLANA_USDC_MINT) {
    return { valid: false, error: 'inputMint must be USDC on Solana' };
  }

  if (!params.outputMint || typeof params.outputMint !== 'string') {
    return { valid: false, error: 'Missing or invalid outputMint (outcome token)' };
  }
  if (!isValidSolanaAddress(params.outputMint)) {
    return { valid: false, error: 'outputMint must be a valid Solana address' };
  }

  if (!params.amount || !isPositiveIntegerString(params.amount) || params.amount === '0') {
    return { valid: false, error: 'amount must be a positive integer (USDC scaled 6 decimals)' };
  }
  if (BigInt(params.amount) < BigInt('10000')) {
    return { valid: false, error: 'amount below minimum (0.01 USDC)' };
  }

  if (!params.userPublicKey || !isValidSolanaAddress(params.userPublicKey)) {
    return { valid: false, error: 'userPublicKey must be a valid Solana wallet address' };
  }

  if (params.slippageBps !== undefined) {
    if (typeof params.slippageBps !== 'number' || params.slippageBps < 0 || params.slippageBps > 1000) {
      return { valid: false, error: 'slippageBps must be 0-1000' };
    }
  }

  return { valid: true };
}

/**
 * Validates parameters for a DFlow sell order (outcome token -> USDC).
 */
export function validateDFlowSellOrder(params: Partial<DFlowOrderParams>): ValidationResult {
  if (!params.inputMint || typeof params.inputMint !== 'string') {
    return { valid: false, error: 'Missing or invalid inputMint (outcome token)' };
  }
  if (!isValidSolanaAddress(params.inputMint)) {
    return { valid: false, error: 'inputMint must be a valid Solana address' };
  }

  if (!params.outputMint || params.outputMint !== SOLANA_USDC_MINT) {
    return { valid: false, error: 'outputMint must be USDC on Solana' };
  }

  if (!params.amount || !isPositiveIntegerString(params.amount) || params.amount === '0') {
    return { valid: false, error: 'amount must be a positive integer (token amount)' };
  }

  if (!params.userPublicKey || !isValidSolanaAddress(params.userPublicKey)) {
    return { valid: false, error: 'userPublicKey must be a valid Solana wallet address' };
  }

  return { valid: true };
}
