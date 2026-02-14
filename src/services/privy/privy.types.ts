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
  embeddedWalletAddress: string;
  proxyWalletAddress: string | null;
  sessionSignerEnabled: boolean;
  usdcApprovalEnabled: boolean;
  ctfApprovalEnabled: boolean;
  onboardingCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
  /** Kalshi/Solana fields (migration 039) */
  tradingRegion?: TradingRegion | null;
  solanaWalletAddress?: string | null;
  solanaWalletId?: string | null;
  kalshiOnboardingCompleted?: boolean;
  kalshiUsdcBalance?: string;
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
