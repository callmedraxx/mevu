/**
 * Fiat On-Ramp Service
 * Generates on-ramp widget URLs for USDC deposits to Solana wallets
 */

import { logger } from '../../config/logger';

const ONRAMP_PROVIDER = process.env.ONRAMP_PROVIDER || 'moonpay';
const ONRAMP_API_KEY = process.env.ONRAMP_API_KEY || '';

export interface OnrampSessionResult {
  widgetUrl?: string;
  sessionToken?: string;
  provider: string;
}

/**
 * Generate on-ramp widget URL or session for USDC deposit to Solana wallet
 */
export async function createOnrampSession(
  solanaWalletAddress: string,
  privyUserId?: string
): Promise<OnrampSessionResult> {
  if (!ONRAMP_API_KEY) {
    logger.warn({ message: 'Onramp API key not configured' });
    return {
      provider: ONRAMP_PROVIDER,
      widgetUrl: `https://www.moonpay.com/buy/usdc_sol?walletAddress=${solanaWalletAddress}`,
    };
  }

  switch (ONRAMP_PROVIDER) {
    case 'moonpay': {
      const params = new URLSearchParams({
        apiKey: ONRAMP_API_KEY,
        currencyCode: 'usdc_sol',
        walletAddress: solanaWalletAddress,
        ...(privyUserId && { externalTransactionId: privyUserId }),
      });
      return {
        provider: 'moonpay',
        widgetUrl: `https://buy.moonpay.com?${params.toString()}`,
      };
    }
    case 'transak': {
      const params = new URLSearchParams({
        apiKey: ONRAMP_API_KEY,
        cryptoCurrencyCode: 'USDC',
        walletAddress: solanaWalletAddress,
        networks: 'solana',
      });
      return {
        provider: 'transak',
        widgetUrl: `https://global.transak.com/?${params.toString()}`,
      };
    }
    default:
      return {
        provider: ONRAMP_PROVIDER,
        widgetUrl: `https://www.moonpay.com/buy/usdc_sol?walletAddress=${solanaWalletAddress}`,
      };
  }
}
