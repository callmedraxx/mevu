/**
 * Check actual address count in Alchemy webhook via API
 */

import axios from 'axios';
import dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables
const envPath = resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });
dotenv.config();

const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const ALCHEMY_AUTH_TOKEN = process.env.ALCHEMY_AUTH_TOKEN;
const ALCHEMY_WEBHOOK_ID = process.env.ALCHEMY_WEBHOOK_ID;

async function checkWebhookAddressCount() {
  if (!ALCHEMY_AUTH_TOKEN || !ALCHEMY_WEBHOOK_ID) {
    console.error('❌ ALCHEMY_AUTH_TOKEN and ALCHEMY_WEBHOOK_ID must be set');
    process.exit(1);
  }

  try {
    console.log('Fetching webhook details from Alchemy API...\n');

    // Get webhook details
    const response = await axios.get(
      `${ALCHEMY_API_URL}/webhook/${ALCHEMY_WEBHOOK_ID}`,
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    const webhook = response.data?.data;
    
    if (!webhook) {
      console.error('❌ Could not fetch webhook details');
      console.log('Response:', JSON.stringify(response.data, null, 2));
      process.exit(1);
    }

    console.log('Webhook Details:');
    console.log(`  ID: ${webhook.id}`);
    console.log(`  Type: ${webhook.webhook_type}`);
    console.log(`  Network: ${webhook.network}`);
    console.log(`  URL: ${webhook.webhook_url}`);
    console.log(`  Addresses: ${webhook.addresses?.length || 0}`);
    
    if (webhook.addresses && webhook.addresses.length > 0) {
      console.log(`\n✅ Actual address count in Alchemy: ${webhook.addresses.length}`);
      console.log(`\nFirst 10 addresses:`);
      webhook.addresses.slice(0, 10).forEach((addr: string, i: number) => {
        console.log(`  ${i + 1}. ${addr}`);
      });
      if (webhook.addresses.length > 10) {
        console.log(`  ... and ${webhook.addresses.length - 10} more`);
      }
    } else {
      console.log('\n⚠️  No addresses found in webhook');
    }

    // Also check if there's a limit or pagination
    if (webhook.addresses && webhook.addresses.length === 100) {
      console.log('\n⚠️  WARNING: Address count is exactly 100.');
      console.log('   This might be a display/pagination limit in the API response.');
      console.log('   The actual webhook may have more addresses.');
    }

  } catch (error: any) {
    console.error('❌ Error fetching webhook details:');
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(`   Error: ${error.message}`);
    }
    process.exit(1);
  }
}

checkWebhookAddressCount()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
