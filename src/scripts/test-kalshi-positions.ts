/**
 * Test script: Fetch Kalshi positions for a Solana wallet
 * Usage: npx tsx src/scripts/test-kalshi-positions.ts [wallet]
 */

import 'dotenv/config';
import { getKalshiPositions } from '../services/kalshi/kalshi-positions.service';

const WALLET = process.argv[2] || '7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU';

async function main() {
  console.log('Fetching Kalshi positions for wallet:', WALLET);
  const positions = await getKalshiPositions(WALLET);
  console.log('Positions count:', positions.length);
  console.log(JSON.stringify(positions, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
