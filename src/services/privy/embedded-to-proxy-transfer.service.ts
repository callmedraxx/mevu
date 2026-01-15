/**
 * Embedded to Proxy Wallet Transfer Service
 * Transfers USDC from embedded wallet to proxy wallet using RelayerClient
 * Uses Privy embedded wallet as signer for gasless transactions
 * Falls back to Privy gas sponsorship if RelayerClient fails
 */

import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { privyConfig } from './privy.config';
import { getUserByPrivyId } from './user.service';
import { embeddedWalletBalanceService } from './embedded-wallet-balance.service';
import { swapNativeUsdcToUsdce, checkSwapNeeded } from './usdc-swap.service';
import { privyService } from './privy.service';
import { depositProgressService } from './deposit-progress.service';

// Cache for RelayerClient instances per user (for embedded wallet transactions)
const relayerClientCache = new Map<string, { relayerClient: any; wallet: any; builderConfig: any }>();

export interface TransferRequest {
  privyUserId: string;
  amountUsdc?: number; // Optional - if omitted, transfer all available balance
}

export interface TransferResult {
  success: boolean;
  transactionHash?: string;
  txHash?: string; // Alias for frontend compatibility
  fromAddress?: string;
  toAddress?: string;
  amountTransferred?: string;
  amountUsdc?: string; // Human-readable amount
  error?: string;
  message?: string;
}

/**
 * Validate Ethereum address format
 */
function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Get or create RelayerClient for embedded wallet transfers
 * Uses embedded wallet as signer (EOA) - transactions execute from embedded wallet
 */
async function getRelayerClientForEmbeddedTransfer(privyUserId: string): Promise<any> {
  const cached = relayerClientCache.get(privyUserId);
  if (cached) {
    return cached.relayerClient;
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user || !user.embeddedWalletAddress) {
    throw new Error('User not found or no embedded wallet address');
  }

  // Import RelayerClient and utilities
  const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
  const { createViemWalletForRelayer } = await import('./wallet-deployment.service');
  const { privyService } = await import('./privy.service');

  const walletId = await privyService.getWalletIdByAddress(privyUserId, user.embeddedWalletAddress);
  const { wallet, builderConfig } = await createViemWalletForRelayer(
    privyUserId,
    user.embeddedWalletAddress,
    walletId || undefined
  );

  // For embedded wallet transfers (EOA -> Safe), we need to execute from embedded wallet
  // RelayerClient with PROXY type might work for direct EOA transactions
  // If not, we'll fall back to direct transaction with Privy signing
  // Try PROXY type first - Polymarket relayer might support EOA transactions via PROXY type
  const relayerClient = new RelayClient(
    privyConfig.relayerUrl,
    privyConfig.chainId,
    wallet,
    builderConfig,
    RelayerTxType.PROXY // Use PROXY type - might support EOA transactions, will fallback if not
  );

  relayerClientCache.set(privyUserId, { relayerClient, wallet, builderConfig });
  return relayerClient;
}

/**
 * Transfer USDC from embedded wallet to proxy wallet
 * @param request - Transfer request containing user ID and optional amount
 * @returns Transfer result with transaction hash or error
 */
export async function transferFromEmbeddedToProxy(
  request: TransferRequest
): Promise<TransferResult> {
  const { privyUserId, amountUsdc } = request;

  logger.info({
    message: '[AUTO-TRANSFER-FLOW] Step 9: transferFromEmbeddedToProxy called',
    flowStep: 'TRANSFER_FUNCTION_CALLED',
    privyUserId,
    requestedAmount: amountUsdc ? amountUsdc + ' USDC' : 'all available',
  });

  try {
    // Get user and verify wallets exist
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: User not found',
        flowStep: 'TRANSFER_FAILED_USER_NOT_FOUND',
        privyUserId,
      });
      return {
        success: false,
        error: 'User not found',
      };
    }

    if (!user.embeddedWalletAddress) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: No embedded wallet address',
        flowStep: 'TRANSFER_FAILED_NO_EMBEDDED_WALLET',
        privyUserId,
      });
      return {
        success: false,
        error: 'User does not have an embedded wallet address',
      };
    }

    if (!user.proxyWalletAddress) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: No proxy wallet address',
        flowStep: 'TRANSFER_FAILED_NO_PROXY_WALLET',
        privyUserId,
      });
      return {
        success: false,
        error: 'User does not have a proxy wallet. Please deploy a proxy wallet first.',
      };
    }

    // Validate proxy wallet address
    if (!isValidEthereumAddress(user.proxyWalletAddress)) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: Invalid proxy wallet address',
        flowStep: 'TRANSFER_FAILED_INVALID_PROXY_ADDRESS',
        privyUserId,
        proxyWalletAddress: user.proxyWalletAddress,
      });
      return {
        success: false,
        error: 'Invalid proxy wallet address format',
      };
    }

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Step 10: Fetching embedded wallet balance',
      flowStep: 'FETCHING_BALANCE',
      privyUserId,
      embeddedWalletAddress: user.embeddedWalletAddress,
    });

    // Get current embedded wallet balance
    let balance = await embeddedWalletBalanceService.getEmbeddedWalletBalance(
      user.embeddedWalletAddress
    );
    let balanceBigInt = BigInt(balance.balanceRaw || '0');
    let balanceHuman = parseFloat(balance.balanceHuman || '0');

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Step 11: Balance fetched',
      flowStep: 'BALANCE_FETCHED',
      privyUserId,
      balanceRaw: balance.balanceRaw,
      balanceHuman: balanceHuman + ' USDC',
    });

    if (balanceBigInt === BigInt(0)) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: Zero balance in embedded wallet',
        flowStep: 'TRANSFER_FAILED_ZERO_BALANCE',
        privyUserId,
        embeddedWalletAddress: user.embeddedWalletAddress,
      });
      return {
        success: false,
        error: 'Insufficient balance in embedded wallet',
        fromAddress: user.embeddedWalletAddress,
        toAddress: user.proxyWalletAddress,
        amountTransferred: '0',
      };
    }

    // Check if we need to swap Native USDC to USDC.e first
    // MoonPay deposits Native USDC, but Polymarket uses USDC.e
    const USDC_E_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    
    // Calculate requested amount for swap check
    const requestedAmountForSwap = amountUsdc !== undefined && amountUsdc > 0 
      ? parseFloat(amountUsdc.toString())
      : balanceHuman;
    
    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Step 12: Checking if swap is needed (Native USDC → USDC.e)',
      flowStep: 'CHECKING_SWAP_NEEDED',
      privyUserId,
      requestedAmount: requestedAmountForSwap + ' USDC',
    });

    const swapCheck = await checkSwapNeeded(user.embeddedWalletAddress, requestedAmountForSwap);
    
    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Step 13: Swap check result',
      flowStep: 'SWAP_CHECK_RESULT',
      privyUserId,
      needsSwap: swapCheck.needsSwap,
      nativeUsdcBalance: swapCheck.nativeBalance + ' USDC',
      usdceBalance: swapCheck.eBalance + ' USDC',
    });

    // Find active deposit for progress tracking (used throughout the function)
    const activeDeposit = depositProgressService.getMostRecentActiveDeposit(privyUserId);
    const depositId = activeDeposit?.depositId;

    // If user has Native USDC but not enough USDC.e, swap first
    if (swapCheck.needsSwap) {
      // Update progress to swapping
      if (depositId) {
        await depositProgressService.updateToSwapping(depositId);
      }

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 14: SWAP REQUIRED - Initiating Native USDC → USDC.e swap',
        flowStep: 'INITIATING_SWAP',
        privyUserId,
        nativeBalance: swapCheck.nativeBalance + ' USDC',
        eBalance: swapCheck.eBalance + ' USDC',
        requestedAmount: requestedAmountForSwap + ' USDC',
      });

      // Update progress to swapping
      if (depositId) {
        await depositProgressService.updateToSwapping(depositId);
      }

      // Swap Native USDC to USDC.e
      const swapAmount = amountUsdc !== undefined && amountUsdc > 0
        ? amountUsdc
        : swapCheck.nativeBalance; // Swap all if no specific amount requested

      const swapResult = await swapNativeUsdcToUsdce(
        privyUserId,
        user.embeddedWalletAddress,
        swapAmount
      );

      if (!swapResult.success) {
        logger.error({
          message: '[AUTO-TRANSFER-FLOW] ❌ FAILED: Swap failed',
          flowStep: 'SWAP_FAILED',
          privyUserId,
          swapAmount: swapAmount + ' USDC',
          error: swapResult.error,
        });
        
        // Update progress to failed
        if (depositId) {
          await depositProgressService.failDeposit(depositId, `Swap failed: ${swapResult.error}`);
        }
        
        return {
          success: false,
          error: `Failed to swap Native USDC to USDC.e: ${swapResult.error}`,
          amountUsdc: swapAmount.toFixed(6),
        };
      }

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Step 15: ✅ Swap successful',
        flowStep: 'SWAP_SUCCESS',
        privyUserId,
        swapTxHash: swapResult.transactionHash,
        amountSwapped: swapResult.amountInHuman,
        amountReceived: swapResult.amountOutHuman,
      });

      // Update progress to swap complete
      if (depositId && swapResult.transactionHash) {
        await depositProgressService.updateSwapComplete(
          depositId,
          swapResult.transactionHash,
          swapResult.amountOutHuman || swapAmount.toFixed(6)
        );
      }

      // Update balance after swap
      balance = await embeddedWalletBalanceService.getEmbeddedWalletBalance(
        user.embeddedWalletAddress
      );
      balanceBigInt = BigInt(balance.balanceRaw || '0');
      balanceHuman = parseFloat(balance.balanceHuman || '0');
    }

    // Determine transfer amount (after potential swap)
    let transferAmount: bigint;
    let transferAmountHuman: string;

    if (amountUsdc !== undefined && amountUsdc > 0) {
      // Transfer specified amount
      const requestedAmount = parseFloat(amountUsdc.toString());
      if (isNaN(requestedAmount) || requestedAmount <= 0) {
        return {
          success: false,
          error: 'Amount must be a positive number',
        };
      }

      if (requestedAmount > balanceHuman) {
        return {
          success: false,
          error: `Insufficient balance. Available: ${balanceHuman.toFixed(6)} USDC, Requested: ${requestedAmount.toFixed(6)} USDC`,
        };
      }

      const parsedAmount = ethers.utils.parseUnits(requestedAmount.toFixed(6), 6);
      transferAmount = BigInt(parsedAmount.toString());
      transferAmountHuman = requestedAmount.toFixed(6);
    } else {
      // Transfer all available balance
      transferAmount = balanceBigInt;
      transferAmountHuman = balanceHuman.toFixed(6);
    }

    logger.info({
      message: 'Initiating USDC transfer from embedded wallet to proxy wallet',
      privyUserId,
      fromWallet: user.embeddedWalletAddress,
      toWallet: user.proxyWalletAddress,
      amountUsdc: transferAmountHuman,
      embeddedBalance: balanceHuman,
      tokenType: 'USDC.e',
    });

    // Update progress to transferring
    if (depositId) {
      await depositProgressService.updateToTransferring(depositId);
    }

    // Get RelayerClient for embedded wallet (EOA)
    const relayerClient = await getRelayerClientForEmbeddedTransfer(privyUserId);
    
    // Always use USDC.e contract (we've swapped if needed)
    const usdcContractAddress = USDC_E_CONTRACT;

    // Encode USDC transfer function call
    // USDC uses 6 decimals
    const { encodeFunctionData } = await import('viem');
    const transferData = encodeFunctionData({
      abi: [
        {
          name: 'transfer',
          type: 'function',
          inputs: [
            { name: 'to', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      functionName: 'transfer',
      args: [user.proxyWalletAddress as `0x${string}`, BigInt(transferAmount.toString())],
    });

    const transaction = {
      to: usdcContractAddress,
      data: transferData,
      value: '0',
    };

    // Execute via RelayerClient (attempt gasless transaction)
    // Note: RelayerClient.PROXY might not support EOA transactions directly
    // If this fails, we'll need to use a direct transaction (user pays gas)
    logger.info({
      message: 'Executing transfer via RelayerClient',
      privyUserId,
      fromAddress: user.embeddedWalletAddress,
      toAddress: user.proxyWalletAddress,
      amountUsdc: transferAmountHuman,
      usdcContract: usdcContractAddress,
      tokenType: usdcContractAddress === USDC_E_CONTRACT ? 'USDC.e' : 'Native USDC',
      txType: 'PROXY',
    });

    let result: any;
    let txHash: string;

    try {
      const response = await relayerClient.execute(
        [transaction],
        `Transfer: ${transferAmountHuman} USDC.e from embedded wallet to proxy wallet`
      );

      result = await response.wait();

      if (!result || !result.transactionHash) {
        throw new Error('Transfer transaction failed - no transaction hash received');
      }

      txHash = result.transactionHash;
    } catch (relayerError) {
      // RelayerClient.PROXY might not support EOA transactions
      // Fallback to Privy gas sponsorship (gasless for user)
      logger.warn({
        message: 'RelayerClient execution failed, falling back to Privy gas sponsorship',
        privyUserId,
        error: relayerError instanceof Error ? relayerError.message : String(relayerError),
      });

      // Encode USDC transfer function call for Privy sendTransaction
      const transferDataForPrivy = encodeFunctionData({
        abi: [
          {
            name: 'transfer',
            type: 'function',
            inputs: [
              { name: 'to', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
            outputs: [{ type: 'bool' }],
          },
        ],
        functionName: 'transfer',
        args: [user.proxyWalletAddress as `0x${string}`, BigInt(transferAmount.toString())],
      });

      // Execute transfer with Privy gas sponsorship (gasless)
      logger.info({
        message: 'Executing transfer via Privy gas sponsorship (gasless)',
        privyUserId,
        fromAddress: user.embeddedWalletAddress,
        toAddress: user.proxyWalletAddress,
        amountUsdc: transferAmountHuman,
      });

      const privyTxResult = await privyService.sendTransaction(
        privyUserId,
        user.embeddedWalletAddress,
        {
          to: usdcContractAddress,
          data: transferDataForPrivy,
        },
        { sponsor: true } // Enable gas sponsorship
      );

      if (!privyTxResult || !privyTxResult.hash) {
        throw new Error('Privy gas-sponsored transfer failed - no transaction hash received');
      }

      txHash = privyTxResult.hash;

      // Wait for confirmation
      const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const receipt = await provider.waitForTransaction(txHash);

      if (!receipt || receipt.status === 0) {
        throw new Error('Privy gas-sponsored transfer transaction failed');
      }

      logger.info({
        message: 'Transfer successful via Privy gas sponsorship',
        privyUserId,
        txHash,
        gasUsed: receipt.gasUsed?.toString(),
      });
    }

    logger.info({
      message: 'USDC transfer from embedded wallet to proxy wallet successful',
      privyUserId,
      fromWallet: user.embeddedWalletAddress,
      toWallet: user.proxyWalletAddress,
      amountUsdc: transferAmountHuman,
      txHash,
    });

    // Update progress to complete
    if (depositId) {
      await depositProgressService.completeDeposit(depositId, txHash);
    }

    // Update embedded wallet balance after transfer
    // The balance service polling will pick this up, but we can trigger a check immediately
    await embeddedWalletBalanceService
      .getEmbeddedWalletBalance(user.embeddedWalletAddress)
      .catch((error) => {
        logger.warn({
          message: 'Failed to refresh embedded wallet balance after transfer',
          privyUserId,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return {
      success: true,
      transactionHash: txHash,
      txHash, // Alias for frontend compatibility
      fromAddress: user.embeddedWalletAddress,
      toAddress: user.proxyWalletAddress,
      amountTransferred: transferAmount.toString(),
      amountUsdc: transferAmountHuman,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error({
      message: 'USDC transfer from embedded wallet to proxy wallet failed',
      privyUserId,
      amountUsdc,
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Update progress to failed
    const activeDeposit = depositProgressService.getMostRecentActiveDeposit(privyUserId);
    if (activeDeposit?.depositId) {
      await depositProgressService.failDeposit(activeDeposit.depositId, errorMessage);
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Check if user has sufficient balance for transfer
 */
export async function checkTransferEligibility(
  privyUserId: string,
  amountUsdc?: number
): Promise<{
  eligible: boolean;
  hasEmbeddedWallet: boolean;
  hasProxyWallet: boolean;
  currentBalance: string;
  currentBalanceHuman: string;
  error?: string;
}> {
  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return {
        eligible: false,
        hasEmbeddedWallet: false,
        hasProxyWallet: false,
        currentBalance: '0',
        currentBalanceHuman: '0',
        error: 'User not found',
      };
    }

    if (!user.embeddedWalletAddress) {
      return {
        eligible: false,
        hasEmbeddedWallet: false,
        hasProxyWallet: !!user.proxyWalletAddress,
        currentBalance: '0',
        currentBalanceHuman: '0',
        error: 'User does not have an embedded wallet',
      };
    }

    if (!user.proxyWalletAddress) {
      return {
        eligible: false,
        hasEmbeddedWallet: true,
        hasProxyWallet: false,
        currentBalance: '0',
        currentBalanceHuman: '0',
        error: 'User does not have a proxy wallet',
      };
    }

    const balance = await embeddedWalletBalanceService.getEmbeddedWalletBalance(
      user.embeddedWalletAddress
    );
    const balanceHuman = parseFloat(balance.balanceHuman || '0');

    if (amountUsdc !== undefined && amountUsdc > 0) {
      if (amountUsdc > balanceHuman) {
        return {
          eligible: false,
          hasEmbeddedWallet: true,
          hasProxyWallet: true,
          currentBalance: balance.balanceRaw,
          currentBalanceHuman: balance.balanceHuman,
          error: `Insufficient balance. Available: ${balanceHuman.toFixed(6)} USDC, Requested: ${amountUsdc.toFixed(6)} USDC`,
        };
      }
    } else if (balanceHuman <= 0) {
      return {
        eligible: false,
        hasEmbeddedWallet: true,
        hasProxyWallet: true,
        currentBalance: balance.balanceRaw,
        currentBalanceHuman: balance.balanceHuman,
        error: 'Insufficient balance in embedded wallet',
      };
    }

    return {
      eligible: true,
      hasEmbeddedWallet: true,
      hasProxyWallet: true,
      currentBalance: balance.balanceRaw,
      currentBalanceHuman: balance.balanceHuman,
    };
  } catch (error) {
    return {
      eligible: false,
      hasEmbeddedWallet: false,
      hasProxyWallet: false,
      currentBalance: '0',
      currentBalanceHuman: '0',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

