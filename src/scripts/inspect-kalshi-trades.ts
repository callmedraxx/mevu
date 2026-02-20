/**
 * Inspect kalshi_trades_history for a user to debug avg entry calculation
 * Usage: npx tsx src/scripts/inspect-kalshi-trades.ts [privyUserId]
 */

import 'dotenv/config';
import { pool, getDatabaseConfig } from '../config/database';

const PRIVY_ID = process.argv[2] || 'did:privy:cmlqu976s005a0ckzaf5o4i1h';

async function main() {
  if (getDatabaseConfig().type !== 'postgres') {
    console.error('Requires postgres');
    process.exit(1);
  }
  const r = await pool.query(
    `SELECT id, kalshi_ticker, outcome, side, input_amount, output_amount, 
            (input_amount::bigint / 1e6)::float as input_usdc,
            (output_amount::bigint / 1e6)::float as output_tokens,
            created_at
     FROM kalshi_trades_history
     WHERE privy_user_id = $1
     ORDER BY created_at ASC`,
    [PRIVY_ID]
  );
  console.log('Trades for', PRIVY_ID);
  console.log(JSON.stringify(r.rows, null, 2));

  for (const row of r.rows) {
    if (row.side === 'BUY' && row.output_tokens > 0) {
      const priceCents = Math.round((parseInt(row.input_amount) * 100) / parseInt(row.output_amount));
      const priceDollars = (parseInt(row.input_amount) / 1e6) / (parseInt(row.output_amount) / 1e6);
      console.log(`\n--- BUY ${row.kalshi_ticker} ${row.outcome} ---`);
      console.log(`  input_amount (raw): ${row.input_amount} => ${(parseInt(row.input_amount)/1e6).toFixed(2)} USDC`);
      console.log(`  output_amount (raw): ${row.output_amount} => ${(parseInt(row.output_amount)/1e6).toFixed(2)} tokens`);
      console.log(`  Computed price: ${priceCents}¢ ($${priceDollars.toFixed(2)}/share)`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
