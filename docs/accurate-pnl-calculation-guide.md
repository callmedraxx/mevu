# Accurate PnL Calculation Guide: Complete Implementation

This document explains the comprehensive approach used in the MEVU codebase to calculate accurate user Profit & Loss (PnL), including deposits, withdrawals, trades, and positions.

---

## Table of Contents

1. [Overview & Philosophy](#overview--philosophy)
2. [Data Sources & Database Schema](#data-sources--database-schema)
3. [Core PnL Calculation Strategy](#core-pnl-calculation-strategy)
4. [Step-by-Step Implementation](#step-by-step-implementation)
5. [Key Formulas](#key-formulas)
6. [Complete Flow Diagram](#complete-flow-diagram)

---

## Overview & Philosophy

### The Core Principle: **Wallet Transfers as Source of Truth**

The MEVU codebase uses **actual wallet transfer data** (on-chain USDC.e movements) as the primary source of truth for calculating PnL. This is more accurate than relying solely on trade records because:

1. **Blockchain is immutable** - Wallet transfers are recorded on-chain and cannot be missed
2. **Includes all activity** - Captures deposits, withdrawals, trades, fees, and any other transfers
3. **Independent verification** - Can cross-verify with trade records but doesn't depend on them
4. **Handles edge cases** - Works even if some trades aren't recorded (e.g., external trading)

### Three-Tier Data Architecture

```
┌─────────────────────────────────────────────────────────┐
│ TIER 1: ON-CHAIN TRANSFERS (Source of Truth)            │
│ • wallet_usdc_transfers table                           │
│ • All USDC.e movements to/from wallet                   │
│ • Tracked via Alchemy webhooks                          │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ TIER 2: TRADE RECORDS (Operational Data)                │
│ • trades_history table                                  │
│ • Individual buy/sell transactions                      │
│ • Used for detailed analysis & realized PnL             │
└─────────────────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────┐
│ TIER 3: CURRENT STATE (Snapshot Data)                   │
│ • wallet_balances table (current USDC balance)          │
│ • user_positions table (current positions)              │
│ • Live prices from Polymarket CLOB                      │
└─────────────────────────────────────────────────────────┘
```

---

## Data Sources & Database Schema

### 1. Wallet USDC Transfers Table

**Purpose**: Records ALL USDC.e transfers (incoming and outgoing) for each user wallet.

```sql
CREATE TABLE wallet_usdc_transfers (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL,
    privy_user_id VARCHAR(255) NOT NULL,
    transfer_type VARCHAR(10) NOT NULL,        -- 'in' or 'out'
    from_address VARCHAR(255) NOT NULL,        -- Source address
    to_address VARCHAR(255) NOT NULL,          -- Destination address
    amount_raw VARCHAR(78) NOT NULL,           -- Atomic units (string for uint256)
    amount_human DECIMAL(20, 6) NOT NULL,      -- Human-readable (6 decimals)
    transaction_hash VARCHAR(255) NOT NULL,    -- On-chain tx hash
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE,
    log_index INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_transfer UNIQUE (transaction_hash, log_index)
);
```

**How it's populated**:
- **Alchemy Webhooks**: Automatically records transfers when they occur on-chain
- **After trades**: Refreshes balance and records trade-related transfers
- **Manual deposits/withdrawals**: Recorded when detected

**Key Query Patterns**:
```sql
-- Get all deposits (external money in)
SELECT SUM(amount_human) 
FROM wallet_usdc_transfers 
WHERE privy_user_id = $1 
  AND transfer_type = 'in' 
  AND LOWER(from_address) NOT IN (/* Polymarket contracts */);

-- Get all withdrawals (external money out)
SELECT SUM(amount_human) 
FROM wallet_usdc_transfers 
WHERE privy_user_id = $1 
  AND transfer_type = 'out' 
  AND LOWER(to_address) NOT IN (/* Polymarket contracts */);

-- Get trading activity (money from/to Polymarket)
SELECT 
  SUM(CASE WHEN transfer_type = 'in' THEN amount_human ELSE 0 END) as trading_in,
  SUM(CASE WHEN transfer_type = 'out' THEN amount_human ELSE 0 END) as trading_out
FROM wallet_usdc_transfers 
WHERE privy_user_id = $1 
  AND LOWER(from_address) IN (/* Polymarket contracts */)
  OR LOWER(to_address) IN (/* Polymarket contracts */);
```

### 2. Trades History Table

**Purpose**: Records all buy/sell trades for calculating realized PnL per position.

```sql
CREATE TABLE trades_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  proxy_wallet_address VARCHAR(42) NOT NULL,
  
  -- Market information
  market_id VARCHAR(255) NOT NULL,
  clob_token_id VARCHAR(255) NOT NULL,        -- Unique position identifier
  outcome TEXT NOT NULL,
  
  -- Trade details
  side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  size DECIMAL(36, 18) NOT NULL,              -- Number of shares
  price DECIMAL(36, 18) NOT NULL,             -- Price per share
  cost_usdc DECIMAL(36, 18) NOT NULL,         -- Total cost (size * price)
  fee_usdc DECIMAL(36, 18) DEFAULT 0,
  
  -- Transaction details
  order_id VARCHAR(255),
  transaction_hash VARCHAR(66),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

**How it's populated**:
- After each successful trade via CLOB Client
- Includes all BUY and SELL orders
- Status tracks: PENDING, FILLED, PARTIALLY_FILLED, CANCELLED, FAILED

**Key Query Pattern** (Realized PnL per position):
```sql
WITH position_summary AS (
  SELECT 
    clob_token_id,
    SUM(CASE WHEN side = 'BUY' THEN cost_usdc ELSE 0 END) as total_buy_cost,
    SUM(CASE WHEN side = 'SELL' AND price < 0.99 THEN cost_usdc ELSE 0 END) as total_sell_proceeds,
    SUM(CASE WHEN side = 'SELL' AND price >= 0.99 THEN size * 1.0 ELSE 0 END) as total_redeem_proceeds
  FROM trades_history
  WHERE privy_user_id = $1 AND status = 'FILLED'
  GROUP BY clob_token_id
)
SELECT 
  (total_sell_proceeds + total_redeem_proceeds) - total_buy_cost as realized_pnl
FROM position_summary
WHERE total_sold_shares > 0 OR total_redeem_proceeds > 0;
```

### 3. Wallet Balances Table

**Purpose**: Stores current USDC.e balance (updated in real-time).

```sql
CREATE TABLE wallet_balances (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL UNIQUE,
    privy_user_id VARCHAR(255) NOT NULL,
    balance_raw VARCHAR(78) NOT NULL,
    balance_human DECIMAL(20, 6) NOT NULL,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

**How it's updated**:
- **Alchemy Webhooks**: On every transfer (incoming or outgoing)
- **After trades**: Refreshed after each trade completes
- **Polling backup**: QuickNode service polls every 2 seconds (redundancy)

### 4. User Positions Table

**Purpose**: Tracks current active positions from Polymarket.

```sql
CREATE TABLE user_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    privy_user_id VARCHAR(255) NOT NULL,
    clob_token_id VARCHAR(255) NOT NULL,
    market_id VARCHAR(255) NOT NULL,
    outcome TEXT NOT NULL,
    quantity DECIMAL(36, 18) NOT NULL,         -- Current position size
    average_price DECIMAL(36, 18),             -- Average buy price
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

**How it's updated**:
- Fetched from Polymarket Data API periodically
- Enriched with live prices from CLOB order book
- Used to calculate unrealized PnL

### 5. PnL History Table

**Purpose**: Stores historical PnL snapshots for charting over time.

```sql
CREATE TABLE user_pnl_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  
  -- P&L values
  total_pnl DECIMAL(36, 18) NOT NULL,
  realized_pnl DECIMAL(36, 18) NOT NULL DEFAULT 0,
  unrealized_pnl DECIMAL(36, 18) NOT NULL DEFAULT 0,
  
  -- Portfolio values
  portfolio_value DECIMAL(36, 18) NOT NULL DEFAULT 0,
  usdc_balance DECIMAL(36, 18) NOT NULL DEFAULT 0,
  total_value DECIMAL(36, 18) NOT NULL DEFAULT 0,
  
  -- Metadata
  active_positions_count INTEGER NOT NULL DEFAULT 0,
  total_positions_count INTEGER NOT NULL DEFAULT 0,
  total_percent_pnl DECIMAL(10, 4) NOT NULL DEFAULT 0,
  
  snapshot_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## Core PnL Calculation Strategy

### Step 1: Identify Transfer Categories

The system categorizes all transfers by checking the `from_address` and `to_address` against known Polymarket contract addresses:

```typescript
const POLYMARKET_CONTRACTS = [
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e', // CTF Exchange
  '0xc5d563a36ae78145c45a50134d48a1215220f80a', // Neg Risk CTF Exchange  
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045', // Conditional Tokens (redemptions)
  '0x23895ddd9d2a22215080c0529614e471e1006bdf', // Fee/Gas address
].map(addr => addr.toLowerCase());
```

**Categories**:
1. **External Deposits**: `transfer_type = 'in'` AND `from_address NOT IN Polymarket contracts`
2. **External Withdrawals**: `transfer_type = 'out'` AND `to_address NOT IN Polymarket contracts`
3. **Trading In**: `transfer_type = 'in'` AND `from_address IN Polymarket contracts` (sells, redemptions)
4. **Trading Out**: `transfer_type = 'out'` AND `to_address IN Polymarket contracts` (buys)

### Step 2: Calculate Trading P&L

Trading P&L is calculated from actual wallet movements to/from Polymarket:

```typescript
// Money received from Polymarket (sells, redemptions)
const tradingIn = SUM(amount_human) 
  WHERE transfer_type = 'in' 
    AND from_address IN Polymarket_contracts;

// Money spent on Polymarket (buys)
const tradingOut = SUM(amount_human) 
  WHERE transfer_type = 'out' 
    AND to_address IN Polymarket_contracts;

// Trading P&L = Money received - Money spent
const tradingPnl = tradingIn - tradingOut;
```

**Why this works**:
- Trading P&L represents actual money flow from trading
- Includes all trades (even if some aren't in trades_history)
- Accounts for fees automatically (they're part of the transfer amounts)

### Step 3: Calculate Estimated Deposits

If explicit external deposits are tracked, use those. Otherwise, calculate from money flow:

```typescript
// Method 1: Use tracked external deposits
const trackedDeposits = SUM(amount_human) 
  WHERE transfer_type = 'in' 
    AND from_address NOT IN Polymarket_contracts;

// Method 2: Calculate from money flow (if trackedDeposits = 0)
// Formula: Initial = Trading OUT + Withdrawals + Current Value - Trading IN
const estimatedDeposits = tradingOut + externalWithdrawals + currentValue - tradingIn;
```

**Why this formula works**:
```
Money Flow Equation:
  Initial Deposits + Trading IN = Trading OUT + External Withdrawals + Current Value

Solving for Initial Deposits:
  Initial Deposits = Trading OUT + External Withdrawals + Current Value - Trading IN
```

### Step 4: Calculate Unrealized P&L

Unrealized P&L comes from active positions with current market prices:

```typescript
// Get all active positions
const positions = await getPositions(privyUserId);

// For each position:
const unrealizedPnl = positions.reduce((total, position) => {
  const currentValue = position.quantity * position.sellPrice;  // Current market value
  const costBasis = position.quantity * position.averagePrice;  // What user paid
  const positionPnl = currentValue - costBasis;
  return total + positionPnl;
}, 0);
```

**Where prices come from**:
- Live CLOB order book data from Polymarket
- `sellPrice` = best_bid (what you'd get if you sold now)
- `buyPrice` = best_ask (what you'd pay to buy now)

### Step 5: Calculate Total P&L

Total P&L combines everything:

```typescript
// Get current state
const usdcBalance = await getUserBalance(privyUserId);          // Current USDC balance
const portfolioValue = await getPortfolioValue(privyUserId);    // Current positions value
const totalValue = portfolioValue + usdcBalance;                // Total current value

// Get external withdrawals
const externalWithdrawals = await calculateTrueWithdrawals(privyUserId);

// Get estimated deposits
const estimatedDeposits = await calculateEstimatedDeposit(...);

// Calculate Total P&L
// Formula: (Current Total Value + External Withdrawals) - Estimated Deposits
const totalPnl = (totalValue + externalWithdrawals) - estimatedDeposits;

// Calculate Realized P&L
// Realized = Total - Unrealized (what's locked in from closed positions)
const realizedPnl = totalPnl - unrealizedPnl;

// Calculate Percentage P&L
const totalPercentPnl = estimatedDeposits > 0 
  ? (totalPnl / estimatedDeposits) * 100 
  : 0;
```

---

## Step-by-Step Implementation

### Phase 1: Set Up Transfer Tracking

#### 1.1 Create Database Tables

Run migrations to create:
- `wallet_usdc_transfers` (all transfers)
- `wallet_balances` (current balance)
- `trades_history` (trade records)
- `user_positions` (current positions)
- `user_pnl_history` (historical snapshots)

#### 1.2 Set Up Alchemy Webhooks

1. **Create Alchemy Account**: Sign up at [alchemy.com](https://alchemy.com)
2. **Create Address Activity Webhook**:
   ```typescript
   POST https://dashboard.alchemy.com/api/create-webhook
   {
     "network": "polygon-mainnet",
     "webhook_type": "ADDRESS_ACTIVITY",
     "webhook_url": "https://your-api.com/api/webhooks/alchemy",
     "addresses": [] // Start empty, add addresses dynamically
   }
   ```

3. **Implement Webhook Handler**:
   ```typescript
   router.post('/webhooks/alchemy', async (req, res) => {
     // 1. Verify signature
     const signature = req.headers['x-alchemy-signature'];
     if (!verifySignature(req.body, signature)) {
       return res.status(401).json({ error: 'Invalid signature' });
     }
     
     // 2. Respond immediately (process async)
     res.status(200).json({ success: true });
     
     // 3. Process transfers
     for (const activity of req.body.event.activity) {
       // Filter for USDC.e transfers
       if (activity.rawContract?.address?.toLowerCase() !== USDC_CONTRACT_ADDRESS) {
         continue;
       }
       
       // Extract transfer details
       const fromAddress = activity.fromAddress?.toLowerCase();
       const toAddress = activity.toAddress?.toLowerCase();
       const value = parseFloat(activity.value?.hex || '0');
       const txHash = activity.hash;
       const blockNumber = activity.blockNum;
       
       // Update recipient (incoming transfer)
       if (toAddress && isOurUser(toAddress)) {
         await processTransfer(toAddress, 'in', value, txHash, blockNumber, fromAddress);
       }
       
       // Update sender (outgoing transfer)
       if (fromAddress && isOurUser(fromAddress)) {
         await processTransfer(fromAddress, 'out', value, txHash, blockNumber, toAddress);
       }
     }
   });
   ```

4. **Process Transfer Function**:
   ```typescript
   async function processTransfer(
     walletAddress: string,
     transferType: 'in' | 'out',
     amount: number,
     txHash: string,
     blockNumber: number,
     counterparty: string
   ) {
     // 1. Find user
     const user = await getUserByWallet(walletAddress);
     if (!user) return;
     
     // 2. Fetch current balance from Alchemy
     const balance = await fetchBalanceFromAlchemy(walletAddress);
     
     // 3. Update wallet_balances table
     await db.query(`
       INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (proxy_wallet_address) 
       DO UPDATE SET balance_raw = $3, balance_human = $4, last_updated_at = NOW()
     `, [walletAddress, user.privyUserId, balance.balanceRaw, balance.balanceHuman]);
     
     // 4. Record transfer in history
     await db.query(`
       INSERT INTO wallet_usdc_transfers 
       (proxy_wallet_address, privy_user_id, transfer_type, from_address, to_address, 
        amount_raw, amount_human, transaction_hash, block_number, block_timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (transaction_hash, log_index) DO NOTHING
     `, [
       walletAddress,
       user.privyUserId,
       transferType,
       transferType === 'in' ? counterparty : walletAddress,
       transferType === 'in' ? walletAddress : counterparty,
       amount.toString(),
       amount,
       txHash,
       blockNumber
     ]);
   }
   ```

#### 1.3 Add Wallet to Webhook on User Registration

```typescript
async function onUserRegistered(privyUserId: string, proxyWalletAddress: string) {
  // Add wallet to Alchemy webhook
  await alchemyWebhookService.addAddresses([proxyWalletAddress]);
  
  // Fetch initial balance and store it
  const balance = await fetchBalanceFromAlchemy(proxyWalletAddress);
  await updateBalanceInDb(proxyWalletAddress, privyUserId, balance);
}
```

### Phase 2: Track Trades

#### 2.1 Record Trades After Execution

```typescript
async function recordTrade(trade: {
  privyUserId: string;
  proxyWalletAddress: string;
  marketId: string;
  clobTokenId: string;
  outcome: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  costUsdc: number;
  feeUsdc: number;
  orderId: string;
  transactionHash: string;
  status: 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'FAILED';
}) {
  await db.query(`
    INSERT INTO trades_history (
      privy_user_id, proxy_wallet_address, market_id, clob_token_id, outcome,
      side, size, price, cost_usdc, fee_usdc, order_id, transaction_hash, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
  `, [
    trade.privyUserId,
    trade.proxyWalletAddress,
    trade.marketId,
    trade.clobTokenId,
    trade.outcome,
    trade.side,
    trade.size,
    trade.price,
    trade.costUsdc,
    trade.feeUsdc,
    trade.orderId,
    trade.transactionHash,
    trade.status
  ]);
  
  // Refresh balance after trade
  await refreshBalance(trade.proxyWalletAddress, trade.privyUserId);
}
```

### Phase 3: Calculate PnL

#### 3.1 Implement PnL Calculation Function

```typescript
async function calculatePnLSnapshot(privyUserId: string): Promise<PnLSnapshot> {
  // Step 1: Get current state
  const user = await getUserByPrivyId(privyUserId);
  const usdcBalance = await getBalanceFromDb(user.proxyWalletAddress);
  const portfolioSummary = await getPortfolioSummary(privyUserId);
  const totalValue = portfolioSummary.portfolio + parseFloat(usdcBalance.balanceHuman);
  
  // Step 2: Calculate external withdrawals
  const externalWithdrawals = await db.query(`
    SELECT COALESCE(SUM(amount_human), 0) as total
    FROM wallet_usdc_transfers
    WHERE privy_user_id = $1 
      AND transfer_type = 'out'
      AND LOWER(to_address) NOT IN (
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        '0xc5d563a36ae78145c45a50134d48a1215220f80a',
        '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        '0x23895ddd9d2a22215080c0529614e471e1006bdf'
      )
  `, [privyUserId]);
  const withdrawals = parseFloat(externalWithdrawals.rows[0]?.total || '0');
  
  // Step 3: Calculate trading P&L
  const tradingIn = await db.query(`
    SELECT COALESCE(SUM(amount_human), 0) as total
    FROM wallet_usdc_transfers
    WHERE privy_user_id = $1 
      AND transfer_type = 'in'
      AND LOWER(from_address) IN (
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        '0xc5d563a36ae78145c45a50134d48a1215220f80a',
        '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
      )
  `, [privyUserId]);
  const tradingInAmount = parseFloat(tradingIn.rows[0]?.total || '0');
  
  const tradingOut = await db.query(`
    SELECT COALESCE(SUM(amount_human), 0) as total
    FROM wallet_usdc_transfers
    WHERE privy_user_id = $1 
      AND transfer_type = 'out'
      AND LOWER(to_address) IN (
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        '0xc5d563a36ae78145c45a50134d48a1215220f80a',
        '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
      )
  `, [privyUserId]);
  const tradingOutAmount = parseFloat(tradingOut.rows[0]?.total || '0');
  
  // Step 4: Calculate estimated deposits
  const trackedDeposits = await db.query(`
    SELECT COALESCE(SUM(amount_human), 0) as total
    FROM wallet_usdc_transfers
    WHERE privy_user_id = $1 
      AND transfer_type = 'in'
      AND LOWER(from_address) NOT IN (
        '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
        '0xc5d563a36ae78145c45a50134d48a1215220f80a',
        '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        '0x23895ddd9d2a22215080c0529614e471e1006bdf'
      )
  `, [privyUserId]);
  const deposits = parseFloat(trackedDeposits.rows[0]?.total || '0');
  
  // If no tracked deposits, estimate from money flow
  const estimatedDeposits = deposits > 0 
    ? deposits 
    : Math.max(0, tradingOutAmount + withdrawals + totalValue - tradingInAmount);
  
  // Step 5: Get unrealized P&L from positions
  const unrealizedPnl = portfolioSummary.totalPnl;
  
  // Step 6: Calculate total P&L
  const totalPnl = (totalValue + withdrawals) - estimatedDeposits;
  
  // Step 7: Calculate realized P&L
  const realizedPnl = totalPnl - unrealizedPnl;
  
  // Step 8: Calculate percentage P&L
  const totalPercentPnl = estimatedDeposits > 0 
    ? (totalPnl / estimatedDeposits) * 100 
    : 0;
  
  return {
    totalPnl,
    realizedPnl,
    unrealizedPnl,
    portfolioValue: portfolioSummary.portfolio,
    usdcBalance: parseFloat(usdcBalance.balanceHuman),
    totalValue,
    activePositionsCount: portfolioSummary.totalPositions,
    totalPositionsCount: portfolioSummary.totalPositions,
    totalPercentPnl,
    snapshotAt: new Date(),
    estimatedDeposits,
    externalWithdrawals: withdrawals,
    tradingIn: tradingInAmount,
    tradingOut: tradingOutAmount,
  };
}
```

#### 3.2 Store PnL Snapshots Periodically

```typescript
async function updatePnLSnapshot(privyUserId: string): Promise<void> {
  const snapshot = await calculatePnLSnapshot(privyUserId);
  
  await db.query(`
    INSERT INTO user_pnl_history (
      privy_user_id, total_pnl, realized_pnl, unrealized_pnl,
      portfolio_value, usdc_balance, total_value,
      active_positions_count, total_positions_count, total_percent_pnl,
      snapshot_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    privyUserId,
    snapshot.totalPnl,
    snapshot.realizedPnl,
    snapshot.unrealizedPnl,
    snapshot.portfolioValue,
    snapshot.usdcBalance,
    snapshot.totalValue,
    snapshot.activePositionsCount,
    snapshot.totalPositionsCount,
    snapshot.totalPercentPnl,
    snapshot.snapshotAt
  ]);
}

// Call periodically (e.g., after trades, daily cron job)
setInterval(async () => {
  const users = await getAllActiveUsers();
  for (const user of users) {
    await updatePnLSnapshot(user.privyUserId);
  }
}, 24 * 60 * 60 * 1000); // Daily
```

---

## Key Formulas

### 1. Trading P&L
```
Trading P&L = Money Received from Polymarket - Money Spent on Polymarket
            = SUM(sells + redemptions) - SUM(buys)
```

### 2. Estimated Deposits
```
If tracked deposits exist:
  Estimated Deposits = SUM(external deposits)
  
If no tracked deposits:
  Estimated Deposits = Trading OUT + External Withdrawals + Current Value - Trading IN
```

### 3. Total P&L
```
Total P&L = (Current Total Value + External Withdrawals) - Estimated Deposits
          = (Portfolio Value + USDC Balance + Withdrawals) - Deposits
```

### 4. Realized P&L
```
Realized P&L = Total P&L - Unrealized P&L
             = (Locked-in profit/loss from closed positions)
```

### 5. Unrealized P&L
```
Unrealized P&L = SUM(Current Position Value - Cost Basis)
                = SUM((Quantity × Current Sell Price) - (Quantity × Average Buy Price))
```

### 6. Percentage P&L
```
Percentage P&L = (Total P&L / Estimated Deposits) × 100
```

---

## Complete Flow Diagram

```
USER DEPOSITS USDC.e
        │
        ▼
┌─────────────────────────────────────┐
│   POLYGON BLOCKCHAIN                │
│   Transfer Event Emitted            │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   ALCHEMY WEBHOOK                   │
│   POST /api/webhooks/alchemy        │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   1. Verify Signature               │
│   2. Extract Transfer Data          │
│   3. Update wallet_balances         │
│   4. Record in wallet_usdc_transfers│
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   USER EXECUTES TRADE               │
│   (BUY or SELL)                     │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   1. Record in trades_history       │
│   2. Refresh balance                │
│   3. Update positions               │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   PnL CALCULATION (On Demand)       │
│                                      │
│   1. Get current USDC balance       │
│   2. Get current positions          │
│   3. Calculate unrealized P&L       │
│   4. Get trading activity           │
│   5. Get external withdrawals       │
│   6. Estimate deposits              │
│   7. Calculate total P&L            │
│   8. Calculate realized P&L         │
│   9. Store snapshot                 │
└───────────────┬─────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│   RETURN TO USER                    │
│   {                                 │
│     totalPnl: 1234.56,             │
│     realizedPnl: 500.00,           │
│     unrealizedPnl: 734.56,         │
│     portfolioValue: 5000.00,       │
│     usdcBalance: 3000.00,          │
│     totalValue: 8000.00,           │
│     estimatedDeposits: 6765.44,    │
│     externalWithdrawals: 0.00,     │
│     tradingIn: 10000.00,           │
│     tradingOut: 8000.00            │
│   }                                 │
└─────────────────────────────────────┘
```

---

## Summary: Why This Approach Works

### ✅ Accuracy
- Uses **on-chain wallet transfers** as source of truth
- Accounts for all money movements (deposits, withdrawals, trades, fees)
- Independent verification with trade records

### ✅ Reliability
- Multiple detection mechanisms (webhooks, polling)
- Database as single source of truth
- Real-time updates via webhooks

### ✅ Completeness
- Tracks deposits, withdrawals, trades, positions
- Calculates both realized and unrealized P&L
- Historical snapshots for charting

### ✅ Performance
- No constant blockchain queries (reads from database)
- Efficient indexing for fast queries
- Real-time updates via webhooks (no polling needed)

### ✅ Edge Case Handling
- Works even if some trades aren't recorded
- Handles cross-chain deposits (via Polymarket Bridge)
- Accounts for fees automatically
- Handles partial fills, cancellations

---

## Implementation Checklist

- [ ] Create database tables (migrations)
- [ ] Set up Alchemy webhook service
- [ ] Implement webhook handler
- [ ] Set up transfer processing
- [ ] Record trades after execution
- [ ] Implement balance refresh after trades
- [ ] Fetch positions from Polymarket
- [ ] Calculate unrealized P&L from positions
- [ ] Implement PnL calculation function
- [ ] Store PnL snapshots periodically
- [ ] Create API endpoint to fetch current PnL
- [ ] Create API endpoint for historical PnL (charting)
- [ ] Test with real transactions
- [ ] Monitor for accuracy and edge cases

---

This approach ensures **100% accurate** PnL calculation by using blockchain data as the source of truth while maintaining performance and reliability through efficient database design and real-time webhook updates.

