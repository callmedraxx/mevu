/**
 * Script to delete a user from the database by their embedded wallet address.
 * Usage: npx tsx src/scripts/delete-user-by-wallet.ts <embedded_wallet_address>
 *
 * Requires DATABASE_URL to be set (or NODE_ENV=production).
 */

import 'dotenv/config';
import { deleteUserByEmbeddedWallet } from '../services/privy/user.service';
import { logger } from '../config/logger';

const EMBEDDED_WALLET = '0x73d8C4A02AB1b1bb04912a9e1E87e898fb85c9Ab';

async function main() {
  const walletAddress = process.argv[2] || EMBEDDED_WALLET;

  if (!walletAddress || !walletAddress.startsWith('0x')) {
    console.error('Usage: npx tsx src/scripts/delete-user-by-wallet.ts <embedded_wallet_address>');
    console.error('Example: npx tsx src/scripts/delete-user-by-wallet.ts 0x73d8C4A02AB1b1bb04912a9e1E87e898fb85c9Ab');
    process.exit(1);
  }

  try {
    logger.info({ message: 'Deleting user by embedded wallet...', embeddedWalletAddress: walletAddress });

    const deleted = await deleteUserByEmbeddedWallet(walletAddress);

    if (deleted) {
      logger.info({ message: 'User deleted successfully', embeddedWalletAddress: walletAddress });
      console.log(`✅ User with embedded wallet ${walletAddress} has been deleted from the database`);
    } else {
      logger.warn({ message: 'User not found', embeddedWalletAddress: walletAddress });
      console.log(`⚠️ No user found with embedded wallet ${walletAddress}`);
    }

    process.exit(deleted ? 0 : 1);
  } catch (error) {
    logger.error({
      message: 'Failed to delete user',
      embeddedWalletAddress: walletAddress,
      error: error instanceof Error ? error.message : String(error),
    });

    console.error('❌ Error deleting user:', error);
    process.exit(1);
  }
}

main();
