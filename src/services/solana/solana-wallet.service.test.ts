/**
 * Unit Tests for Solana Wallet Service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../privy/privy.service', () => ({
  privyService: {
    getWalletIdByAddress: vi.fn(),
    privyClient: null,
  },
}));

vi.mock('../privy/kalshi-user.service', () => ({
  updateUserSolanaWallet: vi.fn().mockResolvedValue(true),
}));

describe('Solana Wallet Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSolanaWallet', () => {
    it('should create wallet and update user when Privy returns valid wallet', async () => {
      const { createSolanaWallet } = await import('./solana-wallet.service');
      const { privyService } = await import('../privy/privy.service');
      const { updateUserSolanaWallet } = await import('../privy/kalshi-user.service');

      (privyService as any).privyClient = {
        wallets: () => ({
          create: vi.fn().mockResolvedValue({
            id: 'wallet-123',
            address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
          }),
        }),
      };

      const result = await createSolanaWallet('did:privy:user1');
      expect(result.address).toBe('7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs');
      expect(result.walletId).toBe('wallet-123');
      expect(updateUserSolanaWallet).toHaveBeenCalledWith(
        'did:privy:user1',
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
      );
    });

    it('should throw when Privy client not initialized', async () => {
      const { createSolanaWallet } = await import('./solana-wallet.service');
      const { privyService } = await import('../privy/privy.service');
      (privyService as any).privyClient = null;

      await expect(createSolanaWallet('did:privy:user1')).rejects.toThrow(
        'Privy client not initialized'
      );
    });
  });

  describe('getSolanaWalletId', () => {
    it('should delegate to privyService.getWalletIdByAddress', async () => {
      const { getSolanaWalletId } = await import('./solana-wallet.service');
      const { privyService } = await import('../privy/privy.service');

      vi.mocked(privyService.getWalletIdByAddress).mockResolvedValue('wallet-456');

      const result = await getSolanaWalletId(
        'did:privy:user1',
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
      );
      expect(result).toBe('wallet-456');
      expect(privyService.getWalletIdByAddress).toHaveBeenCalledWith(
        'did:privy:user1',
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'
      );
    });
  });
});
