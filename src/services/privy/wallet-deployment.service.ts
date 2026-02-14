/**
 * Wallet Deployment Service
 * 
 * Handles the deployment of Polymarket proxy wallets (Gnosis Safe) for users
 * using their Privy embedded wallet as the owner, with the authorization key
 * as a co-owner.
 * 
 * Flow:
 * 1. User registers with Privy embedded wallet
 * 2. Backend creates RelayerClient using viem wallet client (address only, no signing needed)
 * 3. RelayerClient deploys Safe wallet via Polymarket relayer (user's wallet as owner)
 * 4. Backend adds authorization key address as co-owner (from PRIVY_AUTHORIZATION_PRIVATE_KEY)
 * 5. Backend stores proxy wallet address in database
 * 
 * Safe wallet configuration:
 * - Owners: [user's embedded wallet, authorization key address]
 * - Threshold: 1 (either owner can sign transactions independently)
 */

import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { ingestDebugLog } from '../../config/debug-ingest';
import { privyConfig } from './privy.config';
import { privyService } from './privy.service';
import { createPrivySigner } from './privy-signer.adapter';
import { 
  createUser, 
  updateUserProxyWallet, 
  getUserByPrivyId,
  isUsernameAvailable,
  updateUserSessionSigner,
} from './user.service';
import { CreateUserRequest, UserProfile } from './privy.types';

/**
 * Cache for RelayerClient instances per user
 * Key: privyUserId, Value: { relayerClient, wallet, builderConfig, signer, walletId, embeddedWalletAddress }
 */
const relayerClientCache = new Map<string, {
  relayerClient: any;
  wallet: any;
  builderConfig: any;
  signer: any;
  walletId?: string;
  embeddedWalletAddress: string;
}>();

// Note: These types match the Polymarket RelayerClient
// You'll need to install: npm install @polymarket/builder-relayer-client @polymarket/builder-signing-sdk

interface Transaction {
  to: string;
  data: string;
  value: string;
}

interface RelayerTransactionResult {
  transactionID: string;
  transactionHash: string;
  from: string;
  to: string;
  proxyAddress: string;
  data: string;
  state: string;
  type: string;
  metadata: string;
  createdAt: Date;
  updatedAt: Date;
}

// ERC20 approval interface
const erc20Interface = new ethers.utils.Interface([
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

// ERC1155 (CTF) approval interface
const erc1155Interface = new ethers.utils.Interface([
  'function setApprovalForAll(address operator, bool approved)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
]);

/**
 * Create approval transactions for Polymarket trading
 * Uses viem for encoding (compatible with RelayerClient)
 */
async function createApprovalTransactions(): Promise<Transaction[]> {
  const { usdc, ctf, ctfExchange, negRiskCtfExchange, negRiskAdapter } = privyConfig.contracts;
  
  // Import viem functions
  const { encodeFunctionData, maxUint256 } = await import('viem');
  
  const transactions: Transaction[] = [];
  
  // USDC approvals for exchanges
  // Using viem's encodeFunctionData and maxUint256 (compatible with RelayerClient)
  const usdcSpenders = [ctfExchange, negRiskCtfExchange, negRiskAdapter, ctf];
  for (const spender of usdcSpenders) {
    transactions.push({
      to: usdc,
      data: encodeFunctionData({
        abi: [{
          name: 'approve',
          type: 'function',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' }
          ],
          outputs: [{ type: 'bool' }]
        }],
        functionName: 'approve',
        args: [spender as `0x${string}`, maxUint256]
      }),
      value: '0',
    });
  }
  
  // CTF (ERC1155) approvals for exchanges
  const ctfOperators = [ctfExchange, negRiskCtfExchange, negRiskAdapter];
  for (const operator of ctfOperators) {
    transactions.push({
      to: ctf,
      data: encodeFunctionData({
        abi: [{
          name: 'setApprovalForAll',
          type: 'function',
          inputs: [
            { name: 'operator', type: 'address' },
            { name: 'approved', type: 'bool' }
          ],
          outputs: []
        }],
        functionName: 'setApprovalForAll',
        args: [operator as `0x${string}`, true]
      }),
      value: '0',
    });
  }
  
  return transactions;
}

/**
 * Register a new user and deploy their proxy wallet
 * 
 * This is the main function called when a user creates their account.
 * It performs the following steps:
 * 1. Check if user already exists (if so, return existing user)
 * 2. Get or create embedded wallet (ensures one wallet per user)
 * 3. Validates the username is available
 * 4. Creates user record in database
 * 5. Adds session signer to enable backend signing (if userJwt provided)
 * 6. Deploys a Gnosis Safe via Polymarket relayer
 * 7. Updates user record with proxy wallet address
 * 
 * @param privyUserId - The Privy user ID
 * @param username - Desired username
 * @param userJwt - Optional: User JWT token for adding session signer (if not provided, will use authorization private key)
 */
export async function registerUserAndDeployWallet(
  privyUserId: string,
  username: string,
  userJwt?: string
): Promise<{ user: UserProfile; proxyWalletAddress: string | null; embeddedWalletAddress: string }> {
  logger.info({
    message: 'Starting user registration and wallet deployment',
    privyUserId,
    username,
  });

  // Step 1: Check if user already exists
  const existingUser = await getUserByPrivyId(privyUserId);
  if (existingUser) {
    logger.info({
      message: 'User already exists, checking wallet status',
      userId: existingUser.id,
      username: existingUser.username,
      hasProxyWallet: !!existingUser.proxyWalletAddress,
    });

    // If user has proxy wallet, return it
    if (existingUser.proxyWalletAddress) {
      return {
        user: existingUser,
        proxyWalletAddress: existingUser.proxyWalletAddress,
        embeddedWalletAddress: existingUser.embeddedWalletAddress,
      };
    }
    
    // User exists but no proxy wallet - try to deploy it if session signer is available
    // If deployment fails, return user without proxy wallet

    // User exists but no proxy wallet - deploy it
    logger.info({
      message: 'User exists but no proxy wallet, deploying now',
      privyUserId,
      embeddedWalletAddress: existingUser.embeddedWalletAddress,
    });

    // Try to add session signer first if not already added
    if (!existingUser.sessionSignerEnabled) {
      try {
        const { privyService } = await import('./privy.service');
        const { privyConfig } = await import('./privy.config');
        
        const signerId = privyConfig.defaultSignerId;
        if (signerId) {
          logger.info({
            message: 'Adding session signer for existing user before deploying proxy wallet',
            privyUserId,
            walletAddress: existingUser.embeddedWalletAddress,
          });
          
          await privyService.addSessionSigner(
            privyUserId,
            existingUser.embeddedWalletAddress,
            signerId
          );
          
          await updateUserSessionSigner(privyUserId, true);
        }
      } catch (addSignerError) {
        logger.warn({
          message: 'Failed to add session signer for existing user - deployment may fail',
          privyUserId,
          error: addSignerError instanceof Error ? addSignerError.message : String(addSignerError),
        });
      }
    }
    
    try {
      const proxyWalletAddress = await deployProxyWallet(privyUserId, existingUser.embeddedWalletAddress);
      
      // IMPORTANT: Wrap this in its own try-catch so database update failures don't get treated as deployment failures
      let updatedUser: UserProfile | null = null;
      let updateError: Error | null = null;
      
      try {
        updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
      } catch (updateErr) {
        updateError = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
        logger.error({
          message: 'Database update failed after proxy wallet deployment for existing user',
          privyUserId,
          proxyWalletAddress,
          error: updateError.message,
          note: 'Wallet is deployed on-chain. Will retry database update.',
        });
      }
      
      if (!updatedUser) {
        // Retry the update - wallet is deployed, we just need to save it to database
        logger.warn({
          message: 'First attempt to update existing user with proxy wallet failed, retrying',
          privyUserId,
          proxyWalletAddress,
          hadError: !!updateError,
          errorMessage: updateError?.message,
        });
        
        // Wait a moment and retry
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        try {
          updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
        } catch (retryErr) {
          updateError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
          logger.error({
            message: 'Database update retry also failed for existing user',
            privyUserId,
            proxyWalletAddress,
            error: updateError.message,
          });
        }
        
        if (!updatedUser) {
          // This is critical - wallet is deployed but we can't save it
          logger.error({
            message: 'CRITICAL: Proxy wallet deployed but failed to save to database after retry for existing user',
            privyUserId,
            proxyWalletAddress,
            error: updateError?.message,
            note: 'Wallet is deployed on-chain but not saved in database. Will attempt final recovery.',
          });
          
          // Final attempt with longer delay
          await new Promise(resolve => setTimeout(resolve, 2000));
          try {
            updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
            if (updatedUser) {
              logger.info({
                message: 'Successfully updated existing user with proxy wallet on final attempt',
                privyUserId,
                proxyWalletAddress,
              });
            }
          } catch (finalErr) {
            const finalError = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
            logger.error({
              message: 'All database update attempts failed for existing user',
              privyUserId,
              proxyWalletAddress,
              error: finalError.message,
            });
            throw new Error(`Failed to update user with proxy wallet address after all retries. Wallet deployed at: ${proxyWalletAddress}. Error: ${finalError.message}`);
          }
        } else {
          logger.info({
            message: 'Successfully updated existing user with proxy wallet on retry',
            privyUserId,
            proxyWalletAddress,
          });
        }
      }

      // Ensure we have an updated user before proceeding
      if (!updatedUser) {
        throw new Error(`Failed to update user with proxy wallet address after all retries. Wallet deployed at: ${proxyWalletAddress}`);
      }

      // Start tracking USDC.e balance for the proxy wallet
      // IMPORTANT: Don't await this - it might hang. Start it in the background.
      // The database update is more important than balance tracking.
      try {
        const { polygonUsdcBalanceService } = await import('../polygon/polygon-usdc-balance.service');
        // Start watching in background - don't block on it
        polygonUsdcBalanceService.watchAddress(proxyWalletAddress, privyUserId).then(() => {
          logger.info({
            message: 'Started tracking USDC.e balance for proxy wallet',
            privyUserId,
            proxyWalletAddress,
          });
        }).catch((balanceError) => {
          logger.warn({
            message: 'Failed to start balance tracking (non-critical)',
            privyUserId,
            proxyWalletAddress,
            error: balanceError instanceof Error ? balanceError.message : String(balanceError),
          });
        });
        // Don't await - let it run in background
      } catch (balanceError) {
        // Don't fail if balance tracking fails
        logger.warn({
          message: 'Failed to start balance tracking (non-critical)',
          privyUserId,
          proxyWalletAddress,
          error: balanceError instanceof Error ? balanceError.message : String(balanceError),
        });
      }

      return {
        user: updatedUser,
        proxyWalletAddress,
        embeddedWalletAddress: updatedUser.embeddedWalletAddress,
      };
    } catch (error) {
      // Check if this is a database update error (wallet was deployed but not saved)
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isDatabaseUpdateError = errorMessage.toLowerCase().includes('failed to update user with proxy wallet') ||
                                    errorMessage.toLowerCase().includes('wallet deployed at:');
      
      if (isDatabaseUpdateError) {
        // CRITICAL: Wallet was deployed but database update failed
        logger.error({
          message: 'CRITICAL: Proxy wallet deployed but database update failed for existing user',
          privyUserId,
          username: existingUser.username,
          embeddedWalletAddress: existingUser.embeddedWalletAddress,
          error: errorMessage,
          note: 'Wallet is deployed on-chain. Database update failed. User may need to manually update proxy wallet address.',
        });
        
        // Extract proxy wallet address from error message if available
        const proxyWalletMatch = errorMessage.match(/wallet deployed at: (0x[a-fA-F0-9]{40})/i);
        const deployedProxyAddress = proxyWalletMatch ? proxyWalletMatch[1] : null;
        
        // Try one more time to update the database
        if (deployedProxyAddress) {
          logger.info({
            message: 'Attempting final database update with deployed proxy wallet address for existing user',
            privyUserId,
            proxyWalletAddress: deployedProxyAddress,
          });
          
          try {
            const finalUpdatedUser = await updateUserProxyWallet(privyUserId, deployedProxyAddress);
            if (finalUpdatedUser) {
              logger.info({
                message: 'Successfully updated existing user with proxy wallet on final attempt',
                privyUserId,
                proxyWalletAddress: deployedProxyAddress,
              });
              
              return {
                user: finalUpdatedUser,
                proxyWalletAddress: deployedProxyAddress,
                embeddedWalletAddress: finalUpdatedUser.embeddedWalletAddress,
              };
            }
          } catch (finalUpdateError) {
            logger.error({
              message: 'Final database update attempt also failed for existing user',
              privyUserId,
              proxyWalletAddress: deployedProxyAddress,
              error: finalUpdateError instanceof Error ? finalUpdateError.message : String(finalUpdateError),
            });
          }
        }
        
        // If we still can't update, throw the error so it's clear something went wrong
        throw new Error(`Proxy wallet was deployed but failed to save to database. Wallet address: ${deployedProxyAddress || 'unknown'}. Please contact support or manually update via API.`);
      }
      
      // If deployment fails due to session signer, return user without proxy wallet
      const isSessionSignerError = errorMessage.toLowerCase().includes('session signer') || 
                                    errorMessage.toLowerCase().includes('401') ||
                                    errorMessage.toLowerCase().includes('not authorized');
      
      if (isSessionSignerError) {
        logger.info({
          message: 'Proxy wallet deployment skipped for existing user - session signer not authorized',
          privyUserId,
          username: existingUser.username,
        });
        
        return {
          user: existingUser,
          proxyWalletAddress: null as string | null,
          embeddedWalletAddress: existingUser.embeddedWalletAddress,
        };
      }
      
      // For other errors, still return user without proxy wallet
      logger.warn({
        message: 'Failed to deploy proxy wallet for existing user, but returning user data',
        privyUserId,
        error: errorMessage,
      });
      
      return {
        user: existingUser,
        proxyWalletAddress: null as string | null,
        embeddedWalletAddress: existingUser.embeddedWalletAddress,
      };
    }
  }

  // Step 2: Get or create embedded wallet (ensures one wallet per user)
  // Get or create embedded wallet via Privy API
  // This will check for existing wallet first, or create a new one if needed
  const { privyService } = await import('./privy.service');
  const walletResult = await privyService.createEmbeddedWallet(privyUserId);
  const finalEmbeddedWalletAddress = walletResult.address;
  const walletId = walletResult.walletId; // Wallet ID from creation (if wallet was just created)
  
  logger.info({
    message: 'Got or created embedded wallet',
    privyUserId,
    walletAddress: finalEmbeddedWalletAddress,
    walletId: walletId || 'not available',
  });

  // Step 2B: Create Solana embedded wallet (for Kalshi trading)
  // IMPORTANT: EVM wallet MUST be created before Solana wallet (Privy requirement)
  let solanaWalletAddress: string | null = null;
  let solanaWalletId: string | null = null;
  try {
    const solanaResult = await privyService.createSolanaEmbeddedWallet(privyUserId);
    solanaWalletAddress = solanaResult.address;
    solanaWalletId = solanaResult.walletId;
    logger.info({
      message: 'Solana embedded wallet created during registration',
      privyUserId,
      solanaWalletAddress,
      solanaWalletId,
    });
  } catch (solanaError) {
    // Non-critical — user can create Solana wallet later via /api/users/create-solana-wallet
    logger.warn({
      message: 'Failed to create Solana wallet during registration — can be retried later',
      privyUserId,
      error: solanaError instanceof Error ? solanaError.message : String(solanaError),
    });
  }

  // Step 3: Validate username
  const usernameAvailable = await isUsernameAvailable(username);
  if (!usernameAvailable) {
    throw new Error('Username is already taken');
  }

  // Step 4: Create user record
  const createRequest: CreateUserRequest = {
    privyUserId,
    username,
    embeddedWalletAddress: finalEmbeddedWalletAddress,
  };
  
  const user = await createUser(createRequest);
  logger.info({
    message: 'User record created',
    userId: user.id,
    username: user.username,
    embeddedWalletAddress: user.embeddedWalletAddress,
  });

  // Step 4B: Save Solana wallet address if created
  if (solanaWalletAddress) {
    try {
      const { updateUserSolanaWallet } = await import('./kalshi-user.service');
      await updateUserSolanaWallet(privyUserId, solanaWalletAddress, solanaWalletId || undefined);
      user.solanaWalletAddress = solanaWalletAddress;
      user.solanaWalletId = solanaWalletId;
      const { addSolanaAddressToWebhook } = await import('../alchemy/alchemy-solana-webhook-addresses');
      addSolanaAddressToWebhook(solanaWalletAddress).catch(() => {});
    } catch (err) {
      logger.warn({
        message: 'Failed to save Solana wallet address to DB',
        privyUserId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Step 5: Add session signer to enable backend signing (before deploying proxy wallet)
  // NOTE: If wallet was just created, it may already have the session signer added during creation
  // We'll try to add it anyway - addSessionSigner will detect if it already exists and skip
  try {
    const { privyService } = await import('./privy.service');
    const { privyConfig } = await import('./privy.config');
    
    const signerId = privyConfig.defaultSignerId;
    if (!signerId) {
      logger.warn({
        message: 'No default signer ID configured - session signer will not be added',
        privyUserId,
        note: 'Set PRIVY_SIGNER_ID environment variable to enable automatic session signer addition',
      });
    } else {
      logger.info({
        message: 'Adding session signer to enable backend signing',
        privyUserId,
        walletAddress: finalEmbeddedWalletAddress,
        walletId: walletId || 'will be looked up',
        signerId,
        hasUserJwt: !!userJwt,
      });
      
      try {
        // Use walletId directly if we have it (from wallet creation), otherwise addSessionSigner will look it up
        // Pass walletId as an optional parameter - we'll need to modify addSessionSigner to accept it
        await privyService.addSessionSigner(
          privyUserId,
          finalEmbeddedWalletAddress,
          signerId,
          undefined, // policyIds
          userJwt, // Use user JWT if provided, otherwise will use authorization private key
          walletId // Pass walletId if available to avoid lookup
        );
        
        // Update user record to indicate session signer is enabled
        await updateUserSessionSigner(privyUserId, true);
        
        logger.info({
          message: 'Session signer added successfully during registration',
          privyUserId,
        });
      } catch (addSignerError) {
        const errorMessage = addSignerError instanceof Error ? addSignerError.message : String(addSignerError);
        
        // If error is "already exists", that's fine - wallet was created with signer already
        if (errorMessage.toLowerCase().includes('already exists') || errorMessage.toLowerCase().includes('session signer already exists')) {
          logger.info({
            message: 'Session signer already exists (wallet was created with signer) - this is expected',
            privyUserId,
          });
          // Mark session signer as enabled since it already exists
          await updateUserSessionSigner(privyUserId, true);
        } else {
          logger.warn({
            message: 'Failed to add session signer during registration - proxy wallet deployment may fail',
            privyUserId,
            error: errorMessage,
            note: 'User can add session signer later via POST /api/users/add-session-signer',
          });
          // Continue - we'll try to deploy anyway, but it will likely fail
        }
      }
    }
  } catch (sessionSignerError) {
    logger.warn({
      message: 'Error during session signer setup - continuing with registration',
      privyUserId,
      error: sessionSignerError instanceof Error ? sessionSignerError.message : String(sessionSignerError),
    });
    // Continue - registration succeeds even if session signer setup fails
  }

  // Step 6: Try to deploy proxy wallet via Polymarket relayer
  // NOTE: This now works because session signer was added above
  // If it fails, registration still succeeds and user can deploy later
  let proxyWalletAddress: string | null = null;
  try {
    proxyWalletAddress = await deployProxyWallet(privyUserId, finalEmbeddedWalletAddress, walletId);
    
    // Step 6: Update user record with proxy wallet
    // IMPORTANT: Wrap this in its own try-catch so database update failures don't get treated as deployment failures
    let updatedUser: UserProfile | null = null;
    let updateError: Error | null = null;
    
    try {
      updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
    } catch (updateErr) {
      updateError = updateErr instanceof Error ? updateErr : new Error(String(updateErr));
      logger.error({
        message: 'Database update failed after proxy wallet deployment',
        privyUserId,
        proxyWalletAddress,
        error: updateError.message,
        note: 'Wallet is deployed on-chain. Will retry database update.',
      });
    }

    if (!updatedUser) {
      // Retry the update - wallet is deployed, we just need to save it to database
      logger.warn({
        message: 'First attempt to update user with proxy wallet failed, retrying',
        privyUserId,
        proxyWalletAddress,
        hadError: !!updateError,
        errorMessage: updateError?.message,
      });
      
      // Wait a moment and retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      try {
        updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
      } catch (retryErr) {
        updateError = retryErr instanceof Error ? retryErr : new Error(String(retryErr));
        logger.error({
          message: 'Database update retry also failed',
          privyUserId,
          proxyWalletAddress,
          error: updateError.message,
        });
      }
      
      if (!updatedUser) {
        // This is critical - wallet is deployed but we can't save it
        logger.error({
          message: 'CRITICAL: Proxy wallet deployed but failed to save to database after retry',
          privyUserId,
          proxyWalletAddress,
          error: updateError?.message,
          note: 'Wallet is deployed on-chain but not saved in database. Will attempt final recovery.',
        });
        
        // Final attempt with longer delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
          updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
          if (updatedUser) {
            logger.info({
              message: 'Successfully updated user with proxy wallet on final attempt',
              privyUserId,
              proxyWalletAddress,
            });
          }
        } catch (finalErr) {
          const finalError = finalErr instanceof Error ? finalErr : new Error(String(finalErr));
          logger.error({
            message: 'All database update attempts failed',
            privyUserId,
            proxyWalletAddress,
            error: finalError.message,
          });
          throw new Error(`Failed to update user with proxy wallet address after all retries. Wallet deployed at: ${proxyWalletAddress}. Error: ${finalError.message}`);
        }
      } else {
        logger.info({
          message: 'Successfully updated user with proxy wallet on retry',
          privyUserId,
          proxyWalletAddress,
        });
      }
    }

    // Ensure we have an updated user before proceeding
    if (!updatedUser) {
      throw new Error(`Failed to update user with proxy wallet address after all retries. Wallet deployed at: ${proxyWalletAddress}`);
    }

    // Step 7: Start tracking USDC.e balance for the proxy wallet
    // IMPORTANT: Don't await this - it might hang. Start it in the background.
    // The database update is more important than balance tracking.
    try {
      const { polygonUsdcBalanceService } = await import('../polygon/polygon-usdc-balance.service');
      // Start watching in background - don't block on it
      polygonUsdcBalanceService.watchAddress(proxyWalletAddress, privyUserId).then(() => {
        logger.info({
          message: 'Started tracking USDC.e balance for proxy wallet',
          privyUserId,
          proxyWalletAddress,
        });
      }).catch((balanceError) => {
        logger.warn({
          message: 'Failed to start balance tracking (non-critical)',
          privyUserId,
          proxyWalletAddress,
          error: balanceError instanceof Error ? balanceError.message : String(balanceError),
        });
      });
      // Don't await - let it run in background
    } catch (balanceError) {
      // Don't fail registration if balance tracking fails
      logger.warn({
        message: 'Failed to start balance tracking (non-critical)',
        privyUserId,
        proxyWalletAddress,
        error: balanceError instanceof Error ? balanceError.message : String(balanceError),
      });
    }

    logger.info({
      message: 'User registration complete with proxy wallet',
      userId: updatedUser.id,
      username: updatedUser.username,
      embeddedWalletAddress: finalEmbeddedWalletAddress,
      proxyWalletAddress,
    });

    return {
      user: updatedUser,
      proxyWalletAddress,
      embeddedWalletAddress: finalEmbeddedWalletAddress,
    };
  } catch (error) {
    // Check if this is a database update error (wallet was deployed but not saved)
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isDatabaseUpdateError = errorMessage.toLowerCase().includes('failed to update user with proxy wallet') ||
                                  errorMessage.toLowerCase().includes('wallet deployed at:');
    
    if (isDatabaseUpdateError) {
      // CRITICAL: Wallet was deployed but database update failed
      // We should NOT return user without proxy wallet - this is a critical error
      logger.error({
        message: 'CRITICAL: Proxy wallet deployed but database update failed',
        privyUserId,
        username: user.username,
        embeddedWalletAddress: finalEmbeddedWalletAddress,
        error: errorMessage,
        note: 'Wallet is deployed on-chain. Database update failed. User may need to manually update proxy wallet address.',
      });
      
      // Extract proxy wallet address from error message if available
      const proxyWalletMatch = errorMessage.match(/wallet deployed at: (0x[a-fA-F0-9]{40})/i);
      const deployedProxyAddress = proxyWalletMatch ? proxyWalletMatch[1] : null;
      
      // Try one more time to update the database
      if (deployedProxyAddress) {
        logger.info({
          message: 'Attempting final database update with deployed proxy wallet address',
          privyUserId,
          proxyWalletAddress: deployedProxyAddress,
        });
        
        try {
          const finalUpdatedUser = await updateUserProxyWallet(privyUserId, deployedProxyAddress);
          if (finalUpdatedUser) {
            logger.info({
              message: 'Successfully updated user with proxy wallet on final attempt',
              privyUserId,
              proxyWalletAddress: deployedProxyAddress,
            });
            
            return {
              user: finalUpdatedUser,
              proxyWalletAddress: deployedProxyAddress,
              embeddedWalletAddress: finalEmbeddedWalletAddress,
            };
          }
        } catch (finalUpdateError) {
          logger.error({
            message: 'Final database update attempt also failed',
            privyUserId,
            proxyWalletAddress: deployedProxyAddress,
            error: finalUpdateError instanceof Error ? finalUpdateError.message : String(finalUpdateError),
          });
        }
      }
      
      // If we still can't update, throw the error so it's clear something went wrong
      // The wallet is deployed, but we can't save it to the database
      throw new Error(`Proxy wallet was deployed but failed to save to database. Wallet address: ${deployedProxyAddress || 'unknown'}. Please contact support or manually update via API.`);
    }
    
    // If proxy wallet deployment fails (e.g., session signer not authorized),
    // registration still succeeds - user can deploy later
    const isSessionSignerError = errorMessage.toLowerCase().includes('session signer') || 
                                  errorMessage.toLowerCase().includes('401') ||
                                  errorMessage.toLowerCase().includes('not authorized');
    
    if (isSessionSignerError) {
      logger.info({
        message: 'Proxy wallet deployment skipped - session signer not authorized. User can deploy later.',
        privyUserId,
        username: user.username,
        embeddedWalletAddress: finalEmbeddedWalletAddress,
      });
      
      // Return user without proxy wallet - they can deploy it later
      return {
        user,
        proxyWalletAddress: null as string | null,
        embeddedWalletAddress: finalEmbeddedWalletAddress,
      };
    }
    
    // For other errors, still log but don't fail registration
    logger.warn({
      message: 'Failed to deploy proxy wallet during registration, but registration succeeded',
      privyUserId,
      username: user.username,
      error: errorMessage,
      note: 'User can deploy proxy wallet later via POST /api/users/:privyUserId/deploy-proxy-wallet',
    });
    
    // Return user without proxy wallet
    return {
      user,
      proxyWalletAddress: null as string | null,
      embeddedWalletAddress: finalEmbeddedWalletAddress,
    };
  }
}

/**
 * Get the address from a private key
 * 
 * @param privateKey - The private key (with or without 0x prefix)
 * @returns The Ethereum address derived from the private key
 */
function getAddressFromPrivateKey(privateKey: string): string {
  if (!privateKey) {
    throw new Error('Private key is required');
  }
  
  // Remove 0x prefix if present
  const cleanKey = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  
  // Create wallet from private key to get address
  const wallet = new ethers.Wallet(`0x${cleanKey}`);
  return wallet.address;
}

/**
 * Get the authorization key address (co-owner of Safe wallets)
 * 
 * @returns The address derived from PRIVY_AUTHORIZATION_PRIVATE_KEY
 */
function getAuthorizationKeyAddress(): string {
  if (!privyConfig.authorizationPrivateKey) {
    throw new Error('PRIVY_AUTHORIZATION_PRIVATE_KEY is not configured');
  }
  
  return getAddressFromPrivateKey(privyConfig.authorizationPrivateKey);
}

/**
 * Safe contract ABI for owner management functions
 */
const SAFE_ABI = [
  'function addOwnerWithThreshold(address owner, uint256 threshold)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
];

/**
 * Add an owner to a Safe wallet via RelayerClient
 * 
 * @param safeAddress - The Safe wallet address
 * @param newOwnerAddress - The address to add as owner
 * @param signer - The ethers Signer (for signing)
 * @param builderConfig - The builder config for RelayerClient
 * @param relayerClient - The RelayerClient instance
 * @param privyUserId - The Privy user ID (for logging)
 */
async function addOwnerToSafe(
  safeAddress: string,
  newOwnerAddress: string,
  signer: any,
  builderConfig: any,
  relayerClient: any,
  privyUserId: string
): Promise<void> {
  logger.info({
    message: 'Adding owner to Safe wallet',
    safeAddress,
    newOwnerAddress,
    privyUserId,
  });

  // Wait a moment for the Safe to be fully initialized after deployment
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if owner already exists and get current threshold
  let currentThreshold = 1;
  try {
    const provider = new ethers.providers.JsonRpcProvider(privyConfig.rpcUrl);
    const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, provider);
    
    const isOwner = await safeContract.isOwner(newOwnerAddress);
    if (isOwner) {
      logger.info({
        message: 'Owner already exists in Safe wallet',
        safeAddress,
        newOwnerAddress,
        privyUserId,
      });
      return; // Owner already exists, no need to add
    }
    
    // Get current threshold
    currentThreshold = (await safeContract.getThreshold()).toNumber();
    logger.info({
      message: 'Current Safe threshold',
      safeAddress,
      currentThreshold,
      privyUserId,
    });
  } catch (checkError) {
    logger.warn({
      message: 'Could not check Safe state, proceeding with add',
      safeAddress,
      newOwnerAddress,
      privyUserId,
      error: checkError instanceof Error ? checkError.message : String(checkError),
    });
  }

  // Encode the addOwnerWithThreshold function call
  // Threshold stays at 1 (either owner can sign independently)
  // This allows either the user's wallet or the authorization key to sign transactions
  const iface = new ethers.utils.Interface(SAFE_ABI);
  const data = iface.encodeFunctionData('addOwnerWithThreshold', [
    newOwnerAddress,
    currentThreshold, // Keep threshold at 1 (either owner can sign)
  ]);

  // Execute the transaction via RelayerClient
  // The RelayerClient will execute this FROM the Safe wallet
  // Since the user's wallet is the current owner, it can sign this transaction
  const transaction = {
    to: safeAddress,
    data: data,
    value: '0',
  };

  logger.info({
    message: 'Executing addOwnerWithThreshold transaction via RelayerClient',
    safeAddress,
    newOwnerAddress,
    threshold: currentThreshold,
    privyUserId,
  });

  try {
    const response = await relayerClient.execute(
      [transaction],
      'Add authorization key as Safe co-owner'
    );
    
    const result = await response.wait();
    
    if (!result) {
      throw new Error('Add owner transaction failed - no result');
    }

    logger.info({
      message: 'Successfully added owner to Safe wallet',
      safeAddress,
      newOwnerAddress,
      transactionHash: result.transactionHash,
      threshold: currentThreshold,
      privyUserId,
    });
  } catch (executeError) {
    logger.error({
      message: 'Failed to execute addOwnerWithThreshold transaction',
      safeAddress,
      newOwnerAddress,
      privyUserId,
      error: executeError instanceof Error ? executeError.message : String(executeError),
    });
    throw executeError;
  }
}

/**
 * Create a viem wallet client for RelayerClient
 * 
 * Creates a viem wallet client with just the address. RelayerClient only needs
 * the address to set as the Safe owner - it doesn't need actual signing since
 * Polymarket's relayer handles gasless transactions.
 * 
 * @param embeddedWalletAddress - The user's embedded wallet address
 * @returns A viem wallet client with the address
 */
/**
 * Create a viem wallet client for RelayerClient with Privy signing
 * 
 * RelayerClient's abstract-signer expects either:
 * - ethers Wallet/JsonRpcSigner (with proper provider structure)
 * - viem WalletClient (with account and transport)
 * 
 * Since PrivySignerAdapter doesn't match ethers Wallet exactly, and RelayerClient
 * tries to wrap it in ViemSigner (which fails), we use viem WalletClient directly
 * with a custom account that uses Privy's signing methods.
 * 
 * If you have a private key, you could use:
 *   const account = privateKeyToAccount(privateKey);
 *   const wallet = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });
 * 
 * @param privyUserId - The Privy user ID
 * @param embeddedWalletAddress - The user's embedded wallet address
 * @returns A viem WalletClient configured with Privy signing
 */
export async function createViemWalletForRelayer(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string // Optional: walletId to avoid lookup during signing
): Promise<{ wallet: any; builderConfig: any; signer: any }> {
  // Create Privy signer adapter for signing
  const signer = createPrivySigner(privyUserId, embeddedWalletAddress, walletId);
  const signerAddress = await signer.getAddress();
  const normalizedAddress = signerAddress.toLowerCase() as `0x${string}`;
  
  // Import required modules
  const { createWalletClient, http, toHex } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { BuilderConfig } = await import('@polymarket/builder-signing-sdk');
  
  // Create BuilderConfig with remote signing server for Polymarket order signing
  // Note: Safe transaction signing uses the wallet's signing methods, not builderConfig
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
  });
  
  // Create a viem account that uses Privy's signing methods
  // This is what RelayerClient expects - a viem WalletClient with an account
  const account = {
    address: normalizedAddress,
    type: 'local' as const,
    async signMessage({ message }: { message: string | { raw: Uint8Array | string } }) {
      // ViemSigner (from @polymarket/builder-abstract-signer) wraps messages in { raw: Uint8Array }
      // We need to extract the actual message and convert it properly for our signer
      let actualMessage: string | Uint8Array;
      
      if (typeof message === 'object' && message !== null && 'raw' in message) {
        // Message is in { raw: Uint8Array | string } format from ViemSigner
        const rawValue = message.raw;
        if (typeof rawValue === 'string') {
          actualMessage = rawValue;
        } else if (rawValue instanceof Uint8Array) {
          actualMessage = rawValue;
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          // Convert object with numeric keys to Uint8Array
          const length = Object.keys(rawValue).length;
          const bytes = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            bytes[i] = (rawValue as any)[i] || 0;
          }
          actualMessage = bytes;
        } else {
          throw new Error(`Unexpected raw message format: ${typeof rawValue}`);
        }
      } else if (typeof message === 'string') {
        actualMessage = message;
      } else {
        throw new Error(`Unexpected message format: ${typeof message}`);
      }
      
      const signature = await signer.signMessage(actualMessage);
      
      // Defensive normalization - ensure signature is always a hex string
      // RelayerClient/ethers might receive the raw object format from Privy
      if (typeof signature === 'string' && signature.startsWith('0x')) {
        return signature as `0x${string}`;
      }
      
      // If signature is an object with raw property, normalize it
      if (signature && typeof signature === 'object' && 'raw' in signature) {
        const { ethers } = await import('ethers');
        const rawValue = (signature as any).raw;
        let bytes: Uint8Array;
        
        if (rawValue instanceof Uint8Array) {
          bytes = rawValue;
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          // Convert object with numeric keys to Uint8Array
          const length = Object.keys(rawValue).length;
          bytes = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            bytes[i] = rawValue[i] || 0;
          }
        } else {
          throw new Error(`Unexpected raw signature format: ${typeof rawValue}`);
        }
        
        const hexSignature = ethers.utils.hexlify(bytes);
        logger.warn({
          message: 'Normalized signature at account level (defensive)',
          userId: privyUserId,
          signatureLength: bytes.length,
        });
        return hexSignature as `0x${string}`;
      }
      
      // Fallback: try to convert to string
      const hexSig = typeof signature === 'string' ? signature : String(signature);
      if (!hexSig.startsWith('0x')) {
        throw new Error(`Invalid signature format: expected hex string starting with 0x, got ${typeof signature}`);
      }
      return hexSig as `0x${string}`;
    },
    async signTypedData({ domain, types, primaryType, message: messageData }: any) {
      logger.info({
        message: 'Account signTypedData called',
        userId: privyUserId,
        hasDomain: !!domain,
        hasTypes: !!types,
        primaryType,
      });
      
      // Convert viem types to ethers format for Privy
      const ethersTypes: Record<string, ethers.TypedDataField[]> = {};
      for (const [key, value] of Object.entries(types)) {
        if (key !== 'EIP712Domain') {
          ethersTypes[key] = (value as any[]).map((field: any) => ({
            name: field.name,
            type: field.type,
          }));
        }
      }
      
      const ethersDomain: ethers.TypedDataDomain = {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? BigInt(domain.chainId) : undefined,
        verifyingContract: domain.verifyingContract,
        salt: domain.salt ? toHex(domain.salt) : undefined,
      };
      
      const signature = await signer._signTypedData(ethersDomain, ethersTypes, messageData);
      
      logger.info({
        message: 'Received signature from signer._signTypedData',
        userId: privyUserId,
        signatureType: typeof signature,
        isString: typeof signature === 'string',
        isObject: typeof signature === 'object',
        hasRaw: signature && typeof signature === 'object' && 'raw' in signature,
        signaturePreview: typeof signature === 'string' ? signature.substring(0, 20) + '...' : 'object',
      });
      
      // Defensive normalization - ensure signature is always a hex string
      // RelayerClient/ethers might receive the raw object format from Privy
      if (typeof signature === 'string' && signature.startsWith('0x')) {
        logger.info({
          message: 'Signature already in hex string format',
          userId: privyUserId,
          signatureLength: signature.length,
        });
        return signature as `0x${string}`;
      }
      
      // If signature is an object with raw property, normalize it
      if (signature && typeof signature === 'object' && 'raw' in signature) {
        logger.warn({
          message: 'Normalizing signature from raw object format',
          userId: privyUserId,
          rawType: typeof (signature as any).raw,
        });
        
        const { ethers } = await import('ethers');
        const rawValue = (signature as any).raw;
        let bytes: Uint8Array;
        
        if (rawValue instanceof Uint8Array) {
          bytes = rawValue;
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          // Convert object with numeric keys to Uint8Array
          const length = Object.keys(rawValue).length;
          bytes = new Uint8Array(length);
          for (let i = 0; i < length; i++) {
            bytes[i] = rawValue[i] || 0;
          }
        } else {
          throw new Error(`Unexpected raw signature format: ${typeof rawValue}`);
        }
        
        const hexSignature = ethers.utils.hexlify(bytes);
        logger.warn({
          message: 'Normalized typed data signature at account level (defensive)',
          userId: privyUserId,
          signatureLength: bytes.length,
          hexSignature: hexSignature.substring(0, 20) + '...',
        });
        return hexSignature as `0x${string}`;
      }
      
      // Fallback: try to convert to string
      const hexSig = typeof signature === 'string' ? signature : String(signature);
      if (!hexSig.startsWith('0x')) {
        logger.error({
          message: 'Invalid signature format - not a hex string',
          userId: privyUserId,
          signatureType: typeof signature,
          signatureValue: signature,
        });
        throw new Error(`Invalid signature format: expected hex string starting with 0x, got ${typeof signature}`);
      }
      return hexSig as `0x${string}`;
    },
  } as any;
  
  // Create viem wallet client - this is what RelayerClient expects
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(privyConfig.rpcUrl),
  });
  
  return { wallet, builderConfig, signer };
}

/**
 * Deploy a proxy wallet (Gnosis Safe) for a user
 * 
 * Uses the Polymarket relayer to deploy a Safe wallet owned by the user's
 * Privy embedded wallet. The relayer handles gas fees.
 * 
 * @param privyUserId - The Privy user ID (for session signer)
 * @param embeddedWalletAddress - The user's embedded wallet address (becomes Safe owner)
 */
export async function deployProxyWallet(
  privyUserId: string,
  embeddedWalletAddress: string,
  walletId?: string // Optional: walletId to avoid lookup during signing
): Promise<string> {
  logger.info({
    message: 'Deploying proxy wallet via Polymarket relayer',
    privyUserId,
    embeddedWalletAddress,
  });

  // Normalize address for comparison
  const normalizedEmbeddedAddress = embeddedWalletAddress.toLowerCase();
  
  logger.info({
    message: 'Creating viem wallet client - embedded wallet will be set as Safe owner',
    owner: normalizedEmbeddedAddress,
    privyUserId,
  });
  
  // Validate builder signing server URL is configured
  if (!privyConfig.builderSigningServerUrl) {
    const errorMsg = `Builder signing server URL is not configured. Please set BUILDER_SIGNING_SERVER_URL environment variable.`;
    logger.error({
      message: errorMsg,
      privyUserId,
    });
    throw new Error(errorMsg);
  }

  // Log builder signing server URL for debugging
  // Note: Health check is skipped because localhost from Docker container may not be accessible
  // The actual deployment attempt will reveal if there's a connectivity issue
  logger.info({
    message: 'Proceeding with proxy wallet deployment',
    builderSigningServerUrl: privyConfig.builderSigningServerUrl,
    privyUserId,
    note: 'If using localhost from Docker, ensure builder signing server is accessible (consider using host.docker.internal or host network mode)',
  });

  try {
    // Import RelayClient
    logger.info({
      message: 'Importing RelayerClient',
      privyUserId,
    });
    
    let RelayClient: any;
    try {
      const relayClientModule = await import('@polymarket/builder-relayer-client');
      RelayClient = relayClientModule.RelayClient;
      logger.info({
        message: 'Successfully imported RelayerClient',
        privyUserId,
      });
    } catch (importError) {
      logger.error({
        message: 'Failed to import RelayerClient',
        privyUserId,
        error: importError instanceof Error ? importError.message : String(importError),
      });
      throw new Error(`Failed to import required dependencies: ${importError instanceof Error ? importError.message : String(importError)}`);
    }
    
    // Create ethers Signer with Privy signing
    logger.info({
      message: 'Creating ethers Signer with Privy signing for RelayerClient',
      privyUserId,
      embeddedWalletAddress,
    });
    
    // Check cache first
    const cached = relayerClientCache.get(privyUserId);
    let relayerClient: any;
    let wallet: any;
    let builderConfig: any;
    
    if (cached && cached.embeddedWalletAddress.toLowerCase() === embeddedWalletAddress.toLowerCase()) {
      logger.info({
        message: 'Reusing cached RelayerClient instance',
        privyUserId,
        embeddedWalletAddress,
      });
      relayerClient = cached.relayerClient;
      wallet = cached.wallet;
      builderConfig = cached.builderConfig;
    } else {
      // Create new RelayerClient instance
      const walletResult = await createViemWalletForRelayer(privyUserId, embeddedWalletAddress, walletId);
      wallet = walletResult.wallet;
      builderConfig = walletResult.builderConfig;
      const signer = walletResult.signer;
      
      // Verify wallet address matches embedded wallet address
      const walletAddress = wallet.account.address.toLowerCase();
      const normalizedEmbeddedAddress = embeddedWalletAddress.toLowerCase();
      
      if (walletAddress !== normalizedEmbeddedAddress) {
        logger.error({
          message: 'Wallet address mismatch - cannot deploy proxy wallet',
          embeddedWalletAddress: normalizedEmbeddedAddress,
          walletAddress: walletAddress,
        });
        throw new Error('Wallet address does not match embedded wallet address. Cannot set owner correctly.');
      }
      
      logger.info({
        message: 'Viem wallet client created successfully - embedded wallet will be set as Safe owner',
        privyUserId,
        walletAddress: walletAddress,
      });
      
      // Import RelayerTxType
      const { RelayerTxType } = await import('@polymarket/builder-relayer-client');
      
      try {
        logger.info({
          message: 'Creating RelayerClient with viem wallet client',
        privyUserId,
        relayerUrl: privyConfig.relayerUrl,
        chainId: privyConfig.chainId,
        walletAddress: walletAddress,
      });
      
      // Create RelayerClient with viem WalletClient
      // RelayerClient expects viem WalletClient (with account and transport)
      // The account uses Privy's signing methods via PrivySignerAdapter
      // RelayerClient needs actual signatures - "gasless" means Polymarket pays gas,
      // but the wallet still needs to sign the deployment transaction
      relayerClient = new RelayClient(
        privyConfig.relayerUrl,
        privyConfig.chainId,
        wallet, // Pass viem WalletClient (RelayerClient expects this structure)
        builderConfig,
        RelayerTxType.SAFE // Specify Safe wallet type
      );
      logger.info({
        message: 'RelayerClient created successfully',
        owner: walletAddress,
        privyUserId,
      });
      
      // Cache the RelayerClient instance for reuse
      relayerClientCache.set(privyUserId, {
        relayerClient,
        wallet,
        builderConfig,
        signer,
        walletId: walletId || undefined,
        embeddedWalletAddress,
      });
      
      logger.info({
        message: 'RelayerClient cached for future use',
        privyUserId,
        embeddedWalletAddress,
      });
    } catch (clientError) {
      // Enhanced error logging to identify what's undefined
      const errorMessage = clientError instanceof Error ? clientError.message : String(clientError);
      const errorStack = clientError instanceof Error ? clientError.stack : undefined;
      
      logger.error({
        message: 'Failed to create RelayerClient',
        privyUserId,
        relayerUrl: privyConfig.relayerUrl,
        chainId: privyConfig.chainId,
        walletAddress: walletAddress,
        builderConfigType: typeof builderConfig,
        builderConfigKeys: builderConfig ? Object.keys(builderConfig) : [],
        error: errorMessage,
        errorStack,
      });
      
      // Provide more context in the error message
      if (errorMessage.includes("Cannot read properties of undefined")) {
        throw new Error(`Failed to create RelayerClient: ${errorMessage}. This usually means the wallet or builderConfig is missing required properties. Check that the wallet is properly initialized and builderConfig is correctly configured.`);
      }
      
        throw new Error(`Failed to create RelayerClient: ${errorMessage}`);
      }
    }

    // Get authorization key address (will be co-owner)
    let authorizationKeyAddress: string;
    try {
      authorizationKeyAddress = getAuthorizationKeyAddress();
      logger.info({
        message: 'Got authorization key address for co-ownership',
        authorizationKeyAddress,
        privyUserId,
      });
    } catch (error) {
      logger.warn({
        message: 'Could not get authorization key address, deploying with single owner',
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with single owner deployment if authorization key is not configured
      authorizationKeyAddress = '';
    }

    // Get wallet address (from cached or newly created wallet)
    const walletAddress = wallet.account.address.toLowerCase();
    const owners = [walletAddress];
    if (authorizationKeyAddress) {
      owners.push(authorizationKeyAddress.toLowerCase());
    }

    logger.info({
      message: 'Deploying Safe wallet with owners',
      owners,
      privyUserId,
      note: 'RelayerClient will deploy with first owner, then we will add second owner if needed',
    });

    // Deploy the Safe wallet
    // The RelayerClient.deploy() method automatically:
    // 1. Uses the signer's address (embeddedWalletAddress) as the owner
    // 2. Sets threshold to 1 (single owner, single signature required)
    // 3. Deploys the Safe wallet via Polymarket relayer (gasless)
    let deployResponse: any;
    try {
      deployResponse = await relayerClient.deploy();
      logger.info({
        message: 'Deploy response received, waiting for transaction',
        privyUserId,
      });
    } catch (deployError) {
      logger.error({
        message: 'Failed to deploy Safe wallet',
        privyUserId,
        error: deployError instanceof Error ? deployError.message : String(deployError),
      });
      throw new Error(`Failed to deploy Safe wallet: ${deployError instanceof Error ? deployError.message : String(deployError)}`);
    }
    
    let result: any;
    try {
      result = await deployResponse.wait();
      logger.info({
        message: 'Deployment transaction confirmed',
        privyUserId,
        transactionHash: result?.transactionHash,
        proxyAddress: result?.proxyAddress,
      });
    } catch (waitError) {
      logger.error({
        message: 'Failed to wait for deployment transaction',
        privyUserId,
        error: waitError instanceof Error ? waitError.message : String(waitError),
      });
      throw new Error(`Failed to wait for deployment transaction: ${waitError instanceof Error ? waitError.message : String(waitError)}`);
    }

    if (!result || !result.proxyAddress) {
      logger.error({
        message: 'Safe deployment failed - no proxy address returned',
        privyUserId,
        result: result ? JSON.stringify(result) : 'null',
      });
      throw new Error('Safe deployment failed - no proxy address returned');
    }

    const safeAddress = result.proxyAddress;
    logger.info({
      message: 'Proxy wallet deployed successfully',
      proxyAddress: safeAddress,
      transactionHash: result.transactionHash,
      privyUserId,
    });

    // Start tracking USDC.e balance for the proxy wallet
    // IMPORTANT: Don't await this - it might hang. Start it in the background.
    // The database update is more important than balance tracking.
    try {
      const { polygonUsdcBalanceService } = await import('../polygon/polygon-usdc-balance.service');
      // Start watching in background - don't block on it
      polygonUsdcBalanceService.watchAddress(safeAddress, privyUserId).then(() => {
        logger.info({
          message: 'Started tracking USDC.e balance for proxy wallet',
          privyUserId,
          proxyWalletAddress: safeAddress,
        });
      }).catch((balanceError) => {
        logger.warn({
          message: 'Failed to start balance tracking (non-critical)',
          privyUserId,
          proxyWalletAddress: safeAddress,
          error: balanceError instanceof Error ? balanceError.message : String(balanceError),
        });
      });
      // Don't await - let it run in background
    } catch (balanceError) {
      // Don't fail deployment if balance tracking fails
      logger.warn({
        message: 'Failed to start balance tracking (non-critical)',
        privyUserId,
        proxyWalletAddress: safeAddress,
        error: balanceError instanceof Error ? balanceError.message : String(balanceError),
      });
    }

    // Add authorization key as co-owner if configured
    if (authorizationKeyAddress && owners.length > 1) {
      logger.info({
        message: 'Adding authorization key as co-owner',
        safeAddress,
        authorizationKeyAddress,
        privyUserId,
      });

      try {
        await addOwnerToSafe(
          safeAddress,
          authorizationKeyAddress,
          wallet,
          builderConfig,
          relayerClient,
          privyUserId
        );
        
        logger.info({
          message: 'Successfully added authorization key as co-owner',
          safeAddress,
          authorizationKeyAddress,
          privyUserId,
        });
      } catch (addOwnerError) {
        // Log error but don't fail deployment - Safe is already deployed with user as owner
        logger.error({
          message: 'Failed to add authorization key as co-owner, but Safe is deployed',
          safeAddress,
          authorizationKeyAddress,
          privyUserId,
          error: addOwnerError instanceof Error ? addOwnerError.message : String(addOwnerError),
          note: 'Safe wallet is deployed with user as owner. Authorization key can be added later.',
        });
        // Continue - Safe is deployed, just without the second owner
      }
    }

    return safeAddress;
  } catch (error) {
    // Enhanced error logging - extract all possible error information
    let errorMessage = 'Unknown error';
    let errorDetails: any = {};
    
    if (error instanceof Error) {
      errorMessage = error.message || String(error);
      errorDetails = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error && typeof error === 'object') {
      // Try to extract error message from object
      errorMessage = (error as any).message || (error as any).error || (error as any).reason || String(error);
      errorDetails = error;
    } else {
      errorMessage = String(error);
    }
    
    const errorLower = errorMessage.toLowerCase();
    
    // Check for nested errors (common in promise chains)
    if (error && typeof error === 'object') {
      const nestedError = (error as any).error || (error as any).cause;
      if (nestedError) {
        const nestedMessage = nestedError instanceof Error ? nestedError.message : String(nestedError);
        errorMessage = `${errorMessage}. Nested error: ${nestedMessage}`;
      }
    }
    
    logger.error({
      message: 'Error deploying proxy wallet',
      privyUserId,
      embeddedWalletAddress,
      error: errorMessage,
      errorDetails,
      builderSigningServerUrl: privyConfig.builderSigningServerUrl,
      relayerUrl: privyConfig.relayerUrl,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Handle "already deployed" case
    if (errorLower.includes('already deployed') || errorLower.includes('already exists')) {
      logger.info({
        message: 'Proxy wallet already exists, querying address',
        privyUserId,
      });
      
      // Try to get the existing Safe address from the relayer
      // This is a fallback - in practice, we'd query the relayer API
      throw new Error('Proxy wallet already deployed. Please contact support to recover your wallet address.');
    }

    // Provide more specific error messages for common issues
    if (errorLower.includes('builder') || errorLower.includes('signing server') || errorLower.includes('econnrefused') || errorLower.includes('connect econnrefused') || errorLower.includes('fetch failed') || errorLower.includes('network')) {
      throw new Error(`Builder signing server connection failed. URL: ${privyConfig.builderSigningServerUrl}. Please verify BUILDER_SIGNING_SERVER_URL is correct and the server is accessible. Original error: ${errorMessage}`);
    }

    if (errorLower.includes('relayer') && !errorLower.includes('signing')) {
      throw new Error(`Polymarket relayer connection failed. URL: ${privyConfig.relayerUrl}. Please verify POLYMARKET_RELAYER_URL is correct. Original error: ${errorMessage}`);
    }
    
    // Re-throw with enhanced message
    throw new Error(`Failed to deploy proxy wallet: ${errorMessage}`);
  }
}

/**
 * Set up token approvals for a user's proxy wallet
 * 
 * Approves USDC and CTF tokens for Polymarket exchange contracts.
 * This enables the user to trade on Polymarket.
 * 
 * @param privyUserId - The Privy user ID
 */
export async function setupTokenApprovals(
  privyUserId: string
): Promise<{ success: boolean; transactionHashes: string[] }> {
  // #region agent log
  ingestDebugLog({location:'wallet-deployment.service.ts:1628',message:'setupTokenApprovals called',data:{privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'});
  // #endregion
  const user = await getUserByPrivyId(privyUserId);
  
  // #region agent log
  ingestDebugLog({location:'wallet-deployment.service.ts:1632',message:'user lookup result',data:{userFound:!!user,hasProxyWallet:!!user?.proxyWalletAddress,proxyWallet:user?.proxyWalletAddress},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'});
  // #endregion
  
  if (!user) {
    // #region agent log
    ingestDebugLog({location:'wallet-deployment.service.ts:1634',message:'user not found - throwing error',data:{privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'});
    // #endregion
    throw new Error('User not found');
  }
  
  if (!user.proxyWalletAddress) {
    // #region agent log
    fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'wallet-deployment.service.ts:1638',message:'no proxy wallet - throwing error',data:{privyUserId,embeddedWallet:user.embeddedWalletAddress},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion
    throw new Error('User does not have a proxy wallet');
  }

  logger.info({
    message: 'Setting up token approvals',
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
  });
  
  try {
    // Check cache first - reuse RelayerClient from deployment if available
    const cached = relayerClientCache.get(privyUserId);
    let relayerClient: any;
    
    if (cached && cached.embeddedWalletAddress.toLowerCase() === user.embeddedWalletAddress.toLowerCase()) {
      logger.info({
        message: 'Reusing cached RelayerClient instance for token approvals',
        privyUserId,
        embeddedWalletAddress: user.embeddedWalletAddress,
      });
      relayerClient = cached.relayerClient;
    } else {
      // Create new RelayerClient if not cached (shouldn't happen normally, but handle gracefully)
      logger.info({
        message: 'Creating new RelayerClient for token approvals (cache miss)',
        privyUserId,
        embeddedWalletAddress: user.embeddedWalletAddress,
      });
      
      const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
      
      // Try to get walletId for user's wallet
      const { privyService } = await import('./privy.service');
      const walletId = await privyService.getWalletIdByAddress(privyUserId, user.embeddedWalletAddress);
      
      // Create viem wallet client with Privy signing
      const { wallet, builderConfig, signer } = await createViemWalletForRelayer(
        privyUserId,
        user.embeddedWalletAddress,
        walletId || undefined
      );

      relayerClient = new RelayClient(
        privyConfig.relayerUrl,
        privyConfig.chainId,
        wallet, // Pass viem WalletClient (RelayerClient expects this structure)
        builderConfig,
        RelayerTxType.SAFE // Specify Safe wallet type
      );
      
      // Cache it for future use
      relayerClientCache.set(privyUserId, {
        relayerClient,
        wallet,
        builderConfig,
        signer,
        walletId: walletId || undefined,
        embeddedWalletAddress: user.embeddedWalletAddress,
      });
    }

    // Create approval transactions (using viem for encoding)
    const approvalTxs = await createApprovalTransactions();
    
    // Execute all approvals
    const response = await relayerClient.execute(
      approvalTxs,
      'Token approvals for Polymarket trading'
    );
    
    const result = await response.wait();

    if (!result) {
      throw new Error('Token approval transactions failed');
    }

    logger.info({
      message: 'Token approvals completed',
      privyUserId,
      transactionHash: result.transactionHash,
    });

    // Update user profile to mark approvals as enabled
    try {
      // #region agent log
      ingestDebugLog({location:'wallet-deployment.service.ts:1720',message:'updating database approval statuses',data:{privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'});
      // #endregion
      const { updateUserTokenApprovals } = await import('./user.service');
      await updateUserTokenApprovals(privyUserId, true, true);
      // #region agent log
      fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'wallet-deployment.service.ts:1723',message:'database approval statuses updated successfully',data:{privyUserId,usdc:true,ctf:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
      // #endregion
      logger.info({
        message: 'Updated user token approval statuses',
        privyUserId,
        usdcApprovalEnabled: true,
        ctfApprovalEnabled: true,
      });
    } catch (updateError) {
      // #region agent log
      ingestDebugLog({location:'wallet-deployment.service.ts:1730',message:'failed to update database approval statuses',data:{privyUserId,error:updateError instanceof Error ? updateError.message : String(updateError)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'});
      // #endregion
      // Log error but don't fail the approval - approvals are on-chain
      logger.error({
        message: 'Failed to update user token approval statuses (non-critical)',
        privyUserId,
        error: updateError instanceof Error ? updateError.message : String(updateError),
      });
    }

    // #region agent log
    ingestDebugLog({location:'wallet-deployment.service.ts:1739',message:'setupTokenApprovals returning success',data:{success:true,transactionHash:result.transactionHash},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'});
    // #endregion
    return {
      success: true,
      transactionHashes: [result.transactionHash],
    };
  } catch (error) {
    logger.error({
      message: 'Failed to set up token approvals',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get user's wallet information
 * Returns both Polymarket (proxy) and Kalshi (Solana) addresses so the frontend
 * can display the appropriate one based on the poly/kalshi platform toggle.
 */
export async function getUserWalletInfo(privyUserId: string): Promise<{
  embeddedWalletAddress: string;
  proxyWalletAddress: string | null;
  solanaWalletAddress: string | null;
  hasApprovals: boolean;
} | null> {
  const user = await getUserByPrivyId(privyUserId);

  if (!user) {
    return null;
  }

  // TODO: Check on-chain if approvals are set
  // For now, assume approvals are set if proxy wallet exists
  const hasApprovals = !!user.proxyWalletAddress;

  return {
    embeddedWalletAddress: user.embeddedWalletAddress,
    proxyWalletAddress: user.proxyWalletAddress ?? null,
    solanaWalletAddress: user.solanaWalletAddress ?? null,
    hasApprovals,
  };
}
