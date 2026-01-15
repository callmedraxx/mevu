/**
 * One-time script to sync all existing embedded wallets to Alchemy webhook
 * This ensures all existing users' embedded wallets are subscribed for balance monitoring
 * 
 * Run with: npx ts-node src/scripts/sync-embedded-wallets-to-webhook.ts
 */

import { pool } from '../config/database';
import { logger } from '../config/logger';
import { alchemyWebhookService } from '../services/alchemy/alchemy-webhook.service';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function syncAllEmbeddedWallets(): Promise<void> {
  try {
    logger.info({ message: 'Starting embedded wallet webhook sync...' });

    // Initialize Alchemy webhook service first
    await alchemyWebhookService.initialize();

    if (!alchemyWebhookService.isReady()) {
      logger.error({
        message: 'Alchemy webhook service is not ready. Please check configuration.',
      });
      process.exit(1);
    }

    // Get all users with embedded wallets
    const result = await pool.query(`
      SELECT privy_user_id, embedded_wallet_address 
      FROM users 
      WHERE embedded_wallet_address IS NOT NULL
      ORDER BY created_at ASC
    `);

    const users = result.rows;
    logger.info({
      message: 'Found users with embedded wallets',
      count: users.length,
    });

    if (users.length === 0) {
      logger.info({ message: 'No embedded wallets found to sync' });
      return;
    }

    // Subscribe each embedded wallet to Alchemy webhook
    let successCount = 0;
    let errorCount = 0;

    for (const user of users) {
      try {
        await alchemyWebhookService.addEmbeddedWalletAddress(
          user.embedded_wallet_address,
          user.privy_user_id
        );
        successCount++;
        
        if (successCount % 10 === 0) {
          logger.info({
            message: 'Progress: syncing embedded wallets',
            processed: successCount,
            total: users.length,
          });
        }
      } catch (error) {
        errorCount++;
        logger.error({
          message: 'Failed to sync embedded wallet',
          privyUserId: user.privy_user_id,
          embeddedWalletAddress: user.embedded_wallet_address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info({
      message: 'Embedded wallet webhook sync completed',
      total: users.length,
      successful: successCount,
      failed: errorCount,
    });

    // Also run the general sync to ensure all addresses (proxy + embedded) are synced
    logger.info({ message: 'Running general address sync...' });
    await alchemyWebhookService.syncAllAddresses();
    logger.info({ message: 'General address sync completed' });

  } catch (error) {
    logger.error({
      message: 'Error during embedded wallet webhook sync',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run if executed directly
if (require.main === module) {
  syncAllEmbeddedWallets()
    .then(() => {
      logger.info({ message: 'Script completed successfully' });
      process.exit(0);
    })
    .catch((error) => {
      logger.error({
        message: 'Script failed',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}

export { syncAllEmbeddedWallets };
