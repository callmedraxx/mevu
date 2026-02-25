/**
 * CLOB Client Service
 * Manages CLOB client instances for users with BuilderConfig integration
 * for gasless trading via Polymarket relayer
 */

import { ClobClient } from '@polymarket/clob-client';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { logger } from '../../../config/logger';
import { privyConfig } from '../../privy/privy.config';
import { createPrivySigner } from '../../privy/privy-signer.adapter';
import { privyService } from '../../privy/privy.service';
import { getUserByPrivyId, updateUserEmbeddedWalletId } from '../../privy/user.service';
import { UserProfile } from '../../privy/privy.types';

// Cache for CLOB client instances per user
const clobClientCache = new Map<string, {
  clobClient: ClobClient;
  privyUserId: string;
  proxyWalletAddress: string;
}>();

// Separate cache for API credentials — survives CLOB client cache clears
// so we don't re-derive API keys (500-2000ms) unnecessarily
const apiCredsCache = new Map<string, any>();

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Deployed Safe proxy wallet signature type (for gasless trading)

/**
 * Get or create CLOB client for a user
 * Uses RelayerClient for gasless trading via proxy wallet
 */
export async function getClobClientForUser(
  privyUserId: string,
  userJwt?: string,
  preloadedUser?: UserProfile
): Promise<ClobClient> {
  const startTime = Date.now();
  
  // Check cache first
  const cached = clobClientCache.get(privyUserId);
  if (cached) {
    logger.debug({
      message: 'Reusing cached CLOB client',
      privyUserId,
      proxyWalletAddress: cached.proxyWalletAddress,
      cacheHit: true,
    });
    return cached.clobClient;
  }

  // Get user info (use pre-fetched user if available to avoid redundant DB query)
  const userStartTime = Date.now();
  const user = preloadedUser || await getUserByPrivyId(privyUserId);
  const userTimeMs = Date.now() - userStartTime;
  
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet. Please deploy proxy wallet first.');
  }

  logger.info({
    message: 'Creating CLOB client for user (cache miss)',
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
    userQueryTimeMs: userTimeMs,
  });

  // Get wallet ID for faster signing — use cached DB value if available
  const walletIdStartTime = Date.now();
  let walletId = user.embeddedWalletId || null;
  if (!walletId) {
    walletId = await privyService.getWalletIdByAddress(
      privyUserId,
      user.embeddedWalletAddress
    );
    // Cache wallet ID in DB for future lookups
    if (walletId) {
      updateUserEmbeddedWalletId(privyUserId, walletId).catch((err) => {
        logger.warn({
          message: 'Failed to cache embedded wallet ID in DB',
          privyUserId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }
  const walletIdTimeMs = Date.now() - walletIdStartTime;

  // Create Privy signer adapter
  const signer = createPrivySigner(
    privyUserId,
    user.embeddedWalletAddress,
    walletId || undefined
  );

  // Create BuilderConfig for gasless trading via relayer
  // Use remote builder config (builder signing server)
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
  });

  // Create temporary CLOB client to get API credentials
  const tempClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer as any,
    undefined, // No API creds yet
    SIGNATURE_TYPE,
    user.proxyWalletAddress, // Funder address (proxy wallet)
    undefined,
    false,
    builderConfig // Builder config for gasless trading
  );
  
  // Get or create API credentials — check separate cache first
  let apiCreds = apiCredsCache.get(privyUserId);
  if (apiCreds) {
    logger.info({
      message: 'Reusing cached API credentials (skipping createOrDeriveApiKey)',
      privyUserId,
    });
  } else {
    // Try derive first (fast path for returning users — avoids wasted create attempt + extra sign).
    // Only fall back to createOrDeriveApiKey for genuinely new users.
    const apiCredsStartTime = Date.now();
    try {
      apiCreds = await tempClient.deriveApiKey();
      logger.info({
        message: 'Derived API key for CLOB client',
        privyUserId,
        durationMs: Date.now() - apiCredsStartTime,
      });
    } catch (deriveError) {
      // Derive failed — likely a new user with no API key yet. Fall back to create+derive.
      logger.info({
        message: 'deriveApiKey failed, trying createOrDeriveApiKey (new user)',
        privyUserId,
        deriveError: deriveError instanceof Error ? deriveError.message : String(deriveError),
      });
      try {
        apiCreds = await tempClient.createOrDeriveApiKey();
        logger.info({
          message: 'Created API key for CLOB client (new user)',
          privyUserId,
          durationMs: Date.now() - apiCredsStartTime,
        });
      } catch (createError) {
        const errorMessage = createError instanceof Error ? createError.message : String(createError);
        logger.error({
          message: 'Failed to create/derive API key for CLOB client',
          privyUserId,
          error: errorMessage,
        });
        throw new Error(`Failed to create API credentials: ${errorMessage}`);
      }
    }
    // Cache API credentials separately so they survive CLOB client cache clears
    apiCredsCache.set(privyUserId, apiCreds);
  }

  // Create CLOB client with API credentials and builder config
  // Builder config enables gasless trading via Polymarket relayer
  const clobClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer as any,
    apiCreds,
    SIGNATURE_TYPE,
    user.proxyWalletAddress, // Funder address (proxy wallet)
    undefined,
    false,
    builderConfig // Builder config for gasless trading
  );

  // Cache the client
  clobClientCache.set(privyUserId, {
    clobClient,
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
  });

  logger.info({
    message: 'CLOB client created and cached',
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
  });

  return clobClient;
}

/**
 * Clear CLOB client cache for a user
 */
export function clearClobClientCache(privyUserId: string): void {
  clobClientCache.delete(privyUserId);
  logger.debug({
    message: 'Cleared CLOB client cache',
    privyUserId,
  });
}

/**
 * Clear all CLOB client cache
 */
export function clearAllClobClientCache(): void {
  clobClientCache.clear();
  logger.debug({
    message: 'Cleared all CLOB client cache',
  });
}
