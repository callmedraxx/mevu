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
import { privyConfig } from './privy.config';
import { privyService } from './privy.service';
import { createPrivySigner } from './privy-signer.adapter';
import { 
  createUser, 
  updateUserProxyWallet, 
  getUserByPrivyId,
  isUsernameAvailable,
} from './user.service';
import { CreateUserRequest, UserProfile } from './privy.types';

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
 * 5. Deploys a Gnosis Safe via Polymarket relayer
 * 6. Updates user record with proxy wallet address
 * 
 * @param privyUserId - The Privy user ID
 * @param username - Desired username
 * @param embeddedWalletAddress - Optional: The user's Privy embedded wallet address (if not provided, will be created/fetched)
 */
export async function registerUserAndDeployWallet(
  privyUserId: string,
  username: string
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

    try {
      const proxyWalletAddress = await deployProxyWallet(privyUserId, existingUser.embeddedWalletAddress);
      const updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
      
      if (!updatedUser) {
        throw new Error('Failed to update user with proxy wallet address');
      }

      return {
        user: updatedUser,
        proxyWalletAddress,
        embeddedWalletAddress: updatedUser.embeddedWalletAddress,
      };
    } catch (error) {
      // If deployment fails due to session signer, return user without proxy wallet
      const errorMessage = error instanceof Error ? error.message : String(error);
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
  const finalEmbeddedWalletAddress = await privyService.createEmbeddedWallet(privyUserId);
  logger.info({
    message: 'Got or created embedded wallet',
    privyUserId,
    walletAddress: finalEmbeddedWalletAddress,
  });

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

  // Step 5: Try to deploy proxy wallet via Polymarket relayer
  // NOTE: This requires session signer authorization. If it fails, registration still succeeds
  // User can deploy proxy wallet later via POST /api/users/:privyUserId/deploy-proxy-wallet
  let proxyWalletAddress: string | null = null;
  try {
    proxyWalletAddress = await deployProxyWallet(privyUserId, finalEmbeddedWalletAddress);
    
    // Step 6: Update user record with proxy wallet
    const updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);
    
    if (!updatedUser) {
      throw new Error('Failed to update user with proxy wallet address');
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
    // If proxy wallet deployment fails (e.g., session signer not authorized),
    // registration still succeeds - user can deploy later
    const errorMessage = error instanceof Error ? error.message : String(error);
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
async function createViemWalletForRelayer(
  privyUserId: string,
  embeddedWalletAddress: string
): Promise<{ wallet: any; builderConfig: any }> {
  // Create Privy signer adapter for signing
  const signer = createPrivySigner(privyUserId, embeddedWalletAddress);
  const signerAddress = await signer.getAddress();
  const normalizedAddress = signerAddress.toLowerCase() as `0x${string}`;
  
  // Import required modules
  const { createWalletClient, http, toHex } = await import('viem');
  const { polygon } = await import('viem/chains');
  const { BuilderConfig } = await import('@polymarket/builder-signing-sdk');
  
  // Create BuilderConfig with remote signing server
  const builderConfig = new BuilderConfig({
    remoteBuilderConfig: { url: privyConfig.builderSigningServerUrl },
  });
  
  // Create a viem account that uses Privy's signing methods
  // This is what RelayerClient expects - a viem WalletClient with an account
  const account = {
    address: normalizedAddress,
    type: 'local' as const,
    async signMessage({ message }: { message: string }) {
      const signature = await signer.signMessage(message);
      return signature as `0x${string}`;
    },
    async signTypedData({ domain, types, primaryType, message: messageData }: any) {
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
      return signature as `0x${string}`;
    },
  } as any;
  
  // Create viem wallet client - this is what RelayerClient expects
  const wallet = createWalletClient({
    account,
    chain: polygon,
    transport: http(privyConfig.rpcUrl),
  });
  
  return { wallet, builderConfig };
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
  embeddedWalletAddress: string
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
    
    const { wallet, builderConfig } = await createViemWalletForRelayer(privyUserId, embeddedWalletAddress);
    
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
    
    let relayerClient: any;
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
  const user = await getUserByPrivyId(privyUserId);
  
  if (!user) {
    throw new Error('User not found');
  }
  
  if (!user.proxyWalletAddress) {
    throw new Error('User does not have a proxy wallet');
  }

  logger.info({
    message: 'Setting up token approvals',
    privyUserId,
    proxyWalletAddress: user.proxyWalletAddress,
  });
  
  try {
    const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
    
    // Create viem wallet client with Privy signing
    const { wallet, builderConfig } = await createViemWalletForRelayer(
      privyUserId,
      user.embeddedWalletAddress
    );

    const relayerClient = new RelayClient(
      privyConfig.relayerUrl,
      privyConfig.chainId,
      wallet, // Pass viem WalletClient (RelayerClient expects this structure)
      builderConfig,
      RelayerTxType.SAFE // Specify Safe wallet type
    );

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
 */
export async function getUserWalletInfo(privyUserId: string): Promise<{
  embeddedWalletAddress: string;
  proxyWalletAddress: string | null;
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
    proxyWalletAddress: user.proxyWalletAddress,
    hasApprovals,
  };
}
