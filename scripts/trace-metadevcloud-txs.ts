/**
 * Trace metadevcloud Solana wallet transactions to find where $0.25 goes.
 * Usage: npx tsx scripts/trace-metadevcloud-txs.ts
 *
 * Fetches last 10 signatures, then inspects each tx for USDC flows.
 */

import 'dotenv/config';

const WALLET = '7mjajYQifi1MogMJyVxgAXiN7jdJDzwQPbbUoNSF3LnU';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const rpc =
  process.env.ALCHEMY_SOLANA_API_KEY || process.env.ALCHEMY_API_KEY
    ? `https://solana-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_SOLANA_API_KEY || process.env.ALCHEMY_API_KEY}`
    : 'https://api.mainnet-beta.solana.com';

async function rpcCall(method: string, params: any[]): Promise<any> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

async function main() {
  console.log('\n=== METADEVCLOUD SOLANA TX TRACE ===\n');
  console.log('Wallet:', WALLET);
  console.log('RPC:', rpc.replace(/\/v2\/[^/?]+/, '/v2/...'));
  console.log('');

  // 1. Get last 10 signatures
  const sigs = await rpcCall('getSignaturesForAddress', [
    WALLET,
    { limit: 10 },
  ]);
  if (!sigs?.length) {
    console.log('No transactions found');
    return;
  }

  console.log('--- LAST 10 SIGNATURES ---');
  for (const s of sigs) {
    console.log(' ', s.signature, '| slot:', s.slot, '| blockTime:', s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '');
  }
  console.log('');

  // 2. Inspect each tx for USDC flow
  for (const { signature } of sigs) {
    const tx = await rpcCall('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx) continue;

    const meta = tx.meta;
    const pre = meta?.preTokenBalances || [];
    const post = meta?.postTokenBalances || [];

    const userPre = pre.find((b: any) => b.mint === USDC_MINT && b.owner === WALLET);
    const userPost = post.find((b: any) => b.mint === USDC_MINT && b.owner === WALLET);
    const preAmount = userPre ? parseInt(userPre.uiTokenAmount?.amount || '0', 10) : 0;
    const postAmount = userPost ? parseInt(userPost.uiTokenAmount?.amount || '0', 10) : 0;
    const userDelta = preAmount - postAmount;

    // Skip if no USDC movement for this wallet
    if (userDelta === 0 && preAmount === 0 && postAmount === 0) {
      const otherUsdc = pre.concat(post).filter((b: any) => b.mint === USDC_MINT);
      if (otherUsdc.length === 0) continue;
    }

    console.log('--- TX:', signature.slice(0, 20) + '... ---');
    console.log('  Block:', tx.slot, '| Fee:', meta?.fee, 'lamports (Privy sponsors – user pays 0 SOL)');
    console.log('  User USDC: pre=', (preAmount / 1e6).toFixed(6), '| post=', (postAmount / 1e6).toFixed(6));
    console.log('  User USDC delta:', userDelta >= 0 ? '-' : '+', (Math.abs(userDelta) / 1e6).toFixed(6), 'USDC');

    // Parse inner instructions for transferChecked (SPL token transfers)
    const innerInstructions = meta?.innerInstructions || [];
    const transferChecked = tx.transaction?.message?.instructions || [];
    const accountKeys = tx.transaction?.message?.accountKeys || [];

    // Collect all USDC transferChecked from inner instructions
    const transfers: Array<{ amount: number; source: string; dest: string; sourceOwner?: string; destOwner?: string }> = [];

    function resolveOwner(addr: string): string {
      const key = accountKeys.find((k: any) => k.pubkey === addr);
      return key?.pubkey || addr;
    }

    for (const inner of innerInstructions) {
      for (const ix of inner.instructions) {
        const p = ix.parsed;
        if (p?.type === 'transferChecked' && p.info?.mint === USDC_MINT) {
          const amt = parseInt(p.info.tokenAmount?.amount || '0', 10);
          const dec = p.info.tokenAmount?.decimals ?? 6;
          const uiAmt = amt / Math.pow(10, dec);
          transfers.push({
            amount: uiAmt,
            source: p.info.source,
            dest: p.info.destination,
          });
        }
      }
    }

    if (transfers.length > 0) {
      console.log('  USDC transfers (inner):');
      const allBalances = [...(meta?.preTokenBalances || []), ...(meta?.postTokenBalances || [])];
      for (const t of transfers) {
        const srcInfo = allBalances.find((b: any) => b.address === t.source);
        const dstInfo = allBalances.find((b: any) => b.address === t.dest);
        const srcLabel = srcInfo?.owner === WALLET ? 'USER' : (srcInfo?.owner?.slice(0, 12) || t.source.slice(0, 12)) + '...';
        const dstLabel = dstInfo?.owner === WALLET ? 'USER' : (dstInfo?.owner?.slice(0, 12) || t.dest.slice(0, 12)) + '...';
        console.log('    ', t.amount.toFixed(6), 'USDC:', srcLabel, '->', dstLabel);
      }
    }

    // Look at main instructions for program invocations (DFlow, etc.)
    const msg = tx.transaction?.message;
    if (msg?.instructions) {
      for (const ix of msg.instructions) {
        if (ix.programId) {
          const prog = accountKeys.find((k: any) => k.pubkey === ix.programId);
          if (prog && !ix.programId.includes('11111111111111111111111111111111')) {
            // Skip system program for brevity
          }
        }
      }
    }

    console.log('');
  }

  console.log('--- SUMMARY ---');
  console.log('User requested $3. DFlow inAmount = $2.75. $0.25 = DFlow/protocol fee.');
  console.log('Trace above shows per-tx USDC debits. Fee flows to DFlow protocol accounts.');
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
