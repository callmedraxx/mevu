# MEVU Trading System - Complete Implementation Documentation

This document provides comprehensive documentation for recreating the Mevu trading platform, which integrates Privy for authentication, Polymarket for prediction market trading, Gnosis Safe proxy wallets for gasless transactions, and Alchemy webhooks for real-time balance tracking.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Environment Variables](#2-environment-variables)
3. [Privy Setup & Configuration](#3-privy-setup--configuration)
4. [Account Creation & User Registration Flow](#4-account-creation--user-registration-flow)
5. [Proxy Wallet Generation](#5-proxy-wallet-generation)
6. [Session Signer & Backend Signing](#6-session-signer--backend-signing)
7. [CLOB Client & Trading Service](#7-clob-client--trading-service)
8. [Token Approvals](#8-token-approvals)
9. [Alchemy Webhook Integration](#9-alchemy-webhook-integration)
10. [Database Schema](#10-database-schema)
11. [API Endpoints Reference](#11-api-endpoints-reference)
12. [NPM Dependencies](#12-npm-dependencies)
13. [Frontend Integration Guide](#13-frontend-integration-guide)

---

## 1. Architecture Overview

### System Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                    FRONTEND                                       │
│  ┌─────────────┐    ┌──────────────┐    ┌─────────────────┐                      │
│  │   Privy     │───▶│  User Auth   │───▶│  Session Signer │                      │
│  │   SDK       │    │  (Login)     │    │  Authorization  │                      │
│  └─────────────┘    └──────────────┘    └─────────────────┘                      │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                   BACKEND                                        │
│                                                                                  │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐          │
│  │  Privy Service  │───▶│ Wallet Deployment │───▶│  User Database     │          │
│  │  (@privy-io/    │    │    Service        │    │  (PostgreSQL)      │          │
│  │   node)         │    └──────────────────┘    └────────────────────┘          │
│  └─────────────────┘              │                                              │
│          │                        │                                              │
│          ▼                        ▼                                              │
│  ┌─────────────────┐    ┌──────────────────┐                                    │
│  │ PrivySigner     │    │  RelayerClient   │                                    │
│  │ Adapter         │    │  (Polymarket)    │                                    │
│  │ (ethers.js)     │    └──────────────────┘                                    │
│  └─────────────────┘              │                                              │
│          │                        ▼                                              │
│          │              ┌──────────────────┐    ┌────────────────────┐          │
│          │              │  Gnosis Safe     │───▶│  Token Approvals   │          │
│          │              │  Proxy Wallet    │    │  (USDC + CTF)      │          │
│          │              └──────────────────┘    └────────────────────┘          │
│          │                        │                                              │
│          ▼                        ▼                                              │
│  ┌─────────────────┐    ┌──────────────────┐                                    │
│  │  CLOB Client    │◀──│  Builder Config  │                                    │
│  │  (Trading)      │    │  (Signing SDK)   │                                    │
│  └─────────────────┘    └──────────────────┘                                    │
│          │                                                                       │
│          ▼                                                                       │
│  ┌─────────────────┐                                                            │
│  │  Polymarket     │                                                            │
│  │  CLOB API       │                                                            │
│  └─────────────────┘                                                            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL SERVICES                                   │
│                                                                                  │
│  ┌─────────────────┐    ┌──────────────────┐    ┌────────────────────┐          │
│  │  Privy API      │    │  Polymarket      │    │  Alchemy           │          │
│  │  (Wallets)      │    │  Relayer         │    │  (Webhooks)        │          │
│  └─────────────────┘    └──────────────────┘    └────────────────────┘          │
│                                                                                  │
│  ┌─────────────────┐    ┌──────────────────┐                                    │
│  │  Polygon RPC    │    │  Builder Signing │                                    │
│  │  (Blockchain)   │    │  Server          │                                    │
│  └─────────────────┘    └──────────────────┘                                    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Key Concepts

#### Embedded Wallet vs Proxy Wallet

| Concept | Description |
|---------|-------------|
| **Embedded Wallet** | Created by Privy for each user. This is the user's "owner" wallet that controls signing. Address is derived from Privy's MPC infrastructure. |
| **Proxy Wallet** | A Gnosis Safe smart contract wallet deployed via Polymarket's relayer. This wallet holds user funds and is used for trading. The embedded wallet is set as the owner. |

#### Session Signers

Session signers allow the backend to sign transactions on behalf of users without requiring user interaction for each transaction. This is essential for:
- Deploying proxy wallets
- Executing trades
- Setting up token approvals

The backend uses an **Authorization Private Key** that is registered as a session signer with Privy.

#### Authorization Keys

An Authorization Key is a private key that:
1. Is configured in the Privy Dashboard
2. Has permission to sign on behalf of user wallets
3. Is used by the backend to authorize wallet operations

---

## 2. Environment Variables

### Complete Environment Variables List

```bash
# ============================================================
# PRIVY CONFIGURATION
# ============================================================

# Your Privy App ID (from Privy Dashboard → Settings → General)
PRIVY_APP_ID=your-privy-app-id

# Your Privy App Secret (from Privy Dashboard → Settings → General)
PRIVY_APP_SECRET=your-privy-app-secret

# Authorization Private Key for backend signing
# Generate a new Ethereum private key and register it in Privy Dashboard
# Format: 64 hex characters (without 0x prefix) or with 0x prefix
PRIVY_AUTHORIZATION_PRIVATE_KEY=your-64-char-hex-private-key

# Session Signer ID (Authorization Key Quorum ID from Privy Dashboard)
# Found in: Privy Dashboard → Settings → Authorization Keys
PRIVY_SIGNER_ID=your-signer-id-from-dashboard

# ============================================================
# POLYMARKET CONFIGURATION
# ============================================================

# Polymarket Relayer URL (for gasless transactions)
POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com/

# Polymarket CLOB Host
POLYMARKET_CLOB_HOST=https://clob.polymarket.com

# Builder Signing Server URL
# This server handles Polymarket builder credentials for order signing
# For local development: http://localhost:5001/sign
# For Docker: http://host.docker.internal:5001/sign
BUILDER_SIGNING_SERVER_URL=http://localhost:5001/sign

# Polymarket Bridge API (for deposit addresses)
POLYMARKET_BRIDGE_API_URL=https://bridge.polymarket.com

# ============================================================
# ALCHEMY CONFIGURATION (Balance Tracking)
# ============================================================

# Alchemy API Key for Polygon RPC
ALCHEMY_API_KEY=your-alchemy-api-key

# Alchemy Auth Token (from Alchemy Dashboard → Webhooks)
ALCHEMY_AUTH_TOKEN=your-alchemy-auth-token

# Existing Alchemy Webhook ID (optional - will create new if not provided)
ALCHEMY_WEBHOOK_ID=your-webhook-id

# Alchemy Webhook Signing Key (for signature verification)
ALCHEMY_SIGNING_KEY=your-webhook-signing-key

# Your server's webhook endpoint URL (public URL that Alchemy can reach)
ALCHEMY_WEBHOOK_URL=https://your-server.com/api/webhooks/alchemy

# ============================================================
# BLOCKCHAIN CONFIGURATION
# ============================================================

# Polygon RPC URL
RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/your-alchemy-api-key
# Alternative:
POLYGON_RPC_URL=https://polygon-rpc.com

# ============================================================
# DATABASE CONFIGURATION
# ============================================================

# PostgreSQL connection string (production only)
DATABASE_URL=postgresql://user:password@host:port/database

# Node environment
NODE_ENV=production  # or 'development' for in-memory storage

# ============================================================
# SERVER CONFIGURATION
# ============================================================

# Server port
PORT=3000

# Allowed CORS origins (comma-separated)
ALLOWED_ORIGINS=http://localhost:3000,https://your-frontend.com
```

### Environment Variable Sources

| Variable | Where to Get It |
|----------|-----------------|
| `PRIVY_APP_ID` | Privy Dashboard → Settings → General |
| `PRIVY_APP_SECRET` | Privy Dashboard → Settings → General |
| `PRIVY_AUTHORIZATION_PRIVATE_KEY` | Generate with `openssl rand -hex 32` and add public address to Privy Dashboard |
| `PRIVY_SIGNER_ID` | Privy Dashboard → Settings → Authorization Keys → Quorum ID |
| `ALCHEMY_API_KEY` | Alchemy Dashboard → Apps → View Key |
| `ALCHEMY_AUTH_TOKEN` | Alchemy Dashboard → Webhooks → Auth Token |
| `ALCHEMY_WEBHOOK_ID` | Created automatically or from Alchemy Dashboard |
| `ALCHEMY_SIGNING_KEY` | Alchemy Dashboard → Webhook Details → Signing Key |

---

## 3. Privy Setup & Configuration

### Privy Dashboard Configuration Checklist

#### Step 1: Create Privy App
1. Go to [dashboard.privy.io](https://dashboard.privy.io)
2. Create a new app or select existing
3. Note your **App ID** and **App Secret**

#### Step 2: Enable Embedded Wallets
1. Navigate to **Settings → Wallets**
2. Enable **Embedded Wallets**
3. Configure wallet creation settings (automatic creation recommended)

#### Step 3: Configure Authorization Keys
1. Navigate to **Settings → Authorization Keys**
2. Generate a new Ethereum private key locally:
   ```bash
   openssl rand -hex 32
   ```
3. Derive the public address from this private key
4. Add this address as an Authorization Key in Privy Dashboard
5. Note the **Signer ID** (Quorum ID) provided

#### Step 4: Enable Session Signers (if using)
1. Navigate to **Settings → Session Signers**
2. Enable Session Signers feature
3. Configure allowed policies if needed

### Privy Service Initialization

The Privy service is initialized in `src/services/privy/privy.service.ts`:

```typescript
import { PrivyClient } from '@privy-io/node';

class PrivyService {
  private privyClient: PrivyClient | null = null;

  initialize(): void {
    // Validate configuration
    if (!privyConfig.appId || !privyConfig.appSecret) {
      throw new Error('Missing Privy configuration');
    }

    // Initialize PrivyClient SDK
    this.privyClient = new PrivyClient({
      appId: privyConfig.appId,
      appSecret: privyConfig.appSecret,
    });
  }

  // Get authorization context for signing
  private getAuthorizationContext() {
    if (!privyConfig.authorizationPrivateKey) {
      return undefined;
    }
    return {
      authorization_private_keys: [privyConfig.authorizationPrivateKey],
    };
  }
}
```

### Configuration File Structure

```typescript
// src/services/privy/privy.config.ts
export const privyConfig = {
  appId: process.env.PRIVY_APP_ID || '',
  appSecret: process.env.PRIVY_APP_SECRET || '',
  authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '',
  defaultSignerId: process.env.PRIVY_SIGNER_ID || '',
  
  // Polymarket contract addresses on Polygon
  contracts: {
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    ctf: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
    ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  },
  
  chainId: 137, // Polygon mainnet
  rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
  relayerUrl: process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com/',
  builderSigningServerUrl: process.env.BUILDER_SIGNING_SERVER_URL || 'http://localhost:5001/sign',
};
```

---

## 4. Account Creation & User Registration Flow

### Complete Registration Flow

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                          USER REGISTRATION FLOW                               │
└──────────────────────────────────────────────────────────────────────────────┘

Frontend                          Backend                         External Services
   │                                 │                                    │
   │  1. User logs in via Privy     │                                    │
   │ ─────────────────────────────▶ │                                    │
   │                                 │                                    │
   │  2. POST /api/users/register   │                                    │
   │     {privyUserId, username}    │                                    │
   │ ─────────────────────────────▶ │                                    │
   │                                 │                                    │
   │                                 │  3. Check if user exists          │
   │                                 │ ─────────────────────────────────▶ │ (Database)
   │                                 │                                    │
   │                                 │  4. Get/Create embedded wallet    │
   │                                 │ ─────────────────────────────────▶ │ (Privy API)
   │                                 │     createEmbeddedWallet()        │
   │                                 │ ◀───────────────────────────────── │
   │                                 │     {address, walletId}           │
   │                                 │                                    │
   │                                 │  5. Add session signer to wallet  │
   │                                 │ ─────────────────────────────────▶ │ (Privy API)
   │                                 │     addSessionSigner()            │
   │                                 │ ◀───────────────────────────────── │
   │                                 │                                    │
   │                                 │  6. Create user in database       │
   │                                 │ ─────────────────────────────────▶ │ (Database)
   │                                 │                                    │
   │                                 │  7. Deploy proxy wallet (Safe)    │
   │                                 │ ─────────────────────────────────▶ │ (Polymarket
   │                                 │     RelayerClient.deploy()        │  Relayer)
   │                                 │ ◀───────────────────────────────── │
   │                                 │     {proxyAddress, txHash}        │
   │                                 │                                    │
   │                                 │  8. Update user with proxy wallet │
   │                                 │ ─────────────────────────────────▶ │ (Database)
   │                                 │                                    │
   │                                 │  9. Add to Alchemy webhook        │
   │                                 │ ─────────────────────────────────▶ │ (Alchemy API)
   │                                 │                                    │
   │  10. Return user + wallets     │                                    │
   │ ◀───────────────────────────── │                                    │
   │     {user, embeddedWallet,     │                                    │
   │      proxyWallet}              │                                    │
   │                                 │                                    │
```

### Registration Endpoint Implementation

```typescript
// POST /api/users/register
router.post('/register', async (req: Request, res: Response) => {
  const { privyUserId, username, userJwt } = req.body;

  // Validate username format
  const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({
      success: false,
      error: 'Username must be 3-50 characters, alphanumeric and underscores only',
    });
  }

  // Register user and deploy proxy wallet
  const result = await registerUserAndDeployWallet(privyUserId, username, userJwt);

  res.status(201).json({
    success: true,
    user: result.user,
    embeddedWalletAddress: result.embeddedWalletAddress,
    proxyWalletAddress: result.proxyWalletAddress,
    sessionSignerEnabled: result.user.sessionSignerEnabled,
  });
});
```

### Core Registration Function

```typescript
// src/services/privy/wallet-deployment.service.ts
export async function registerUserAndDeployWallet(
  privyUserId: string,
  username: string,
  userJwt?: string
): Promise<{ user: UserProfile; proxyWalletAddress: string | null; embeddedWalletAddress: string }> {
  
  // Step 1: Check if user already exists
  const existingUser = await getUserByPrivyId(privyUserId);
  if (existingUser?.proxyWalletAddress) {
    return {
      user: existingUser,
      proxyWalletAddress: existingUser.proxyWalletAddress,
      embeddedWalletAddress: existingUser.embeddedWalletAddress,
    };
  }

  // Step 2: Get or create embedded wallet
  const walletResult = await privyService.createEmbeddedWallet(privyUserId);
  const embeddedWalletAddress = walletResult.address;
  const walletId = walletResult.walletId;

  // Step 3: Validate username availability
  const usernameAvailable = await isUsernameAvailable(username);
  if (!usernameAvailable) {
    throw new Error('Username is already taken');
  }

  // Step 4: Create user record
  const user = await createUser({
    privyUserId,
    username,
    embeddedWalletAddress,
  });

  // Step 5: Add session signer
  const signerId = privyConfig.defaultSignerId;
  if (signerId) {
    await privyService.addSessionSigner(
      privyUserId,
      embeddedWalletAddress,
      signerId,
      undefined,
      userJwt,
      walletId
    );
    await updateUserSessionSigner(privyUserId, true);
  }

  // Step 6: Deploy proxy wallet
  const proxyWalletAddress = await deployProxyWallet(
    privyUserId,
    embeddedWalletAddress,
    walletId
  );

  // Step 7: Update user with proxy wallet
  const updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);

  // Step 8: Add to Alchemy webhook for balance tracking
  await alchemyWebhookService.addUserAddress(proxyWalletAddress, privyUserId);

  return {
    user: updatedUser,
    proxyWalletAddress,
    embeddedWalletAddress,
  };
}
```

---

## 5. Proxy Wallet Generation

### What is a Proxy Wallet?

A proxy wallet is a **Gnosis Safe** smart contract wallet deployed on Polygon. It provides:
- **Gasless transactions** via Polymarket's relayer
- **Multi-signature support** (threshold = 1, either owner can sign)
- **Smart contract functionality** for trading

### Owners Configuration

The Safe wallet is deployed with:
1. **User's embedded wallet** - Primary owner
2. **Authorization key address** - Co-owner (derived from `PRIVY_AUTHORIZATION_PRIVATE_KEY`)

Threshold is set to 1, meaning either owner can authorize transactions independently.

### Proxy Wallet Deployment Process

```typescript
// src/services/privy/wallet-deployment.service.ts
export async function deployProxyWallet(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string
): Promise<string> {
  
  // Step 1: Create viem wallet client for signing
  const { wallet, builderConfig, signer } = await createViemWalletForRelayer(
    privyUserId,
    embeddedWalletAddress,
    walletId
  );

  // Step 2: Import RelayerClient
  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');

  // Step 3: Create RelayerClient instance
  const relayerClient = new RelayClient(
    privyConfig.relayerUrl,      // https://relayer-v2.polymarket.com/
    privyConfig.chainId,          // 137 (Polygon)
    wallet,                       // Viem wallet client
    builderConfig,                // BuilderConfig for signing
    RelayerTxType.SAFE            // Deploy Safe wallet type
  );

  // Step 4: Deploy the Safe wallet
  const deployResponse = await relayerClient.deploy();
  const result = await deployResponse.wait();

  const safeAddress = result.proxyAddress;

  // Step 5: Add authorization key as co-owner (optional)
  const authorizationKeyAddress = getAuthorizationKeyAddress();
  if (authorizationKeyAddress) {
    await addOwnerToSafe(
      safeAddress,
      authorizationKeyAddress,
      wallet,
      builderConfig,
      relayerClient,
      privyUserId
    );
  }

  return safeAddress;
}
```

### Creating Viem Wallet Client for Relayer

```typescript
export async function createViemWalletForRelayer(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string
): Promise<{ wallet: any; builderConfig: any; signer: any }> {
  
  // Create Privy signer adapter
  const signer = createPrivySigner(privyUserId, embeddedWalletAddress, walletId);
  const signerAddress = await signer.getAddress();
  const normalizedAddress = signerAddress.toLowerCase() as `0x${string}`;

  // Import viem and BuilderConfig
  const { createWalletClient, http } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { BuilderConfig } = await import('@polymarket/builder-signing-sdk');

  // Create BuilderConfig with remote signing server
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
  });

  // Create viem account with Privy signing
  const account = {
    address: normalizedAddress,
    type: 'local' as const,
    
    async signMessage({ message }) {
      // Handle message formats from ViemSigner
      let actualMessage = typeof message === 'object' && 'raw' in message 
        ? message.raw 
        : message;
      const signature = await signer.signMessage(actualMessage);
      return signature as `0x${string}`;
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
      
      const signature = await signer._signTypedData(domain, ethersTypes, message);
      return signature as `0x${string}`;
    },
  };

  // Create viem wallet client
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(privyConfig.rpcUrl),
  });

  return { wallet, builderConfig, signer };
}
```

---

## 6. Session Signer & Backend Signing

### How Session Signers Work

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                        SESSION SIGNER FLOW                                     │
└───────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────┐
                    │          PRIVY DASHBOARD            │
                    │                                     │
                    │  1. Add Authorization Key           │
                    │     (Public address derived from    │
                    │      PRIVY_AUTHORIZATION_PRIVATE_   │
                    │      KEY)                           │
                    │                                     │
                    │  2. Get Signer ID (Quorum ID)       │
                    │     → Set as PRIVY_SIGNER_ID       │
                    └─────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│                           BACKEND SIGNING                                      │
│                                                                                │
│  ┌─────────────────────┐    ┌─────────────────────┐    ┌───────────────────┐ │
│  │ Sign Request        │    │ Privy SDK           │    │ Privy API         │ │
│  │ (Order, Message)    │───▶│ signTypedData()     │───▶│ Authorization     │ │
│  │                     │    │                     │    │ Verified via      │ │
│  └─────────────────────┘    │ With:               │    │ Private Key       │ │
│                              │ authorization_      │    └───────────────────┘ │
│                              │ context: {          │              │           │
│                              │   authorization_    │              │           │
│                              │   private_keys:     │              ▼           │
│                              │   [PRIVY_AUTH_KEY]  │    ┌───────────────────┐ │
│                              │ }                   │    │ Signature         │ │
│                              └─────────────────────┘    │ Returned          │ │
│                                                         └───────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

### PrivySignerAdapter Implementation

The `PrivySignerAdapter` extends ethers.js `Signer` to use Privy's signing API:

```typescript
// src/services/privy/privy-signer.adapter.ts
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
    this.walletAddress = ethers.utils.getAddress(walletAddress.toLowerCase());
    this.walletId = walletId;
    this.provider = provider || new ethers.providers.JsonRpcProvider(privyConfig.rpcUrl);
  }

  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  async signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    let messageString = typeof message === 'string' 
      ? message 
      : ethers.utils.hexlify(message);
    
    return await privyService.signMessage({
      userId: this.userId,
      message: messageString,
    });
  }

  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    // Serialize BigInt values (Privy API doesn't accept BigInt)
    const serializedMessage = serializeBigInt(value);
    
    const typedData = {
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? Number(domain.chainId) : undefined,
        verifyingContract: domain.verifyingContract,
      },
      types: types,
      primaryType: Object.keys(types).find(key => key !== 'EIP712Domain') || '',
      message: serializedMessage,
    };

    return await privyService.signTypedData({
      userId: this.userId,
      typedData,
      walletId: this.walletId,
    });
  }
}
```

### Adding Session Signer to Wallet

```typescript
// src/services/privy/privy.service.ts
async addSessionSigner(
  userId: string,
  walletAddress: string,
  signerId: string,
  policyIds?: string[],
  userJwt?: string,
  walletId?: string
): Promise<void> {
  
  // Get wallet ID if not provided
  let finalWalletId = walletId;
  if (!finalWalletId) {
    finalWalletId = await this.getWalletIdByAddress(userId, walletAddress);
  }

  // Build authorization context
  let authorizationContext;
  const authKeyContext = this.getAuthorizationContext();
  
  if (authKeyContext?.authorization_private_keys?.length) {
    authorizationContext = authKeyContext;
  } else if (userJwt) {
    authorizationContext = { user_jwts: [userJwt] };
  }

  // Get current wallet signers
  const walletsService = this.privyClient.wallets();
  const wallet = await walletsService.getWallet(finalWalletId, {
    authorization_context: authorizationContext,
  });

  // Check if signer already exists
  const existingSigners = wallet.additional_signers || [];
  const signerExists = existingSigners.some(s => s.signer_id === signerId);
  if (signerExists) return;

  // Add new signer
  const updatedSigners = [
    ...existingSigners.map(s => ({ signer_id: s.signer_id })),
    { signer_id: signerId },
  ];

  // Update wallet
  await walletsService.update(
    finalWalletId,
    { additional_signers: updatedSigners },
    authorizationContext
  );
}
```

---

## 7. CLOB Client & Trading Service

### CLOB Client Initialization

```typescript
// src/services/polymarket/trading/clob-client.service.ts
const CLOB_HOST = process.env.POLYMARKET_CLOB_HOST || 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon mainnet
const SIGNATURE_TYPE = 2; // Deployed Safe proxy wallet

export async function getClobClientForUser(
  privyUserId: string,
  userJwt?: string
): Promise<ClobClient> {
  
  // Get user info
  const user = await getUserByPrivyId(privyUserId);
  if (!user?.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet');
  }

  // Get wallet ID for faster signing
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
    remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
  });

  // Create temporary client to get API credentials
  const tempClient = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    undefined,           // No API creds yet
    SIGNATURE_TYPE,
    user.proxyWalletAddress,  // Funder address
    undefined,
    false,
    builderConfig
  );

  // Create or derive API key
  const apiCreds = await tempClient.createOrDeriveApiKey();

  // Create final CLOB client with credentials
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

### Trade Execution Flow

```typescript
// src/services/polymarket/trading/trading.service.ts
export async function executeTrade(request: CreateTradeRequest): Promise<CreateTradeResponse> {
  const { privyUserId, marketInfo, side, orderType, size, price } = request;

  // Validate user
  const user = await getUserByPrivyId(privyUserId);
  if (!user?.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet');
  }
  if (!user.usdcApprovalEnabled || !user.ctfApprovalEnabled) {
    throw new Error('Token approvals not set up');
  }

  // Pre-check balance for BUY orders
  if (side === TradeSide.BUY) {
    const estimatedCost = parseFloat(size) * parseFloat(price);
    const feeAmount = estimatedCost * FEE_CONFIG.RATE;
    const totalRequired = estimatedCost + feeAmount;
    
    const balanceResult = await fetchBalanceFromAlchemy(user.proxyWalletAddress);
    const balanceUsdc = parseFloat(balanceResult.balanceHuman);
    
    if (balanceUsdc < totalRequired) {
      throw new Error(`Insufficient balance. Need $${totalRequired.toFixed(2)}`);
    }
  }

  // Save trade record with PENDING status
  const tradeRecord = await saveTradeRecord({
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
    marketId: marketInfo.marketId,
    clobTokenId: marketInfo.clobTokenId,
    outcome: marketInfo.outcome,
    side,
    orderType,
    size,
    price,
    costUsdc: (parseFloat(size) * parseFloat(price)).toFixed(18),
    status: 'PENDING',
  });

  // Get CLOB client
  const clobClient = await getClobClientForUser(privyUserId);

  // Execute order based on type
  let orderResponse;
  if (orderType === OrderType.FOK || orderType === OrderType.FAK) {
    // Market order
    let orderAmount = side === TradeSide.BUY 
      ? parseFloat(size) * parseFloat(price)  // BUY: USDC amount
      : parseFloat(size);                      // SELL: shares

    orderResponse = await clobClient.createAndPostMarketOrder(
      {
        tokenID: marketInfo.clobTokenId,
        amount: orderAmount,
        side: side === TradeSide.BUY ? Side.BUY : Side.SELL,
      },
      {},
      orderType === OrderType.FOK ? ClobOrderType.FOK : ClobOrderType.FAK
    );
  } else {
    // Limit order
    orderResponse = await clobClient.createAndPostOrder({
      tokenID: marketInfo.clobTokenId,
      price: parseFloat(price),
      size: parseFloat(size),
      side: side === TradeSide.BUY ? Side.BUY : Side.SELL,
    });
  }

  // Update trade record with result
  const finalStatus = orderResponse.status === 'MATCHED' ? 'FILLED' : 'PENDING';
  await updateTradeRecordById(tradeRecord.id, {
    orderId: orderResponse.orderID,
    status: finalStatus,
    feeRate: FEE_CONFIG.RATE,
    feeAmount: (parseFloat(size) * parseFloat(price) * FEE_CONFIG.RATE).toFixed(18),
  });

  // Transfer fee if filled
  if (finalStatus === 'FILLED') {
    const feeAmount = parseFloat(size) * parseFloat(price) * FEE_CONFIG.RATE;
    await transferFee(privyUserId, feeAmount, tradeRecord.id);
    await refreshPositions(privyUserId);
    await refreshAndUpdateBalance(user.proxyWalletAddress, privyUserId);
  }

  return {
    success: finalStatus === 'FILLED',
    orderId: orderResponse.orderID,
    status: finalStatus,
    trade: tradeRecord,
  };
}
```

### Fee Configuration

```typescript
// src/services/polymarket/trading/trading.types.ts
export const FEE_CONFIG = {
  RATE: 0.01,  // 1%
  WALLET: '0x23895DdD9D2a22215080C0529614e471e1006BDf',  // Fee recipient
  MAX_RETRIES: 5,
};
```

---

## 8. Token Approvals

### Required Approvals

Before trading, users must approve tokens for Polymarket exchange contracts:

| Token | Contract Address | Spenders |
|-------|------------------|----------|
| **USDC.e** | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | CTF Exchange, NegRisk Exchange, NegRisk Adapter, CTF |
| **CTF (ERC1155)** | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` | CTF Exchange, NegRisk Exchange, NegRisk Adapter |

### Contract Addresses on Polygon

```typescript
contracts: {
  usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  ctf: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
}
```

### Token Approval Implementation

```typescript
// src/services/privy/wallet-deployment.service.ts
async function createApprovalTransactions(): Promise<Transaction[]> {
  const { usdc, ctf, ctfExchange, negRiskCtfExchange, negRiskAdapter } = privyConfig.contracts;
  const { encodeFunctionData, maxUint256 } = await import('viem');
  
  const transactions: Transaction[] = [];

  // USDC approvals (ERC20)
  const usdcSpenders = [ctfExchange, negRiskCtfExchange, negRiskAdapter, ctf];
  for (const spender of usdcSpenders) {
    transactions.push({
      to: usdc,
      data: encodeFunctionData({
        abi: [{
          name: 'approve',
          type: 'function',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: [{ type: 'bool' }]
        }],
        functionName: 'approve',
        args: [spender, maxUint256]
      }),
      value: '0',
    });
  }

  // CTF approvals (ERC1155 setApprovalForAll)
  const ctfOperators = [ctfExchange, negRiskCtfExchange, negRiskAdapter];
  for (const operator of ctfOperators) {
    transactions.push({
      to: ctf,
      data: encodeFunctionData({
        abi: [{
          name: 'setApprovalForAll',
          type: 'function',
          inputs: [
            { name: 'operator', type: 'address' },
            { name: 'approved', type: 'bool' }
          ],
          outputs: []
        }],
        functionName: 'setApprovalForAll',
        args: [operator, true]
      }),
      value: '0',
    });
  }

  return transactions;
}

export async function setupTokenApprovals(privyUserId: string): Promise<{ success: boolean; transactionHashes: string[] }> {
  const user = await getUserByPrivyId(privyUserId);
  if (!user?.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet');
  }

  // Get or create RelayerClient
  const { wallet, builderConfig, signer } = await createViemWalletForRelayer(
    privyUserId,
    user.embeddedWalletAddress
  );

  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
  const relayerClient = new RelayClient(
    privyConfig.relayerUrl,
    privyConfig.chainId,
    wallet,
    builderConfig,
    RelayerTxType.SAFE
  );

  // Create and execute approval transactions
  const approvalTxs = await createApprovalTransactions();
  const response = await relayerClient.execute(
    approvalTxs,
    'Token approvals for Polymarket trading'
  );
  const result = await response.wait();

  // Update user profile
  await updateUserTokenApprovals(privyUserId, true, true);

  return {
    success: true,
    transactionHashes: [result.transactionHash],
  };
}
```

---

## 9. Alchemy Webhook Integration

### Webhook Setup

Alchemy webhooks provide real-time notifications for USDC.e transfers to/from user proxy wallets.

```typescript
// src/services/alchemy/alchemy-webhook.service.ts
const ALCHEMY_API_URL = 'https://dashboard.alchemy.com/api';
const POLYGON_NETWORK = 'MATIC_MAINNET';
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

class AlchemyWebhookService extends EventEmitter {
  async initialize(): Promise<void> {
    if (!ALCHEMY_AUTH_TOKEN) {
      logger.warn('ALCHEMY_AUTH_TOKEN not set, webhook service disabled');
      return;
    }

    // Use existing webhook or create new one
    if (ALCHEMY_WEBHOOK_ID) {
      this.webhookId = ALCHEMY_WEBHOOK_ID;
    } else if (WEBHOOK_URL) {
      await this.createWebhook();
    }

    // Sync all existing user addresses
    await this.syncAllAddresses();
    this.isInitialized = true;
  }

  private async createWebhook(): Promise<void> {
    const response = await axios.post(
      `${ALCHEMY_API_URL}/create-webhook`,
      {
        network: POLYGON_NETWORK,
        webhook_type: 'ADDRESS_ACTIVITY',
        webhook_url: WEBHOOK_URL,
        addresses: [],
      },
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
    this.webhookId = response.data.data.id;
  }

  async addAddresses(addresses: string[]): Promise<void> {
    await axios.patch(
      `${ALCHEMY_API_URL}/update-webhook-addresses`,
      {
        webhook_id: this.webhookId,
        addresses_to_add: addresses.map(a => a.toLowerCase()),
        addresses_to_remove: [],
      },
      {
        headers: {
          'X-Alchemy-Token': ALCHEMY_AUTH_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );
  }

  async processWebhook(payload: AlchemyWebhookPayload): Promise<void> {
    for (const activity of payload.event.activity) {
      // Only process USDC.e transfers
      if (activity.rawContract?.address?.toLowerCase() !== USDC_CONTRACT_ADDRESS.toLowerCase()) {
        continue;
      }

      const toAddress = activity.toAddress?.toLowerCase();
      const fromAddress = activity.fromAddress?.toLowerCase();
      const value = parseInt(activity.rawContract.rawValue, 16);
      const txHash = activity.hash;
      const blockNumber = parseInt(activity.blockNum, 16);

      // Update balance for recipient (deposit)
      if (toAddress) {
        await this.updateBalanceForAddress(toAddress, 'in', value, txHash, blockNumber, fromAddress);
      }

      // Update balance for sender (withdrawal)
      if (fromAddress) {
        await this.updateBalanceForAddress(fromAddress, 'out', value, txHash, blockNumber, toAddress);
      }
    }
  }

  private async updateBalanceForAddress(
    address: string,
    transferType: 'in' | 'out',
    amount: number,
    txHash: string,
    blockNumber: number,
    counterparty: string
  ): Promise<void> {
    // Check if address belongs to our user
    const userResult = await pool.query(
      `SELECT privy_user_id FROM users WHERE LOWER(proxy_wallet_address) = LOWER($1)`,
      [address]
    );
    if (userResult.rows.length === 0) return;

    const privyUserId = userResult.rows[0].privy_user_id;

    // Fetch current balance from Alchemy
    const balance = await fetchBalanceFromAlchemy(address);

    // Update database
    await pool.query(
      `INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (proxy_wallet_address) DO UPDATE SET 
         balance_raw = $3, balance_human = $4, last_updated_at = NOW()`,
      [address, privyUserId, balance.balanceRaw, balance.balanceHuman]
    );

    // Record transfer
    await pool.query(
      `INSERT INTO wallet_usdc_transfers 
       (proxy_wallet_address, privy_user_id, transfer_type, from_address, to_address, 
        amount_raw, amount_human, transaction_hash, block_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (transaction_hash, proxy_wallet_address) DO NOTHING`,
      [address, privyUserId, transferType, ...]
    );

    // Emit notification for SSE clients
    this.emit('deposit', {
      type: transferType === 'in' ? 'deposit' : 'withdrawal',
      privyUserId,
      proxyWalletAddress: address,
      amount: ethers.utils.formatUnits(amount.toString(), 6),
      txHash,
      blockNumber,
      newBalance: balance.balanceHuman,
    });
  }

  subscribeToDeposits(privyUserId: string, listener: (notification) => void): () => void {
    if (!this.depositListeners.has(privyUserId)) {
      this.depositListeners.set(privyUserId, new Set());
    }
    this.depositListeners.get(privyUserId).add(listener);
    
    return () => {
      this.depositListeners.get(privyUserId)?.delete(listener);
    };
  }
}
```

### Webhook Route Handler

```typescript
// src/routes/webhooks.ts
router.post('/alchemy', async (req: Request, res: Response) => {
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-alchemy-signature'] as string;

  // Verify signature
  if (signature && !alchemyWebhookService.verifySignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond immediately to avoid timeout
  res.status(200).json({ success: true, message: 'Webhook received' });

  // Process in background
  try {
    await alchemyWebhookService.processWebhook(req.body);
  } catch (error) {
    logger.error({ message: 'Error processing webhook', error });
  }
});
```

### SSE Streaming for Real-Time Updates

```typescript
// src/routes/webhooks.ts
router.get('/deposits/stream/:privyUserId', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send connected message
  res.write(`data: ${JSON.stringify({ type: 'connected', privyUserId })}\n\n`);

  // Subscribe to deposit notifications
  const unsubscribe = alchemyWebhookService.subscribeToDeposits(privyUserId, (notification) => {
    res.write(`data: ${JSON.stringify(notification)}\n\n`);
  });

  // Heartbeat every 30 seconds
  const heartbeatInterval = setInterval(() => {
    res.write(`: heartbeat\n\n`);
  }, 30000);

  // Handle disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
    res.end();
  });
});
```

---

## 10. Database Schema

### Users Table

```sql
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_user_id VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  embedded_wallet_address VARCHAR(42) NOT NULL,
  proxy_wallet_address VARCHAR(42),
  session_signer_enabled BOOLEAN DEFAULT FALSE,
  usdc_approval_enabled BOOLEAN DEFAULT FALSE,
  ctf_approval_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_privy_user_id ON users(privy_user_id);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_embedded_wallet ON users(embedded_wallet_address);
CREATE INDEX idx_users_proxy_wallet ON users(proxy_wallet_address);
```

### Wallet Balances Table

```sql
CREATE TABLE IF NOT EXISTS wallet_balances (
  id SERIAL PRIMARY KEY,
  proxy_wallet_address VARCHAR(255) NOT NULL UNIQUE,
  privy_user_id VARCHAR(255) NOT NULL,
  balance_raw VARCHAR(78) NOT NULL,
  balance_human DECIMAL(20, 6) NOT NULL,
  last_updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_wallet_balance_user 
    FOREIGN KEY (privy_user_id) REFERENCES users(privy_user_id) ON DELETE CASCADE
);

CREATE INDEX idx_wallet_balances_proxy_wallet ON wallet_balances(proxy_wallet_address);
CREATE INDEX idx_wallet_balances_privy_user ON wallet_balances(privy_user_id);
```

### Wallet USDC Transfers Table

```sql
CREATE TABLE IF NOT EXISTS wallet_usdc_transfers (
  id SERIAL PRIMARY KEY,
  proxy_wallet_address VARCHAR(255) NOT NULL,
  privy_user_id VARCHAR(255) NOT NULL,
  transfer_type VARCHAR(10) NOT NULL CHECK (transfer_type IN ('in', 'out')),
  from_address VARCHAR(255) NOT NULL,
  to_address VARCHAR(255) NOT NULL,
  amount_raw VARCHAR(78) NOT NULL,
  amount_human DECIMAL(20, 6) NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,
  block_number BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(transaction_hash, proxy_wallet_address)
);

CREATE INDEX idx_wallet_transfers_proxy ON wallet_usdc_transfers(proxy_wallet_address);
CREATE INDEX idx_wallet_transfers_user ON wallet_usdc_transfers(privy_user_id);
CREATE INDEX idx_wallet_transfers_created ON wallet_usdc_transfers(created_at DESC);
```

### Trades History Table

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
  side VARCHAR(10) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type VARCHAR(20) NOT NULL CHECK (order_type IN ('FOK', 'FAK', 'LIMIT', 'MARKET')),
  
  -- Amounts
  size DECIMAL(36, 18) NOT NULL,
  price DECIMAL(36, 18) NOT NULL,
  cost_usdc DECIMAL(36, 18) NOT NULL,
  
  -- Fees
  fee_usdc DECIMAL(36, 18) DEFAULT 0,
  fee_rate DECIMAL(10, 8),
  fee_amount DECIMAL(36, 18),
  fee_status VARCHAR(20) CHECK (fee_status IN ('PENDING', 'PAID', 'FAILED', 'RETRYING')),
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
  error_message TEXT,
  
  -- Metadata
  metadata JSONB,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trades_history_privy_user_id ON trades_history(privy_user_id);
CREATE INDEX idx_trades_history_market_id ON trades_history(market_id);
CREATE INDEX idx_trades_history_status ON trades_history(status);
CREATE INDEX idx_trades_history_created_at ON trades_history(created_at DESC);
CREATE INDEX idx_trades_history_user_created ON trades_history(privy_user_id, created_at DESC);
```

---

## 11. API Endpoints Reference

### User Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/users/register` | Register new user and deploy proxy wallet |
| `GET` | `/api/users/profiles/:privyUserId` | Get user profile by Privy ID |
| `GET` | `/api/users/by-username/:username` | Get user by username |
| `GET` | `/api/users/check-username/:username` | Check username availability |
| `GET` | `/api/users/:privyUserId/wallet` | Get wallet information |
| `POST` | `/api/users/:privyUserId/deploy-proxy-wallet` | Deploy proxy wallet (if missing) |
| `POST` | `/api/users/approve-tokens` | Set up token approvals |
| `POST` | `/api/users/add-session-signer` | Add session signer to wallet |
| `POST` | `/api/users/session-signer/confirm` | Confirm session signer enabled |
| `POST` | `/api/users/:privyUserId/deposit-addresses` | Get deposit addresses for bridging |
| `GET` | `/api/users/check-privy-config` | Check Privy configuration status |

### Trading Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/trading/buy` | Execute buy order |
| `POST` | `/api/trading/sell` | Execute sell order |
| `GET` | `/api/trading/history` | Get trade history |
| `GET` | `/api/trading/redeem/available` | Get redeemable positions |
| `POST` | `/api/trading/redeem` | Redeem single position |
| `POST` | `/api/trading/redeem/all` | Redeem all positions |

### Balance Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/balances/:privyUserId` | Get current balance (from DB) |
| `POST` | `/api/balances/:privyUserId/refresh` | Force refresh from Alchemy |
| `GET` | `/api/balances/:privyUserId/transfers` | Get transfer history |
| `GET` | `/api/balances/:privyUserId/deposits` | Get deposit history only |
| `GET` | `/api/balances/stream/:privyUserId` | SSE stream for balance updates |

### Webhook Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/webhooks/alchemy` | Receive Alchemy webhook notifications |
| `GET` | `/api/webhooks/alchemy/status` | Get webhook service status |
| `GET` | `/api/webhooks/deposits/stream/:privyUserId` | SSE stream for deposit notifications |

### Positions Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/positions/:privyUserId` | Get user positions |
| `GET` | `/api/positions/:privyUserId/portfolio` | Get portfolio summary |
| `GET` | `/api/positions/portfolio/:privyUserId/stream` | SSE stream for portfolio updates |

---

## 12. NPM Dependencies

### Core Dependencies

```json
{
  "dependencies": {
    "@privy-io/node": "^0.6.2",
    "@polymarket/builder-relayer-client": "^0.0.8",
    "@polymarket/builder-signing-sdk": "^0.0.8",
    "@polymarket/clob-client": "^4.22.8",
    "axios": "^1.6.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "ethers": "^5.7.2",
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "swagger-jsdoc": "^6.2.8",
    "swagger-ui-express": "^5.0.0",
    "ws": "^8.16.0"
  }
}
```

### Dev Dependencies

```json
{
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.5",
    "@types/pg": "^8.10.9",
    "@types/ws": "^8.5.10",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

### Package Descriptions

| Package | Purpose |
|---------|---------|
| `@privy-io/node` | Server-side Privy SDK for wallet operations and signing |
| `@polymarket/clob-client` | Polymarket CLOB client for order creation and trading |
| `@polymarket/builder-relayer-client` | RelayerClient for gasless transactions via Safe |
| `@polymarket/builder-signing-sdk` | BuilderConfig for Polymarket order signing |
| `ethers` | Ethereum library (v5) for signatures and utilities |
| `viem` | Modern EVM library (used internally by Polymarket packages) |
| `pg` | PostgreSQL client |
| `ws` | WebSocket library for real-time updates |

---

## 13. Frontend Integration Guide

### Privy Authentication Setup

```typescript
// Frontend Privy configuration
import { PrivyProvider } from '@privy-io/react-auth';

const privyConfig = {
  appId: 'your-privy-app-id',
  config: {
    loginMethods: ['email', 'wallet', 'google'],
    embeddedWallets: {
      createOnLogin: 'users-without-wallets',
      requireUserPasswordOnCreate: false,
    },
  },
};

function App() {
  return (
    <PrivyProvider {...privyConfig}>
      <YourApp />
    </PrivyProvider>
  );
}
```

### Registration Flow

```typescript
// Frontend registration
import { usePrivy, useWallets } from '@privy-io/react-auth';

function RegisterUser() {
  const { user, authenticated, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  
  const register = async (username: string) => {
    if (!authenticated || !user) return;
    
    // Get embedded wallet
    const embeddedWallet = wallets.find(w => w.walletClientType === 'privy');
    
    // Get user JWT (optional - for session signer)
    const userJwt = await getAccessToken();
    
    // Call backend registration
    const response = await fetch('/api/users/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        privyUserId: user.id,
        username,
        userJwt,
      }),
    });
    
    const result = await response.json();
    // result.user, result.embeddedWalletAddress, result.proxyWalletAddress
  };
}
```

### Trading Flow

```typescript
// Frontend trading
async function executeBuy(marketInfo: MarketInfo, shares: number, price: number) {
  const response = await fetch('/api/trading/buy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      privyUserId: user.id,
      marketInfo: {
        marketId: marketInfo.id,
        marketQuestion: marketInfo.question,
        clobTokenId: marketInfo.clobTokenId,
        outcome: marketInfo.outcome,
      },
      orderType: 'FOK',
      size: shares.toString(),
      price: price.toString(),
    }),
  });
  
  const result = await response.json();
  // result.success, result.orderId, result.status, result.trade
}
```

### Balance Tracking with SSE

```typescript
// Frontend SSE for balance updates
function useBalanceStream(privyUserId: string) {
  const [balance, setBalance] = useState('0');
  
  useEffect(() => {
    const eventSource = new EventSource(
      `/api/balances/stream/${privyUserId}`
    );
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'snapshot' || data.type === 'deposit' || data.type === 'withdrawal') {
        setBalance(data.humanBalance);
      }
    };
    
    return () => eventSource.close();
  }, [privyUserId]);
  
  return balance;
}
```

### Deposit Addresses

```typescript
// Get deposit addresses for bridging
async function getDepositAddresses(privyUserId: string) {
  const response = await fetch(`/api/users/${privyUserId}/deposit-addresses`, {
    method: 'POST',
  });
  
  const result = await response.json();
  // result.addresses = [
  //   { chain: 'Polygon', address: '0x...', token: 'USDC.e', minCheckoutUsd: 2 },
  //   { chain: 'Ethereum', address: '0x...', token: 'USDC', minCheckoutUsd: 10 },
  //   { chain: 'Solana', address: '...', token: 'SOL', minCheckoutUsd: 5 },
  //   { chain: 'Base', address: '0x...', token: 'USDC', minCheckoutUsd: 2 },
  // ]
}
```

---

## Builder Signing Server

The builder signing server is a separate service that handles Polymarket builder credentials. It must be running and accessible to the backend.

### Server Requirements

The builder signing server needs these environment variables:
- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_SECRET`
- `POLY_BUILDER_PASSPHRASE`

These credentials are obtained from Polymarket and enable gasless order signing.

### Connection Configuration

```bash
# Local development
BUILDER_SIGNING_SERVER_URL=http://localhost:5001/sign

# Docker (using host network)
BUILDER_SIGNING_SERVER_URL=http://host.docker.internal:5001/sign

# Docker (using gateway IP)
BUILDER_SIGNING_SERVER_URL=http://172.17.0.1:5001/sign
```

---

## Security Considerations

### Private Key Management

1. **Never commit private keys** - Use environment variables or secrets manager
2. **Rotate keys regularly** - Especially `PRIVY_AUTHORIZATION_PRIVATE_KEY`
3. **Use different keys per environment** - Separate dev/staging/production

### Webhook Security

1. **Always verify signatures** - Use `ALCHEMY_SIGNING_KEY`
2. **Respond immediately** - Process webhooks asynchronously
3. **Implement idempotency** - Handle duplicate webhook deliveries

### API Security

1. **Validate user ownership** - Verify `privyUserId` matches authenticated user
2. **Rate limit endpoints** - Especially trading and balance endpoints
3. **Validate input** - Check amounts, addresses, and parameters

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Session signer not authorized" | Session signer not added to wallet | Call `/api/users/add-session-signer` or check Privy Dashboard |
| "User does not have a proxy wallet" | Wallet deployment failed | Call `/api/users/:id/deploy-proxy-wallet` |
| "Token approvals not set up" | Approvals not executed | Call `/api/users/approve-tokens` |
| "Builder signing server connection failed" | Server not running or wrong URL | Verify `BUILDER_SIGNING_SERVER_URL` |
| "Insufficient balance" | Not enough USDC in proxy wallet | Check balance and deposit more USDC |

### Debug Endpoints

- `GET /api/users/check-privy-config` - Verify Privy configuration
- `GET /api/webhooks/alchemy/status` - Check Alchemy webhook status
- `POST /api/balances/:id/refresh` - Force balance refresh

---

## Conclusion

This documentation covers the complete implementation of the Mevu trading system. The key components are:

1. **Privy** - Authentication and embedded wallet management
2. **Gnosis Safe** - Proxy wallets for gasless trading
3. **Polymarket CLOB** - Order execution and trading
4. **Alchemy Webhooks** - Real-time balance tracking
5. **PostgreSQL** - User and trade persistence

By following this documentation, you can recreate the entire trading infrastructure for a Polymarket-based prediction market application.

