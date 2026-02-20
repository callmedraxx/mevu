/**
 * One-off fix: correct input_amount for trade that was recorded as $3 instead of $2.64 (3 shares @ 88¢)
 * Run: npx tsx src/scripts/fix-kalshi-trade-2640000.ts
 */

import 'dotenv/config';
import { pool, getDatabaseConfig } from '../config/database';

const TRADE_ID = '495b2928-b8ae-4789-89ad-bbf4ca52bb13';

async function main() {
  if (getDatabaseConfig().type !== 'postgres') {
    console.error('Requires postgres');
    process.exit(1);
  }
  const r = await pool.query(
    `UPDATE kalshi_trades_history 
     SET input_amount = '2640000' 
     WHERE id = $1 AND input_amount = '3000000' 
     RETURNING id, input_amount, output_amount, kalshi_ticker, outcome`,
    [TRADE_ID]
  );
  if (r.rowCount === 0) {
    console.log('No row updated (may already be correct or not found)');
    return;
  }
  console.log('Fixed trade:', r.rows[0]);
  console.log('New avg price: 2640000/3000000 * 100 = 88¢');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
