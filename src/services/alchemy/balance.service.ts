/**
 * Alchemy Balance Service
 * Centralized service for fetching and updating USDC.e balances using Alchemy API
 * Only called on webhook events or after trades - no polling
 */

import axios from 'axios';
import { ethers } from 'ethers';
import { pool } from '../../config/database';
import { logger } from '../../config/logger';

const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

export interface BalanceResult {
  balanceRaw: string;
  balanceHuman: string;
}

/**
 * Fetch USDC.e balance from Alchemy API
 */
export async function fetchBalanceFromAlchemy(address: string): Promise<BalanceResult> {
  const alchemyApiKey = process.env.ALCHEMY_API_KEY;
  if (!alchemyApiKey) throw new Error('ALCHEMY_API_KEY not configured');

  const response = await axios.post(`https://polygon-mainnet.g.alchemy.com/v2/${alchemyApiKey}`, {
    id: 1,
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

/**
 * Fetch balance from Alchemy and update database
 * Called after trades or webhook events
 */
export async function refreshAndUpdateBalance(
  proxyWalletAddress: string,
  privyUserId: string
): Promise<BalanceResult> {
  const normalizedAddress = proxyWalletAddress.toLowerCase();
  
  const balance = await fetchBalanceFromAlchemy(proxyWalletAddress);
  
  await pool.query(
    `INSERT INTO wallet_balances (proxy_wallet_address, privy_user_id, balance_raw, balance_human, last_updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (proxy_wallet_address) DO UPDATE SET 
       balance_raw = $3, 
       balance_human = $4, 
       last_updated_at = NOW()`,
    [normalizedAddress, privyUserId, balance.balanceRaw, balance.balanceHuman]
  );

  logger.info({
    message: 'Balance refreshed from Alchemy',
    proxyWalletAddress: normalizedAddress,
    privyUserId,
    balanceHuman: balance.balanceHuman,
  });

  return balance;
}

/**
 * Get balance from database only (no API call)
 */
export async function getBalanceFromDb(proxyWalletAddress: string): Promise<BalanceResult | null> {
  const result = await pool.query(
    'SELECT balance_raw, balance_human FROM wallet_balances WHERE LOWER(proxy_wallet_address) = LOWER($1)',
    [proxyWalletAddress]
  );

  if (result.rows.length === 0) return null;

  return {
    balanceRaw: result.rows[0].balance_raw,
    balanceHuman: result.rows[0].balance_human.toString(),
  };
}
