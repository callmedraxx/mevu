# Kalshi: Position "Disappearing" After Failed Sell

## Symptom

User attempts to sell a Kalshi position. The sell fails (e.g. Privy "Insufficient gas credits balance"). The position then appears to disappear from the UI, even though the sell never executed and tokens remain on-chain.

## Root Causes (Two Issues)

### 1. users.solana_wallet_address null (primary — affected metadevcloud)

`getUnifiedPositions` previously used `user.solanaWalletAddress` from the users table only. When `users.solana_wallet_address` is null (e.g. wallet from trade history but never backfilled), we skipped Kalshi entirely and returned no positions even after page refresh.

**Fix:** Use `getSolanaAddressForKalshiUser(privyUserId)` which falls back to `kalshi_trades_history` when the users table has null. Migration `050_backfill_solana_wallet_address.sql` backfills the users table for affected users.

### 2. Frontend optimistic update (secondary)

**Kalshi positions are NOT stored in our database.** They are fetched live from on-chain. The backend never deletes Kalshi positions on sell failure.

Another possible cause is **frontend optimistic update**:

1. User clicks Sell
2. Frontend optimistically removes the position from the displayed list
3. API returns 400 (sell failed)
4. Frontend does not refetch positions or restore the removed item
5. Position appears "gone" until the user refreshes the page

## Backend Safeguards (Implemented)

- On sell failure, we **never**:
  - INSERT into `kalshi_trades_history`
  - Call `publishKalshiPositionUpdate`
  - Modify any position-related DB

- We now include `refetchPositions: true` in the error response when a sell fails. Frontend should refetch positions when receiving this hint.

## Frontend Fix

When a Kalshi sell returns `success: false`:

1. **Refetch positions** (e.g. call `GET /api/trading/positions?platform=kalshi` or the unified endpoint)
2. Or avoid optimistic removal: only remove the position after confirming `success: true`

## Verification

- Position remains on-chain: Solana token balance is unchanged
- `getKalshiPositions(solanaAddress)` should still return the position
- No backend code modifies Kalshi position state on failure
