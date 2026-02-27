/**
 * Privy Types
 * Type definitions for Privy integration
 */

export interface PrivyUser {
  id: string;
  createdAt: Date;
  linkedAccounts: PrivyLinkedAccount[];
}

export interface PrivyLinkedAccount {
  type: string;
  address?: string;
  chainType?: string;
  walletClientType?: string;
  connectorType?: string;
}

export interface PrivyEmbeddedWallet {
  address: string;
  chainType: 'ethereum' | 'solana';
  walletClientType: 'privy';
}

export interface SessionSignerConfig {
  userId: string;
  walletAddress: string;
}

export interface SignTypedDataRequest {
  userId: string;
  typedData: EIP712TypedData;
  walletId?: string; // Optional: walletId to avoid lookup if already known
}

export interface SignMessageRequest {
  userId: string;
  message: string;
  walletId?: string; // Optional: walletId to avoid lookup if already known
}

export interface EIP712TypedData {
  domain: EIP712Domain;
  types: Record<string, EIP712Type[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface EIP712Domain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

export interface EIP712Type {
  name: string;
  type: string;
}

export type TradingRegion = 'us' | 'international';

export interface UserProfile {
  id: string;
  privyUserId: string;
  username: string;
  /** EVM/Polygon embedded wallet (0x...) — Polymarket deposits, NOT Solana */
  embeddedWalletAddress: string;
  /** Polymarket proxy/Safe (0x...) — CLOB positions, NOT embedded or Solana */
  proxyWalletAddress: string | null;
  sessionSignerEnabled: boolean;
  usdcApprovalEnabled: boolean;
  ctfApprovalEnabled: boolean;
  onboardingCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Kalshi/Solana fields — Solana chain only (base58), NOT proxy or embedded */
  tradingRegion?: TradingRegion | null;
  /** Solana wallet (base58) for Kalshi/DFlow — distinct from proxy_wallet and embedded_wallet */
  solanaWalletAddress?: string | null;
  /** Privy wallet ID for Solana wallet — used for signAndSendSolanaTransaction */
  solanaWalletId?: string | null;
  kalshiOnboardingCompleted?: boolean;
  kalshiUsdcBalance?: string;
  embeddedWalletId?: string | null;
}

export interface CreateUserRequest {
  privyUserId: string;
  username: string;
  embeddedWalletAddress: string;
  tradingRegion?: TradingRegion | null;
}

export interface CreateUserResponse {
  success: boolean;
  user: UserProfile;
  proxyWalletAddress: string;
}

export interface ApproveTokensRequest {
  userId: string;
}

export interface ApproveTokensResponse {
  success: boolean;
  approvals: {
    usdc: boolean;
    ctf: boolean;
  };
  transactionHashes: string[];
}
