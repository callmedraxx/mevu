/**
 * Redemption Service
 * Handles redeeming winning positions on Polymarket
 * Supports both standard and negative risk markets
 *
 * Uses on-chain Safe nonce instead of relayer's /nonce endpoint to avoid
 * nonce desync issues (relayer increments nonce on failed txs, on-chain doesn't).
 */

import {
  encodeFunctionData,
  hashTypedData,
  toBytes,
  encodePacked,
  hexToBigInt,
  zeroAddress,
  getCreate2Address,
  keccak256,
  encodeAbiParameters,
  createPublicClient,
  http,
} from 'viem';
import { polygon } from 'viem/chains';
import { pool } from '../../../config/database';
import { logger } from '../../../config/logger';
import { getUserByPrivyId } from '../../privy/user.service';
import { privyConfig } from '../../privy/privy.config';
import { saveTradeRecord, updateTradeRecordById } from './trades-history.service';
import { refreshAndUpdateBalance } from '../../alchemy/balance.service';
import { refreshPositions } from '../../positions/positions.service';
import axios from 'axios';

// Contract addresses
const CTF_CONTRACT_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Safe infrastructure constants (from @polymarket/builder-relayer-client)
const SAFE_FACTORY = '0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b' as `0x${string}`;
const SAFE_INIT_CODE_HASH = '0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf' as `0x${string}`;

// Safe nonce ABI
const SAFE_NONCE_ABI = [{
  name: 'nonce',
  type: 'function',
  stateMutability: 'view',
  inputs: [] as const,
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

// Parent collection ID is always null (0x00...00) for Polymarket binary markets
const PARENT_COLLECTION_ID = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// Index sets for binary markets: [1, 2] means both outcomes
const INDEX_SETS = [BigInt(1), BigInt(2)];

// CTF redeemPositions ABI (standard markets)
const REDEEM_POSITIONS_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSets', type: 'uint256[]' }
  ],
  outputs: []
}] as const;

// Neg Risk Adapter redeemPositions ABI (negative risk markets)
// Per SDK: only conditionId + amounts (no indexSets parameter)
const NEG_RISK_REDEEM_ABI = [{
  name: 'redeemPositions',
  type: 'function',
  inputs: [
    { name: '_conditionId', type: 'bytes32' },
    { name: '_amounts', type: 'uint256[]' }
  ],
  outputs: []
}] as const;

// Cache for wallet/builderConfig instances (no longer caching RelayerClient)
const walletCache = new Map<string, { wallet: any; builderConfig: any }>();

export interface RedeemablePosition {
  asset: string;
  conditionId: string;
  size: string;
  curPrice: string;
  currentValue: string;
  title: string;
  outcome: string;
  eventId: string;
}

export interface RedemptionResult {
  success: boolean;
  transactionHash?: string;
  redemptionId?: string;
  redeemedAmount?: string;
  error?: string;
}

export interface BatchRedemptionResult {
  success: boolean;
  totalRedeemed: number;
  totalAmount: string;
  results: {
    conditionId: string;
    title: string;
    outcome: string;
    success: boolean;
    transactionHash?: string;
    redemptionId?: string;
    redeemedAmount?: string;
    error?: string;
  }[];
}

/**
 * Get or create wallet + builderConfig for user
 */
async function getWalletAndConfig(privyUserId: string, embeddedWalletAddress: string): Promise<{ wallet: any; builderConfig: any }> {
  const cached = walletCache.get(privyUserId);
  if (cached) {
    return cached;
  }

  const { createViemWalletForRelayer } = await import('../../privy/wallet-deployment.service');
  const { privyService } = await import('../../privy/privy.service');

  // Use cached embedded_wallet_id from DB if available, fall back to Privy API
  let walletId: string | undefined = undefined;
  try {
    const { getUserByPrivyId: getUser } = await import('../../privy/user.service');
    const user = await getUser(privyUserId);
    if (user?.embeddedWalletId) {
      walletId = user.embeddedWalletId;
    } else {
      const fetchedWalletId = await privyService.getWalletIdByAddress(privyUserId, embeddedWalletAddress);
      if (fetchedWalletId) {
        walletId = fetchedWalletId;
        // Cache for future use
        const { updateUserEmbeddedWalletId } = await import('../../privy/user.service');
        updateUserEmbeddedWalletId(privyUserId, fetchedWalletId).catch(() => {});
      }
    }
  } catch {
    logger.warn({
      message: 'Could not get wallet ID, will look up during signing',
      privyUserId,
    });
  }

  const { wallet, builderConfig } = await createViemWalletForRelayer(
    privyUserId,
    embeddedWalletAddress,
    walletId || undefined
  );

  const result = { wallet, builderConfig };
  walletCache.set(privyUserId, result);
  return result;
}

/**
 * Derive Safe address from owner address (same logic as SDK)
 */
function deriveSafeAddress(ownerAddress: string): `0x${string}` {
  return getCreate2Address({
    bytecodeHash: SAFE_INIT_CODE_HASH,
    from: SAFE_FACTORY,
    salt: keccak256(encodeAbiParameters([{ name: 'address', type: 'address' }], [ownerAddress as `0x${string}`])),
  });
}

/**
 * Read Safe nonce directly from on-chain (bypasses relayer's stale nonce)
 */
async function getOnChainSafeNonce(safeAddress: `0x${string}`): Promise<bigint> {
  const publicClient = createPublicClient({
    chain: polygon,
    transport: http(privyConfig.rpcUrl),
  });

  // Use type assertion to work around strict viem generics
  const nonce = await (publicClient as any).readContract({
    address: safeAddress,
    abi: SAFE_NONCE_ABI,
    functionName: 'nonce',
  }) as bigint;

  return nonce;
}

/**
 * Split signature and pack with adjusted v for Gnosis Safe eth_sign type
 * Replicates splitAndPackSig from @polymarket/builder-relayer-client
 */
function splitAndPackSafeSignature(sig: string): string {
  let sigV = parseInt(sig.slice(-2), 16);
  switch (sigV) {
    case 0:
    case 1:
      sigV += 31;
      break;
    case 27:
    case 28:
      sigV += 4;
      break;
    default:
      throw new Error(`Invalid signature v value: ${sigV}`);
  }
  const adjusted = sig.slice(0, -2) + sigV.toString(16);
  const r = hexToBigInt(('0x' + adjusted.slice(2, 66)) as `0x${string}`);
  const s = hexToBigInt(('0x' + adjusted.slice(66, 130)) as `0x${string}`);
  const v = parseInt(adjusted.slice(130, 132), 16);
  return encodePacked(['uint256', 'uint256', 'uint8'], [r, s, v]);
}

/**
 * @deprecated Replaced by submitRedemptionTransaction + pollAndFinalizeRedemption
 */
async function _executeWithOnChainNonce_UNUSED(
  wallet: any,
  builderConfig: any,
  transaction: { to: string; data: `0x${string}`; value: string },
  metadata: string,
): Promise<{ transactionHash?: string; state?: string }> {
  const ownerAddress = wallet.account.address as `0x${string}`;
  const safeAddress = deriveSafeAddress(ownerAddress);
  const chainId = privyConfig.chainId;

  // 1. Read nonce from on-chain (the source of truth)
  const onChainNonce = await getOnChainSafeNonce(safeAddress);

  logger.info({
    message: 'On-chain Safe nonce fetched for redemption',
    ownerAddress,
    safeAddress,
    onChainNonce: onChainNonce.toString(),
  });

  // 2. Build EIP-712 SafeTx hash (same as SDK's createStructHash)
  const structHash = hashTypedData({
    primaryType: 'SafeTx',
    domain: {
      chainId,
      verifyingContract: safeAddress,
    },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      to: transaction.to as `0x${string}`,
      value: BigInt(0),
      data: transaction.data,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: onChainNonce,
    },
  });

  // 3. Sign the hash using personal_sign (eth_sign mode, same as SDK)
  const rawSig = await wallet.signMessage({
    account: wallet.account,
    message: { raw: toBytes(structHash) },
  });

  // 4. Pack signature with adjusted v for Safe eth_sign type
  const packedSig = splitAndPackSafeSignature(rawSig);

  // 5. Build the request payload (same format as SDK's buildSafeTransactionRequest)
  const request = {
    from: ownerAddress,
    to: transaction.to,
    proxyWallet: safeAddress,
    data: transaction.data,
    nonce: onChainNonce.toString(),
    signature: packedSig,
    signatureParams: {
      gasPrice: '0',
      operation: '0',
      safeTxnGas: '0',
      baseGas: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
    },
    type: 'SAFE',
    metadata,
  };

  logger.info({
    message: 'Submitting Safe transaction with on-chain nonce',
    ownerAddress,
    safeAddress,
    nonce: onChainNonce.toString(),
    to: transaction.to,
  });

  // 6. Generate builder auth headers and submit to relayer
  const relayerUrl = privyConfig.relayerUrl.endsWith('/')
    ? privyConfig.relayerUrl.slice(0, -1)
    : privyConfig.relayerUrl;

  const body = JSON.stringify(request);
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (builderConfig && builderConfig.isValid()) {
    const builderHeaders = await builderConfig.generateBuilderHeaders('POST', '/submit', body);
    if (builderHeaders) {
      headers = { ...headers, ...builderHeaders };
    }
  }

  const submitResponse = await axios.post(`${relayerUrl}/submit`, body, { headers });
  const { transactionID, state, transactionHash } = submitResponse.data;

  logger.info({
    message: 'Relayer submit response received',
    transactionID,
    state,
    transactionHash,
  });

  // 7. Poll for transaction confirmation (same logic as SDK's pollUntilState)
  const maxPolls = 100;
  const pollFrequency = 2000;
  const targetStates = ['STATE_MINED', 'STATE_CONFIRMED'];
  const failState = 'STATE_FAILED';

  logger.info({
    message: `Waiting for transaction ${transactionID} to reach ${targetStates.join('/')}`,
  });

  for (let i = 0; i < maxPolls; i++) {
    const txnResponse = await axios.get(`${relayerUrl}/transaction`, {
      params: { id: transactionID },
    });
    const txns = txnResponse.data;

    if (Array.isArray(txns) && txns.length > 0) {
      const txn = txns[0];
      if (targetStates.includes(txn.state)) {
        return { transactionHash: txn.transactionHash, state: txn.state };
      }
      if (txn.state === failState) {
        logger.error({
          message: `Transaction ${transactionID} failed on-chain`,
          transactionHash: txn.transactionHash,
          state: txn.state,
        });
        return { transactionHash: txn.transactionHash, state: txn.state };
      }
    }

    await new Promise(resolve => setTimeout(resolve, pollFrequency));
  }

  logger.error({ message: `Transaction ${transactionID} polling timed out` });
  return { state: 'TIMEOUT' };
}

/**
 * Submit a Safe transaction (sign + relayer submit) WITHOUT polling for mining.
 * Returns immediately after the relayer accepts the transaction.
 */
async function submitRedemptionTransaction(
  wallet: any,
  builderConfig: any,
  transaction: { to: string; data: `0x${string}`; value: string },
  metadata: string,
): Promise<{ transactionHash: string; transactionID: string }> {
  const ownerAddress = wallet.account.address as `0x${string}`;
  const safeAddress = deriveSafeAddress(ownerAddress);
  const chainId = privyConfig.chainId;

  // 1. Read nonce from on-chain
  const onChainNonce = await getOnChainSafeNonce(safeAddress);

  logger.info({
    message: 'On-chain Safe nonce fetched for redemption',
    ownerAddress,
    safeAddress,
    onChainNonce: onChainNonce.toString(),
  });

  // 2. Build EIP-712 SafeTx hash
  const structHash = hashTypedData({
    primaryType: 'SafeTx',
    domain: { chainId, verifyingContract: safeAddress },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      to: transaction.to as `0x${string}`,
      value: BigInt(0),
      data: transaction.data,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: onChainNonce,
    },
  });

  // 3. Sign
  const rawSig = await wallet.signMessage({
    account: wallet.account,
    message: { raw: toBytes(structHash) },
  });
  const packedSig = splitAndPackSafeSignature(rawSig);

  // 4. Submit to relayer
  const request = {
    from: ownerAddress,
    to: transaction.to,
    proxyWallet: safeAddress,
    data: transaction.data,
    nonce: onChainNonce.toString(),
    signature: packedSig,
    signatureParams: {
      gasPrice: '0',
      operation: '0',
      safeTxnGas: '0',
      baseGas: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
    },
    type: 'SAFE',
    metadata,
  };

  const relayerUrl = privyConfig.relayerUrl.endsWith('/')
    ? privyConfig.relayerUrl.slice(0, -1)
    : privyConfig.relayerUrl;

  const body = JSON.stringify(request);
  let headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (builderConfig && builderConfig.isValid()) {
    const builderHeaders = await builderConfig.generateBuilderHeaders('POST', '/submit', body);
    if (builderHeaders) {
      headers = { ...headers, ...builderHeaders };
    }
  }

  const submitResponse = await axios.post(`${relayerUrl}/submit`, body, { headers });
  const { transactionID, transactionHash } = submitResponse.data;

  logger.info({
    message: 'Relayer submit response received',
    transactionID,
    transactionHash,
  });

  return { transactionHash, transactionID };
}

/**
 * Background: poll relayer for mining confirmation, then refresh balance + positions.
 * Runs after the HTTP response has been sent to the user.
 */
async function pollAndFinalizeRedemption(
  transactionID: string,
  tradeRecordId: string,
  privyUserId: string,
  conditionId: string,
  proxyWalletAddress: string,
): Promise<void> {
  const relayerUrl = privyConfig.relayerUrl.endsWith('/')
    ? privyConfig.relayerUrl.slice(0, -1)
    : privyConfig.relayerUrl;

  const maxPolls = 100;
  const pollFrequency = 2000;
  const targetStates = ['STATE_MINED', 'STATE_CONFIRMED'];

  for (let i = 0; i < maxPolls; i++) {
    try {
      const txnResponse = await axios.get(`${relayerUrl}/transaction`, {
        params: { id: transactionID },
      });
      const txns = txnResponse.data;

      if (Array.isArray(txns) && txns.length > 0) {
        const txn = txns[0];
        if (targetStates.includes(txn.state)) {
          logger.info({
            message: 'Redemption transaction confirmed (background)',
            privyUserId,
            conditionId,
            transactionHash: txn.transactionHash,
            state: txn.state,
          });

          await updateTradeRecordById(tradeRecordId, {
            transactionHash: txn.transactionHash,
            status: 'FILLED',
          });

          // Refresh balance and positions in parallel
          await Promise.allSettled([
            refreshAndUpdateBalance(proxyWalletAddress, privyUserId).then(() =>
              logger.info({ message: 'Balance refreshed after redemption', privyUserId })
            ),
            refreshPositions(privyUserId).then(() =>
              logger.info({ message: 'Positions refreshed after redemption', privyUserId })
            ),
          ]);
          return;
        }

        if (txn.state === 'STATE_FAILED') {
          logger.error({
            message: 'Redemption transaction failed on-chain (background)',
            privyUserId,
            conditionId,
            transactionHash: txn.transactionHash,
          });
          await updateTradeRecordById(tradeRecordId, { status: 'FAILED' });
          return;
        }
      }
    } catch {
      // Retry on network errors
    }

    await new Promise(resolve => setTimeout(resolve, pollFrequency));
  }

  logger.error({ message: 'Redemption polling timed out (background)', privyUserId, transactionID });
  await updateTradeRecordById(tradeRecordId, { status: 'FAILED' });
}

/**
 * Get redeemable positions for a user
 */
export async function getRedeemablePositions(privyUserId: string): Promise<RedeemablePosition[]> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT asset, condition_id, size, cur_price, current_value, title, outcome, event_id
       FROM user_positions
       WHERE privy_user_id = $1 AND redeemable = true AND CAST(size AS DECIMAL) > 0
       ORDER BY current_value DESC`,
      [privyUserId]
    );

    return result.rows.map(row => ({
      asset: row.asset,
      conditionId: row.condition_id,
      size: String(row.size),
      curPrice: String(row.cur_price),
      currentValue: String(row.current_value),
      title: row.title,
      outcome: row.outcome,
      eventId: row.event_id,
    }));
  } finally {
    client.release();
  }
}

/**
 * Redeem a single position
 */
export async function redeemPosition(
  privyUserId: string,
  conditionId: string
): Promise<RedemptionResult> {
  logger.info({
    message: 'Starting position redemption',
    privyUserId,
    conditionId,
  });

  // Fetch user and position in parallel
  const [user, positionResult] = await Promise.all([
    getUserByPrivyId(privyUserId),
    (async () => {
      const client = await pool.connect();
      try {
        return await client.query(
          `SELECT asset, condition_id, size, cur_price, current_value, title, outcome, event_id, negative_risk, outcome_index
           FROM user_positions
           WHERE privy_user_id = $1 AND condition_id = $2`,
          [privyUserId, conditionId]
        );
      } finally {
        client.release();
      }
    })(),
  ]);

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (!user.proxyWalletAddress) {
    return { success: false, error: 'User does not have a proxy wallet' };
  }

  if (!user.embeddedWalletAddress) {
    return { success: false, error: 'User does not have an embedded wallet' };
  }

  if (positionResult.rows.length === 0) {
    return { success: false, error: 'Position not found' };
  }

  const position = positionResult.rows[0];

  if (parseFloat(position.size) <= 0) {
    return { success: false, error: 'Position has no tokens to redeem' };
  }

  // Determine if this is a negative risk market
  const isNegativeRisk = position.negative_risk || false;

  // Calculate expected redemption amount (winning positions redeem at $1 per share)
  const redeemAmount = parseFloat(position.size); // In USDC

  // Save trade record and initialize wallet in parallel (independent operations)
  const [redemptionRecord, { wallet, builderConfig }] = await Promise.all([
    saveTradeRecord({
      privyUserId,
      proxyWalletAddress: user.proxyWalletAddress,
      marketId: position.event_id || 'unknown',
      marketQuestion: position.title,
      clobTokenId: position.asset,
      outcome: position.outcome,
      side: 'REDEEM',
      orderType: 'REDEEM',
      size: position.size,
      price: '1.000000', // Redemption is always at $1
      costUsdc: '0', // No cost for redemption
      feeUsdc: '0',
      status: 'PENDING',
      metadata: {
        conditionId,
        redeemAmount: redeemAmount.toFixed(6),
        type: 'redemption',
        negativeRisk: isNegativeRisk,
      },
    }),
    getWalletAndConfig(privyUserId, user.embeddedWalletAddress),
  ]);

  try {

    let redeemData: `0x${string}`;
    let targetContract: string;

    if (isNegativeRisk) {
      // Negative risk markets: use the Neg Risk Adapter
      const rawAmount = BigInt(Math.floor(parseFloat(position.size) * 1e6));
      const outcomeIndex = position.outcome_index ?? 0;
      const indexSet1Amount = outcomeIndex === 0 ? rawAmount : BigInt(0);
      const indexSet2Amount = outcomeIndex === 1 ? rawAmount : BigInt(0);

      logger.info({
        message: 'Using Neg Risk Adapter for redemption',
        privyUserId,
        conditionId,
        outcomeIndex,
        rawAmount: rawAmount.toString(),
        indexSet1Amount: indexSet1Amount.toString(),
        indexSet2Amount: indexSet2Amount.toString(),
      });

      redeemData = encodeFunctionData({
        abi: NEG_RISK_REDEEM_ABI,
        functionName: 'redeemPositions',
        args: [
          conditionId as `0x${string}`,
          [indexSet1Amount, indexSet2Amount],
        ],
      });
      targetContract = NEG_RISK_ADAPTER_ADDRESS;
    } else {
      // Standard markets: use the CTF contract directly
      redeemData = encodeFunctionData({
        abi: REDEEM_POSITIONS_ABI,
        functionName: 'redeemPositions',
        args: [
          USDC_CONTRACT_ADDRESS as `0x${string}`,
          PARENT_COLLECTION_ID,
          conditionId as `0x${string}`,
          INDEX_SETS,
        ],
      });
      targetContract = CTF_CONTRACT_ADDRESS;
    }

    const transaction = {
      to: targetContract,
      data: redeemData,
      value: '0',
    };

    logger.info({
      message: 'Executing redemption with on-chain nonce',
      privyUserId,
      conditionId,
      targetContract,
      isNegativeRisk,
    });

    // Execute redemption: submit to relayer then return immediately
    // (don't block the user waiting for mining + balance/position refresh)
    const submitResult = await submitRedemptionTransaction(
      wallet,
      builderConfig,
      transaction,
      `Redeem ${position.outcome} position: ${position.title}`,
    );

    if (!submitResult.transactionHash) {
      throw new Error('Relayer did not return a transaction hash');
    }

    const { transactionHash, transactionID } = submitResult;

    logger.info({
      message: 'Redemption submitted to relayer, returning to user',
      privyUserId,
      conditionId,
      transactionHash,
      transactionID,
    });

    // Update trade record with tx hash immediately
    updateTradeRecordById(redemptionRecord.id, {
      transactionHash,
      status: 'PENDING',
    }).catch(() => {});

    // Background: poll for confirmation, then refresh balance + positions
    pollAndFinalizeRedemption(
      transactionID,
      redemptionRecord.id,
      privyUserId,
      conditionId,
      user.proxyWalletAddress,
    ).catch((err) => {
      logger.error({
        message: 'Background redemption finalization failed',
        privyUserId,
        conditionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      success: true,
      transactionHash,
      redemptionId: redemptionRecord.id,
      redeemedAmount: redeemAmount.toFixed(6),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    logger.error({
      message: 'Redemption failed',
      privyUserId,
      conditionId,
      error: errorMessage,
    });

    // Update redemption record to failed
    await updateTradeRecordById(redemptionRecord.id, {
      status: 'FAILED',
      errorMessage,
    });

    return {
      success: false,
      redemptionId: redemptionRecord.id,
      error: errorMessage,
    };
  }
}

/**
 * Redeem all redeemable positions for a user
 */
export async function redeemAllPositions(privyUserId: string): Promise<BatchRedemptionResult> {
  logger.info({
    message: 'Starting batch redemption',
    privyUserId,
  });

  // Get all redeemable positions
  const positions = await getRedeemablePositions(privyUserId);

  if (positions.length === 0) {
    return {
      success: true,
      totalRedeemed: 0,
      totalAmount: '0',
      results: [],
    };
  }

  const results: BatchRedemptionResult['results'] = [];
  let totalRedeemed = 0;
  let totalAmount = 0;

  // Redeem each position sequentially
  for (const position of positions) {
    const result = await redeemPosition(privyUserId, position.conditionId);

    results.push({
      conditionId: position.conditionId,
      title: position.title,
      outcome: position.outcome,
      success: result.success,
      transactionHash: result.transactionHash,
      redemptionId: result.redemptionId,
      redeemedAmount: result.redeemedAmount,
      error: result.error,
    });

    if (result.success && result.redeemedAmount) {
      totalRedeemed++;
      totalAmount += parseFloat(result.redeemedAmount);
    }
  }

  logger.info({
    message: 'Batch redemption completed',
    privyUserId,
    totalPositions: positions.length,
    totalRedeemed,
    totalAmount: totalAmount.toFixed(6),
  });

  return {
    success: totalRedeemed > 0,
    totalRedeemed,
    totalAmount: totalAmount.toFixed(6),
    results,
  };
}

/**
 * Check if a position is redeemable on-chain (optional verification)
 */
export async function checkRedeemableOnChain(
  proxyWalletAddress: string,
  conditionId: string
): Promise<boolean> {
  // This would require reading the CTF contract state
  // For now, we trust the Polymarket API's redeemable flag
  // TODO: Implement on-chain verification if needed
  return true;
}
