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
import { getUserByPrivyId } from '../../privy/user.service';

// Cache for CLOB client instances per user
const clobClientCache = new Map<string, {
  clobClient: ClobClient;
  privyUserId: string;
  proxyWalletAddress: string;
}>();

const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Deployed Safe proxy wallet signature type (for gasless trading)

/**
 * Get or create CLOB client for a user
 * Uses RelayerClient for gasless trading via proxy wallet
 */
export async function getClobClientForUser(
  privyUserId: string,
  userJwt?: string
): Promise<ClobClient> {
  // Check cache first
  const cached = clobClientCache.get(privyUserId);
  if (cached) {
    logger.debug({
      message: 'Reusing cached CLOB client',
      privyUserId,
      proxyWalletAddress: cached.proxyWalletAddress,
    });
    return cached.clobClient;
  }

  // Get user info
  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    throw new Error('User not found');
  }

  if (!user.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet. Please deploy proxy wallet first.');
  }

  logger.info({
    message: 'Creating CLOB client for user',
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
  });

  // Get wallet ID for faster signing
  const walletId = await privyService.getWalletIdByAddress(
    privyUserId,
    user.embeddedWalletAddress
  );

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
  
  // Create or derive API key
  // Note: createOrDeriveApiKey() first tries to create, then derives if create fails
  // The first attempt may fail with "Could not create api key" which is expected
  // if an API key already exists - it will then derive successfully
  let apiCreds;
  try {
    apiCreds = await tempClient.createOrDeriveApiKey();
    logger.info({
      message: 'Created or derived API key for CLOB client',
      privyUserId,
      hasApiKey: !!apiCreds,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Check if this is a "could not create" error - try derive only
    if (errorMessage.toLowerCase().includes('could not create')) {
      logger.info({
        message: 'API key creation failed (expected if key exists), trying derive only',
        privyUserId,
      });
      try {
        apiCreds = await tempClient.deriveApiKey();
        logger.info({
          message: 'Successfully derived API key',
          privyUserId,
          hasApiKey: !!apiCreds,
        });
      } catch (deriveError) {
        logger.error({
          message: 'Failed to derive API key for CLOB client',
          privyUserId,
          error: deriveError instanceof Error ? deriveError.message : String(deriveError),
        });
        throw new Error(`Failed to derive API credentials: ${deriveError instanceof Error ? deriveError.message : String(deriveError)}`);
      }
    } else {
      logger.error({
        message: 'Failed to create/derive API key for CLOB client',
        privyUserId,
        error: errorMessage,
      });
      throw new Error(`Failed to create API credentials: ${errorMessage}`);
    }
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
