# Kalshi Shares Discrepancy Investigation

## Problem
User bought with $3 expecting ~6.25 shares at 48¢/share, but position shows:
- **5 shares** (expected 6.25)
- **50¢ avg** (expected 48¢)
- **47¢ current** → $2.35 value

## Investigation Summary

### 1. Data Flow

**Frontend (TradingWidget)** → sends `usdcAmount` (USDC in micro: $3 = 3_000_000)
- `totalCost` = user-entered $3
- `sharesFromDollar` = totalCost / (priceInCents/100) = 3/0.48 = **6.25** (estimate only)
- Sends **$3 USDC** to backend, NOT "6.25 shares"

**Backend (kalshi-trading.service)**:
- Sends `amount: 3_000_000` to DFlow `getBuyOrder`
- DFlow returns: `inAmount` (actual USDC used), `outAmount` (tokens received), optional `platformFee`
- Saves `input_amount`, `output_amount` in `kalshi_trades_history`

**Position display**:
- **Shares** come from **on-chain** (Solana `getTokenAccountsByOwner`) via `getAllOutcomeTokenBalances`
- **Avg price** comes from `kalshi_trades_history` BUY fills: `(sum input_amount) / (sum output_amount)` in cents

### 2. Root Cause Analysis

The 5 shares shown are the **actual on-chain balance** – the source of truth. So DFlow delivered 5 shares.

| Scenario | Explanation |
|----------|-------------|
| **Slippage** | 10% `predictionMarketSlippageBps` allows worse fills. At 48¢ estimate, fill at 60¢ → 3/0.60 = **5 shares exactly** |
| **DFlow fees** | Prediction market fee formula: `0.08 × c × p × (1−p)`. For 5 contracts at 50¢: ~10¢ fee. Doesn't fully explain $0.50 gap |
| **Thin liquidity** | Order book may have filled at worse price |
| **Kalshi whole contracts** | Kalshi API uses whole numbers; DFlow/Solana tokens may differ |

Most likely: **execution price was worse than 48¢**. At 60¢ fill: $3 buys exactly 5 shares. Avg 50¢ suggests recorded `input_amount` ~$2.50 for 5 shares (e.g. after fees), or a different trade mix.

### 3. Verify Your Trade

Run the inspect script with your Privy user ID:

```bash
npx tsx src/scripts/inspect-kalshi-trades.ts YOUR_PRIVY_USER_ID
```

This shows:
- `input_amount` (USDC spent, 6 decimals)
- `output_amount` (tokens received, 6 decimals)
- Computed price in cents

If `output_amount` = 5_000_000 (5e6) and `input_amount` = 2_500_000 ($2.50), that explains avg 50¢ with 5 shares. The $0.50 difference would be DFlow fee + rent/other costs.

### 4. The $0.25 Gap (requested $3, inAmount $2.75)

When we send `amount: 3000000` ($3) to DFlow, the response has `inAmount: 2752455` ($2.75). The **$0.25 difference** is:

- **Not** in `platformFee` (null for async prediction market orders).
- **Likely** the DFlow prediction-market fee, collected on-chain but not exposed in the quote response for async execution.
- The Solana transaction debits the **full** requested amount ($3) from the user; ~$2.75 goes to the token swap, ~$0.25 to protocol/fee accounts.

We now log `unaccountedUsdc` and a note in the fund flow step. Verify on Solscan by inspecting the tx's USDC transfers.

### 5. Do We Charge Fees on Kalshi? **No.**

**MeVU does not charge any fees on Kalshi trades.**

- Kalshi DFlow params do **not** include `platformFeeBps`; we never pass it.
- Polymarket fee logic (`fee.service.ts`, `FEE_CONFIG`) is EVM-only (RelayerClient, proxy wallets). Kalshi uses Solana + DFlow and has no integration with that code.
- The ~$0.25–0.26 round-trip loss (e.g. 4.50 → 4.24 USDC) comes from **DFlow / prediction-market protocol fees** on the buy and/or sell legs, not from MeVU.

### 6. DFlow Fee Formula and Share Estimation

#### Official DFlow Fee Formula

From [DFlow Prediction Market Fees](https://dflow.mintlify.app/build/prediction-markets/prediction-market-fees):

```
fee = scale × c × p × (1 − p)
```

| Symbol | Meaning |
|--------|---------|
| **scale** | Taker fee tier (0.08–0.09). Assumed **Frost** (0.09) unless volume qualifies for Glacier/Steel/Obsidian. |
| **c** | Number of **contracts** (shares) traded |
| **p** | **Fill price** as probability (0.0–1.0), e.g. 48¢ → 0.48 |

The result is in **contracts** (shares). In USDC: `feeUsdc ≈ fee × p` (each share worth ~p dollars at settlement).

**Fee tiers** (30-day outcome token volume):

| Tier | 30D Volume | Taker scale |
|------|------------|------------|
| Frost | < $50M | **0.09** (default for most builders) |
| Glacier | $50–150M | 0.0875 |
| Steel | $150–300M | 0.085 |
| Obsidian | > $300M | 0.08 |

---

#### Worked Example: Our $3 Buy at 48¢

**Inputs:**

- User spends: **$3 USDC**
- Display price: **48¢** → `p = 0.48`
- Naive shares (no fees): `3 / 0.48 = 6.25`

**Actual DFlow response:**

- `inAmount`: **2,752,455** ($2.75) — USDC used for the swap  
- `outAmount`: **5,000,000** (5 shares) — tokens received  
- **Unaccounted (DFlow fee)**: `3.00 − 2.75 = $0.25`  
- **Effective execution price**: `2.75 / 5 = 55¢` per share

---

#### Why the Formula Doesn’t Match Exactly

**With formula:**
- `c = 5`, `p = 0.55` (fill price)
- `fee = 0.09 × 5 × 0.55 × 0.45 ≈ 0.11` (in contracts)
- In USDC: `0.11 × 0.55 ≈ $0.06` → much less than $0.25

Reasons the $0.25 doesn’t line up:

1. **Chicken-and-egg**: We don’t know `c` or true `p` until execution. We only have an estimate.
2. **Async orders**: For prediction-market async execution, `platformFee` is often null, so the fee structure isn’t exposed in the quote response.
3. **Other costs**: Solana rent, liquidity, and order-book impact can add cost beyond the basic formula.
4. **Formula units**: Docs say the fee is in contracts; conversion to USDC may differ in practice.

---

#### Frontend Estimation Logic

**1. Conservative fee estimate**

Assume a fraction of the spend goes to DFlow fees before the swap:

```
estimatedFeeUsdc = usdcAmount × FEE_ESTIMATE_PCT
```

- `FEE_ESTIMATE_PCT ≈ 0.08` (8%) for 40¢–60¢ markets  
- Higher near 50¢ (max `p × (1−p)`)

**2. Net USDC for shares**

```
usdcForShares = usdcAmount × (1 − FEE_ESTIMATE_PCT)
```

**3. Estimated shares**

```
estimatedShares = usdcForShares / (priceInCents / 100)
```

**4. Applying to our $3 @ 48¢ example**

- `FEE_ESTIMATE_PCT = 0.083` (~8.3%, since 0.25/3 ≈ 8.3%)
- `usdcForShares = 3 × (1 − 0.083) = 2.75`
- `estimatedShares = 2.75 / 0.48 ≈ 5.73` — closer to 5 than 6.25  
- Or with 10%: `2.7 / 0.48 ≈ 5.6`

**5. Slippage**

We use `predictionMarketSlippageBps = 1000` (10%). Fill can be 10% worse, e.g. 48¢ → 53¢:

```
minSharesWithSlippage = usdcForShares / (priceInCents/100 × 1.10)
```

For $2.75 @ 48¢ with 10% slippage: `2.75 / (0.48 × 1.10) ≈ 5.2`

---

#### Recommended Frontend Logic (Summary)

```typescript
// Constants (tune based on observed fills)
const DFLOW_FEE_ESTIMATE_PCT = 0.085;  // ~8.5% for mid-range markets
const SLIPPAGE_BPS = 1000;              // 10% - matches predictionMarketSlippageBps

// User enters: usdcAmount ($3), priceInCents (48)
const price = priceInCents / 100;                    // 0.48
const usdcForShares = usdcAmount * (1 - DFLOW_FEE_ESTIMATE_PCT);  // 3 * 0.915 = 2.75
const estimatedShares = usdcForShares / price;      // ~5.73
const minShares = usdcForShares / (price * (1 + SLIPPAGE_BPS/10000));  // ~5.2

// Display
// "Est. ~6 shares (min ~5 after fees & slippage)"
// "DFlow fee ~$0.25 (8.5%)"
```

**UX suggestions:**

1. Show **est. shares** and **min shares** (with fees + slippage).
2. Show **est. DFlow fee**: `usdcAmount × DFLOW_FEE_ESTIMATE_PCT`.
3. Keep labels like “Est.” or “~” to indicate these are approximations.

---

### 7. Recommendations

1. **Clarify UI**: Label "Est. Shares" as estimate; actual may vary due to execution price/slippage/fees.

2. **Log DFlow response**: Full trace logs include inAmount, outAmount, platformFee, unaccountedUsdc.

3. **Consider minOutAmount**: DFlow supports `otherAmountThreshold` (min output). We could derive from user's minimum acceptable shares and pass it, so the tx fails if fill is below threshold (rather than silently getting fewer shares).

4. **Pre-trade quote**: Optionally call DFlow first (without building tx) to show expected shares and min shares (after slippage) before user confirms.
