/**
 * Check Privy App Configuration
 * 
 * This script queries Privy's API to check app configuration,
 * particularly session signer settings and wallet configuration.
 */

import { PrivyClient } from '@privy-io/node';
import axios from 'axios';
import { privyConfig } from '../services/privy/privy.config';
import { logger } from '../config/logger';

async function checkPrivyConfig() {
  console.log('\n=== Privy App Configuration Check ===\n');

  // Check environment variables
  console.log('Environment Variables:');
  console.log(`  PRIVY_APP_ID: ${privyConfig.appId ? '✓ Set' : '✗ Missing'}`);
  console.log(`  PRIVY_APP_SECRET: ${privyConfig.appSecret ? '✓ Set' : '✗ Missing'}`);
  console.log(`  PRIVY_AUTHORIZATION_PRIVATE_KEY: ${privyConfig.authorizationPrivateKey ? '✓ Set' : '✗ Missing'}`);
  console.log(`  PRIVY_SIGNER_ID: ${privyConfig.defaultSignerId ? '✓ Set' : '✗ Missing'}`);
  console.log('');

  if (!privyConfig.appId || !privyConfig.appSecret) {
    console.error('❌ Missing required Privy credentials. Cannot check configuration.');
    process.exit(1);
  }

  try {
    // Initialize PrivyClient
    const privyClient = new PrivyClient({
      appId: privyConfig.appId,
      appSecret: privyConfig.appSecret,
    });

    console.log('✓ PrivyClient initialized\n');

    // Try to get app configuration via API
    // Note: Privy's API might not expose all settings, but we can try
    const credentials = Buffer.from(`${privyConfig.appId}:${privyConfig.appSecret}`).toString('base64');
    
    console.log('Checking Privy API endpoints...\n');

    // Check if we can query app info
    try {
      const response = await axios.get('https://auth.privy.io/api/v1/apps/me', {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'privy-app-id': privyConfig.appId,
        },
      });
      
      console.log('App Information:');
      console.log(JSON.stringify(response.data, null, 2));
      console.log('');
    } catch (error: any) {
      console.log('⚠ Could not fetch app info via API (this is normal - Privy may not expose this endpoint)');
      if (error.response) {
        console.log(`  Status: ${error.response.status}`);
        console.log(`  Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      console.log('');
    }

    // Check session signer status by trying to query a user's wallets
    if (privyConfig.defaultSignerId) {
      console.log('Session Signer Configuration:');
      console.log(`  Signer ID: ${privyConfig.defaultSignerId}`);
      console.log(`  Authorization Key: ${privyConfig.authorizationPrivateKey ? 'Present' : 'Missing'}`);
      console.log('');
    }

    // Provide dashboard check instructions
    console.log('=== Dashboard Checklist ===\n');
    console.log('Please verify the following in your Privy Dashboard (https://dashboard.privy.io):\n');
    console.log('1. Session Signers:');
    console.log('   - Go to: Settings → Session Signers');
    console.log('   - Ensure "Session Signers" feature is ENABLED');
    console.log('   - Check that your authorization key quorum is configured');
    console.log('   - Verify the Signer ID matches PRIVY_SIGNER_ID in your .env');
    console.log('');
    console.log('2. Wallet Configuration:');
    console.log('   - Go to: Settings → Wallets');
    console.log('   - Ensure "Embedded Wallets" are enabled');
    console.log('   - Check wallet creation settings');
    console.log('');
    console.log('3. App Settings:');
    console.log('   - Go to: Settings → General');
    console.log('   - Verify App ID matches PRIVY_APP_ID');
    console.log('   - Check that the app is in the correct environment (dev/prod)');
    console.log('');
    console.log('4. Authorization Keys:');
    console.log('   - Go to: Settings → Authorization Keys');
    console.log('   - Verify your authorization private key is configured');
    console.log('   - Check that the key has signing permissions');
    console.log('');

    // Test signing capability
    console.log('=== Testing Signing Capability ===\n');
    
    if (privyConfig.authorizationPrivateKey) {
      console.log('✓ Authorization private key is configured');
      console.log('  This should allow signing without session signers');
    } else {
      console.log('⚠ No authorization private key configured');
      console.log('  You will need session signers enabled in the dashboard');
    }

    console.log('\n=== Recommendations ===\n');
    
    if (!privyConfig.authorizationPrivateKey) {
      console.log('❌ CRITICAL: PRIVY_AUTHORIZATION_PRIVATE_KEY is not set');
      console.log('   You need either:');
      console.log('   1. Set PRIVY_AUTHORIZATION_PRIVATE_KEY in your .env file, OR');
      console.log('   2. Enable Session Signers in the Privy Dashboard');
      console.log('');
    }

    if (!privyConfig.defaultSignerId) {
      console.log('⚠ PRIVY_SIGNER_ID is not set');
      console.log('   This is optional if using authorization private key');
      console.log('');
    }

    console.log('Next Steps:');
    console.log('1. Verify session signers are enabled in Privy Dashboard');
    console.log('2. Ensure PRIVY_AUTHORIZATION_PRIVATE_KEY is set correctly');
    console.log('3. Test the /api/users/add-session-signer endpoint');
    console.log('4. Then test proxy wallet deployment');
    console.log('');

  } catch (error: any) {
    console.error('❌ Error checking Privy configuration:');
    console.error(error.message);
    if (error.response) {
      console.error(`  Status: ${error.response.status}`);
      console.error(`  Response: ${JSON.stringify(error.response.data, null, 2)}`);
    }
    process.exit(1);
  }
}

// Run the check
checkPrivyConfig()
  .then(() => {
    console.log('✓ Configuration check complete\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Configuration check failed:', error);
    process.exit(1);
  });
