/**
 * Analyze webhook addresses to see breakdown of proxy vs embedded wallets
 * 
 * Run with: npx ts-node src/scripts/analyze-webhook-addresses.ts
 */

import axios from 'axios';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import dotenv from 'dotenv';
import { Pool } from 'pg';

// Load environment variables
const envPath = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });
dotenv.config();

// Create pool directly for this script
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN;
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID;

/**
 * Get all addresses currently in the webhook (with pagination)
 */
async function getAllWebhookAddresses(): Promise<string[]> {
  if (!ALCHEMY_AUTH_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    throw new Error('ALCHEMY_AUTH_TOKEN and ALCHEMY_WEBHOOK_ID must be set');
  }

  const allAddresses: string[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const params: Record<string, string> = {
      webhook_id: ALCHEMY_WEBHOOK_ID,
      limit: '100',
    };
    
    if (cursor) {
      params.after = cursor;
    }

    const response = await axios.get(
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
    }

    if (data.pagination?.cursors?.after) {
      cursor = data.pagination.cursors.after;
    } else {
      break;
    }
  }

  return allAddresses;
}

/**
 * Parse embedded wallet addresses from CSV
 */
function parseEmbeddedWalletsFromCSV(filePath: string): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  
  if (lines.length < 2) return [];

  const header = lines[0].split('\t');
  const embeddedWalletIndex = header.indexOf('Embedded Ethereum accounts');

  if (embeddedWalletIndex === -1) return [];

  const addresses: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t');
    const embeddedWallet = row[embeddedWalletIndex]?.trim();

    if (embeddedWallet && embeddedWallet.startsWith('0x') && embeddedWallet.length === 42) {
      addresses.push(embeddedWallet.toLowerCase());
    }
  }

  return addresses;
}

async function main() {
  console.log('='.repeat(60));
  console.log('Webhook Address Analysis');
  console.log('='.repeat(60));

  try {
    // Get all webhook addresses
    console.log('\nFetching webhook addresses...');
    const webhookAddresses = await getAllWebhookAddresses();
    const webhookAddressSet = new Set(webhookAddresses.map(a => a.toLowerCase()));
    console.log(`Total addresses in webhook: ${webhookAddresses.length}`);

    // Get CSV addresses
    const csvPath = join(__dirname, '../../users.csv');
    const csvAddresses = parseEmbeddedWalletsFromCSV(csvPath);
    const csvAddressSet = new Set(csvAddresses);
    console.log(`Embedded wallets in CSV: ${csvAddresses.length}`);

    // Get database addresses
    console.log('\nQuerying database...');
    const dbResult = await pool.query(`
      SELECT 
        privy_user_id,
        proxy_wallet_address,
        embedded_wallet_address
      FROM users 
      WHERE proxy_wallet_address IS NOT NULL OR embedded_wallet_address IS NOT NULL
    `);

    const dbProxyAddresses: string[] = [];
    const dbEmbeddedAddresses: string[] = [];
    
    dbResult.rows.forEach(row => {
      if (row.proxy_wallet_address) {
        dbProxyAddresses.push(row.proxy_wallet_address.toLowerCase());
      }
      if (row.embedded_wallet_address) {
        dbEmbeddedAddresses.push(row.embedded_wallet_address.toLowerCase());
      }
    });

    console.log(`Proxy wallets in DB: ${dbProxyAddresses.length}`);
    console.log(`Embedded wallets in DB: ${dbEmbeddedAddresses.length}`);

    // Analyze webhook addresses
    console.log('\n' + '-'.repeat(60));
    console.log('Webhook Address Breakdown');
    console.log('-'.repeat(60));

    let proxyInWebhook = 0;
    let embeddedInWebhook = 0;
    let csvOnlyInWebhook = 0;
    let unknownInWebhook = 0;

    const dbProxySet = new Set(dbProxyAddresses);
    const dbEmbeddedSet = new Set(dbEmbeddedAddresses);

    const unknownAddresses: string[] = [];

    for (const addr of webhookAddresses) {
      const lowerAddr = addr.toLowerCase();
      
      if (dbProxySet.has(lowerAddr)) {
        proxyInWebhook++;
      } else if (dbEmbeddedSet.has(lowerAddr)) {
        embeddedInWebhook++;
      } else if (csvAddressSet.has(lowerAddr)) {
        csvOnlyInWebhook++;
      } else {
        unknownInWebhook++;
        unknownAddresses.push(addr);
      }
    }

    console.log(`\nAddresses in webhook by type:`);
    console.log(`  - Proxy wallets (from DB): ${proxyInWebhook}`);
    console.log(`  - Embedded wallets (from DB): ${embeddedInWebhook}`);
    console.log(`  - Embedded wallets (CSV only, not in DB): ${csvOnlyInWebhook}`);
    console.log(`  - Unknown/Other: ${unknownInWebhook}`);

    // Check what's missing
    console.log('\n' + '-'.repeat(60));
    console.log('Missing from Webhook');
    console.log('-'.repeat(60));

    const missingProxy = dbProxyAddresses.filter(a => !webhookAddressSet.has(a));
    const missingEmbedded = dbEmbeddedAddresses.filter(a => !webhookAddressSet.has(a));
    const missingCSV = csvAddresses.filter(a => !webhookAddressSet.has(a));

    console.log(`\nProxy wallets NOT in webhook: ${missingProxy.length}`);
    if (missingProxy.length > 0 && missingProxy.length <= 10) {
      missingProxy.forEach(a => console.log(`  - ${a}`));
    }

    console.log(`Embedded wallets (DB) NOT in webhook: ${missingEmbedded.length}`);
    if (missingEmbedded.length > 0 && missingEmbedded.length <= 10) {
      missingEmbedded.forEach(a => console.log(`  - ${a}`));
    }

    console.log(`CSV wallets NOT in webhook: ${missingCSV.length}`);
    if (missingCSV.length > 0 && missingCSV.length <= 10) {
      missingCSV.forEach(a => console.log(`  - ${a}`));
    }

    if (unknownAddresses.length > 0) {
      console.log(`\nUnknown addresses in webhook (first 10):`);
      unknownAddresses.slice(0, 10).forEach(a => console.log(`  - ${a}`));
      if (unknownAddresses.length > 10) {
        console.log(`  ... and ${unknownAddresses.length - 10} more`);
      }
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total webhook addresses: ${webhookAddresses.length}`);
    console.log(`  - Proxy wallets: ${proxyInWebhook}`);
    console.log(`  - Embedded wallets: ${embeddedInWebhook + csvOnlyInWebhook}`);
    console.log(`  - Unknown: ${unknownInWebhook}`);
    console.log(`\nAll CSV addresses in webhook: ${missingCSV.length === 0 ? '✅ YES' : '❌ NO'}`);
    console.log(`All DB proxy wallets in webhook: ${missingProxy.length === 0 ? '✅ YES' : '❌ NO'}`);
    console.log(`All DB embedded wallets in webhook: ${missingEmbedded.length === 0 ? '✅ YES' : '❌ NO'}`);

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

main()
  .then(() => {
    console.log('\n✅ Analysis complete');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
