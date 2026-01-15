/**
 * Script to subscribe embedded wallet addresses from CSV to Alchemy webhook
 * Parses users.csv and subscribes all embedded wallet addresses
 * 
 * Run with: npx ts-node src/scripts/subscribe-embedded-wallets-from-csv.ts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../config/logger';
import { alchemyWebhookService } from '../services/alchemy/alchemy-webhook.service';
import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables - try multiple paths
const envPath = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });
// Also try default location
dotenv.config();

interface UserRow {
  id: string;
  embeddedWalletAddress: string;
}

function parseCSV(filePath: string): UserRow[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    throw new Error('CSV file must have at least a header and one data row');
  }

  // Parse header to find column indices
  const header = lines[0].split('\t');
  const idIndex = header.indexOf('ID');
  const embeddedWalletIndex = header.indexOf('Embedded Ethereum accounts');

  if (idIndex === -1) {
    throw new Error('ID column not found in CSV');
  }

  if (embeddedWalletIndex === -1) {
    throw new Error('Embedded Ethereum accounts column not found in CSV');
  }

  const users: UserRow[] = [];

  // Parse data rows (skip header)
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    const id = row[idIndex]?.trim();
    const embeddedWallet = row[embeddedWalletIndex]?.trim();

    // Only include rows with embedded wallet addresses (starting with 0x)
    if (id && embeddedWallet && embeddedWallet.startsWith('0x')) {
      users.push({
        id,
        embeddedWalletAddress: embeddedWallet,
      });
    }
  }

  return users;
}

async function subscribeEmbeddedWallets(): Promise<void> {
  try {
    logger.info({ message: 'Starting embedded wallet subscription from CSV...' });

    // Check if Alchemy is configured
    if (!process.env.ALCHEMY_AUTH_TOKEN) {
      logger.error({
        message: 'ALCHEMY_AUTH_TOKEN environment variable is not set.',
        note: 'Please set ALCHEMY_AUTH_TOKEN and optionally ALCHEMY_WEBHOOK_ID or ALCHEMY_WEBHOOK_URL',
      });
      process.exit(1);
    }

    // Initialize Alchemy webhook service
    await alchemyWebhookService.initialize();

    if (!alchemyWebhookService.isReady()) {
      logger.error({
        message: 'Alchemy webhook service is not ready. Please check configuration.',
        required: 'ALCHEMY_AUTH_TOKEN',
        optional: 'ALCHEMY_WEBHOOK_ID or ALCHEMY_WEBHOOK_URL',
      });
      process.exit(1);
    }

    // Parse CSV file
    const csvPath = join(__dirname, '../../users.csv');
    logger.info({ message: 'Parsing CSV file', path: csvPath });

    const users = parseCSV(csvPath);
    logger.info({
      message: 'Parsed embedded wallet addresses from CSV',
      count: users.length,
    });

    if (users.length === 0) {
      logger.warn({ message: 'No embedded wallet addresses found in CSV' });
      return;
    }

    // Batch subscribe all embedded wallets at once (more efficient)
    const addresses = users.map(u => u.embeddedWalletAddress);
    
    logger.info({
      message: 'Starting batch subscription process',
      totalAddresses: addresses.length,
    });

    let successCount = 0;
    let errorCount = 0;
    const errors: Array<{ id: string; address: string; error: string }> = [];

    try {
      // Add all addresses in one batch call
      await alchemyWebhookService.addAddresses(addresses);
      successCount = addresses.length;
      
      logger.info({
        message: 'Successfully batch-subscribed embedded wallets to Alchemy webhook',
        count: successCount,
      });
    } catch (error) {
      // If batch fails, try individual subscriptions
      logger.warn({
        message: 'Batch subscription failed, trying individual subscriptions',
        error: error instanceof Error ? error.message : String(error),
      });

      for (const user of users) {
        try {
          await alchemyWebhookService.addEmbeddedWalletAddress(
            user.embeddedWalletAddress,
            user.id
          );
          successCount++;
          
          if (successCount % 10 === 0) {
            logger.info({
              message: 'Progress: subscribing embedded wallets',
              processed: successCount,
              total: users.length,
            });
          }
        } catch (individualError: any) {
          errorCount++;
          const errorMessage = individualError instanceof Error ? individualError.message : String(individualError);
          errors.push({
            id: user.id,
            address: user.embeddedWalletAddress,
            error: errorMessage,
          });
          logger.error({
            message: 'Failed to subscribe embedded wallet',
            privyUserId: user.id,
            embeddedWalletAddress: user.embeddedWalletAddress,
            error: errorMessage,
          });
        }
      }
    }

    logger.info({
      message: 'Embedded wallet subscription completed',
      total: users.length,
      successful: successCount,
      failed: errorCount,
    });

    if (errors.length > 0) {
      logger.warn({
        message: 'Some subscriptions failed',
        errorCount: errors.length,
        errors: errors.slice(0, 10), // Log first 10 errors
      });
    }

    // Log all addresses that were successfully subscribed
    logger.info({
      message: 'Successfully subscribed embedded wallets',
      addresses: users
        .slice(0, successCount)
        .map(u => u.embeddedWalletAddress)
        .slice(0, 20), // Log first 20 addresses
      note: successCount > 20 ? `... and ${successCount - 20} more` : '',
    });

  } catch (error) {
    logger.error({
      message: 'Error during embedded wallet subscription',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  subscribeEmbeddedWallets()
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

export { subscribeEmbeddedWallets };
