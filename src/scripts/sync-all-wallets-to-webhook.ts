/**
 * Script to sync ALL embedded wallet addresses to Alchemy webhook
 * This includes:
 * 1. Embedded wallets from the CSV file (Privy export)
 * 2. Any existing wallets in the database
 * 
 * Run with: npx ts-node src/scripts/sync-all-wallets-to-webhook.ts
 */

import axios from 'axios';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import dotenv from 'dotenv';

// Load environment variables
const envPath = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });
dotenv.config();

const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN;
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID;

interface PaginatedAddressResponse {
  data: string[];
  pagination: {
    cursors: {
      after?: string;
    };
    total_count: number;
  };
}

/**
 * Get all addresses currently in the webhook (with pagination)
 */
async function getAllWebhookAddresses(): Promise<string[]> {
  if (!ALCHEMY_AUTH_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    throw new Error('ALCHEMY_AUTH_TOKEN and ALCHEMY_WEBHOOK_ID must be set');
  }

  const allAddresses: string[] = [];
  let cursor: string | undefined = undefined;
  let pageCount = 0;

  console.log('Fetching all addresses from Alchemy webhook...');

  while (true) {
    pageCount++;
    const params: Record<string, string> = {
      webhook_id: ALCHEMY_WEBHOOK_ID,
      limit: '100', // Max per page (Alchemy limit)
    };
    
    if (cursor) {
      params.after = cursor;
    }

    const response = await axios.get<PaginatedAddressResponse>(
      `${ALCHEMY_API_URL}/webhook-addresses`,
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
        params,
      }
    );

    const data = response.data;
    
    if (data.data && data.data.length > 0) {
      allAddresses.push(...data.data);
      console.log(`  Page ${pageCount}: fetched ${data.data.length} addresses (total so far: ${allAddresses.length})`);
    }

    // Check for more pages
    if (data.pagination?.cursors?.after) {
      cursor = data.pagination.cursors.after;
    } else {
      break;
    }
  }

  console.log(`\nTotal addresses in webhook: ${allAddresses.length}`);
  return allAddresses;
}

/**
 * Parse embedded wallet addresses from CSV
 */
function parseEmbeddedWalletsFromCSV(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) {
    return [];
  }

  // Parse header to find column index
  const header = lines[0].split('\t');
  const embeddedWalletIndex = header.indexOf('Embedded Ethereum accounts');

  if (embeddedWalletIndex === -1) {
    console.warn('Embedded Ethereum accounts column not found in CSV');
    return [];
  }

  const addresses: string[] = [];

  // Parse data rows (skip header)
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    const embeddedWallet = row[embeddedWalletIndex]?.trim();

    // Only include valid addresses (starting with 0x)
    if (embeddedWallet && embeddedWallet.startsWith('0x') && embeddedWallet.length === 42) {
      addresses.push(embeddedWallet.toLowerCase());
    }
  }

  return addresses;
}

/**
 * Add addresses to webhook in batches
 */
async function addAddressesToWebhook(addresses: string[]): Promise<{ success: number; failed: number }> {
  if (!ALCHEMY_AUTH_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    throw new Error('ALCHEMY_AUTH_TOKEN and ALCHEMY_WEBHOOK_ID must be set');
  }

  if (addresses.length === 0) {
    return { success: 0, failed: 0 };
  }

  const BATCH_SIZE = 500; // Alchemy limit
  const batches: string[][] = [];

  for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
    batches.push(addresses.slice(i, i + BATCH_SIZE));
  }

  console.log(`\nAdding ${addresses.length} addresses in ${batches.length} batch(es)...`);

  let successCount = 0;
  let failedCount = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    try {
      const response = await axios.patch(
        `${ALCHEMY_API_URL}/update-webhook-addresses`,
        {
          webhook_id: ALCHEMY_WEBHOOK_ID,
          addresses_to_add: batch,
          addresses_to_remove: [],
        },
        {
          headers: {
            'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
            'Content-Type': 'application/json',
          },
        }
      );

      successCount += batch.length;
      console.log(`  Batch ${i + 1}/${batches.length}: Added ${batch.length} addresses (status: ${response.status})`);
    } catch (error: any) {
      failedCount += batch.length;
      console.error(`  Batch ${i + 1}/${batches.length}: FAILED - ${error.response?.data?.message || error.message}`);
      
      // Log the first few addresses that failed for debugging
      console.error(`    First 3 addresses in failed batch: ${batch.slice(0, 3).join(', ')}`);
    }
  }

  return { success: successCount, failed: failedCount };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Alchemy Webhook Address Sync Tool');
  console.log('='.repeat(60));

  if (!ALCHEMY_AUTH_TOKEN) {
    console.error('\n❌ ALCHEMY_AUTH_TOKEN environment variable is not set');
    process.exit(1);
  }

  if (!ALCHEMY_WEBHOOK_ID) {
    console.error('\n❌ ALCHEMY_WEBHOOK_ID environment variable is not set');
    process.exit(1);
  }

  console.log(`\nWebhook ID: ${ALCHEMY_WEBHOOK_ID}`);

  try {
    // Step 1: Get current addresses in webhook
    console.log('\n' + '-'.repeat(60));
    console.log('Step 1: Checking current webhook addresses');
    console.log('-'.repeat(60));
    
    const currentAddresses = await getAllWebhookAddresses();
    const currentAddressSet = new Set(currentAddresses.map(a => a.toLowerCase()));

    // Step 2: Parse addresses from CSV
    console.log('\n' + '-'.repeat(60));
    console.log('Step 2: Parsing embedded wallets from CSV');
    console.log('-'.repeat(60));

    const csvPath = join(__dirname, '../../users.csv');
    console.log(`Reading from: ${csvPath}`);
    
    const csvAddresses = parseEmbeddedWalletsFromCSV(csvPath);
    console.log(`Found ${csvAddresses.length} embedded wallet addresses in CSV`);

    // Step 3: Find addresses that need to be added
    console.log('\n' + '-'.repeat(60));
    console.log('Step 3: Identifying addresses to add');
    console.log('-'.repeat(60));

    const addressesToAdd = csvAddresses.filter(addr => !currentAddressSet.has(addr.toLowerCase()));
    
    console.log(`Current addresses in webhook: ${currentAddresses.length}`);
    console.log(`Addresses from CSV: ${csvAddresses.length}`);
    console.log(`New addresses to add: ${addressesToAdd.length}`);
    console.log(`Already in webhook: ${csvAddresses.length - addressesToAdd.length}`);

    if (addressesToAdd.length === 0) {
      console.log('\n✅ All CSV addresses are already in the webhook!');
    } else {
      // Step 4: Add missing addresses
      console.log('\n' + '-'.repeat(60));
      console.log('Step 4: Adding missing addresses to webhook');
      console.log('-'.repeat(60));

      console.log('\nAddresses to add:');
      addressesToAdd.forEach((addr, i) => {
        console.log(`  ${i + 1}. ${addr}`);
      });

      const result = await addAddressesToWebhook(addressesToAdd);
      
      console.log('\n' + '-'.repeat(60));
      console.log('Results');
      console.log('-'.repeat(60));
      console.log(`Successfully added: ${result.success}`);
      console.log(`Failed: ${result.failed}`);
    }

    // Step 5: Verify final count
    console.log('\n' + '-'.repeat(60));
    console.log('Step 5: Verifying final address count');
    console.log('-'.repeat(60));

    const finalAddresses = await getAllWebhookAddresses();
    console.log(`\n✅ Final address count in webhook: ${finalAddresses.length}`);

    // Show summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Initial webhook addresses: ${currentAddresses.length}`);
    console.log(`CSV embedded wallets: ${csvAddresses.length}`);
    console.log(`Final webhook addresses: ${finalAddresses.length}`);
    console.log(`Net addresses added: ${finalAddresses.length - currentAddresses.length}`);

  } catch (error: any) {
    console.error('\n❌ Error:', error.response?.data || error.message);
    process.exit(1);
  }
}

main()
  .then(() => {
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
