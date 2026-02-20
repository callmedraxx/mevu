/**
 * Pre-warm DFlow market mappings for specific Kalshi tickers.
 * Run with: npx tsx src/scripts/sync-dflow-markets.ts [TICKER1 TICKER2 ...]
 *
 * Mappings are now populated on-demand when users trade (direct ticker lookup).
 * This script is optional — use it to pre-warm the cache for tickers you expect users to trade.
 *
 * Requires: DATABASE_URL, DFLOW_API_KEY
 */

import 'dotenv/config';
import { dflowMetadataService } from '../services/dflow/dflow-metadata.service';

async function main() {
  if (!dflowMetadataService.isEnabled()) {
    console.error('Add DFLOW_API_KEY to .env for production metadata API access');
    process.exit(1);
  }

  const tickers = process.argv.slice(2).filter(Boolean);

  if (tickers.length === 0) {
    console.log(
      'DFlow mappings are populated on-demand when users trade (no bulk sync needed).\n' +
        'To pre-warm specific tickers: npx tsx src/scripts/sync-dflow-markets.ts KXFEDCHAIRNOM-29-JS KXSB-26-NE'
    );
    process.exit(0);
  }

  console.log(`Pre-warming ${tickers.length} ticker(s)...`);
  let found = 0;
  for (const ticker of tickers) {
    const mapping = await dflowMetadataService.getMapping(ticker);
    if (mapping) {
      console.log(`  ${ticker}: cached`);
      found++;
    } else {
      console.log(`  ${ticker}: not found or not tradeable`);
    }
  }
  console.log(`Done. ${found}/${tickers.length} mappings cached.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
