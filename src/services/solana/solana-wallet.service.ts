/**
 * Solana Wallet Service
 * Manages Privy Solana embedded wallets for US/Kalshi users
 */

import { logger } from '../../config/logger';
import { privyService } from '../privy/privy.service';
import { updateUserSolanaWallet } from '../privy/kalshi-user.service';

export interface CreateSolanaWalletResult {
  address: string;
  walletId?: string;
}

/**
 * Create a Solana embedded wallet for a user via Privy
 */
export async function createSolanaWallet(
  privyUserId: string
): Promise<CreateSolanaWalletResult> {
  const privyClient = (privyService as any).privyClient;
  if (!privyClient) {
    throw new Error('Privy client not initialized');
  }

  try {
    const walletsService = privyClient.wallets();
    const createRequest: any = {
      chain_type: 'solana',
      owner: { user_id: privyUserId },
    };

    const wallet = await walletsService.create(createRequest);
    if (!wallet || !wallet.address) {
      throw new Error('Privy returned wallet without address');
    }

    await updateUserSolanaWallet(privyUserId, wallet.address);

    const { addSolanaAddressToWebhook } = await import('../alchemy/alchemy-solana-webhook-addresses');
    addSolanaAddressToWebhook(wallet.address).catch(() => {});

    logger.info({
      message: 'Solana wallet created',
      privyUserId,
      address: wallet.address,
      walletId: wallet.id,
    });

    return {
      address: wallet.address,
      walletId: wallet.id,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({
      message: 'Failed to create Solana wallet',
      privyUserId,
      error: msg,
    });
    throw new Error(`Failed to create Solana wallet: ${msg}`);
  }
}

/**
 * Get Solana wallet ID for a user's Solana address
 */
export async function getSolanaWalletId(
  privyUserId: string,
  solanaAddress: string
): Promise<string | null> {
  return privyService.getWalletIdByAddress(privyUserId, solanaAddress);
}
