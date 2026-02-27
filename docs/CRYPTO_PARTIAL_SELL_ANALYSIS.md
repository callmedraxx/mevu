# Crypto Partial Sell Analysis: 72 shares requested, only 41 sold

## What Happened

**BUY (16:15:45):**
- Requested: 72.46 shares at 0.69
- Actual fill: 73.53 shares at 0.68 (slightly better)
- Status: FILLED ✓

**SELL (16:18:59):**
- Requested: 72.65 shares at 0.91
- Actual fill: **41 shares** at 0.91
- Status: FILLED (but partial!)
- **~31.65 shares unaccounted for**

## Root Cause

### 1. Crypto markets override FOK → GTC limit

In `trading.service.ts` (lines 323-337):

```typescript
// Crypto markets: use GTC (limit) instead of FOK/FAK to avoid frequent "couldn't be fully filled" failures
const isCryptoMarket = marketInfo.metadata?.category === 'crypto';
const orderType = isCryptoMarket && (request.orderType === OrderType.FOK || request.orderType === OrderType.FAK)
  ? OrderType.LIMIT
  : request.orderType;
```

**FOK (Fill-Or-Kill):** All-or-nothing. Either the entire order fills or it's cancelled. No partial fills.

**GTC Limit:** Fill what you can immediately, post the rest on the order book. Partial fills allowed.

When the user clicked "sell all" with FOK, the backend silently converted it to a GTC limit order. Only 41 shares had matching buy liquidity at 0.91, so:
- 41 shares filled immediately ✓
- ~31.65 shares were posted to the order book as a resting sell order at 0.91

### 2. Where are the remaining ~31.65 shares?

They are **not lost**. They are in one of two states:

| Location | Description |
|----------|-------------|
| **User's position** | The user still owns ~31.65 shares (they're in the proxy wallet) |
| **Open order on book** | There's a resting limit sell order for ~31.65 shares at 0.91 on Polymarket |

If someone buys at 0.91, that order will fill and the user will sell the remaining shares. The user can also cancel the open order if they want to keep the shares or sell at a different price.

### 3. Fee overcharge

- **Charged:** 0.661115 USDC (1% of full order: 72.65 × 0.91 = 66.11)
- **Should have charged:** 0.373100 USDC (1% of actual fill: 41 × 0.91 = 37.31)
- **Overcharge:** ~0.29 USDC

The fee is transferred immediately when we get `status: 'matched'` from the CLOB, using the **requested** size (72.65 × 0.91). The actual fill data (41 shares) arrives later via `fetchAndUpdateTransactionHash` in the background—after the fee has already been transferred.

### 4. CLOB response has fill data we're not using

From the logs:
```
responseKeys: ['errorMsg', 'orderID', 'takingAmount', 'makingAmount', 'status', 'transactionsHashes', 'success']
hasMatchedOrders: false
sizeMatched: undefined
amountMatched: undefined
```

Polymarket uses `takingAmount` and `makingAmount` for fill amounts (not `size_matched`). For a SELL:
- `makingAmount` = shares sold
- `takingAmount` = USDC received

We're not reading these fields, so we could use them for immediate fill size and correct fee calculation.

## Recommended Fixes

### Fix 1: Don't use GTC for "sell all" on crypto (or surface clearly)

**Option A:** Keep FOK for crypto sells—if it fails with "couldn't be fully filled", return that error to the user instead of silently doing a partial fill. User expects all-or-nothing.

**Option B:** If we keep GTC for crypto, we must:
- Return `PARTIALLY_FILLED` status when we detect partial fill
- Show user: "41 of 72.65 shares sold. 31.65 shares at 0.91 resting on order book."
- Let user cancel the resting order if desired

### Fix 2: Use takingAmount/makingAmount for immediate fill size

Parse `orderResponse.takingAmount` and `orderResponse.makingAmount` from the CLOB response. For a SELL, `makingAmount` = shares filled. Use this to:
- Set correct `actualFillSize` in trade record immediately
- Calculate fee on actual fill: `feeAmount = actualFillSize * price * FEE_CONFIG.RATE`
- Only transfer fee after we have actual fill size (or use CLOB response if available)

### Fix 3: For limit orders, wait for fill data before fee transfer

For limit orders (which can have partial fills), defer the fee transfer until `fetchAndUpdateTransactionHash` completes and we have actual fill data. Then charge fee only on the actual fill amount.

### Fix 4: Aggregate multiple trades for partial fills

`findMatchingClobTrade` uses `.find()` and returns only the **first** matching trade. For a limit order that fills in multiple chunks over time, there could be multiple trades. We may need to aggregate all trades for the orderId to get total fill size.

## Summary

| Issue | Cause | Impact |
|-------|-------|--------|
| Only 41 of 72.65 sold | GTC limit allows partial fill; only 41 shares had liquidity at 0.91 | User thinks they sold all; ~31.65 resting on book |
| "Unaccounted" shares | User still owns them + open order on book | Confusion; shares not lost |
| Fee overcharge | Fee based on full order, not actual fill | ~$0.29 overcharged |
| Wrong status | We mark MATCHED as FILLED for limit orders | No indication of partial fill |

---

## Why the remaining shares don't show in positions

**Verified for user `did:privy:cmjx5296y007tji0c0eymk5f9` (proxy: `0x1a5ab60ae0cf623c553714c47cae52d84bf712e4`):**

The Polymarket Data API (`/positions?user=...`) returns only 8 positions, all with size < 1 share. The ~32-share position from the BTC crypto market is **not in the Data API response at all**.

Possible reasons:
1. **Open order locks shares** – When shares are in a resting sell order, the Data API may return net available (balance minus locked) = 0, so the position is excluded or shows as 0.
2. **Crypto markets not indexed** – The Data API may index only main Polymarket markets; crypto 5-min markets might use a different pipeline or have indexing delay.
3. **Different asset ID format** – Crypto CLOB token IDs might not match the Data API's asset format.

---

## Options to surface the "missing" shares

### Option 1: Fetch and display open orders (recommended)

The CLOB client has `getOpenOrders()` which returns the user's resting orders. The ~31.65 shares are in an open sell order at 0.91.

**Implementation:**
- Add an API endpoint: `GET /api/trading/open-orders?privyUserId=...`
- Call `clobClient.getOpenOrders()` (requires auth via user's CLOB client)
- Return open orders to the frontend
- Show in UI: "You have an open sell order for 31.65 shares at 0.91" with a cancel button

**Pros:** Directly shows where the shares are; user can cancel or wait for fill.  
**Cons:** Requires CLOB auth; need to map order token IDs to market metadata.

### Option 2: Stop overriding FOK → GTC for crypto sells

Revert the crypto override so sells use FOK. If liquidity is insufficient, the order fails with "couldn't be fully filled" instead of creating a partial fill + resting order.

**Pros:** No partial fills; user gets clear success or failure.  
**Cons:** More failed sells when liquidity is thin; worse UX for crypto.

### Option 3: Use FAK instead of GTC for crypto

FAK = Fill-And-Kill: fill what's available, cancel the rest. No resting orders.

**Pros:** Partial fills allowed, but no resting orders; no "ghost" positions.  
**Cons:** Unfilled portion is cancelled; user must retry to sell the rest.

### Option 4: Hybrid – try FOK first, fall back to GTC with clear messaging

1. Try FOK first.
2. If it fails with "couldn't be fully filled", retry as GTC.
3. After GTC, check `takingAmount`/`makingAmount` for partial fill.
4. If partial: return `PARTIALLY_FILLED`, show "X of Y sold; Z shares resting at price P" and surface open orders.

### Option 5: Fetch positions from CLOB/on-chain for crypto

Use `getBalanceAllowance` or on-chain token balances for crypto markets instead of the Data API.

**Pros:** May include locked shares or use a different indexing path.  
**Cons:** More work; CLOB balance API may not expose position size in the same way.

### Option 6: Add "Open orders" section to positions tab

Always fetch and display open orders alongside positions. Users see both:
- Positions (from Data API)
- Open orders (from CLOB `getOpenOrders`)

Shares in open orders are effectively "reserved" and can be shown as such.

---

## Recommended path

1. **Short term:** Implement Option 1 + 6 – add open orders API and UI so users can see and cancel resting orders.
2. **Medium term:** Implement Option 4 – FOK first, then GTC with clear partial-fill messaging.
3. **Fee fix:** Use `takingAmount`/`makingAmount` from the CLOB response to charge fee only on the actual fill amount.
