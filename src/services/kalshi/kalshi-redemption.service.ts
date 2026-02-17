import { pool, getDatabaseConfig } from '../../config/database';
import { dflowClient } from '../dflow/dflow.client';
import { privyService } from '../privy/privy.service';
import { SOLANA_USDC_MINT } from '../dflow/dflow-order-validation';
import { setKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { getSolanaUsdcBalance } from '../solana/solana-usdc-balance';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';
import { logger } from '../../config/logger';

export interface RedeemResult {
  success: boolean;
  solanaSignature?: string;
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

    // Get the user's wallet ID for signing
    const userResult = await client.query(
      'SELECT solana_wallet_id FROM users WHERE privy_user_id = $1',
      [privyUserId]
    );
    const solanaWalletId = userResult.rows[0]?.solana_wallet_id;
    if (!solanaWalletId) return { success: false, error: 'User has no Solana wallet ID' };

    const orderResponse = await dflowClient.getSellOrder({
      inputMint: outcomeMint,
      outputMint: SOLANA_USDC_MINT,
      amount: pos.token_balance,
      userPublicKey: pos.solana_wallet_address,
    });
    if (!orderResponse.transaction) return { success: false, error: 'No transaction from DFlow' };

    // Sign and submit via Privy
    const { hash } = await privyService.signAndSendSolanaTransaction(
      solanaWalletId,
      orderResponse.transaction
    );

    logger.info({
      message: 'Kalshi position redeemed',
      privyUserId,
      outcomeMint,
      txHash: hash,
    });

    await client.query(
      "UPDATE kalshi_positions SET redeemed_at = NOW(), token_balance = '0', updated_at = NOW() WHERE privy_user_id = $1 AND outcome_mint = $2",
      [privyUserId, outcomeMint]
    );

    // Post-redeem balance sync (same webhook-first, on-chain-fallback pattern)
    syncBalanceAfterRedeem(privyUserId, pos.solana_wallet_address);

    return { success: true, solanaSignature: hash };
  } catch (e) {
    logger.error({
      message: 'Kalshi redemption failed',
      privyUserId,
      outcomeMint,
      error: e instanceof Error ? e.message : String(e),
    });
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.release();
  }
}

function syncBalanceAfterRedeem(privyUserId: string, solanaWallet: string): void {
  const delays = [5000, 15000, 30000];
  for (const delay of delays) {
    setTimeout(async () => {
      try {
        const { getUserByPrivyId } = await import('../privy/user.service');
        const user = await getUserByPrivyId(privyUserId);
        const dbBalance = parseFloat((user as any)?.kalshiUsdcBalance ?? '0') || 0;
        const onChainBalance = await getSolanaUsdcBalance(solanaWallet);
        const onChainNum = parseFloat(onChainBalance) || 0;
        if (Math.abs(onChainNum - dbBalance) > 0.001) {
          await setKalshiUsdcBalance(privyUserId, onChainBalance);
          publishKalshiPositionUpdate(privyUserId, {
            type: 'balance_update',
            amount: onChainBalance,
            source: 'kalshi_redeem_onchain_fallback',
          });
          logger.info({
            message: 'Post-redeem on-chain balance synced (webhook fallback)',
            privyUserId,
            balance: onChainBalance,
            delayMs: delay,
          });
        }
      } catch (err) {
        logger.warn({
          message: 'Post-redeem balance sync failed',
          privyUserId,
          delayMs: delay,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, delay);
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
