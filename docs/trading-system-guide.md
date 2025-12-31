# Trading System Implementation Guide

This document provides a comprehensive explanation of how the Mevu codebase implements trading on Polymarket, including the complete flow from API request to on-chain execution using the CLOB Client, Relay Client, and Privy signing infrastructure.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Core Components](#core-components)
   - [Privy Signer Adapter](#privy-signer-adapter)
   - [Privy Service](#privy-service)
   - [CLOB Client Service](#clob-client-service)
   - [Relay Client & Wallet Deployment](#relay-client--wallet-deployment)
4. [Trading Flow](#trading-flow)
   - [Buy Orders](#buy-orders)
   - [Sell Orders](#sell-orders)
5. [Price and Size Calculations](#price-and-size-calculations)
6. [Order Types](#order-types)
7. [Fee System](#fee-system)
8. [Redemption System](#redemption-system)
9. [Database Schema](#database-schema)
10. [API Endpoints](#api-endpoints)
11. [Configuration](#configuration)
12. [Error Handling](#error-handling)
13. [Implementation Guide](#implementation-guide)

---

## System Overview

The trading system enables users to buy and sell outcome shares on Polymarket prediction markets. It uses a **gasless trading** architecture where:

1. **Users sign orders** with their Privy embedded wallet (via backend session signing)
2. **Orders are submitted** to Polymarket's CLOB (Central Limit Order Book)
3. **Transactions are executed** via Polymarket's Relayer (users don't pay gas)
4. **Funds are held** in Gnosis Safe proxy wallets controlled by the user

### Key Technologies

| Component | Technology | Purpose |
|-----------|------------|---------|
| Wallet Signing | Privy SDK + Authorization Keys | Server-side transaction signing |
| Order Matching | Polymarket CLOB Client | Submit and manage orders |
| Transaction Execution | Polymarket Relay Client | Gasless Safe transactions |
| Wallet Infrastructure | Gnosis Safe | Secure multi-sig proxy wallets |
| Order Signing | Builder Signing SDK | Sign orders for builder flow |

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TRADING REQUEST                                 │
│                    (POST /api/trading/buy or /sell)                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           TRADING SERVICE                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Validate user exists and has proxy wallet                        │   │
│  │ 2. Check token approvals (USDC & CTF)                               │   │
│  │ 3. Pre-check balance via Alchemy                                    │   │
│  │ 4. Save trade record with PENDING status                            │   │
│  │ 5. Get CLOB client for user                                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CLOB CLIENT SERVICE                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Create PrivySignerAdapter (ethers.Signer)                        │   │
│  │ 2. Create BuilderConfig (for gasless order signing)                 │   │
│  │ 3. Initialize ClobClient with signer, API creds, builder config     │   │
│  │ 4. Create or derive API key for CLOB authentication                 │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PRIVY SIGNER ADAPTER                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Implements ethers.Signer interface:                                 │   │
│  │ • getAddress() → Returns embedded wallet address                    │   │
│  │ • signMessage() → Calls PrivyService.signMessage()                  │   │
│  │ • _signTypedData() → Calls PrivyService.signTypedData()             │   │
│  │                                                                      │   │
│  │ Key transformations:                                                 │   │
│  │ • Hex-encodes binary messages for Safe transaction hashes           │   │
│  │ • Serializes BigInt values to strings (Privy API requirement)       │   │
│  │ • Normalizes signatures from {raw: Uint8Array} to hex strings       │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PRIVY SERVICE                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ Uses @privy-io/node SDK with AuthorizationContext:                  │   │
│  │                                                                      │   │
│  │ 1. Get wallet ID from address                                       │   │
│  │ 2. Build authorization context:                                     │   │
│  │    {                                                                │   │
│  │      authorization_private_keys: [PRIVY_AUTHORIZATION_PRIVATE_KEY]  │   │
│  │    }                                                                │   │
│  │ 3. Call privyClient.wallets().ethereum().signTypedData()            │   │
│  │ 4. Normalize signature to hex string                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POLYMARKET CLOB API                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ For FOK/FAK orders: createAndPostMarketOrder()                      │   │
│  │ For LIMIT orders: createAndPostOrder()                              │   │
│  │                                                                      │   │
│  │ Order signed with EIP-712 typed data                                │   │
│  │ Builder signs order for gasless execution                           │   │
│  │ CLOB matches order against order book                               │   │
│  │ Returns orderID and status                                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       POST-TRADE PROCESSING                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ 1. Update trade record with orderId and status                      │   │
│  │ 2. Fetch transaction hash from CLOB (async)                         │   │
│  │ 3. Transfer platform fee via RelayClient                            │   │
│  │ 4. Refresh user positions                                           │   │
│  │ 5. Refresh USDC balance from Alchemy                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### Privy Signer Adapter

**File:** `src/services/privy/privy-signer.adapter.ts`

The `PrivySignerAdapter` is a custom `ethers.Signer` implementation that bridges Privy's API-based signing with the interfaces expected by Polymarket SDKs.

```typescript
export class PrivySignerAdapter extends ethers.Signer {
  private userId: string;
  private walletAddress: string;
  private walletId?: string;
  readonly provider: ethers.providers.Provider;

  constructor(
    userId: string,
    walletAddress: string,
    provider?: ethers.providers.Provider,
    walletId?: string
  ) {
    super();
    this.userId = userId;
    // Normalize address to proper checksum format
    const normalized = walletAddress.toLowerCase();
    this.walletAddress = ethers.utils.getAddress(normalized);
    this.walletId = walletId;
    this.provider = provider || new ethers.providers.JsonRpcProvider(rpcUrl);
  }

  // Returns the embedded wallet address
  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  // Signs messages via Privy API
  async signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    let messageString: string;
    if (typeof message === 'string') {
      messageString = message;
    } else {
      // Hex-encode binary data (e.g., Safe transaction hashes)
      messageString = ethers.utils.hexlify(message);
    }
    return privyService.signMessage({ userId: this.userId, message: messageString });
  }

  // Signs EIP-712 typed data via Privy API
  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    // Serialize BigInt values to strings (Privy API requirement)
    const serializeBigInt = (obj: any): any => {
      if (typeof obj === 'bigint') return obj.toString();
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj)) return obj.map(serializeBigInt);
        const result: any = {};
        for (const [key, val] of Object.entries(obj)) {
          result[key] = serializeBigInt(val);
        }
        return result;
      }
      return obj;
    };

    const typedData: EIP712TypedData = {
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? Number(domain.chainId) : undefined,
        verifyingContract: domain.verifyingContract,
      },
      types: types,
      primaryType: Object.keys(types).find(key => key !== 'EIP712Domain') || '',
      message: serializeBigInt(value),
    };

    return privyService.signTypedData({
      userId: this.userId,
      typedData,
      walletId: this.walletId,
    });
  }
}

// Factory function
export function createPrivySigner(
  userId: string,
  walletAddress: string,
  walletId?: string
): PrivySignerAdapter {
  return new PrivySignerAdapter(userId, walletAddress, undefined, walletId);
}
```

#### Key Points:

1. **Interface Compatibility**: Implements `ethers.Signer` so it works with `ClobClient`
2. **Binary Message Handling**: Hex-encodes `Uint8Array` messages for Safe transaction hashes
3. **BigInt Serialization**: Converts `BigInt` to strings since Privy API doesn't accept BigInt
4. **Signature Normalization**: Handles various signature formats from Privy (hex string, `{raw: Uint8Array}`)

---

### Privy Service

**File:** `src/services/privy/privy.service.ts`

The `PrivyService` handles direct communication with Privy's API for signing operations.

```typescript
class PrivyService {
  private privyClient: PrivyClient | null = null;

  // Get authorization context for server-side signing
  private getAuthorizationContext(): AuthorizationContext | undefined {
    if (!privyConfig.authorizationPrivateKey) return undefined;
    return {
      authorization_private_keys: [privyConfig.authorizationPrivateKey],
    };
  }

  // Sign EIP-712 typed data
  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    const walletId = request.walletId || await this.getWalletIdByAddress(
      request.userId,
      await this.getEmbeddedWalletAddress(request.userId)
    );

    const authorizationContext = this.getAuthorizationContext();

    // Use Privy SDK to sign
    const response = await this.privyClient.wallets().ethereum().signTypedData(
      walletId,
      {
        params: {
          typed_data: {
            domain: request.typedData.domain,
            types: request.typedData.types,
            primary_type: request.typedData.primaryType,
            message: request.typedData.message,
          },
        },
        authorization_context: authorizationContext,
      }
    );

    // CRITICAL: Normalize signature format
    const rawSignature = response?.signature;
    
    if (typeof rawSignature === 'string') {
      return rawSignature; // Already hex string
    }
    
    if (rawSignature && typeof rawSignature === 'object' && 'raw' in rawSignature) {
      // Convert {raw: Uint8Array} to hex string
      const bytes = rawSignature.raw instanceof Uint8Array
        ? rawSignature.raw
        : new Uint8Array(Object.values(rawSignature.raw));
      return ethers.utils.hexlify(bytes);
    }
    
    return String(rawSignature);
  }
}
```

#### Authorization Context

The `authorization_context` is the key to server-side signing:

```typescript
// Environment variable required
PRIVY_AUTHORIZATION_PRIVATE_KEY=0x...your_private_key...

// This private key must be registered in Privy Dashboard as an "Authorization Key"
// The corresponding address becomes a co-owner of user wallets
```

---

### CLOB Client Service

**File:** `src/services/polymarket/trading/clob-client.service.ts`

The `ClobClient` is Polymarket's SDK for interacting with their Central Limit Order Book.

```typescript
const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Safe proxy wallet signature type

export async function getClobClientForUser(
  privyUserId: string,
  userJwt?: string
): Promise<ClobClient> {
  const user = await getUserByPrivyId(privyUserId);
  
  // Get wallet ID for faster signing (avoids lookup during each sign)
  const walletId = await privyService.getWalletIdByAddress(
    privyUserId,
    user.embeddedWalletAddress
  );

  // Create Privy signer adapter
  const signer = createPrivySigner(
    privyUserId,
    user.embeddedWalletAddress,
    walletId || undefined
  );

  // Create BuilderConfig for gasless trading
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: BUILDER_SIGNING_SERVER_URL },
  });

  // Create temporary client to get API credentials
  const tempClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    undefined, // No API creds yet
    SIGNATURE_TYPE,
    user.proxyWalletAddress, // Funder address
    undefined,
    false,
    builderConfig
  );
  
  // Create or derive API key for CLOB authentication
  const apiCreds = await tempClient.createOrDeriveApiKey();

  // Create final client with API credentials
  const clobClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    apiCreds,
    SIGNATURE_TYPE,
    user.proxyWalletAddress,
    undefined,
    false,
    builderConfig
  );

  return clobClient;
}
```

#### ClobClient Constructor Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| `host` | `https://clob.polymarket.com` | CLOB API endpoint |
| `chainId` | `137` | Polygon mainnet |
| `signer` | `PrivySignerAdapter` | Signs orders |
| `creds` | API credentials | Authentication for CLOB |
| `signatureType` | `2` | Safe proxy wallet type |
| `funder` | Proxy wallet address | Address that holds funds |
| `builderConfig` | `BuilderConfig` | Enables gasless trading |

---

### Relay Client & Wallet Deployment

**File:** `src/services/privy/wallet-deployment.service.ts`

The `RelayClient` handles gasless transactions through Polymarket's relayer for:
- Deploying Gnosis Safe proxy wallets
- Setting token approvals
- Transferring fees
- Redeeming positions

```typescript
export async function createViemWalletForRelayer(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string
): Promise<{ wallet: any; builderConfig: any; signer: any }> {
  const signer = createPrivySigner(privyUserId, embeddedWalletAddress, walletId);
  const normalizedAddress = (await signer.getAddress()).toLowerCase() as `0x${string}`;

  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: BUILDER_SIGNING_SERVER_URL },
  });

  // Create viem account that uses Privy's signing methods
  const account = {
    address: normalizedAddress,
    type: 'local' as const,
    
    async signMessage({ message }) {
      // Handle viem's {raw: Uint8Array} message format
      let actualMessage: string | Uint8Array;
      if (typeof message === 'object' && 'raw' in message) {
        actualMessage = message.raw;
      } else {
        actualMessage = message;
      }
      return await signer.signMessage(actualMessage) as `0x${string}`;
    },
    
    async signTypedData({ domain, types, primaryType, message }) {
      // Convert viem types to ethers format
      const ethersTypes = {};
      for (const [key, value] of Object.entries(types)) {
        if (key !== 'EIP712Domain') {
          ethersTypes[key] = value.map(field => ({
            name: field.name,
            type: field.type,
          }));
        }
      }
      return await signer._signTypedData(domain, ethersTypes, message) as `0x${string}`;
    },
  };

  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(RPC_URL),
  });

  return { wallet, builderConfig, signer };
}

export async function deployProxyWallet(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string
): Promise<string> {
  const { wallet, builderConfig } = await createViemWalletForRelayer(
    privyUserId,
    embeddedWalletAddress,
    walletId
  );

  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');

  const relayerClient = new RelayClient(
    RELAYER_URL,
    CHAIN_ID,
    wallet,
    builderConfig,
    RelayerTxType.SAFE
  );

  // Deploy the Safe wallet
  const deployResponse = await relayerClient.deploy();
  const result = await deployResponse.wait();

  const safeAddress = result.proxyAddress;

  // Add authorization key as co-owner
  await addOwnerToSafe(safeAddress, authorizationKeyAddress, ...);

  return safeAddress;
}
```

---

## Trading Flow

### Buy Orders

```
User wants to buy 10 shares at $0.50 each
         │
         ▼
┌────────────────────────────────────────────┐
│ Frontend sends:                            │
│ {                                          │
│   privyUserId: "did:privy:...",           │
│   marketInfo: {                            │
│     marketId: "0x...",                    │
│     clobTokenId: "12345...",              │
│     outcome: "Yes"                         │
│   },                                       │
│   size: "10",      // shares               │
│   price: "0.50",   // price per share      │
│   orderType: "FOK"                         │
│ }                                          │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Backend calculates:                        │
│                                            │
│ USDC Amount = shares × price               │
│             = 10 × 0.50                    │
│             = $5.00 USDC                   │
│                                            │
│ Fee = USDC Amount × 1%                     │
│     = $5.00 × 0.01                         │
│     = $0.05 USDC                           │
│                                            │
│ Total Required = $5.05 USDC                │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Pre-check balance via Alchemy:             │
│ fetchBalanceFromAlchemy(proxyWallet)       │
│                                            │
│ If balance < $5.05:                        │
│   Return error "Insufficient balance"      │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Create order via ClobClient:               │
│                                            │
│ clobClient.createAndPostMarketOrder({      │
│   tokenID: "12345...",                     │
│   amount: 5.00,  // BUY uses USDC amount   │
│   side: Side.BUY                           │
│ }, {}, ClobOrderType.FOK)                  │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Order signing flow:                        │
│                                            │
│ 1. ClobClient creates EIP-712 order        │
│ 2. Calls signer._signTypedData()           │
│ 3. PrivySignerAdapter → PrivyService       │
│ 4. Privy API signs with auth context       │
│ 5. Signature returned to ClobClient        │
│ 6. Order submitted to CLOB with signature  │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ CLOB Response:                             │
│ {                                          │
│   orderID: "abc123...",                    │
│   status: "MATCHED"                        │
│ }                                          │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Post-trade:                                │
│ 1. Update trade record → FILLED            │
│ 2. Transfer fee $0.05 to fee wallet        │
│ 3. Refresh positions (async)               │
│ 4. Refresh balance (async)                 │
└────────────────────────────────────────────┘
```

### Sell Orders

```
User wants to sell 10 shares at $0.60 each
         │
         ▼
┌────────────────────────────────────────────┐
│ Frontend sends:                            │
│ {                                          │
│   privyUserId: "did:privy:...",           │
│   marketInfo: { ... },                     │
│   size: "10",      // shares to sell       │
│   price: "0.60",   // expected price       │
│   orderType: "FOK"                         │
│ }                                          │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Create order via ClobClient:               │
│                                            │
│ clobClient.createAndPostMarketOrder({      │
│   tokenID: "12345...",                     │
│   amount: 10,     // SELL uses shares      │
│   side: Side.SELL                          │
│ }, {}, ClobOrderType.FOK)                  │
│                                            │
│ Note: For SELL, amount = number of shares  │
│       Price is determined by order book    │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ CLOB matches and fills order               │
│ Actual fill price may differ from input    │
└────────────────────────────────────────────┘
         │
         ▼
┌────────────────────────────────────────────┐
│ Async: Fetch actual fill data              │
│                                            │
│ trades = await clobClient.getTrades()      │
│ matchingTrade = trades.find(orderID)       │
│                                            │
│ Update trade record with:                  │
│ - Actual fill price                        │
│ - Actual fill size                         │
│ - Actual cost USDC                         │
│ - Transaction hash                         │
└────────────────────────────────────────────┘
```

---

## Price and Size Calculations

### Buy Orders

```typescript
// Frontend sends shares and price
const requestedShares = 10;
const pricePerShare = 0.50;

// Backend calculates USDC amount to send to CLOB
const usdcAmount = requestedShares * pricePerShare;
// usdcAmount = 10 * 0.50 = 5.00 USDC

// For createAndPostMarketOrder with BUY:
clobClient.createAndPostMarketOrder({
  tokenID: clobTokenId,
  amount: usdcAmount,  // 5.00 (USDC to spend)
  side: Side.BUY
}, {}, ClobOrderType.FOK);
```

### Sell Orders

```typescript
// Frontend sends shares and expected price
const sharesToSell = 10;
const expectedPrice = 0.60;

// For createAndPostMarketOrder with SELL:
clobClient.createAndPostMarketOrder({
  tokenID: clobTokenId,
  amount: sharesToSell,  // 10 (shares to sell)
  side: Side.SELL
}, {}, ClobOrderType.FOK);

// Actual fill price comes from order book matching
// May be different from expectedPrice
```

### Fee Calculation

```typescript
const FEE_RATE = 0.01; // 1%

// For BUY
const tradeCost = shares * price;
const fee = tradeCost * FEE_RATE;
const totalRequired = tradeCost + fee;

// For SELL
const proceedsFromSale = actualFillSize * actualFillPrice;
const fee = proceedsFromSale * FEE_RATE;
const netProceeds = proceedsFromSale - fee;
```

---

## Order Types

### FOK (Fill or Kill)

```typescript
OrderType.FOK
```
- **Behavior**: Entire order must fill immediately or cancel
- **Use case**: Market orders where user wants guaranteed execution
- **Minimum**: $1 USDC for market buy orders

### FAK (Fill and Kill)

```typescript
OrderType.FAK
```
- **Behavior**: Fill as much as possible immediately, cancel rest
- **Use case**: Large orders in thin markets

### LIMIT

```typescript
OrderType.LIMIT
```
- **Behavior**: Order sits in order book until filled or cancelled
- **Use case**: Specific price targets
- **Status**: Returns `LIVE` or `OPEN` until filled

---

## Fee System

**File:** `src/services/polymarket/trading/fee.service.ts`

### Fee Configuration

```typescript
export const FEE_CONFIG = {
  RATE: 0.01,        // 1% fee
  WALLET: '0x23895DdD9D2a22215080C0529614e471e1006BDf',
  MAX_RETRIES: 5,
};
```

### Fee Transfer Flow

```typescript
export async function transferFee(
  privyUserId: string,
  feeAmountUsdc: number,
  tradeId: string
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  // Get RelayerClient for gasless transfer
  const relayerClient = await getRelayerClientForFee(privyUserId);

  // Encode USDC transfer (6 decimals)
  const feeAmountWei = ethers.utils.parseUnits(feeAmountUsdc.toFixed(6), 6);

  const transferData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: 'transfer',
    args: [FEE_CONFIG.WALLET, BigInt(feeAmountWei.toString())]
  });

  const transaction = {
    to: USDC_CONTRACT_ADDRESS,
    data: transferData,
    value: '0',
  };

  // Execute via RelayerClient (gasless)
  const response = await relayerClient.execute(
    [transaction],
    `Trading fee: ${feeAmountUsdc} USDC`
  );

  const result = await response.wait();

  // Update trade record
  await updateTradeRecordById(tradeId, {
    feeStatus: 'PAID',
    feeTxHash: result.transactionHash,
  });

  return { success: true, txHash: result.transactionHash };
}
```

### Fee Retry Logic

```typescript
export async function retryPendingFees(): Promise<void> {
  // Find trades with pending/failed fees
  const result = await client.query(
    `SELECT id, privy_user_id, cost_usdc, fee_amount, fee_retry_count
     FROM trades_history
     WHERE fee_status IN ('PENDING', 'FAILED', 'RETRYING')
       AND fee_retry_count < $1
       AND status = 'FILLED'
       AND (fee_last_retry IS NULL OR fee_last_retry < NOW() - INTERVAL '5 minutes')
     ORDER BY created_at ASC
     LIMIT 10`,
    [FEE_CONFIG.MAX_RETRIES]
  );

  for (const row of result.rows) {
    await transferFee(row.privy_user_id, row.fee_amount, row.id);
  }
}
```

---

## Redemption System

**File:** `src/services/polymarket/trading/redemption.service.ts`

When a market resolves, winning positions can be redeemed for USDC.

### Contracts

```typescript
// Standard markets
const CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';

// Negative risk markets
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// USDC
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
```

### Redemption Flow

```typescript
export async function redeemPosition(
  privyUserId: string,
  conditionId: string
): Promise<RedemptionResult> {
  const user = await getUserByPrivyId(privyUserId);
  const position = await getPositionFromDB(privyUserId, conditionId);

  const isNegativeRisk = position.negative_risk || false;
  const redeemAmount = parseFloat(position.size); // Winning = $1 per share

  // Get RelayerClient
  const relayerClient = await getRelayerClient(privyUserId, user.embeddedWalletAddress);

  let redeemData: `0x${string}`;
  let targetContract: string;

  if (isNegativeRisk) {
    // Negative risk markets use the adapter
    const rawAmount = BigInt(Math.floor(parseFloat(position.size) * 1e6));
    const outcomeIndex = position.outcome_index ?? 0;

    redeemData = encodeFunctionData({
      abi: NEG_RISK_REDEEM_ABI,
      functionName: 'redeemPositions',
      args: [
        conditionId,
        [BigInt(1), BigInt(2)], // Index sets for binary markets
        [outcomeIndex === 0 ? rawAmount : 0n, outcomeIndex === 1 ? rawAmount : 0n],
      ],
    });
    targetContract = NEG_RISK_ADAPTER_ADDRESS;
  } else {
    // Standard markets use CTF directly
    redeemData = encodeFunctionData({
      abi: REDEEM_POSITIONS_ABI,
      functionName: 'redeemPositions',
      args: [
        USDC_CONTRACT_ADDRESS,
        PARENT_COLLECTION_ID,
        conditionId,
        [BigInt(1), BigInt(2)],
      ],
    });
    targetContract = CTF_CONTRACT_ADDRESS;
  }

  const transaction = {
    to: targetContract,
    data: redeemData,
    value: '0',
  };

  // Execute via RelayerClient (gasless)
  const response = await relayerClient.execute(
    [transaction],
    `Redeem ${position.outcome} position: ${position.title}`
  );

  const result = await response.wait();

  // Refresh balance and positions
  await refreshAndUpdateBalance(user.proxyWalletAddress, privyUserId);
  await refreshPositions(privyUserId);

  return {
    success: true,
    transactionHash: result.transactionHash,
    redeemedAmount: redeemAmount.toFixed(6),
  };
}
```

---

## Database Schema

**File:** `migrations/011_create_trades_history_table.sql`

```sql
CREATE TABLE IF NOT EXISTS trades_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) NOT NULL,
  proxy_wallet_address VARCHAR(42) NOT NULL,
  
  -- Market information
  market_id VARCHAR(255) NOT NULL,
  market_question TEXT,
  clob_token_id VARCHAR(255) NOT NULL,
  outcome TEXT NOT NULL,
  
  -- Trade details
  side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL', 'REDEEM')),
  order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('FOK', 'FAK', 'LIMIT', 'MARKET', 'REDEEM')),
  
  -- Amounts
  size DECIMAL(36, 18) NOT NULL,      -- Number of shares
  price DECIMAL(36, 18) NOT NULL,     -- Price per share
  cost_usdc DECIMAL(36, 18) NOT NULL, -- Total cost (size * price)
  
  -- Fees
  fee_usdc DECIMAL(36, 18) DEFAULT 0,
  fee_rate DECIMAL(10, 6),
  fee_amount DECIMAL(36, 18),
  fee_status VARCHAR(20),             -- PENDING, PAID, FAILED, RETRYING
  fee_tx_hash VARCHAR(66),
  fee_retry_count INTEGER DEFAULT 0,
  fee_last_retry TIMESTAMP WITH TIME ZONE,
  
  -- Transaction details
  order_id VARCHAR(255),
  transaction_hash VARCHAR(66),
  block_number BIGINT,
  block_timestamp TIMESTAMP WITH TIME ZONE,
  
  -- Status
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'FAILED')),
  
  -- Metadata
  metadata JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_trades_history_privy_user_id ON trades_history(privy_user_id);
CREATE INDEX idx_trades_history_market_id ON trades_history(market_id);
CREATE INDEX idx_trades_history_status ON trades_history(status);
CREATE INDEX idx_trades_history_user_created ON trades_history(privy_user_id, created_at DESC);
```

---

## API Endpoints

### POST /api/trading/buy

Execute a buy order.

**Request:**
```json
{
  "privyUserId": "did:privy:cmj921f4201dql40c3nubss93",
  "marketInfo": {
    "marketId": "0x123...",
    "clobTokenId": "16678291189211314787...",
    "outcome": "Yes",
    "marketQuestion": "Will event happen?"
  },
  "size": "10",
  "price": "0.50",
  "orderType": "FOK"
}
```

**Response:**
```json
{
  "success": true,
  "orderId": "abc123...",
  "status": "FILLED",
  "trade": {
    "id": "uuid",
    "side": "BUY",
    "size": "10",
    "price": "0.50",
    "costUsdc": "5.000000",
    "feeUsdc": "0.050000"
  }
}
```

### POST /api/trading/sell

Execute a sell order. Same structure as buy.

### GET /api/trading/history

Get trade history for a user.

**Query Parameters:**
- `privyUserId` (required)
- `limit` (default: 100)
- `offset` (default: 0)
- `side` (optional): BUY, SELL
- `marketId` (optional)
- `status` (optional): PENDING, FILLED, CANCELLED, FAILED

### GET /api/trading/redeem/available

Get redeemable positions.

### POST /api/trading/redeem

Redeem a single position.

**Request:**
```json
{
  "privyUserId": "did:privy:...",
  "conditionId": "0x..."
}
```

### POST /api/trading/redeem/all

Redeem all redeemable positions.

---

## Configuration

### Environment Variables

```bash
# Privy Configuration
PRIVY_APP_ID=your_app_id
PRIVY_APP_SECRET=your_app_secret
PRIVY_AUTHORIZATION_PRIVATE_KEY=0x...  # Critical for server-side signing
PRIVY_SIGNER_ID=authorization_key_id   # From Privy Dashboard

# Polymarket Configuration
POLYMARKET_CLOB_HOST=https://clob.polymarket.com
POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com/

# Builder Configuration
BUILDER_SIGNING_SERVER_URL=http://localhost:5001/sign

# Network Configuration
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### Polymarket Contract Addresses (Polygon Mainnet)

```typescript
const contracts = {
  usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  ctf: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
};
```

---

## Error Handling

### Error Codes

```typescript
export enum TradeErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  NO_PROXY_WALLET = 'NO_PROXY_WALLET',
  TOKENS_NOT_APPROVED = 'TOKENS_NOT_APPROVED',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  INVALID_PRICE = 'INVALID_PRICE',
  INVALID_SIZE = 'INVALID_SIZE',
  MARKET_UNAVAILABLE = 'MARKET_UNAVAILABLE',
  ORDER_REJECTED = 'ORDER_REJECTED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}
```

### Retry Logic

```typescript
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;

function isRetryableError(error: any): boolean {
  const status = error?.response?.status;
  return status === 503 || status === 502 || status === 429 || status === 504;
}

// Exponential backoff
for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    orderResponse = await clobClient.createAndPostMarketOrder(...);
    break;
  } catch (error) {
    if (isRetryableError(error) && attempt < MAX_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await sleep(delayMs);
      continue;
    }
    throw error;
  }
}
```

---

## Implementation Guide

### Step 1: Set Up Privy Authorization Key

1. Go to Privy Dashboard → Settings → Authorization Keys
2. Create a new authorization key
3. Copy the private key to `PRIVY_AUTHORIZATION_PRIVATE_KEY`
4. Copy the signer ID to `PRIVY_SIGNER_ID`

### Step 2: Set Up Builder Signing Server

You need a separate server that handles builder credentials:

```bash
# Builder signing server environment
POLY_BUILDER_API_KEY=your_builder_api_key
POLY_BUILDER_SECRET=your_builder_secret
POLY_BUILDER_PASSPHRASE=your_builder_passphrase
```

### Step 3: Implement Privy Signer

1. Create `PrivySignerAdapter` extending `ethers.Signer`
2. Implement `getAddress()`, `signMessage()`, `_signTypedData()`
3. Handle signature format normalization

### Step 4: Create CLOB Client Factory

1. Create `getClobClientForUser()` function
2. Handle API key creation/derivation
3. Pass `BuilderConfig` for gasless trading

### Step 5: Implement Trading Service

1. Validate user and approvals
2. Pre-check balance
3. Create CLOB order
4. Handle response and update records
5. Transfer fees asynchronously

### Step 6: Add Token Approvals

Before trading, users need approvals:

```typescript
// USDC approvals
await approve(USDC, ctfExchange, MAX_UINT256);
await approve(USDC, negRiskCtfExchange, MAX_UINT256);

// CTF (ERC1155) approvals
await setApprovalForAll(CTF, ctfExchange, true);
await setApprovalForAll(CTF, negRiskCtfExchange, true);
```

---

## Summary

The trading system uses a multi-layer architecture:

1. **PrivySignerAdapter** - Bridges Privy API to ethers.Signer interface
2. **PrivyService** - Handles Privy SDK calls with authorization context
3. **ClobClient** - Polymarket's order book SDK
4. **RelayClient** - Gasless Safe transactions for approvals, fees, redemptions
5. **BuilderConfig** - Enables builder flow for gasless order signing

Key flows:
- **Buy**: Shares × Price = USDC amount sent to CLOB
- **Sell**: Shares sent to CLOB, actual fill price from order book
- **Redeem**: CTF contract redeems winning positions for USDC
- **Fees**: 1% platform fee transferred via RelayClient

