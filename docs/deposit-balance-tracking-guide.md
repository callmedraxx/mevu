# Deposit & Balance Tracking System Guide

This document provides a detailed explanation of how the MEVU codebase implements deposit detection, balance tracking, and real-time notifications for USDC.e on Polygon.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Database Schema](#database-schema)
4. [Core Services](#core-services)
   - [Alchemy Webhook Service](#1-alchemy-webhook-service)
   - [Alchemy Balance Service](#2-alchemy-balance-service)
   - [Polygon USDC Balance Service (QuickNode)](#3-polygon-usdc-balance-service-quicknode)
5. [API Endpoints](#api-endpoints)
6. [Real-Time Notifications (SSE)](#real-time-notifications-sse)
7. [Configuration & Environment Variables](#configuration--environment-variables)
8. [Implementation Steps for Your App](#implementation-steps-for-your-app)
9. [Polymarket Bridge Deposit Addresses](#polymarket-bridge-deposit-addresses)

---

## System Overview

The balance tracking system uses a **multi-source, event-driven architecture**:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BALANCE TRACKING SYSTEM                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐        │
│   │  Alchemy        │    │  QuickNode      │    │  Manual         │        │
│   │  Webhooks       │    │  WebSocket      │    │  Refresh        │        │
│   │  (Primary)      │    │  (Backup/Poll)  │    │  (API Call)     │        │
│   └────────┬────────┘    └────────┬────────┘    └────────┬────────┘        │
│            │                      │                      │                  │
│            └──────────────────────┴──────────────────────┘                  │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌──────────────────────────┐                             │
│                    │  PostgreSQL Database     │                             │
│                    │  • wallet_balances       │                             │
│                    │  • wallet_usdc_transfers │                             │
│                    └──────────────────────────┘                             │
│                                   │                                         │
│                    ┌──────────────┴──────────────┐                          │
│                    ▼                             ▼                          │
│        ┌────────────────────┐      ┌────────────────────┐                   │
│        │  REST API          │      │  SSE Stream        │                   │
│        │  (Read from DB)    │      │  (Real-time Push)  │                   │
│        └────────────────────┘      └────────────────────┘                   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Event-Driven Updates**: Balances are updated when events occur (webhook/transfer event), not by polling
2. **Database as Source of Truth**: API endpoints read from the database, not blockchain
3. **Redundancy**: Multiple detection mechanisms (webhooks, WebSocket, polling)
4. **Real-Time Notifications**: SSE streams for instant frontend updates
5. **No API Rate Limit Issues**: Avoids constant blockchain queries

---

## Architecture Diagram

```
User deposits USDC.e to Proxy Wallet
              │
              ▼
    ┌─────────────────────────────────────────────────────────────┐
    │                    POLYGON BLOCKCHAIN                        │
    │           USDC.e Transfer Event Emitted                      │
    └─────────────────────────────────────────────────────────────┘
              │                           │
              ▼                           ▼
    ┌──────────────────┐       ┌──────────────────────────┐
    │  ALCHEMY NOTIFY  │       │  QUICKNODE WEBSOCKET     │
    │  (Webhook)       │       │  (Backup Detection)      │
    └────────┬─────────┘       └────────────┬─────────────┘
             │                              │
             ▼                              ▼
    ┌──────────────────┐       ┌──────────────────────────┐
    │  /api/webhooks/  │       │  pollBalances()          │
    │  alchemy         │       │  (Every 2 seconds)       │
    └────────┬─────────┘       └────────────┬─────────────┘
             │                              │
             └──────────┬───────────────────┘
                        ▼
              ┌────────────────────┐
              │ updateBalanceFor   │
              │ Address()          │
              │  • Fetch balance   │
              │    from Alchemy    │
              │  • Update DB       │
              │  • Record transfer │
              │  • Emit SSE event  │
              └─────────┬──────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│wallet_      │ │wallet_usdc_ │ │SSE Stream   │
│balances     │ │transfers    │ │Notification │
│(Current)    │ │(History)    │ │(Real-time)  │
└─────────────┘ └─────────────┘ └─────────────┘
```

---

## Database Schema

### Table: `wallet_balances`

Stores the **current** USDC.e balance for each proxy wallet.

```sql
CREATE TABLE IF NOT EXISTS wallet_balances (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL UNIQUE,
    privy_user_id VARCHAR(255) NOT NULL,
    balance_raw VARCHAR(78) NOT NULL,         -- Wei/atomic units (string for uint256)
    balance_human DECIMAL(20, 6) NOT NULL,    -- Human-readable (USDC has 6 decimals)
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT fk_wallet_balance_user 
        FOREIGN KEY (privy_user_id) 
        REFERENCES users(privy_user_id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_wallet_balances_proxy_wallet ON wallet_balances(proxy_wallet_address);
CREATE INDEX idx_wallet_balances_privy_user ON wallet_balances(privy_user_id);
CREATE INDEX idx_wallet_balances_last_updated ON wallet_balances(last_updated_at DESC);
```

### Table: `wallet_usdc_transfers`

Stores **all transfer history** (deposits and withdrawals).

```sql
CREATE TABLE IF NOT EXISTS wallet_usdc_transfers (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL,
    privy_user_id VARCHAR(255) NOT NULL,
    transfer_type VARCHAR(10) NOT NULL,        -- 'in' (deposit) or 'out' (withdrawal)
    from_address VARCHAR(255) NOT NULL,
    to_address VARCHAR(255) NOT NULL,
    amount_raw VARCHAR(78) NOT NULL,           -- Wei/atomic units
    amount_human DECIMAL(20, 6) NOT NULL,      -- Human-readable
    transaction_hash VARCHAR(255) NOT NULL,
    block_number BIGINT NOT NULL,
    block_timestamp TIMESTAMP WITH TIME ZONE,
    log_index INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT fk_wallet_transfer_user 
        FOREIGN KEY (privy_user_id) 
        REFERENCES users(privy_user_id) ON DELETE CASCADE,
    
    -- Prevent duplicate transfers
    CONSTRAINT unique_transfer UNIQUE (transaction_hash, log_index)
);

-- Indexes for efficient queries
CREATE INDEX idx_wallet_transfers_proxy_wallet ON wallet_usdc_transfers(proxy_wallet_address);
CREATE INDEX idx_wallet_transfers_privy_user ON wallet_usdc_transfers(privy_user_id);
CREATE INDEX idx_wallet_transfers_type ON wallet_usdc_transfers(transfer_type);
CREATE INDEX idx_wallet_transfers_tx_hash ON wallet_usdc_transfers(transaction_hash);
CREATE INDEX idx_wallet_transfers_block_number ON wallet_usdc_transfers(block_number DESC);
CREATE INDEX idx_wallet_transfers_created_at ON wallet_usdc_transfers(created_at DESC);
```

---

## Core Services

### 1. Alchemy Webhook Service

**File:** `src/services/alchemy/alchemy-webhook.service.ts`

This is the **primary** deposit detection mechanism. Alchemy sends webhooks whenever USDC.e is transferred to/from watched addresses.

#### How It Works

1. **Initialization**: Registers all user proxy wallet addresses with Alchemy's Address Activity webhook
2. **Webhook Receipt**: Receives POST requests from Alchemy when transfers occur
3. **Processing**: Filters for USDC.e transfers, updates database, emits SSE notifications

#### Key Methods

```typescript
// Initialize and sync all addresses
async initialize(): Promise<void> {
  // Check if webhook ID exists or create new webhook
  if (ALCHEMY_WEBHOOK_ID) {
    this.webhookId = ALCHEMY_WEBHOOK_ID;
  } else if (WEBHOOK_URL) {
    await this.createWebhook();
  }
  
  // Sync all existing user addresses to the webhook
  await this.syncAllAddresses();
}

// Add new user's address when they register
async addUserAddress(proxyWalletAddress: string, privyUserId: string): Promise<void> {
  await this.addAddresses([proxyWalletAddress]);
}

// Process incoming webhook from Alchemy
async processWebhook(payload: AlchemyWebhookPayload): Promise<void> {
  for (const activity of payload.event.activity) {
    // Only process USDC.e transfers
    if (activity.rawContract?.address?.toLowerCase() !== USDC_CONTRACT_ADDRESS.toLowerCase()) {
      continue;
    }

    // Update recipient (incoming transfer)
    if (toAddress) {
      await this.updateBalanceForAddress(toAddress, 'in', value, txHash, blockNumber, fromAddress);
    }

    // Update sender (outgoing transfer)
    if (fromAddress) {
      await this.updateBalanceForAddress(fromAddress, 'out', value, txHash, blockNumber, toAddress);
    }
  }
}
```

#### Core Update Logic

```typescript
private async updateBalanceForAddress(
  address: string,
  transferType: 'in' | 'out',
  amount: number,
  txHash: string,
  blockNumber: number,
  counterparty: string
): Promise<void> {
  // 1. Check if address belongs to our user
  const userResult = await pool.query(
    `SELECT privy_user_id FROM users WHERE LOWER(proxy_wallet_address) = LOWER($1)`,
    [address]
  );
  if (userResult.rows.length === 0) return; // Not our user

  const privyUserId = userResult.rows[0].privy_user_id;

  // 2. Fetch current balance from Alchemy API
  const balanceResponse = await axios.post(alchemyUrl, {
    jsonrpc: '2.0',
    method: 'alchemy_getTokenBalances',
    params: [address, [USDC_CONTRACT_ADDRESS]],
  });
  
  const balanceRaw = BigInt(balanceResponse.data.result.tokenBalances[0].tokenBalance).toString();
  const balanceHuman = ethers.utils.formatUnits(balanceRaw, 6);

  // 3. Update wallet_balances table (upsert)
  await pool.query(
    `INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (proxy_wallet_address) 
     DO UPDATE SET balance_raw = $3, balance_human = $4, last_updated_at = NOW()`,
    [address, privyUserId, balanceRaw, balanceHuman]
  );

  // 4. Record the transfer in history
  await pool.query(
    `INSERT INTO wallet_usdc_transfers 
     (proxy_wallet_address, privy_user_id, transfer_type, from_address, to_address, 
      amount_raw, amount_human, transaction_hash, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (transaction_hash, proxy_wallet_address) DO NOTHING`,
    [address, privyUserId, transferType, ...]
  );

  // 5. Emit real-time notification via SSE
  const notification: BalanceNotification = {
    type: transferType === 'in' ? 'deposit' : 'withdrawal',
    privyUserId,
    proxyWalletAddress: address,
    amount: humanAmount,
    txHash,
    blockNumber,
    newBalance: balanceHuman,
  };
  this.notifyDeposit(notification);
}
```

#### SSE Subscription System

```typescript
// Map of userId -> Set of listeners
private depositListeners: Map<string, Set<DepositListener>> = new Map();

// Subscribe to deposit notifications
subscribeToDeposits(privyUserId: string, listener: DepositListener): () => void {
  if (!this.depositListeners.has(privyUserId)) {
    this.depositListeners.set(privyUserId, new Set());
  }
  this.depositListeners.get(privyUserId)!.add(listener);

  // Return unsubscribe function
  return () => {
    const listeners = this.depositListeners.get(privyUserId);
    if (listeners) {
      listeners.delete(listener);
    }
  };
}

// Notify all subscribers
private notifyDeposit(notification: DepositNotification): void {
  // Emit global event
  this.emit('deposit', notification);

  // Notify specific user listeners
  const listeners = this.depositListeners.get(notification.privyUserId);
  if (listeners) {
    listeners.forEach(listener => listener(notification));
  }
}
```

---

### 2. Alchemy Balance Service

**File:** `src/services/alchemy/balance.service.ts`

A lightweight service for fetching and updating balances on-demand.

```typescript
// Fetch balance from Alchemy API
export async function fetchBalanceFromAlchemy(address: string): Promise<BalanceResult> {
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  
  const response = await axios.post(`https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`, {
    jsonrpc: '2.0',
    method: 'alchemy_getTokenBalances',
    params: [address, [USDC_CONTRACT_ADDRESS]],
  });

  let balanceRaw = '0';
  let balanceHuman = '0';

  if (response.data?.result?.tokenBalances?.[0]) {
    const tokenBalance = response.data.result.tokenBalances[0];
    if (tokenBalance.tokenBalance && tokenBalance.tokenBalance !== '0x') {
      const balanceBigInt = BigInt(tokenBalance.tokenBalance);
      balanceRaw = balanceBigInt.toString();
      balanceHuman = ethers.utils.formatUnits(balanceBigInt.toString(), 6);
    }
  }

  return { balanceRaw, balanceHuman };
}

// Fetch and update database (called after trades)
export async function refreshAndUpdateBalance(
  proxyWalletAddress: string,
  privyUserId: string
): Promise<BalanceResult> {
  const balance = await fetchBalanceFromAlchemy(proxyWalletAddress);
  
  await pool.query(
    `INSERT INTO wallet_balances (...) VALUES (...) ON CONFLICT DO UPDATE ...`,
    [proxyWalletAddress, privyUserId, balance.balanceRaw, balance.balanceHuman]
  );

  return balance;
}

// Read from database only (no API call)
export async function getBalanceFromDb(proxyWalletAddress: string): Promise<BalanceResult | null> {
  const result = await pool.query(
    'SELECT balance_raw, balance_human FROM wallet_balances WHERE proxy_wallet_address = $1',
    [proxyWalletAddress]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}
```

---

### 3. Polygon USDC Balance Service (QuickNode)

**File:** `src/services/polygon/polygon-usdc-balance.service.ts`

A **backup/redundant** balance tracking service using QuickNode WebSocket and polling.

#### Key Features

- **WebSocket Connection**: Monitors for Transfer events (backup, not always reliable)
- **Polling Fallback**: Polls balances every 2 seconds for watched addresses
- **Rate Limit Handling**: Exponential backoff when rate limited
- **In-Memory State**: Tracks watched addresses and their balances

#### Initialization

```typescript
async initialize(): Promise<void> {
  // Create WebSocket provider for event listening
  this.provider = new ethers.providers.WebSocketProvider(wssUrl);

  // Use polygon-rpc.com for balance queries (more reliable, no rate limits)
  this.httpProvider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, { chainId: 137 });

  // Create USDC contract instance
  const usdcAbi = [
    'function balanceOf(address owner) view returns (uint256)',
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ];
  this.contract = new ethers.Contract(USDC_CONTRACT_ADDRESS, usdcAbi, this.provider);
  this.httpContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, usdcAbi, this.httpProvider);

  // Start polling (more reliable than WebSocket events)
  this.startBalancePolling();
}
```

#### Polling Logic

```typescript
private startBalancePolling(): void {
  // Poll every 2 seconds
  this.pollingInterval = setInterval(async () => {
    await this.pollBalances();
  }, this.pollingIntervalMs);
}

private async pollBalances(): Promise<void> {
  // Skip if rate limited
  if (this.isRateLimited()) return;

  for (const [addressLower, watched] of this.watchedAddresses) {
    // Fetch current balance
    const balanceBN = await this.httpContract.balanceOf(watched.proxyWalletAddress);
    const currentBalance = BigInt(balanceBN.toString());
    const previousBalance = watched.balance;

    // Always update database to keep in sync
    await this.updateBalance(watched.proxyWalletAddress, watched.privyUserId, currentBalance.toString());

    // Check if balance changed
    if (currentBalance !== previousBalance) {
      const difference = currentBalance - previousBalance;
      const isIncoming = difference > 0;
      
      // Update in-memory state
      watched.balance = currentBalance;
      
      // Persist transfer record
      await this.persistTransfer(...);

      // Notify listeners
      watched.listeners.forEach(listener => listener(update));
    }
  }
}
```

#### Watch an Address

```typescript
async watchAddress(proxyWalletAddress: string, privyUserId: string): Promise<string> {
  const addressLower = proxyWalletAddress.toLowerCase();

  // Skip if already watching
  if (this.watchedAddresses.has(addressLower)) {
    return this.watchedAddresses.get(addressLower)!.balance.toString();
  }

  // Fetch initial balance
  const balanceBN = await this.httpContract.balanceOf(proxyWalletAddress);
  const balance = BigInt(balanceBN.toString());

  // Create watched address entry
  const watched: WatchedAddress = {
    proxyWalletAddress,
    privyUserId,
    balance,
    listeners: new Set(),
    lastSyncedAt: new Date(),
  };

  this.watchedAddresses.set(addressLower, watched);

  // Persist initial balance to database
  await this.updateBalance(proxyWalletAddress, privyUserId, balance.toString());

  return balance.toString();
}
```

---

## API Endpoints

### Balance Routes (`/api/balances`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:privyUserId` | Get current balance (from database) |
| POST | `/:privyUserId/refresh` | Force refresh from Alchemy API |
| GET | `/:privyUserId/transfers` | Get all transfer history |
| GET | `/:privyUserId/deposits` | Get deposit history only |
| GET | `/stream/:privyUserId` | SSE stream for real-time updates |

### Webhook Routes (`/api/webhooks`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/alchemy` | Receive Alchemy webhook notifications |
| POST | `/alchemy/test` | Test endpoint for development |
| GET | `/alchemy/status` | Check webhook service status |
| GET | `/deposits/stream/:privyUserId` | SSE stream for deposit notifications |

### Example: Get Balance

```typescript
// GET /api/balances/:privyUserId
router.get('/:privyUserId', async (req, res) => {
  const { privyUserId } = req.params;
  const user = await getUserByPrivyId(privyUserId);

  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.proxyWalletAddress) return res.status(400).json({ error: 'No proxy wallet' });

  // Read from database ONLY - no Alchemy call
  // Balance is updated by webhooks and after trades
  const dbResult = await pool.query(
    'SELECT balance_raw, balance_human, last_updated_at FROM wallet_balances WHERE proxy_wallet_address = $1',
    [user.proxyWalletAddress]
  );
  
  res.json({ 
    success: true, 
    balance: dbResult.rows[0]?.balance_raw || '0',
    humanBalance: dbResult.rows[0]?.balance_human || '0',
    source: 'database',
    lastUpdated: dbResult.rows[0]?.last_updated_at
  });
});
```

---

## Real-Time Notifications (SSE)

### How SSE Works

1. Frontend opens EventSource connection to `/api/balances/stream/:privyUserId`
2. Server sends initial snapshot
3. When deposit occurs (via webhook), server pushes update
4. Frontend receives update instantly without polling

### Server-Side SSE Handler

```typescript
router.get('/stream/:privyUserId', async (req, res) => {
  const { privyUserId } = req.params;
  const user = await getUserByPrivyId(privyUserId);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial snapshot
  const balance = await getBalanceFromDb(user.proxyWalletAddress);
  res.write(`data: ${JSON.stringify({ 
    type: 'snapshot', 
    balance: balance.balanceRaw, 
    humanBalance: balance.balanceHuman 
  })}\n\n`);

  // Subscribe to deposit notifications
  const unsubscribe = alchemyWebhookService.subscribeToDeposits(privyUserId, (notification) => {
    res.write(`data: ${JSON.stringify({ 
      type: notification.type, 
      balance: notification.newBalance,
      amount: notification.amount,
      txHash: notification.txHash 
    })}\n\n`);
  });

  // Heartbeat every 30 seconds
  const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});
```

### Frontend Usage (Example)

```javascript
// Connect to SSE stream
const eventSource = new EventSource(`/api/balances/stream/${privyUserId}`);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'snapshot') {
    setBalance(data.humanBalance);
  } else if (data.type === 'deposit') {
    // Show deposit notification
    toast.success(`Received ${data.amount} USDC!`);
    setBalance(data.balance);
  } else if (data.type === 'withdrawal') {
    setBalance(data.balance);
  }
};

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  eventSource.close();
  // Reconnect after delay
  setTimeout(() => connectSSE(), 5000);
};
```

---

## Configuration & Environment Variables

### Required Environment Variables

```env
# Alchemy Configuration (Primary)
ALCHEMY_API_KEY=your-alchemy-api-key
ALCHEMY_AUTH_TOKEN=your-alchemy-auth-token       # For webhook management
ALCHEMY_WEBHOOK_ID=existing-webhook-id           # If you have one already
ALCHEMY_SIGNING_KEY=webhook-signing-key          # For signature verification
ALCHEMY_WEBHOOK_URL=https://yourserver.com/api/webhooks/alchemy

# QuickNode Configuration (Backup)
QUICKNODE_WSS_URL=wss://your-quicknode-endpoint
QUICKNODE_API_URL=https://your-quicknode-endpoint

# Polygon RPC (Fallback for balance queries)
POLYGON_RPC_URL=https://polygon-rpc.com

# Database
DATABASE_URL=postgresql://user:password@host:5432/dbname
```

### Constants

```typescript
// USDC.e on Polygon (bridged USDC)
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_DECIMALS = 6;

// Transfer event signature
const TRANSFER_EVENT_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');
```

---

## Implementation Steps for Your App

### Step 1: Create Database Tables

Run the migrations:

```sql
-- wallet_balances table (current balance)
CREATE TABLE wallet_balances (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL UNIQUE,
    privy_user_id VARCHAR(255) NOT NULL,
    balance_raw VARCHAR(78) NOT NULL,
    balance_human DECIMAL(20, 6) NOT NULL,
    last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- wallet_usdc_transfers table (transfer history)
CREATE TABLE wallet_usdc_transfers (
    id SERIAL PRIMARY KEY,
    proxy_wallet_address VARCHAR(255) NOT NULL,
    privy_user_id VARCHAR(255) NOT NULL,
    transfer_type VARCHAR(10) NOT NULL,  -- 'in' or 'out'
    from_address VARCHAR(255) NOT NULL,
    to_address VARCHAR(255) NOT NULL,
    amount_raw VARCHAR(78) NOT NULL,
    amount_human DECIMAL(20, 6) NOT NULL,
    transaction_hash VARCHAR(255) NOT NULL,
    block_number BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_transfer UNIQUE (transaction_hash, log_index)
);
```

### Step 2: Set Up Alchemy Webhook

1. Go to [Alchemy Dashboard](https://dashboard.alchemy.com) → Notify → Create Webhook
2. Choose "Address Activity" webhook type
3. Select "Polygon Mainnet" network
4. Set your webhook URL: `https://yourserver.com/api/webhooks/alchemy`
5. Save the webhook ID and signing key to environment variables

### Step 3: Implement Webhook Handler

```typescript
// POST /api/webhooks/alchemy
router.post('/alchemy', async (req, res) => {
  // Verify signature
  const signature = req.headers['x-alchemy-signature'];
  if (!verifySignature(JSON.stringify(req.body), signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond immediately (process async)
  res.status(200).json({ success: true });

  // Process webhook
  await processWebhook(req.body);
});
```

### Step 4: Add Address to Webhook on User Registration

```typescript
// When user deploys proxy wallet
async function onProxyWalletDeployed(privyUserId: string, proxyWalletAddress: string) {
  // Add to Alchemy webhook
  await alchemyWebhookService.addUserAddress(proxyWalletAddress, privyUserId);
  
  // Optionally start watching with QuickNode (backup)
  await polygonUsdcBalanceService.watchAddress(proxyWalletAddress, privyUserId);
}
```

### Step 5: Implement SSE Stream

```typescript
router.get('/stream/:userId', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial balance
  const balance = await getBalance(userId);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', ...balance })}\n\n`);

  // Subscribe to updates
  const unsubscribe = webhookService.subscribe(userId, (update) => {
    res.write(`data: ${JSON.stringify(update)}\n\n`);
  });

  // Cleanup
  req.on('close', () => {
    unsubscribe();
    res.end();
  });
});
```

### Step 6: Refresh Balance After Trades

```typescript
// After successful trade
async function onTradeCompleted(privyUserId: string, proxyWalletAddress: string) {
  // Refresh balance from Alchemy (trade affects balance)
  await refreshAndUpdateBalance(proxyWalletAddress, privyUserId);
}
```

---

---

## Polymarket Bridge Deposit Addresses

In addition to direct USDC.e deposits to the proxy wallet, the system supports cross-chain deposits via Polymarket's Bridge API. This allows users to deposit from:
- **Polygon** (direct USDC.e)
- **Ethereum** (USDC → auto-bridged to Polygon)
- **Base** (USDC → auto-bridged to Polygon)
- **Solana** (SOL → auto-bridged and swapped to USDC.e)

### How Bridge Deposit Addresses Work

```
User wants to deposit from Ethereum
              │
              ▼
    ┌─────────────────────────────────────────────────────────────┐
    │         POST /api/users/{userId}/deposit-addresses          │
    │                                                              │
    │  1. Get user's proxy wallet address from database           │
    │  2. Call Polymarket Bridge API: POST /deposit               │
    │     { address: proxyWalletAddress }                         │
    │  3. Bridge API returns deposit addresses per chain:         │
    │     { evm: "0x...", svm: "..." }                            │
    │  4. Enrich with supported assets (min amounts, tokens)     │
    │  5. Return deposit addresses to frontend                    │
    └─────────────────────────────────────────────────────────────┘
              │
              ▼
    User sends USDC to evm address on Ethereum
              │
              ▼
    ┌─────────────────────────────────────────────────────────────┐
    │              POLYMARKET BRIDGE SYSTEM                        │
    │  • Detects deposit on Ethereum                              │
    │  • Bridges to Polygon                                       │
    │  • Swaps to USDC.e if needed                                │
    │  • Sends to user's proxy wallet                             │
    └─────────────────────────────────────────────────────────────┘
              │
              ▼
    USDC.e arrives at proxy wallet on Polygon
              │
              ▼
    Alchemy Webhook detects → Updates balance → SSE notification
```

### API Endpoint: Get Deposit Addresses

**Endpoint:** `POST /api/users/:privyUserId/deposit-addresses`

```typescript
router.post('/:privyUserId/deposit-addresses', async (req, res) => {
  const { privyUserId } = req.params;

  // 1. Get user and verify proxy wallet exists
  const user = await getUserByPrivyId(privyUserId);
  if (!user?.proxyWalletAddress) {
    return res.status(400).json({ error: 'No proxy wallet' });
  }

  // 2. Call Polymarket Bridge API
  const bridgeApiUrl = process.env.POLYMARKET_BRIDGE_API_URL || 'https://bridge.polymarket.com';
  const response = await axios.post(`${bridgeApiUrl}/deposit`, {
    address: user.proxyWalletAddress,
  });

  // Response from Polymarket Bridge API:
  // {
  //   address: {
  //     evm: "0x7d597d8ce27e13ab65e4613db6dcfcbbdde8816a",  // For ETH, Base
  //     svm: "Hx8d...abc",                                   // For Solana
  //     btc: "bc1q..."                                       // For Bitcoin (if supported)
  //   }
  // }

  // 3. Get supported assets to enrich response
  const supportedAssets = await getSupportedAssets();

  // 4. Enrich deposit addresses with chain information
  const enrichedAddresses = [];

  // Polygon: Use proxy wallet directly
  enrichedAddresses.push({
    chain: 'Polygon',
    address: user.proxyWalletAddress,
    minCheckoutUsd: 2,
    token: 'USDC.e',
  });

  // Ethereum: Use evm address from Bridge API
  if (response.data.address?.evm) {
    enrichedAddresses.push({
      chain: 'Ethereum',
      address: response.data.address.evm,
      minCheckoutUsd: 10,
      token: 'USDC',
    });
  }

  // Base: Use same evm address
  if (response.data.address?.evm) {
    enrichedAddresses.push({
      chain: 'Base',
      address: response.data.address.evm,
      minCheckoutUsd: 5,
      token: 'USDC',
    });
  }

  // Solana: Use svm address
  if (response.data.address?.svm) {
    enrichedAddresses.push({
      chain: 'Solana',
      address: response.data.address.svm,
      minCheckoutUsd: 5,
      token: 'SOL',
    });
  }

  res.json({
    success: true,
    addresses: enrichedAddresses,
    note: 'Assets are automatically bridged and swapped to USDC.e on Polygon',
  });
});
```

### Getting Supported Assets

The system caches supported assets from Polymarket for 24 hours:

```typescript
const SUPPORTED_ASSETS_CACHE_TTL = 86400; // 24 hours
const SUPPORTED_ASSETS_CACHE_KEY = 'polymarket:supported-assets';

async function getSupportedAssets(): Promise<any[]> {
  // Check cache first
  const cached = await getCache(SUPPORTED_ASSETS_CACHE_KEY);
  if (cached) {
    return JSON.parse(cached).supportedAssets || [];
  }

  // Fetch from Polymarket Bridge API
  const bridgeApiUrl = process.env.POLYMARKET_BRIDGE_API_URL || 'https://bridge.polymarket.com';
  const response = await axios.get(`${bridgeApiUrl}/supported-assets`);

  // Response structure:
  // {
  //   supportedAssets: [
  //     {
  //       chainId: "137",
  //       chainName: "Polygon",
  //       token: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", symbol: "USDC.e" },
  //       minCheckoutUsd: 2
  //     },
  //     {
  //       chainId: "1",
  //       chainName: "Ethereum",
  //       token: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC" },
  //       minCheckoutUsd: 10
  //     },
  //     // ... more assets
  //   ]
  // }

  // Cache for 24 hours
  await setCache(SUPPORTED_ASSETS_CACHE_KEY, JSON.stringify(response.data), SUPPORTED_ASSETS_CACHE_TTL);

  return response.data.supportedAssets || [];
}
```

### Environment Variables for Bridge

```env
# Polymarket Bridge API (for cross-chain deposits)
POLYMARKET_BRIDGE_API_URL=https://bridge.polymarket.com
```

### Frontend Usage Example

```javascript
// 1. Get deposit addresses for user
const response = await fetch(`/api/users/${privyUserId}/deposit-addresses`, {
  method: 'POST',
});
const { addresses } = await response.json();

// 2. Display to user
// addresses = [
//   { chain: 'Polygon', address: '0x...proxy', minCheckoutUsd: 2, token: 'USDC.e' },
//   { chain: 'Ethereum', address: '0x...bridge', minCheckoutUsd: 10, token: 'USDC' },
//   { chain: 'Base', address: '0x...bridge', minCheckoutUsd: 5, token: 'USDC' },
//   { chain: 'Solana', address: 'Hx8d...', minCheckoutUsd: 5, token: 'SOL' },
// ]

// 3. User sends funds to appropriate address based on their chain
// 4. Polymarket Bridge automatically handles bridging
// 5. Funds arrive at proxy wallet on Polygon
// 6. Alchemy webhook detects → balance updates → SSE notification
```

### Key Points

| Chain | Deposit Address Source | Token | Notes |
|-------|------------------------|-------|-------|
| **Polygon** | Proxy Wallet (direct) | USDC.e | No bridging needed |
| **Ethereum** | Bridge API `evm` | USDC | Bridged to Polygon |
| **Base** | Bridge API `evm` | USDC | Bridged to Polygon |
| **Solana** | Bridge API `svm` | SOL/USDC | Bridged + swapped |

---

## Summary

| Component | Purpose | When Used |
|-----------|---------|-----------|
| **Alchemy Webhooks** | Primary deposit detection | Real-time, on every transfer |
| **QuickNode Polling** | Backup detection | Every 2 seconds (redundancy) |
| **Balance Service** | On-demand refresh | After trades, manual refresh |
| **PostgreSQL** | Source of truth | All API reads |
| **SSE Streams** | Real-time notifications | Frontend live updates |
| **Polymarket Bridge** | Cross-chain deposits | ETH, Base, Solana → Polygon |

This architecture ensures:
- ✅ **Instant deposit detection** via webhooks
- ✅ **No API rate limits** (reads from database)
- ✅ **Real-time frontend updates** via SSE
- ✅ **Redundancy** with multiple detection mechanisms
- ✅ **Complete audit trail** of all transfers
- ✅ **Cross-chain support** via Polymarket Bridge

