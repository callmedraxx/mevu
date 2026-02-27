/**
 * Check Kalshi activity history and balances for a user (by username or privyUserId)
 * Usage: npx tsx src/scripts/check-user-kalshi-activity.ts metadevcloud
 *    or: npx tsx src/scripts/check-user-kalshi-activity.ts did:privy:xxx
 */

import 'dotenv/config';
import { pool, getDatabaseConfig } from '../config/database';
import { getUserByUsername, getUserByPrivyId } from '../services/privy/user.service';
import { getKalshiPositions } from '../services/kalshi/kalshi-positions.service';
import { getSolanaUsdcBalance } from '../services/solana/solana-usdc-balance';

const IDENTIFIER = process.argv[2] || 'metadevcloud';

async function main() {
  if (getDatabaseConfig().type !== 'postgres') {
    console.error('Requires postgres (set DATABASE_URL)');
    process.exit(1);
  }

  // Resolve to privyUserId
  let privyUserId: string;
  let user: Awaited<ReturnType<typeof getUserByPrivyId>>;

  if (IDENTIFIER.startsWith('did:privy:')) {
    privyUserId = IDENTIFIER;
    user = await getUserByPrivyId(privyUserId);
  } else {
    user = await getUserByUsername(IDENTIFIER);
    if (!user) {
      console.error(`User not found: ${IDENTIFIER}`);
      process.exit(1);
    }
    privyUserId = user.privyUserId;
  }

  const u = user as any;
  let solanaWallet = u?.solanaWalletAddress;

  // Fallback: get solana_wallet from most recent trade if not in users table
  if (!solanaWallet) {
    const tradeRes = await pool.query(
      'SELECT solana_wallet_address FROM kalshi_trades_history WHERE privy_user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [privyUserId]
    );
    solanaWallet = tradeRes.rows[0]?.solana_wallet_address ?? null;
    if (solanaWallet) console.log('  (solana_wallet from trade history - not in users table)');
  }

  console.log('\n=== USER ===');
  console.log('  username:', u?.username);
  console.log('  privy_user_id:', privyUserId);
  console.log('  solana_wallet:', solanaWallet ?? '(none)');
  console.log('  kalshi_usdc_balance (DB):', u?.kalshiUsdcBalance ?? '0');

  // On-chain Kalshi USDC balance
  if (solanaWallet) {
    const onChainBalance = await getSolanaUsdcBalance(solanaWallet);
    console.log('  kalshi_usdc_balance (on-chain):', onChainBalance);
  }

  // Activity history (kalshi_trades_history)
  console.log('\n=== KALSHI TRADES HISTORY ===');
  const historyRes = await pool.query(
    `SELECT id, kalshi_ticker, outcome, side, input_amount, output_amount, 
            platform_fee, dflow_order_id, status, solana_signature, created_at
     FROM kalshi_trades_history
     WHERE privy_user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [privyUserId]
  );

  if (historyRes.rows.length === 0) {
    console.log('  (no trades)');
  } else {
    for (const row of historyRes.rows) {
      const inputUsdc = row.input_amount ? (parseInt(row.input_amount) / 1e6).toFixed(2) : '?';
      const outputTokens = row.output_amount ? (parseInt(row.output_amount) / 1e6).toFixed(2) : '?';
      console.log(`  [${row.created_at}] ${row.side} ${row.kalshi_ticker} ${row.outcome}`);
      console.log(`    input: ${inputUsdc} USDC | output: ${outputTokens} tokens | status: ${row.status}`);
      if (row.solana_signature) console.log(`    tx: ${row.solana_signature}`);
    }
  }

  // Positions (from on-chain + kalshi_trades_history enrichment)
  console.log('\n=== KALSHI POSITIONS ===');
  if (!solanaWallet) {
    console.log('  (no Solana wallet - cannot fetch positions)');
  } else {
    const positions = await getKalshiPositions(solanaWallet);
    if (positions.length === 0) {
      console.log('  (no positions)');
    } else {
      for (const p of positions) {
        console.log(`  ${p.kalshiTicker ?? '?'} ${p.outcome ?? '?'}`);
        console.log(`    size: ${p.tokenBalanceHuman ?? p.tokenBalance ?? '?'} | cost: $${p.totalCostUsdc ?? '?'} | avg: ${p.avgEntryPrice ?? '?'}¢`);
      }
    }
  }

  console.log('\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
