/**
 * Investigate a Kalshi/DFlow Solana transaction to trace fund flow.
 * Usage: npx tsx scripts/investigate-kalshi-tx.ts <txSignature>
 */

const TX = process.argv[2] || '3ETSGdoRCZC4eahK7XtC7Mb5twRtNHxuqSAYjZNon4734ewozvengAaZ88J5xGzY6oYYE84EkL7V5vH9VLrDzdkx';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USER_WALLET = '7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU';

async function main() {
  const rpc = process.env.ALCHEMY_SOLANA_API_KEY
    ? `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_SOLANA_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';

  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [TX, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
    }),
  });
  const json = await res.json();
  if (json.error) {
    console.error('RPC error:', json.error);
    process.exit(1);
  }
  const tx = json.result;
  if (!tx) {
    console.error('Transaction not found');
    process.exit(1);
  }

  const meta = tx.meta;
  const pre = meta.preTokenBalances || [];
  const post = meta.postTokenBalances || [];
  const accountKeys = tx.transaction.message.accountKeys;

  console.log('\n=== KALSHI TX INVESTIGATION ===\n');
  console.log('Tx:', TX);
  console.log('Block:', tx.slot);
  console.log('Fee (lamports):', meta.fee);
  console.log('');

  // Find user's USDC balance
  const userPre = pre.find(
    (b: any) => b.mint === USDC_MINT && b.owner === USER_WALLET
  );
  const userPost = post.find(
    (b: any) => b.mint === USDC_MINT && b.owner === USER_WALLET
  );

  const preAmount = userPre ? parseInt(userPre.uiTokenAmount?.amount || '0', 10) : 0;
  const postAmount = userPost ? parseInt(userPost.uiTokenAmount?.amount || '0', 10) : 0;
  const debited = preAmount - postAmount;

  console.log('--- USER USDC FLOW ---');
  console.log('User wallet:', USER_WALLET);
  console.log('Pre-tx balance:', (preAmount / 1e6).toFixed(6), 'USDC');
  console.log('Post-tx balance:', (postAmount / 1e6).toFixed(6), 'USDC');
  console.log('USDC debited from user:', (debited / 1e6).toFixed(6), 'USDC');
  console.log('');

  // Find all USDC transfers in inner instructions
  const innerInstructions = meta.innerInstructions || [];
  for (const inner of innerInstructions) {
    for (const ix of inner.instructions) {
      const p = ix.parsed;
      if (p?.type === 'transferChecked' && p.info?.tokenAmount) {
        const amt = parseInt(p.info.tokenAmount.amount, 10);
        const dec = p.info.tokenAmount.decimals || 6;
        const uiAmt = amt / Math.pow(10, dec);
        console.log('--- TOKEN TRANSFER ---');
        console.log('  Amount:', uiAmt.toFixed(6), 'USDC');
        console.log('  Source:', p.info.source);
        console.log('  Destination:', p.info.destination);
        console.log('');
      }
    }
  }

  // Summary
  console.log('--- FINDINGS ---');
  const requestedUsdc = 3_000_000; // What we sent to DFlow
  const dflowInAmount = 2_752_455; // What DFlow returned as inAmount
  const actualDebited = debited;

  console.log('Requested (sent to DFlow):', (requestedUsdc / 1e6).toFixed(6), 'USDC');
  console.log('DFlow inAmount (quote):', (dflowInAmount / 1e6).toFixed(6), 'USDC');
  console.log('Actual on-chain debited:', (actualDebited / 1e6).toFixed(6), 'USDC');

  if (Math.abs(actualDebited - dflowInAmount) < 100) {
    console.log('\n✓ Actual debited matches DFlow inAmount. No extra fee taken.');
    console.log('  The $0.25 (requested - inAmount) was NEVER debited - it stayed in the user wallet.');
    console.log('  DFlow built a tx that only uses $2.75, not the full $3 we requested.');
  } else {
    console.log('\n? Discrepancy between actual debited and DFlow inAmount.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
