# Embedded Wallet Webhook Sync

## Overview

This document explains how existing embedded wallets are automatically subscribed to Alchemy webhooks for balance monitoring.

## Automatic Sync on Startup

The system automatically syncs all existing embedded wallets to Alchemy webhooks in two places:

### 1. Alchemy Webhook Service Initialization
- **Location**: `src/services/alchemy/alchemy-webhook.service.ts`
- **Method**: `syncAllAddresses()`
- **When**: Called during `alchemyWebhookService.initialize()` on server startup
- **What it does**: Syncs **both** proxy wallets AND embedded wallets to the webhook
- **Code**: Lines 332-363

### 2. Embedded Wallet Balance Service Initialization
- **Location**: `src/services/privy/embedded-wallet-balance.service.ts`
- **Method**: `syncAllEmbeddedWalletsToWebhook()`
- **When**: Called during `embeddedWalletBalanceService.initialize()` on server startup
- **What it does**: Specifically syncs all embedded wallets to the webhook
- **Code**: Lines 157-191

## For Existing Users

**Good news**: All existing embedded wallets are automatically synced on every server startup!

When the server starts:
1. `alchemyWebhookService.initialize()` runs first and syncs all addresses (proxy + embedded)
2. `embeddedWalletBalanceService.initialize()` runs and also syncs embedded wallets (redundant but safe)

This means:
- ✅ Existing users with embedded wallets are automatically subscribed on startup
- ✅ No manual intervention needed
- ✅ Happens automatically every time the server restarts

## One-Time Sync Script (Optional)

If you want to manually sync all embedded wallets without restarting the server, you can run:

```bash
npx ts-node src/scripts/sync-embedded-wallets-to-webhook.ts
```

This script:
- Initializes the Alchemy webhook service
- Fetches all users with embedded wallets from the database
- Subscribes each embedded wallet to the webhook
- Provides progress updates and error reporting

## New User Flow

For new users, embedded wallets are automatically subscribed:
1. **During Registration**: When `registerUserAndDeployWallet()` creates a new embedded wallet, it's immediately subscribed (Step 2.5)
2. **For Existing Users**: When an existing user is found, their embedded wallet is also subscribed (Step 1)

## Verification

To verify embedded wallets are subscribed, check the logs on server startup:

```
[INFO] Synced all user addresses (proxy + embedded) to Alchemy webhook
[INFO] Synced all embedded wallets to Alchemy webhook
```

## Troubleshooting

If embedded wallets are not being synced:

1. **Check Alchemy Configuration**:
   - `ALCHEMY_AUTH_TOKEN` must be set
   - `ALCHEMY_WEBHOOK_ID` or `ALCHEMY_WEBHOOK_URL` must be set

2. **Check Logs**:
   - Look for "Synced all user addresses" message
   - Look for "Synced all embedded wallets" message

3. **Manual Sync**:
   - Run the sync script: `npx ts-node src/scripts/sync-embedded-wallets-to-webhook.ts`

4. **Database Check**:
   ```sql
   SELECT privy_user_id, embedded_wallet_address 
   FROM users 
   WHERE embedded_wallet_address IS NOT NULL;
   ```

## Summary

- ✅ **Automatic**: All embedded wallets are synced on every server startup
- ✅ **Redundant**: Two services sync embedded wallets for safety
- ✅ **New Users**: Embedded wallets are subscribed immediately upon creation
- ✅ **Existing Users**: Embedded wallets are subscribed on next server startup
- ✅ **Manual Option**: Script available for one-time manual sync if needed

No action required - the system handles everything automatically!
