# Kalshi Positions & Trade History — Unified Widget Plan

## Overview

Unify the trade widget so **Positions** and **History** tabs display both Polymarket and Kalshi data, with clear platform indicators. Kalshi positions use the Kalshi sell endpoint. The active market switch stays on Kalshi after a successful trade unless the user manually switches.

---

## 0. DFlow Research — Positions & User Activity

### DFlow does NOT have a user positions or user activity API

Per [DFlow’s official “Track User Positions” recipe](https://pond.dflow.net/build/recipes/prediction-markets/track-positions.md), positions must be derived as follows:

1. **On-chain (Solana)** – Read wallet token balances
2. **DFlow Metadata API** – Filter outcome mints and fetch market metadata

### DFlow APIs used for positions

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/filter_outcome_mints` | Accept wallet mint addresses → return which are prediction-market outcome mints |
| `POST /api/v1/markets/batch` | Accept outcome mints → return market metadata (ticker, title, YES/NO, etc.) |

### DFlow Trades API (market-level, NOT user-specific)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/v1/trades?ticker=...` | All trades for a market (filter by ticker, timestamp) |
| `GET /api/v1/trades/by-mint/{mint}` | All trades for a market (looked up by mint) |

These return **market-level** trade flow, not per-user activity. For **user trade history**, we must use our `kalshi_trades_history` (recorded when users trade) or parse on-chain transactions. No DFlow endpoint provides “trades by wallet”.

### Positions flow (on-chain + DFlow)

```
Solana RPC: getParsedTokenAccountsByOwner(wallet, TOKEN_2022_PROGRAM_ID)
    → non-zero Token-2022 balances
    ↓
DFlow: POST /filter_outcome_mints { addresses: [...] }
    → outcomeMints (subset that are prediction tokens)
    ↓
DFlow: POST /markets/batch { mints: outcomeMints }
    → market metadata (ticker, title, yesMint, noMint)
    ↓
Map each token → position (YES/NO from account.yesMint/noMint match)
```

---

## 1. Data Shape Comparison

### Polymarket

| Field | Polymarket Position | Polymarket Trade |
|-------|---------------------|------------------|
| Identifier | `asset` (clobTokenId) | `clobTokenId`, `marketId` |
| Sell key | `asset` → clobTokenId | — |
| Size/shares | `size` | `size` |
| Price | `avgPrice`, `curPrice` (0–1) | `price` (0–1) |
| Value | `currentValue`, `initialValue` | `costUsdc` |
| PnL | `cashPnl`, `percentPnl` | — |
| Outcome | `outcome` (Yes/No) | `outcome` |
| Market info | `title`, `slug`, `eventSlug` | `marketQuestion` |

### Kalshi

| Field | Kalshi Position | Kalshi Trade |
|-------|-----------------|--------------|
| Identifier | `outcome_mint` | `outcome_mint`, `kalshi_ticker` |
| Sell key | `kalshi_ticker`, `outcome`, `tokenAmount` | — |
| Size/shares | `token_balance` (raw) | — |
| Price | `avg_entry_price` (0–100) | `price_per_token` |
| Value | `total_cost_usdc` | `input_amount`, `output_amount` |
| PnL | (derive from current price) | — |
| Outcome | `outcome` (YES/NO) | `outcome` |
| Market info | `market_title`, `kalshi_ticker` | `market_title` |

---

## 2. Backend Changes (This Repo)

### 2.1 Kalshi Positions — On-Chain + DFlow (DFlow's Official Recipe)

Positions are **not** derived from our trade history. Use DFlow's documented flow per [Track User Positions](https://pond.dflow.net/build/recipes/prediction-markets/track-positions.md):

1. **Solana RPC** — `getParsedTokenAccountsByOwner(userWallet, { programId: TOKEN_2022_PROGRAM_ID })`
   - Outcome tokens use Token-2022; keep only non-zero balances
2. **DFlow** — `POST /api/v1/filter_outcome_mints` with mint addresses (max 200) → `outcomeMints`
3. **DFlow** — `POST /api/v1/markets/batch` with mints → market metadata (ticker, title, yesMint/noMint)
4. **Map** each token → position (YES/NO from mint match; balance from tokenAmount)

**Implementation**: New `KalshiPositionsService` taking `solanaWalletAddress`, querying Solana RPC + DFlow metadata API.

### 2.2 Unified Positions API

**New endpoint:** `GET /api/trading/positions?privyUserId=...&platform=all|polymarket|kalshi`

Response shape (each position has `platform`):

```json
{
  "success": true,
  "positions": [
    {
      "platform": "polymarket",
      "id": "...",
      "asset": "clob_token_id",
      "size": "10.5",
      "avgPrice": "0.65",
      "curPrice": "0.72",
      "currentValue": "7.56",
      "initialValue": "6.83",
      "cashPnl": "0.73",
      "percentPnl": "10.7",
      "outcome": "Yes",
      "title": "Will X win?",
      "sellAction": { "type": "polymarket", "clobTokenId": "..." }
    },
    {
      "platform": "kalshi",
      "id": "...",
      "outcomeMint": "...",
      "kalshiTicker": "KXNBAGAME-26FEB19ATLPHI-ATL",
      "outcome": "YES",
      "tokenBalance": "1000000",
      "tokenBalanceHuman": "1.0",
      "avgEntryPrice": 37,
      "totalCostUsdc": "0.37",
      "marketTitle": "Atlanta at Philadelphia Winner?",
      "curPrice": 38,
      "sellAction": {
        "type": "kalshi",
        "kalshiTicker": "KXNBAGAME-26FEB19ATLPHI-ATL",
        "outcome": "YES",
        "tokenAmount": "1000000"
      }
    }
  ],
  "portfolio": 1250.50,
  "totalPositions": 5
}
```

- When `platform=kalshi`: call `GET /api/kalshi-trading/positions` and `GET /api/kalshi-trading/portfolio`.
- When `platform=polymarket`: call existing `GET /api/positions/:privyUserId`.
- When `platform=all`: merge both and add `platform` to each item.

### 2.3 Unified Trade History API

**New endpoint:** `GET /api/trading/history?privyUserId=...&platform=all|polymarket|kalshi`

Response shape:

```json
{
  "success": true,
  "trades": [
    {
      "platform": "polymarket",
      "id": "...",
      "side": "BUY",
      "outcome": "Yes",
      "size": "10",
      "price": "0.65",
      "costUsdc": "6.50",
      "marketQuestion": "Will X win?",
      "createdAt": "2026-02-17T...",
      "status": "FILLED",
      "transactionHash": "0x..."
    },
    {
      "platform": "kalshi",
      "id": "...",
      "side": "BUY",
      "outcome": "YES",
      "kalshiTicker": "KXNBAGAME-26FEB19ATLPHI-ATL",
      "inputAmount": "1000000",
      "outputAmount": "2702702",
      "pricePerToken": 37,
      "marketTitle": "Atlanta at Philadelphia Winner?",
      "createdAt": "2026-02-17T...",
      "status": "FILLED",
      "solanaSignature": "..."
    }
  ],
  "total": 20
}
```

- `trades_history` → Polymarket trades (add `platform: 'polymarket'`).
- `kalshi_trades_history` → Kalshi trades (add `platform: 'kalshi'`).
- Normalize: `costUsdc` vs `input_amount` (convert 6-decimal raw to human), `price` vs `price_per_token` (cents).

### 2.4 Kalshi Sell for Positions

Sell payload for Kalshi positions:

```typescript
POST /api/kalshi-trading/sell
{
  privyUserId: string,
  kalshiTicker: string,   // from position
  outcome: string,        // YES | NO
  tokenAmount: string    // raw 6-decimal, e.g. "1000000" for 1 share
}
```

`tokenAmount` comes from `token_balance` (or equivalent) on the position. Use the position’s `kalshi_ticker` and `outcome`.

---

## 3. Frontend Changes (Separate Repo)

### 3.1 Trade Widget — Positions Tab

- Use unified `GET /api/trading/positions?platform=all` (or respect current switch).
- Render each position with a badge: “Polymarket” or “Kalshi”.
- **Polymarket**: keep existing sell flow (CLOB sell with `asset`/clobTokenId).
- **Kalshi**: on sell click:
  - Call `POST /api/kalshi-trading/sell` with `kalshiTicker`, `outcome`, `tokenAmount` (from `token_balance` or human→raw).

### 3.2 Trade Widget — History Tab (Implemented)

- **Endpoint**: `GET /api/trading/history?privyUserId=...&platform=all|polymarket|kalshi`
- Show trades with platform badge: “Polymarket” or “Kalshi”.
- Normalize display: side, outcome, amount, price, date, status.

### 3.3 Active Market Switch Persistence

- After a **successful** Kalshi trade (buy or sell):
  - Do **not** switch the toggle back to Polymarket.
  - Keep the switch on Kalshi until the user changes it manually.
- Implementation idea:
  - Store `activePlatform: 'polymarket' | 'kalshi'` in component state or a small context.
  - On successful Kalshi trade: set `activePlatform = 'kalshi'` and do not reset.
  - Only change when the user clicks the switch.

---

## 4. Implementation Order

1. **Backend**
   - [ ] Add Kalshi positions via on-chain + DFlow (Solana RPC + filter_outcome_mints + markets/batch).
   - [ ] Add `GET /api/trading/positions` with `platform` support and normalized response.
   - [x] Add `GET /api/trading/history` with `platform` support and normalized response (done).
   - [ ] Document Kalshi sell payload for positions.

2. **Frontend**
   - [ ] Use unified positions API in the positions tab.
   - [ ] Use unified history API in the history tab.
   - [ ] Add platform badges.
   - [ ] Wire Kalshi sell button to `POST /api/kalshi-trading/sell`.
   - [ ] Preserve Kalshi selection on successful Kalshi trades (no auto-switch to Polymarket).

---

## 5. API Summary

| Endpoint | Purpose |
|----------|---------|
| `GET /api/trading/positions?privyUserId=&platform=all\|polymarket\|kalshi` | Unified positions |
| `GET /api/trading/history?privyUserId=&platform=all\|polymarket\|kalshi` | Unified trade history |
| `POST /api/kalshi-trading/sell` | Sell Kalshi position (kalshiTicker, outcome, tokenAmount) |

---

## 6. Kalshi Position → Sell Mapping

For each Kalshi position row:

- `kalshi_ticker` → `kalshiTicker`
- `outcome` → `outcome`
- `token_balance` (raw 6-decimal) → `tokenAmount`

Example: `token_balance: "1500000"` → sell 1.5 shares.
