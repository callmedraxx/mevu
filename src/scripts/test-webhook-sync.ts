/**
 * Test script to check webhook sync status and manually trigger sync
 */

import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
const envPath = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });
dotenv.config();

async function testSync() {
  try {
    console.log('Testing Alchemy webhook sync...\n');

    // Import after env is loaded
    const { alchemyWebhookService } = await import('../services/alchemy/alchemy-webhook.service');
    const { pool } = await import('../config/database');

    // Initialize webhook service
    console.log('1. Initializing Alchemy webhook service...');
    await alchemyWebhookService.initialize();

    if (!alchemyWebhookService.isReady()) {
      console.error('❌ Alchemy webhook service is not ready');
      process.exit(1);
    }
    console.log('✅ Webhook service initialized\n');

    // Check database counts
    console.log('2. Checking database for addresses...');
    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT 
          proxy_wallet_address,
          embedded_wallet_address
        FROM users 
        WHERE proxy_wallet_address IS NOT NULL OR embedded_wallet_address IS NOT NULL
      `);

      const addresses: string[] = [];
      const proxyAddresses: string[] = [];
      const embeddedAddresses: string[] = [];

      result.rows.forEach(row => {
        if (row.proxy_wallet_address) {
          addresses.push(row.proxy_wallet_address);
          proxyAddresses.push(row.proxy_wallet_address);
        }
        if (row.embedded_wallet_address) {
          addresses.push(row.embedded_wallet_address);
          embeddedAddresses.push(row.embedded_wallet_address);
        }
      });

      const uniqueAddresses = [...new Set(addresses.map(a => a.toLowerCase()))];

      console.log(`   Total users with wallets: ${result.rows.length}`);
      console.log(`   Proxy wallets: ${proxyAddresses.length}`);
      console.log(`   Embedded wallets: ${embeddedAddresses.length}`);
      console.log(`   Unique addresses (total): ${uniqueAddresses.length}\n`);

      // Manually trigger sync
      console.log('3. Manually syncing all addresses to webhook...');
      console.log(`   This will add ${uniqueAddresses.length} addresses in batches of 500...\n`);

      await alchemyWebhookService.syncAllAddresses();

      console.log('\n✅ Sync completed!');
      console.log(`\nExpected addresses in Alchemy: ${uniqueAddresses.length}`);
      console.log('Please check your Alchemy dashboard to verify.\n');

    } finally {
      client.release();
      await pool.end();
    }

  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

testSync()
  .then(() => {
    console.log('Script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
