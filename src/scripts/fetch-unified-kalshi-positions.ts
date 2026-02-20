/**
 * Fetch unified Kalshi positions with enrichment (avg entry, current price, PnL).
 * Usage: npx tsx src/scripts/fetch-unified-kalshi-positions.ts [solanaWallet]
 * Or with privyUserId: npx tsx src/scripts/fetch-unified-kalshi-positions.ts --privy <privyUserId>
 */

import 'dotenv/config';
import { pool, getDatabaseConfig } from '../config/database';
import { getUnifiedPositions } from '../services/trading/unified-positions.service';

const WALLET = process.argv[2] || '7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU';
const USE_PRIVY = process.argv[2] === '--privy';
const PRIVY_OR_WALLET = process.argv[3] || (USE_PRIVY ? '' : WALLET);

async function getPrivyIdBySolana(solanaAddress: string): Promise<string | null> {
  if (getDatabaseConfig().type !== 'postgres') return null;
  const r = await pool.query(
    `SELECT privy_user_id FROM users WHERE solana_wallet_address = $1`,
    [solanaAddress]
  );
  return r.rows[0]?.privy_user_id ?? null;
}

async function main() {
  let privyUserId: string | null = null;

  if (USE_PRIVY && PRIVY_OR_WALLET) {
    privyUserId = PRIVY_OR_WALLET;
    console.log('Using privyUserId:', privyUserId);
  } else {
    const wallet = PRIVY_OR_WALLET;
    console.log('Looking up privy user for Solana wallet:', wallet);
    privyUserId = await getPrivyIdBySolana(wallet);
    if (!privyUserId) {
      console.error('No user found with solana_wallet_address =', wallet);
      process.exit(1);
    }
    console.log('Found privyUserId:', privyUserId);
  }

  console.log('\nFetching unified Kalshi positions (with avg entry, current price, PnL)...\n');
  const positions = await getUnifiedPositions(privyUserId, { platform: 'kalshi' });
  console.log('Count:', positions.length);
  console.log(JSON.stringify(positions, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
