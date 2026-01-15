/**
 * USDC Swap Service
 * Swaps Native USDC to USDC.e on Polygon using 0x API
 * Uses Privy gas sponsorship for gasless transactions
 * Reference: https://docs.privy.io/recipes/swap-with-0x
 */

import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { privyService } from './privy.service';
import { encodeFunctionData } from 'viem';

// Contract addresses on Polygon
const USDC_NATIVE_CONTRACT = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const USDC_E_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_DECIMALS = 6;

// Polygon chain ID
const POLYGON_CHAIN_ID = 137;

// ERC20 ABI for approvals and balance checks
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
];

export interface SwapResult {
  success: boolean;
  transactionHash?: string;
  amountIn: string;
  amountOut: string;
  amountInHuman: string;
  amountOutHuman: string;
  error?: string;
}

/**
 * Get a swap quote from 0x API using allowance-based flow (not Permit2)
 * This is required for Privy TEE/EIP-7702 wallets which don't support Permit2 signatures
 */
async function get0xQuoteAllowance(
  sellToken: string,
  buyToken: string,
  sellAmount: string,
  takerAddress: string
): Promise<any> {
  const apiKey = process.env.ZX_API_KEY || process.env.OX_API_KEY;
  
  if (!apiKey) {
    throw new Error('0x API key not configured. Set ZX_API_KEY or OX_API_KEY environment variable.');
  }

  // Use the allowance-based endpoint (not permit2) for compatibility with TEE wallets
  const url = `https://api.0x.org/swap/allowance-holder/quote?chainId=${POLYGON_CHAIN_ID}&sellToken=${sellToken}&buyToken=${buyToken}&sellAmount=${sellAmount}&taker=${takerAddress}`;
  
  logger.info({
    message: 'Fetching 0x swap quote (allowance-based, not Permit2)',
    sellToken,
    buyToken,
    sellAmount,
    takerAddress,
  });

  const response = await fetch(url, {
    headers: {
      '0x-api-key': apiKey,
      '0x-version': 'v2',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`0x API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * Swap Native USDC to USDC.e using 0x API
 * @param privyUserId - The Privy user ID
 * @param embeddedWalletAddress - The embedded wallet address (has Native USDC)
 * @param amountUsdc - Amount to swap in USDC (human-readable). If undefined, swaps all available balance
 * @returns Swap result with transaction hash and amounts
 */
export async function swapNativeUsdcToUsdce(
  privyUserId: string,
  embeddedWalletAddress: string,
  amountUsdc?: number
): Promise<SwapResult> {
  try {
    const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

    // Get Native USDC balance
    const nativeUsdcContract = new ethers.Contract(
      USDC_NATIVE_CONTRACT,
      ERC20_ABI,
      provider
    );
    const nativeBalance = await nativeUsdcContract.balanceOf(embeddedWalletAddress);
    const nativeBalanceHuman = parseFloat(ethers.utils.formatUnits(nativeBalance, USDC_DECIMALS));

    if (nativeBalanceHuman === 0) {
      return {
        success: false,
        error: 'No Native USDC balance to swap',
        amountIn: '0',
        amountOut: '0',
        amountInHuman: '0',
        amountOutHuman: '0',
      };
    }

    // Determine swap amount
    let swapAmountHuman: number;
    if (amountUsdc !== undefined && amountUsdc > 0) {
      if (amountUsdc > nativeBalanceHuman) {
        return {
          success: false,
          error: `Insufficient Native USDC balance. Available: ${nativeBalanceHuman.toFixed(6)} USDC, Requested: ${amountUsdc.toFixed(6)} USDC`,
          amountIn: '0',
          amountOut: '0',
          amountInHuman: '0',
          amountOutHuman: '0',
        };
      }
      swapAmountHuman = amountUsdc;
    } else {
      swapAmountHuman = nativeBalanceHuman;
    }

    const swapAmountRaw = ethers.utils.parseUnits(swapAmountHuman.toFixed(6), USDC_DECIMALS);

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] SWAP Step 1: Initiating Native USDC → USDC.e swap via 0x',
      flowStep: 'SWAP_INITIATING',
      privyUserId,
      embeddedWalletAddress,
      swapAmount: swapAmountHuman + ' USDC',
      nativeBalance: nativeBalanceHuman + ' USDC',
    });

    // Step 1: Get quote from 0x using allowance-based flow (not Permit2)
    // Permit2 is not supported by Privy TEE/EIP-7702 wallets
    const quoteResult = await get0xQuoteAllowance(
      USDC_NATIVE_CONTRACT,
      USDC_E_CONTRACT,
      swapAmountRaw.toString(),
      embeddedWalletAddress
    );

    if (!quoteResult || !quoteResult.transaction) {
      throw new Error('Invalid quote response from 0x API');
    }

    // Get the spender address from the quote (0x Exchange Proxy or similar)
    const spenderAddress = quoteResult.issues?.allowance?.spender || quoteResult.transaction.to;

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] SWAP Step 2: 0x quote received (allowance-based, NOT Permit2)',
      flowStep: 'SWAP_QUOTE_RECEIVED',
      privyUserId,
      sellAmount: ethers.utils.formatUnits(quoteResult.sellAmount || swapAmountRaw, USDC_DECIMALS) + ' USDC',
      buyAmount: ethers.utils.formatUnits(quoteResult.buyAmount || '0', USDC_DECIMALS) + ' USDC.e',
      spender: spenderAddress,
      transactionTo: quoteResult.transaction?.to,
    });

    // Step 2: Approve the 0x spender contract to spend Native USDC (if needed)
    // Uses Privy gas sponsorship for gasless approval
    const currentAllowance = await nativeUsdcContract.allowance(
      embeddedWalletAddress,
      spenderAddress
    );

    if (currentAllowance.lt(swapAmountRaw)) {
      logger.info({
        message: '[AUTO-TRANSFER-FLOW] SWAP Step 3: Approving 0x spender (Privy gas sponsored)',
        flowStep: 'SWAP_APPROVING',
        privyUserId,
        spender: spenderAddress,
        tokenContract: USDC_NATIVE_CONTRACT,
        note: 'This transaction is gas-sponsored by Privy',
      });

      // Encode approve function call
      const approveData = encodeFunctionData({
        abi: [
          {
            name: 'approve',
            type: 'function',
            inputs: [
              { name: 'spender', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ name: '', type: 'bool' }],
          },
        ],
        functionName: 'approve',
        args: [spenderAddress as `0x${string}`, BigInt(ethers.constants.MaxUint256.toString())],
      });

      // Send approval transaction with Privy gas sponsorship
      const approveResult = await privyService.sendTransaction(
        privyUserId,
        embeddedWalletAddress,
        {
          to: USDC_NATIVE_CONTRACT,
          data: approveData,
        },
        { sponsor: true } // Enable gas sponsorship
      );

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] SWAP Step 4: ✅ Approval successful (gas sponsored)',
        flowStep: 'SWAP_APPROVAL_SUCCESS',
        privyUserId,
        txHash: approveResult.hash,
        polygonscanUrl: `https://polygonscan.com/tx/${approveResult.hash}`,
      });

      // Wait for approval to be mined
      const approvalReceipt = await provider.waitForTransaction(approveResult.hash);
      if (!approvalReceipt || approvalReceipt.status === 0) {
        throw new Error('Approval transaction failed');
      }
    }

    // Step 3: Use the transaction data directly (no Permit2 signature needed)
    const transactionData = quoteResult.transaction.data;

    // Step 4: Execute the swap transaction with Privy gas sponsorship
    // Using allowance-based flow (compatible with TEE/EIP-7702 wallets)
    logger.info({
      message: '[AUTO-TRANSFER-FLOW] SWAP Step 5: Executing swap transaction (Privy gas sponsored)',
      flowStep: 'SWAP_EXECUTING',
      privyUserId,
      to: quoteResult.transaction.to,
      value: quoteResult.transaction.value || '0',
      note: 'This transaction is gas-sponsored by Privy',
    });

    // Send swap transaction with Privy gas sponsorship
    const swapResult = await privyService.sendTransaction(
      privyUserId,
      embeddedWalletAddress,
      {
        to: quoteResult.transaction.to,
        data: transactionData,
        value: quoteResult.transaction.value || '0',
      },
      { sponsor: true } // Enable gas sponsorship
    );

    // Wait for swap transaction to be mined
    const receipt = await provider.waitForTransaction(swapResult.hash);

    if (!receipt || receipt.status === 0) {
      throw new Error('Swap transaction failed');
    }

    // Calculate amount out from quote
    const amountOutHuman = parseFloat(
      ethers.utils.formatUnits(quoteResult.buyAmount || swapAmountRaw, USDC_DECIMALS)
    );

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] SWAP Step 6: ✅ Swap successful!',
      flowStep: 'SWAP_SUCCESS',
      privyUserId,
      txHash: swapResult.hash,
      polygonscanUrl: `https://polygonscan.com/tx/${swapResult.hash}`,
      amountIn: swapAmountHuman + ' Native USDC',
      amountOut: amountOutHuman + ' USDC.e',
      gasUsed: receipt.gasUsed?.toString(),
    });

    return {
      success: true,
      transactionHash: swapResult.hash,
      amountIn: swapAmountRaw.toString(),
      amountOut: quoteResult.buyAmount || swapAmountRaw.toString(),
      amountInHuman: swapAmountHuman.toFixed(6),
      amountOutHuman: amountOutHuman.toFixed(6),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logger.error({
      message: '[AUTO-TRANSFER-FLOW] SWAP ❌ FAILED: Swap error',
      flowStep: 'SWAP_ERROR',
      privyUserId,
      embeddedWalletAddress,
      error: errorMessage,
      stack: errorStack,
      troubleshooting: [
        'Check if 0x API key is valid (ZX_API_KEY)',
        'Check if Privy gas sponsorship has credits',
        'Check if TEE is enabled in Privy dashboard',
        'Check if Polygon is enabled for gas sponsorship',
        'Verify embedded wallet has Native USDC balance',
      ],
    });

    return {
      success: false,
      error: errorMessage,
      amountIn: '0',
      amountOut: '0',
      amountInHuman: '0',
      amountOutHuman: '0',
    };
  }
}

/**
 * Check if a swap is needed (user has Native USDC but needs USDC.e)
 */
export async function checkSwapNeeded(
  walletAddress: string,
  requiredAmountUsdc?: number
): Promise<{ needsSwap: boolean; nativeBalance: number; eBalance: number }> {
  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const nativeUsdcContract = new ethers.Contract(USDC_NATIVE_CONTRACT, ERC20_ABI, provider);
  const usdceContract = new ethers.Contract(USDC_E_CONTRACT, ERC20_ABI, provider);

  const [nativeBalance, eBalance] = await Promise.all([
    nativeUsdcContract.balanceOf(walletAddress),
    usdceContract.balanceOf(walletAddress),
  ]);

  const nativeBalanceHuman = parseFloat(ethers.utils.formatUnits(nativeBalance, USDC_DECIMALS));
  const eBalanceHuman = parseFloat(ethers.utils.formatUnits(eBalance, USDC_DECIMALS));

  const requiredAmount = requiredAmountUsdc || nativeBalanceHuman;
  const needsSwap = nativeBalanceHuman > 0 && eBalanceHuman < requiredAmount;

  return {
    needsSwap,
    nativeBalance: nativeBalanceHuman,
    eBalance: eBalanceHuman,
  };
}

/**
 * Get balances for both Native USDC and USDC.e for any wallet address
 */
export async function getUsdcBalances(
  walletAddress: string
): Promise<{ nativeUsdc: number; usdce: number; total: number }> {
  const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);

  const nativeUsdcContract = new ethers.Contract(USDC_NATIVE_CONTRACT, ERC20_ABI, provider);
  const usdceContract = new ethers.Contract(USDC_E_CONTRACT, ERC20_ABI, provider);

  const [nativeBalance, eBalance] = await Promise.all([
    nativeUsdcContract.balanceOf(walletAddress),
    usdceContract.balanceOf(walletAddress),
  ]);

  const nativeUsdc = parseFloat(ethers.utils.formatUnits(nativeBalance, USDC_DECIMALS));
  const usdce = parseFloat(ethers.utils.formatUnits(eBalance, USDC_DECIMALS));

  return {
    nativeUsdc,
    usdce,
    total: nativeUsdc + usdce,
  };
}
