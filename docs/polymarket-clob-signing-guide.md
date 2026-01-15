# Polymarket CLOB Order Signing with Privy Embedded Wallets

This guide explains how this codebase successfully signs Polymarket CLOB orders using Privy embedded wallets with `signatureType 2` (POLY_GNOSIS_SAFE).

## Problem Context

When integrating Privy embedded wallets with Polymarket's CLOB:
- **ClobAuth signatures work** ✅ (API credential creation/derivation)
- **Order signatures fail** ❌ with "invalid signature"

The issue: Privy's `signTypedData` produces signatures, but Order signing has specific requirements that differ from ClobAuth.

---

## Architecture Overview

This solution uses three main components:

1. **`PrivySignerAdapter`** - Custom ethers.js Signer wrapping Privy's signing APIs
2. **`BuilderConfig`** - Handles builder order signing via remote signing server
3. **`ClobClient`** - Official Polymarket CLOB client

```
┌─────────────────────────────────────────────────────────────────┐
│                         Trading Flow                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Request                                                    │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────┐                                                │
│  │ ClobClient  │◄──── BuilderConfig (remote signing server)     │
│  └──────┬──────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌──────────────────┐                                           │
│  │ PrivySignerAdapter│◄──── Signs via Privy SDK                 │
│  └────────┬─────────┘       with authorization_private_key      │
│           │                                                      │
│           ▼                                                      │
│  ┌─────────────────┐                                            │
│  │  Privy Service  │◄──── Uses AuthorizationContext             │
│  └─────────────────┘                                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Implementation Details

### 1. CLOB Client Creation

```typescript
// src/services/polymarket/trading/clob-client.service.ts

const SIGNATURE_TYPE = 2; // Deployed Safe proxy wallet signature type

// Create Privy signer adapter
const signer = createPrivySigner(
  privyUserId,
  user.embeddedWalletAddress,
  walletId || undefined
);

// CRITICAL: Create BuilderConfig for gasless trading via relayer
// This uses a REMOTE builder signing server
const builderConfig = new BuilderConfig({
  remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
});

// Create CLOB client with all components
const clobClient = new ClobClient(
  CLOB_HOST,
  CHAIN_ID,
  signer as any,
  apiCreds,
  SIGNATURE_TYPE,
  user.proxyWalletAddress, // Funder address (proxy wallet)
  undefined,
  false,
  builderConfig // Builder config for gasless trading
);
```

### 2. BuilderConfig with Remote Signing Server

**This is the critical piece that makes order signing work.**

The `builderSigningServerUrl` points to a separate service that holds Polymarket builder credentials:
- `POLY_BUILDER_API_KEY`
- `POLY_BUILDER_SECRET`
- `POLY_BUILDER_PASSPHRASE`

```typescript
// src/services/privy/privy.config.ts

export const privyConfig = {
  // Builder signing server URL
  // This server runs with POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE
  builderSigningServerUrl: process.env.BUILDER_SIGNING_SERVER_URL || 'http://localhost:5001/sign',
};
```

### 3. Privy Signer Adapter

Custom ethers.js Signer that wraps Privy's signing methods:

```typescript
// src/services/privy/privy-signer.adapter.ts

export class PrivySignerAdapter extends ethers.Signer {
  private userId: string;
  private walletAddress: string;
  private walletId?: string;

  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    
    // IMPORTANT: Serialize BigInt values to strings
    // Privy API doesn't accept BigInt
    const serializeBigInt = (obj: any): any => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'bigint') return obj.toString();
      if (typeof obj === 'object' && obj.constructor === Object) {
        const result: any = {};
        for (const [key, val] of Object.entries(obj)) {
          result[key] = serializeBigInt(val);
        }
        return result;
      }
      if (Array.isArray(obj)) return obj.map(serializeBigInt);
      // Handle ethers BigNumber
      if (obj && typeof obj === 'object' && '_hex' in obj) {
        return obj.toString();
      }
      return obj;
    };

    const serializedMessage = serializeBigInt(value);
    
    const typedData: EIP712TypedData = {
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? Number(domain.chainId) : undefined,
        verifyingContract: domain.verifyingContract,
        salt: domain.salt ? String(domain.salt) : undefined,
      },
      types: types as Record<string, { name: string; type: string }[]>,
      primaryType: Object.keys(types).find(key => key !== 'EIP712Domain') || '',
      message: serializedMessage,
    };

    const signature = await privyService.signTypedData({
      userId: this.userId,
      typedData,
      walletId: this.walletId,
    });

    // Normalize signature format (see section 5)
    return normalizeSignature(signature);
  }
}
```

### 4. Privy Service with Authorization Private Key

**Use authorization private key, NOT session signers or user JWT:**

```typescript
// src/services/privy/privy.service.ts

class PrivyService {
  
  // Get authorization context from private key
  private getAuthorizationContext(): AuthorizationContext | undefined {
    if (!privyConfig.authorizationPrivateKey) {
      return undefined;
    }
    return {
      authorization_private_keys: [privyConfig.authorizationPrivateKey],
    };
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    const authorizationContext = this.getAuthorizationContext();
    
    const ethereumWallets = this.privyClient.wallets().ethereum();
    
    // Use SDK's signTypedData with authorization context
    const response = await ethereumWallets.signTypedData(
      walletId,
      {
        params: {
          typed_data: {
            domain: request.typedData.domain,
            types: request.typedData.types,
            primary_type: request.typedData.primaryType, // snake_case for SDK
            message: request.typedData.message,
          },
        },
        authorization_context: authorizationContext, // CRITICAL: Pass auth context
      }
    );
    
    return normalizeSignature(response.signature);
  }
}
```

### 5. Signature Normalization

Privy may return signatures in different formats. Always normalize to `0x`-prefixed hex string:

```typescript
function normalizeSignature(signature: any): string {
  // Already a hex string
  if (typeof signature === 'string' && signature.startsWith('0x')) {
    return signature;
  }
  
  // Handle {raw: Uint8Array} format from Privy
  if (signature && typeof signature === 'object' && 'raw' in signature) {
    const rawValue = signature.raw;
    let bytes: Uint8Array;
    
    if (rawValue instanceof Uint8Array) {
      bytes = rawValue;
    } else if (typeof rawValue === 'object' && rawValue !== null) {
      // Convert object with numeric keys to Uint8Array
      const length = Object.keys(rawValue).length;
      bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = rawValue[i] || 0;
      }
    } else {
      throw new Error(`Unexpected raw signature format: ${typeof rawValue}`);
    }
    
    return ethers.utils.hexlify(bytes);
  }
  
  throw new Error(`Invalid signature format: ${typeof signature}`);
}
```

### 6. Wallet Creation with App as Additional Signer

When creating embedded wallets, add your app's signer ID:

```typescript
// src/services/privy/privy.service.ts

async createEmbeddedWallet(userId: string): Promise<{ address: string; walletId?: string }> {
  const createRequest: any = {
    chain_type: 'ethereum',
    owner: {
      user_id: userId,
    },
  };
  
  // Add app as additional signer if signer ID is configured
  if (privyConfig.defaultSignerId) {
    createRequest.additional_signers = [
      {
        signer_id: privyConfig.defaultSignerId,
      },
    ];
  }
  
  const wallet = await this.privyClient.wallets().create(createRequest);
  return { address: wallet.address, walletId: wallet.id };
}
```

---

## Required Environment Variables

```bash
# Privy credentials
PRIVY_APP_ID=your_app_id
PRIVY_APP_SECRET=your_app_secret

# Authorization private key (from Privy Dashboard > Authorization Keys)
PRIVY_AUTHORIZATION_PRIVATE_KEY=your_auth_private_key

# Default signer ID (authorization key quorum ID from Privy Dashboard)
PRIVY_SIGNER_ID=your_authorization_key_quorum_id

# Builder signing server URL
# This server must have POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE
BUILDER_SIGNING_SERVER_URL=http://localhost:5001/sign

# Polymarket endpoints
POLYMARKET_CLOB_HOST=https://clob.polymarket.com
POLYMARKET_RELAYER_URL=https://relayer-v2.polymarket.com/

# Polygon RPC
RPC_URL=https://polygon-rpc.com
```

---

## Common Issues and Solutions

### Issue 1: "invalid signature" on Order signing

**Cause:** Order signatures require the BuilderConfig with remote signing server.

**Solution:** Ensure `builderConfig` is passed to `ClobClient` constructor:
```typescript
const builderConfig = new BuilderConfig({
  remoteBuilderConfig: { url: process.env.BUILDER_SIGNING_SERVER_URL },
});

const clobClient = new ClobClient(
  host, chainId, signer, apiCreds, signatureType, funderAddress,
  undefined, false,
  builderConfig // Don't forget this!
);
```

### Issue 2: Signature format errors

**Cause:** Privy returns `{raw: Uint8Array}` instead of hex string.

**Solution:** Always normalize signatures before returning:
```typescript
if (signature && typeof signature === 'object' && 'raw' in signature) {
  return ethers.utils.hexlify(signature.raw);
}
```

### Issue 3: BigInt serialization errors

**Cause:** Privy API doesn't accept BigInt values.

**Solution:** Serialize all BigInt values to strings before calling Privy:
```typescript
const serializedMessage = JSON.parse(JSON.stringify(message, (_, v) =>
  typeof v === 'bigint' ? v.toString() : v
));
```

### Issue 4: 401 Unauthorized from Privy

**Cause:** Missing or invalid authorization context.

**Solution:** Ensure `PRIVY_AUTHORIZATION_PRIVATE_KEY` is set and passed correctly:
```typescript
const authorizationContext = {
  authorization_private_keys: [process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY],
};
```

### Issue 5: Builder signing server connection failed

**Cause:** Builder signing server not accessible or not running.

**Solution:** 
1. Ensure the builder signing server is running
2. For Docker: Use `host.docker.internal` or Docker gateway IP
3. Verify the server has the required Polymarket builder credentials

---

## File Structure Reference

```
src/services/
├── privy/
│   ├── privy.config.ts          # Configuration (env vars)
│   ├── privy.service.ts         # Privy API interactions
│   ├── privy.types.ts           # Type definitions
│   ├── privy-signer.adapter.ts  # Custom ethers.js Signer
│   └── wallet-deployment.service.ts  # Proxy wallet deployment
└── polymarket/
    └── trading/
        ├── clob-client.service.ts  # CLOB client creation
        └── trading.service.ts      # Trade execution
```

---

## Summary: Key Differences from Broken Implementations

| Aspect | Working Implementation | Broken Implementation |
|--------|------------------------|----------------------|
| **Order Signing** | Uses `BuilderConfig` with remote signing server | Tries to sign directly with Privy |
| **Auth Method** | `authorization_private_keys` in AuthorizationContext | Session signers or user JWT |
| **BigInt Handling** | Serializes BigInt to strings before Privy call | Sends raw BigInt |
| **Signature Format** | Normalizes `{raw: Uint8Array}` to hex string | Doesn't handle object format |
| **Wallet Setup** | Creates wallet with app as additional signer | Missing additional signer |

---

## Dependencies

```json
{
  "@polymarket/clob-client": "^x.x.x",
  "@polymarket/builder-signing-sdk": "^x.x.x",
  "@polymarket/builder-relayer-client": "^x.x.x",
  "@privy-io/node": "^x.x.x",
  "ethers": "^5.x.x",
  "viem": "^x.x.x"
}
```

