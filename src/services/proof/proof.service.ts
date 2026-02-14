/**
 * Proof KYC Verification Service
 * Integrates with DFlow's Proof identity verification system.
 * All prediction market buying on Kalshi requires Proof verification after Feb 20, 2026.
 *
 * Proof API: GET https://proof.dflow.net/verify/{solanaAddress} → { verified: boolean }
 * Deep link: https://dflow.net/proof?wallet={addr}&signature={sig}&timestamp={ts}&redirect_uri={uri}
 * Message format: "Proof KYC verification: {timestamp}" where timestamp is Unix milliseconds
 *
 * Best practices (per https://pond.dflow.net/build/proof/partner-integration):
 * - Cache verified status (stable post-confirmation); do NOT cache unverified (may change externally)
 * - Always verify server-side for sensitive operations (trade gate)
 * - Generate fresh signatures near redirect time
 */

import { logger } from '../../config/logger';
import { privyService } from '../privy/privy.service';

const PROOF_API_BASE = 'https://proof.dflow.net';
const PROOF_DEEP_LINK_BASE = 'https://dflow.net/proof';

// In-memory cache: only cache verified=true (permanent). Unverified is never cached
// because the user may verify via an external partner app at any time.
const verifiedCache = new Set<string>();

export async function checkVerification(solanaAddress: string): Promise<boolean> {
  // Verified status is permanent — return from cache
  if (verifiedCache.has(solanaAddress)) return true;

  try {
    const response = await fetch(`${PROOF_API_BASE}/verify/${solanaAddress}`);
    if (!response.ok) {
      logger.error({
        message: 'Proof verification API error',
        solanaAddress,
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    const data = (await response.json()) as { verified?: boolean };
    const verified = data.verified === true;

    if (verified) {
      verifiedCache.add(solanaAddress);
    }

    logger.info({
      message: 'Proof verification check',
      solanaAddress,
      verified,
    });

    return verified;
  } catch (error) {
    logger.error({
      message: 'Proof verification API call failed',
      solanaAddress,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function generateProofDeepLink(
  walletId: string,
  solanaAddress: string,
  redirectUri: string
): Promise<{ url: string }> {
  // Timestamp in milliseconds (13 digits) per DFlow Proof spec
  const timestamp = Date.now().toString();
  const message = `Proof KYC verification: ${timestamp}`;

  // Sign message via Privy server SDK
  const { signature } = await privyService.signSolanaMessage(
    walletId,
    new TextEncoder().encode(message)
  );

  // Construct deep link URL
  const params = new URLSearchParams({
    wallet: solanaAddress,
    signature,
    timestamp,
    redirect_uri: redirectUri,
  });

  const url = `${PROOF_DEEP_LINK_BASE}?${params.toString()}`;

  logger.info({
    message: 'Generated Proof deep link',
    solanaAddress,
    timestamp,
    redirectUri,
  });

  return { url };
}
