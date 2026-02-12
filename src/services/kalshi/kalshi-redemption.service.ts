import { pool, getDatabaseConfig } from '../../config/database';
import { dflowClient } from '../dflow/dflow.client';
import { SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';

export interface RedeemResult {
  success: boolean;
  error?: string;
}

export async function redeemKalshiPosition(
  privyUserId: string,
  outcomeMint: string
): Promise<RedeemResult> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return { success: false, error: 'Database not available' };
  const client = await pool.connect();
  try {
    const posResult = await client.query(
      'SELECT * FROM kalshi_positions WHERE privy_user_id = $1 AND outcome_mint = $2 AND is_redeemable = true',
      [privyUserId, outcomeMint]
    );
    if (posResult.rows.length === 0) return { success: false, error: 'Position not found or not redeemable' };
    const pos = posResult.rows[0];
    const orderResponse = await dflowClient.getSellOrder({
      inputMint: outcomeMint,
      outputMint: SOLANA_USDC_MINT,
      amount: pos.token_balance,
      userPublicKey: pos.solana_wallet_address,
    });
    if (!orderResponse.transaction) return { success: false, error: 'No transaction from DFlow' };
    await client.query(
      "UPDATE kalshi_positions SET redeemed_at = NOW(), token_balance = '0', updated_at = NOW() WHERE privy_user_id = $1 AND outcome_mint = $2",
      [privyUserId, outcomeMint]
    );
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

export async function getRedeemablePositions(privyUserId: string): Promise<any[]> {
  const dbConfig = getDatabaseConfig();
  if (dbConfig.type !== 'postgres') return [];
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM kalshi_positions WHERE privy_user_id = $1 AND is_redeemable = true AND redeemed_at IS NULL',
      [privyUserId]
    );
    return result.rows;
  } finally {
    client.release();
  }
}
