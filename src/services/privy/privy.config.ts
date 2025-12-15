/**
 * Privy Configuration
 * Environment variables and constants for Privy integration
 */

export const privyConfig = {
  // Privy App credentials
  appId: process.env.PRIVY_APP_ID || '',
  appSecret: process.env.PRIVY_APP_SECRET || '',
  
  // Authorization key for signing requests (required for adding session signers)
  authorizationPrivateKey: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY || '',
  
  // Default session signer ID (optional - can be overridden per request)
  // This is the authorization key quorum ID from Privy Dashboard
  defaultSignerId: process.env.PRIVY_SIGNER_ID || '',
  
  // Polymarket contract addresses on Polygon
  contracts: {
    usdc: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    ctf: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
    ctfExchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
    negRiskCtfExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
    negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  },
  
  // Chain configuration
  chainId: 137, // Polygon mainnet
  
  // RPC URL
  rpcUrl: process.env.RPC_URL || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
  
  // Polymarket Relayer URL
  relayerUrl: process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com/',
  
  // Builder signing server URL (your server that handles builder credentials)
  // This server runs with POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE
  // Your backend just needs to point to it - no credentials needed here
  // 
  // Default behavior:
  // - If BUILDER_SIGNING_SERVER_URL env var is set, use that
  // - Otherwise, default to localhost:5001/sign
  // 
  // For Docker: Set BUILDER_SIGNING_SERVER_URL=http://host.docker.internal:5001/sign
  // (requires extra_hosts: ["host.docker.internal:host-gateway"] in docker-compose.yml)
  // Or use the Docker gateway IP: BUILDER_SIGNING_SERVER_URL=http://172.17.0.1:5001/sign
  builderSigningServerUrl: process.env.BUILDER_SIGNING_SERVER_URL || 'http://localhost:5001/sign',
};

/**
 * Validate that required Privy configuration is present
 */
export function validatePrivyConfig(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  if (!privyConfig.appId) missing.push('PRIVY_APP_ID');
  if (!privyConfig.appSecret) missing.push('PRIVY_APP_SECRET');
  
  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * Validate that builder signing server is configured
 */
export function validateBuilderConfig(): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  
  if (!privyConfig.builderSigningServerUrl) {
    missing.push('BUILDER_SIGNING_SERVER_URL');
  }
  
  return {
    valid: missing.length === 0,
    missing,
  };
}
