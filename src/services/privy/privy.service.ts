/**
 * Privy Service
 * Handles Privy server-side operations including session signer functionality
 * 
 * This service allows the backend to sign transactions on behalf of users
 * who have authorized session signers via the frontend.
 * 
 * Uses @privy-io/node SDK for all Privy API interactions.
 */

import { PrivyClient, type AuthorizationContext } from '@privy-io/node';
import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { privyConfig, validatePrivyConfig } from './privy.config';
import { 
  PrivyUser, 
  SignTypedDataRequest, 
  SignMessageRequest,
  EIP712TypedData,
} from './privy.types';

class PrivyService {
  private privyClient: PrivyClient | null = null;
  private client: AxiosInstance; // Keep for backward compatibility
  private initialized: boolean = false;
  private walletClient: AxiosInstance; // Keep for backward compatibility
  // In-memory lock to prevent concurrent wallet creation for the same user
  private walletCreationLocks = new Map<string, Promise<{ address: string; walletId?: string }>>();

  constructor() {
    // Keep axios clients for backward compatibility and fallback
    this.client = axios.create({
      baseURL: 'https://auth.privy.io',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    this.walletClient = axios.create({
      baseURL: 'https://api.privy.io',
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Initialize the Privy service
   * Validates configuration and sets up PrivyClient SDK.
   * Idempotent: safe to call multiple times.
   */
  initialize(): void {
    if (this.initialized) return;
    const validation = validatePrivyConfig();
    
    if (!validation.valid) {
      logger.warn({
        message: 'Privy configuration incomplete - some features will be unavailable',
        missingEnvVars: validation.missing,
      });
      return;
    }

    // Initialize PrivyClient SDK
    try {
      this.privyClient = new PrivyClient({
        appId: privyConfig.appId,
        appSecret: privyConfig.appSecret,
      });
      logger.info({ message: 'PrivyClient SDK initialized successfully' });
    } catch (error) {
      logger.error({
        message: 'Failed to initialize PrivyClient SDK',
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue with axios fallback
    }

    // Set up Basic Auth header for axios clients (fallback)
    const credentials = Buffer.from(`${privyConfig.appId}:${privyConfig.appSecret}`).toString('base64');
    this.client.defaults.headers.common['Authorization'] = `Basic ${credentials}`;
    this.client.defaults.headers.common['privy-app-id'] = privyConfig.appId;

    this.walletClient.defaults.headers.common['Authorization'] = `Basic ${credentials}`;
    this.walletClient.defaults.headers.common['privy-app-id'] = privyConfig.appId;

    this.initialized = true;
    logger.info({ message: 'Privy service initialized successfully' });
  }

  /**
   * Get authorization context for signing requests
   * Uses authorization private key if configured
   */
  private getAuthorizationContext(): AuthorizationContext | undefined {
    if (!privyConfig.authorizationPrivateKey) {
      return undefined;
    }

    return {
      authorization_private_keys: [privyConfig.authorizationPrivateKey],
    };
  }

  /**
   * Get wallet ID from wallet address
   * Fetches user's wallets and finds the one matching the address
   */
  async getWalletIdByAddress(userId: string, address: string): Promise<string | null> {
    logger.info({
      message: 'Getting wallet ID by address',
      userId,
      address,
      usingSDK: !!this.privyClient,
    });

    if (!this.privyClient) {
      // Fallback to axios
      try {
        const response = await this.client.get(`/api/v1/users/${userId}/wallets`);
        const wallets = response.data?.wallets || response.data || [];
        
        logger.debug({
          message: 'Fetched wallets via axios',
          userId,
          walletCount: Array.isArray(wallets) ? wallets.length : 0,
          wallets: Array.isArray(wallets) ? wallets.map((w: any) => ({
            id: w?.id,
            address: w?.address,
            type: w?.type,
            walletClientType: w?.walletClientType || w?.wallet_client_type,
          })) : [],
        });
        
        const normalizedAddress = address.toLowerCase();
        const wallet = Array.isArray(wallets) ? wallets.find((w: any) => {
          const walletAddress = w?.address || w?.wallet_address;
          return walletAddress && walletAddress.toLowerCase() === normalizedAddress;
        }) : null;
        
        if (wallet) {
          logger.info({
            message: 'Found wallet ID via axios',
            userId,
            address,
            walletId: wallet.id || wallet.wallet_id,
          });
          return wallet.id || wallet.wallet_id || null;
        }
        
        logger.warn({
          message: 'Wallet not found in wallets list',
          userId,
          address,
          availableAddresses: Array.isArray(wallets) ? wallets.map((w: any) => w?.address || w?.wallet_address).filter(Boolean) : [],
        });
        
        return null;
      } catch (error) {
        logger.error({
          message: 'Error fetching wallet ID via axios',
          userId,
          address,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    try {
      // Try SDK - method name may vary by version
      const usersService = this.privyClient.users();
      const user = await (usersService as any).getUser?.(userId);
      if (user) {
        const linkedAccounts = user.linkedAccounts || user.linked_accounts || [];
        const normalizedAddress = address.toLowerCase();
        
        logger.debug({
          message: 'Checking linked accounts from SDK user',
          userId,
          address,
          linkedAccountsCount: Array.isArray(linkedAccounts) ? linkedAccounts.length : 0,
          linkedAccounts: Array.isArray(linkedAccounts) ? linkedAccounts.map((acc: any) => ({
            id: acc?.id,
            walletId: acc?.walletId,
            type: acc?.type,
            walletClientType: acc?.walletClientType || acc?.wallet_client_type,
            address: acc?.address,
            allKeys: Object.keys(acc || {}),
          })) : [],
        });
        
        const wallet = Array.isArray(linkedAccounts) ? linkedAccounts.find((account: any) => {
          const accountAddress = account?.address || account?.wallet_address;
          return accountAddress && accountAddress.toLowerCase() === normalizedAddress;
        }) : null;
        
        if (wallet) {
          // Try multiple possible ID field names
          const walletId = wallet.id || wallet.walletId || wallet.wallet_id || wallet.accountId;
          logger.info({
            message: 'Found wallet ID via SDK from linkedAccounts',
            userId,
            address,
            walletId,
            walletKeys: Object.keys(wallet),
          });
          return walletId || null;
        }
      }
    } catch (error) {
      // Fall through to axios if SDK fails
      logger.warn({
        message: 'Error fetching wallet ID via SDK, falling back to axios',
        userId,
        address,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    
    // Fallback: Try to get wallet ID from user's linkedAccounts via axios
    try {
      logger.info({
        message: 'Fetching user via axios to get wallet ID from linkedAccounts',
        userId,
        address,
      });
      
      const userResponse = await this.client.get(`/api/v1/users/${userId}`);
      const user = userResponse.data;
      const linkedAccounts = user?.linkedAccounts || user?.linked_accounts || [];
      const normalizedAddress = address.toLowerCase();
      
      logger.debug({
        message: 'Fetched user via axios, checking linkedAccounts',
        userId,
        linkedAccountsCount: Array.isArray(linkedAccounts) ? linkedAccounts.length : 0,
        linkedAccounts: Array.isArray(linkedAccounts) ? linkedAccounts.map((acc: any) => ({
          id: acc?.id,
          walletId: acc?.walletId,
          type: acc?.type,
          walletClientType: acc?.walletClientType || acc?.wallet_client_type,
          address: acc?.address,
          allKeys: Object.keys(acc || {}).slice(0, 10), // First 10 keys for debugging
        })) : [],
      });
      
      const wallet = Array.isArray(linkedAccounts) ? linkedAccounts.find((account: any) => {
        const accountAddress = account?.address || account?.wallet_address;
        return accountAddress && accountAddress.toLowerCase() === normalizedAddress;
      }) : null;
      
      if (wallet) {
        // Try multiple possible ID field names
        const walletId = wallet.id || wallet.walletId || wallet.wallet_id || wallet.accountId;
        logger.info({
          message: 'Found wallet ID via axios from linkedAccounts',
          userId,
          address,
          walletId,
          walletKeys: Object.keys(wallet).slice(0, 10),
        });
        return walletId || null;
      }
      
      logger.warn({
        message: 'Wallet not found in linkedAccounts',
        userId,
        address,
        availableAddresses: Array.isArray(linkedAccounts) ? linkedAccounts.map((acc: any) => acc?.address || acc?.wallet_address).filter(Boolean) : [],
      });
      
      return null;
    } catch (error) {
      logger.error({
        message: 'Error fetching wallet ID via axios',
        userId,
        address,
        error: error instanceof Error ? error.message : String(error),
        status: (error as any)?.response?.status,
      });
      return null;
    }
  }

  /**
   * Check if service is properly initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get a Privy user by their ID
   * Uses Privy SDK if available, falls back to axios
   */
  async getUser(userId: string): Promise<PrivyUser | null> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    try {
      // Use SDK if available
      if (this.privyClient) {
        try {
          const usersService = this.privyClient.users();
          const user = await (usersService as any).getUser?.(userId);
          if (user) {
            return user as any; // Convert SDK user to our PrivyUser type
          }
        } catch (error: any) {
          if (error?.status === 404 || error?.response?.status === 404) {
            return null;
          }
          // Fall through to axios if SDK fails
        }
      }

      // Fallback to axios
      const response = await this.client.get(`/api/v1/users/${userId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      
      // Handle SDK errors
      if (error && typeof error === 'object' && 'status' in error && (error as any).status === 404) {
        return null;
      }
      
      logger.error({
        message: 'Error fetching Privy user',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the embedded wallet address for a user
   * Handles different Privy API response formats and wallet types
   */
  async getEmbeddedWalletAddress(userId: string): Promise<string | null> {
    try {
      const user = await this.getUser(userId);
      if (!user) {
        logger.warn({
          message: 'User not found in Privy',
          userId,
        });
        return null;
      }

      // Handle different response formats - check multiple possible field names
      const userAny = user as any;
      let linkedAccounts: any[] = [];
      
      // Try different possible field names for linked accounts
      if (Array.isArray(userAny?.linkedAccounts)) {
        linkedAccounts = userAny.linkedAccounts;
      } else if (Array.isArray(userAny?.linked_accounts)) {
        linkedAccounts = userAny.linked_accounts;
      } else if (Array.isArray(userAny?.wallets)) {
        linkedAccounts = userAny.wallets;
      }

      if (!Array.isArray(linkedAccounts) || linkedAccounts.length === 0) {
        logger.warn({
          message: 'No linked accounts found in Privy user response',
          userId,
          userKeys: Object.keys(userAny || {}),
        });
        return null;
      }

      logger.debug({
        message: 'Found linked accounts',
        userId,
        accountCount: linkedAccounts.length,
        accountTypes: linkedAccounts.map((acc: any) => ({
          type: acc?.type || acc?.account_type,
          walletClientType: acc?.walletClientType || acc?.wallet_client_type,
          address: acc?.address,
        })),
      });

      // Try multiple filters to find embedded wallet
      // 1. Type = wallet AND walletClientType = privy (most common)
      let embeddedWallet = linkedAccounts.find((account: any) => {
        const type = account?.type || account?.account_type;
        const walletClientType = account?.walletClientType || account?.wallet_client_type;
        return type === 'wallet' && walletClientType === 'privy';
      });

      // 2. If not found, try just walletClientType = privy
      if (!embeddedWallet) {
        embeddedWallet = linkedAccounts.find((account: any) => {
          const walletClientType = account?.walletClientType || account?.wallet_client_type;
          return walletClientType === 'privy';
        });
      }

      // 3. If still not found, try type = wallet (might be embedded wallet)
      if (!embeddedWallet) {
        embeddedWallet = linkedAccounts.find((account: any) => {
          const type = account?.type || account?.account_type;
          return type === 'wallet';
        });
      }

      // 4. If still not found, check if there's a wallet with address (fallback)
      if (!embeddedWallet && linkedAccounts.length > 0) {
        // Look for any account with an address that looks like a wallet
        embeddedWallet = linkedAccounts.find((account: any) => {
          const address = account?.address || account?.wallet_address;
          return address && /^0x[a-fA-F0-9]{40}$/.test(address);
        });
      }

      if (embeddedWallet) {
        const address = embeddedWallet.address || embeddedWallet.wallet_address;
        logger.info({
          message: 'Found embedded wallet',
          userId,
          walletAddress: address,
          walletType: embeddedWallet?.type || embeddedWallet?.account_type,
          walletClientType: embeddedWallet?.walletClientType || embeddedWallet?.wallet_client_type,
        });
        return address || null;
      }

      logger.warn({
        message: 'No embedded wallet found in linked accounts',
        userId,
        linkedAccountsCount: linkedAccounts.length,
      });

      return null;
    } catch (error) {
      logger.error({
        message: 'Error getting embedded wallet address',
        userId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return null;
    }
  }

  /**
   * Sign a message using the user's embedded wallet via session signer
   * 
   * Uses Privy SDK with AuthorizationContext for signing.
   */
  async signMessage(request: SignMessageRequest): Promise<string> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    try {
      // Try to use SDK if available
      if (this.privyClient) {
        // Use provided walletId if available, otherwise look it up
        let walletId = request.walletId;
        
        if (!walletId) {
          const embeddedWalletAddress = await this.getEmbeddedWalletAddress(request.userId);
          if (embeddedWalletAddress) {
            walletId = await this.getWalletIdByAddress(request.userId, embeddedWalletAddress) || undefined;
          }
        }
        
        if (walletId) {
          logger.info({
            message: 'Signing message with walletId',
            userId: request.userId,
            walletId,
            walletIdSource: request.walletId ? 'provided' : 'looked up',
          });
          
          const authorizationContext = this.getAuthorizationContext();
          const response = await this.privyClient.wallets().ethereum().signMessage(walletId, {
            message: request.message,
            authorization_context: authorizationContext,
          });
          
          // Normalize signature format for downstream consumers (RelayerClient expects 0x-prefixed hex string)
          const rawSignature = (response as any)?.signature;
          
          logger.info({
            message: 'Received signature from Privy signMessage',
            userId: request.userId,
            walletId,
            signatureType: typeof rawSignature,
            isString: typeof rawSignature === 'string',
            isObject: typeof rawSignature === 'object',
            hasRaw: rawSignature && typeof rawSignature === 'object' && 'raw' in rawSignature,
          });
          
          if (typeof rawSignature === 'string') {
            // Already a hex string
            return rawSignature;
          }
          
          if (rawSignature && typeof rawSignature === 'object' && 'raw' in rawSignature) {
            try {
              // raw might be a Uint8Array or an object with numeric keys (JSON-serialized Uint8Array)
              const rawValue = (rawSignature as any).raw;
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
              
              // Convert to 0x-prefixed hex string
              const hexSignature = ethers.utils.hexlify(bytes);
              
              logger.info({
                message: 'Normalized Privy signature from raw format',
                userId: request.userId,
                walletId,
                signatureLength: bytes.length,
              });
              
              return hexSignature;
            } catch (convertError) {
              logger.error({
                message: 'Failed to convert Privy signature to hex string',
                userId: request.userId,
                walletId,
                signatureType: typeof rawSignature,
                signatureKeys: Object.keys(rawSignature),
                rawValueType: typeof (rawSignature as any)?.raw,
                rawValueKeys: (rawSignature as any)?.raw ? Object.keys((rawSignature as any).raw) : [],
                convertError: convertError instanceof Error ? convertError.message : String(convertError),
              });
              // Fall through to generic handling below
            }
          }
          
          // Fallback: stringify whatever we got, but this is unexpected
          logger.warn({
            message: 'Privy signMessage returned unexpected signature format',
            userId: request.userId,
            walletId,
            rawSignature,
          });
          return String(rawSignature);
        }
      }

      // Fallback to axios
      const response = await this.client.post('/api/v1/wallets/rpc', {
        user_id: request.userId,
        chain_type: 'ethereum',
        method: 'personal_sign',
        params: {
          message: request.message,
        },
      });

      return response.data.signature;
    } catch (error) {
      logger.error({
        message: 'Error signing message via Privy',
        userId: request.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sign EIP-712 typed data using the user's embedded wallet via session signer
   * 
   * This is used for signing Polymarket orders and other structured data.
   * Uses Privy SDK with AuthorizationContext for signing.
   */
  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    try {
      // Try to use SDK if available
      if (this.privyClient) {
        // Get wallet ID - use provided walletId if available, otherwise look it up
        let walletId = request.walletId;
        
        if (!walletId) {
          // Get wallet ID from user's embedded wallet
          const embeddedWalletAddress = await this.getEmbeddedWalletAddress(request.userId);
          if (embeddedWalletAddress) {
            const lookedUpId = await this.getWalletIdByAddress(request.userId, embeddedWalletAddress);
            walletId = lookedUpId ?? undefined;
          }
        }
        
        if (walletId) {
            // Use SDK to sign with authorization context
            // Try authorization private key first (most reliable)
            let authorizationContext = this.getAuthorizationContext();
            
            logger.info({
              message: 'Checking authorization context for signing',
              userId: request.userId,
              walletId,
              hasAuthContext: !!authorizationContext,
              hasAuthKeys: !!(authorizationContext?.authorization_private_keys?.length),
              authKeyLength: authorizationContext?.authorization_private_keys?.length || 0,
              hasPrivyConfigAuthKey: !!privyConfig.authorizationPrivateKey,
            });
            
            // If no auth key, we can't sign (session signers require user JWT)
            if (!authorizationContext || !authorizationContext.authorization_private_keys?.length) {
              logger.warn({
                message: 'No authorization private key available for signing',
                userId: request.userId,
                walletId,
                privyConfigHasAuthKey: !!privyConfig.authorizationPrivateKey,
              });
              // Fall through to RPC endpoint which might work with session signers
            } else {
              logger.info({
                message: 'Signing typed data via Privy SDK with authorization private key',
                userId: request.userId,
                walletId,
                hasAuthContext: !!authorizationContext,
              });
              
              // Use Privy SDK's wallets().ethereum().signTypedData() method
              // This follows Privy's documentation for signing typed data with authorization context
              logger.info({
                message: 'Using Privy SDK wallets().ethereum().signTypedData() for signing typed data',
                userId: request.userId,
                walletId,
              });
              
              try {
                if (!this.privyClient) {
                  throw new Error('PrivyClient SDK not initialized');
                }
                
                // Use SDK's wallets().ethereum().signTypedData() method
                // This handles authorization signature generation automatically
                const ethereumWallets = this.privyClient.wallets().ethereum();
                
                // Get embedded wallet address for logging
                const embeddedWalletAddress = await this.getEmbeddedWalletAddress(request.userId);
                
                logger.info({
                  message: 'Calling Privy SDK wallets().ethereum().signTypedData()',
                  userId: request.userId,
                  walletId,
                  address: embeddedWalletAddress,
                });
                
                // Use the SDK's signTypedData method with authorization context
                // Following Privy's instructions: pass authorization_context inside the options object
                // Format: signTypedData(walletId, { params: { typed_data }, authorization_context })
                const response = await ethereumWallets.signTypedData(
                  walletId,
                  {
                    params: {
                      typed_data: {
                        domain: request.typedData.domain as any, // SDK expects flexible domain format
                        types: request.typedData.types,
                        primary_type: request.typedData.primaryType, // Note: snake_case for SDK params
                        message: request.typedData.message,
                      },
                    },
                    authorization_context: authorizationContext, // Pass as part of options object per Privy docs
                  }
                );
                
                // Normalize signature format for downstream consumers (RelayerClient expects 0x-prefixed hex string)
                const rawSignature = (response as any)?.signature;
                
                logger.info({
                  message: 'Received signature from Privy signTypedData',
                  userId: request.userId,
                  walletId,
                  signatureType: typeof rawSignature,
                  isString: typeof rawSignature === 'string',
                  isObject: typeof rawSignature === 'object',
                  hasRaw: rawSignature && typeof rawSignature === 'object' && 'raw' in rawSignature,
                });
                
                if (typeof rawSignature === 'string') {
                  // Already a hex string
                  return rawSignature;
                }
                
                if (rawSignature && typeof rawSignature === 'object' && 'raw' in rawSignature) {
                  try {
                    // raw might be a Uint8Array or an object with numeric keys (JSON-serialized Uint8Array)
                    const rawValue = (rawSignature as any).raw;
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
                    
                    // Convert to 0x-prefixed hex string
                    const hexSignature = ethers.utils.hexlify(bytes);
                    
                    logger.info({
                      message: 'Normalized Privy typed data signature from raw format',
                      userId: request.userId,
                      walletId,
                      signatureLength: bytes.length,
                    });
                    
                    return hexSignature;
                  } catch (convertError) {
                    logger.error({
                      message: 'Failed to convert Privy signature to hex string',
                      userId: request.userId,
                      walletId,
                      signatureType: typeof rawSignature,
                      signatureKeys: Object.keys(rawSignature),
                      rawValueType: typeof (rawSignature as any)?.raw,
                      rawValueKeys: (rawSignature as any)?.raw ? Object.keys((rawSignature as any).raw) : [],
                      convertError: convertError instanceof Error ? convertError.message : String(convertError),
                    });
                    // Fall through to generic handling below
                  }
                }
                
                // Fallback: stringify whatever we got, but this is unexpected
                logger.warn({
                  message: 'Privy signTypedData returned unexpected signature format',
                  userId: request.userId,
                  walletId,
                  rawSignature,
                });
                return String(rawSignature);
              } catch (signError: any) {
                logger.error({
                  message: 'Privy SDK signTypedData failed',
                  userId: request.userId,
                  walletId,
                  error: signError.message,
                  status: signError?.response?.status,
                  responseData: signError?.response?.data,
                  errorName: signError?.name,
                  stack: signError?.stack,
                });
                throw new Error(`Sign typed data failed: ${signError.message}`);
              }
            }
          }
        }

      // Fallback to direct RPC endpoint if SDK not available
      // Note: This requires session signers to be enabled
      logger.info({
        message: 'Using direct RPC endpoint for signing typed data',
        userId: request.userId,
      });
      
      const response = await this.client.post('/api/v1/wallets/rpc', {
        user_id: request.userId,
        chain_type: 'ethereum',
        method: 'eth_signTypedData_v4',
        params: {
          typed_data: {
            domain: request.typedData.domain,
            types: request.typedData.types,
            primaryType: request.typedData.primaryType,
            message: request.typedData.message,
          },
        },
      });

      return response.data.signature;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Provide more helpful error messages for common cases
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const responseData = error.response?.data;
        
        if (status === 401) {
          const helpfulError = new Error('Session signer not authorized. User must authorize a session signer on the frontend before the backend can sign transactions.');
          logger.error({
            message: 'Privy authentication failed - session signer not authorized',
            userId: request.userId,
            status,
            responseData,
          });
          throw helpfulError;
        }
        
        logger.error({
          message: 'Error signing typed data via Privy',
          userId: request.userId,
          status,
          responseData,
          error: errorMessage,
        });
      } else {
        logger.error({
          message: 'Error signing typed data via Privy',
          userId: request.userId,
          error: errorMessage,
        });
      }
      
      throw error;
    }
  }

  /**
   * Add session signer to a user's wallet using Privy SDK
   * 
   * @param userId - The Privy user ID
   * @param walletAddress - The embedded wallet address
   * @param signerId - The authorization key quorum ID (from Privy Dashboard)
   * @param policyIds - Optional policy IDs to apply to the signer
   * @param userJwt - Optional user JWT token for signing the wallet update (required if wallet owner must sign)
   */
  async addSessionSigner(
    userId: string,
    walletAddress: string,
    signerId: string,
    policyIds?: string[],
    userJwt?: string,
    walletId?: string // Optional: walletId to avoid lookup if already known
  ): Promise<void> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    if (!this.privyClient) {
      throw new Error('PrivyClient SDK not initialized. Please ensure PRIVY_APP_ID and PRIVY_APP_SECRET are set.');
    }

    try {
      // Get wallet ID from address (or use provided walletId)
      let finalWalletId: string | undefined;
      
      if (walletId) {
        logger.info({
          message: 'addSessionSigner: Using provided wallet ID',
          userId,
          walletAddress,
          walletId,
        });
        finalWalletId = walletId;
      } else {
        logger.info({
          message: 'addSessionSigner: Getting wallet ID from address',
          userId,
          walletAddress,
        });
        const lookedUpId = await this.getWalletIdByAddress(userId, walletAddress);
        finalWalletId = lookedUpId ?? undefined;
      }
      
      logger.info({
        message: 'addSessionSigner: Wallet ID lookup result',
        userId,
        walletAddress,
        walletId: finalWalletId || 'NOT FOUND',
      });
      
      if (!finalWalletId) {
        // Try to get more info about what wallets exist
        try {
          const user = await this.getUser(userId);
          const walletsResponse = await this.client.get(`/api/v1/users/${userId}/wallets`);
          const wallets = walletsResponse.data?.wallets || walletsResponse.data || [];
          
          logger.error({
            message: 'Wallet ID not found - available wallets',
            userId,
            targetAddress: walletAddress,
            availableWallets: Array.isArray(wallets) ? wallets.map((w: any) => ({
              id: w?.id,
              address: w?.address || w?.wallet_address,
              type: w?.type,
              chainType: w?.chainType || w?.chain_type,
            })) : [],
            userLinkedAccounts: (user as any)?.linkedAccounts?.length || (user as any)?.linked_accounts?.length || 0,
          });
        } catch (debugError) {
          logger.error({
            message: 'Failed to get debug info',
            userId,
            error: debugError instanceof Error ? debugError.message : String(debugError),
          });
        }
        
        throw new Error(`Wallet not found for address ${walletAddress}`);
      }

      // Build authorization context for signing the update request
      // Try authorization private key first (most reliable), then user JWT
      let authorizationContext: AuthorizationContext | undefined;
      
      // First, try authorization private key (if configured)
      const authKeyContext = this.getAuthorizationContext();
      if (authKeyContext && authKeyContext.authorization_private_keys?.length) {
        authorizationContext = authKeyContext;
        logger.info({
          message: 'Using authorization private key for wallet update',
          userId,
          walletAddress,
        });
      } else if (userJwt) {
        // Fallback to user JWT if no auth key
        authorizationContext = {
          user_jwts: [userJwt],
        };
        logger.info({
          message: 'Using user JWT for wallet update',
          userId,
          walletAddress,
          hasJwt: !!userJwt,
        });
      } else {
        throw new Error('Either userJwt or PRIVY_AUTHORIZATION_PRIVATE_KEY must be provided to sign the wallet update request.');
      }

      // Get current wallet to see existing signers
      // Try SDK first, fallback to REST API
      let wallet: any;
      
      try {
        const walletsService = this.privyClient.wallets();
        
        // Try SDK method
        wallet = await (walletsService as any).getWallet?.(finalWalletId, {
          authorization_context: authorizationContext,
        }) || await (walletsService as any).getWallet?.(finalWalletId, authorizationContext);
        
        if (!wallet) {
          throw new Error('SDK returned undefined');
        }
      } catch (sdkError) {
        logger.warn({
          message: 'SDK getWallet failed, trying REST API',
          walletId: finalWalletId,
          error: sdkError instanceof Error ? sdkError.message : String(sdkError),
        });
        
        // Fallback to REST API - but REST API requires signed requests
        // For now, if SDK fails, assume no existing signers
        logger.warn({
          message: 'SDK getWallet failed, assuming no existing signers',
          walletId: finalWalletId,
          error: sdkError instanceof Error ? sdkError.message : String(sdkError),
        });
        wallet = { additional_signers: [] };
      }
      
      logger.info({
        message: 'Wallet retrieved',
        userId,
        walletId: finalWalletId,
        hasWallet: !!wallet,
        hasAdditionalSigners: !!(wallet as any)?.additional_signers,
        existingSignerCount: Array.isArray((wallet as any)?.additional_signers) ? (wallet as any).additional_signers.length : 0,
      });

      // Build additional_signers array - SDK uses snake_case
      // Privy API only accepts signer_id, not policy_ids
      // Handle case where wallet might be undefined
      const existingSigners = (wallet && (wallet as any).additional_signers) 
        ? ((wallet as any).additional_signers as Array<{signer_id: string}>)
        : [];
      const newSigner = {
        signer_id: signerId,
        // Note: policyIds parameter is ignored - Privy API doesn't support policy_ids field
      };

      // Check if signer already exists
      const signerExists = existingSigners.some((s: any) => (s.signer_id || s.signerId) === signerId);
      if (signerExists) {
        logger.info({
          message: 'Session signer already exists',
          userId,
          walletAddress,
          signerId,
        });
        return;
      }

      // Add new signer - ensure all signers use snake_case format
      // Privy API doesn't accept policy_ids field, so we only include signer_id
      const updatedSigners = [
        ...existingSigners.map((s: any) => ({
          signer_id: s.signer_id || s.signerId,
          // Note: Privy API doesn't support policy_ids, so we omit it
        })),
        newSigner,
      ];

      // Update wallet with new session signer
      logger.info({
        message: 'Updating wallet with session signer',
        userId,
        walletId: finalWalletId,
        signerId,
        hasAuthContext: !!authorizationContext,
        authContextType: authorizationContext?.authorization_private_keys ? 'private_key' : authorizationContext?.user_jwts ? 'user_jwt' : 'none',
      });

      const walletsService = this.privyClient.wallets();
      
      // Try SDK update method - pass authorization_context as third parameter
      try {
        // Method 1: Try update with authorization_context as third param
        const updateResult = await (walletsService as any).update?.(
          finalWalletId,
          {
            additional_signers: updatedSigners,
          },
          authorizationContext
        );
        
        if (updateResult) {
          logger.info({
            message: 'Wallet updated successfully via SDK update method',
            userId,
            walletId: finalWalletId,
          });
          return;
        }
      } catch (sdkError1: any) {
        logger.warn({
          message: 'SDK update method failed, trying updateWallet',
          error: sdkError1.message,
          status: sdkError1?.response?.status,
        });
        
        // Method 2: Try updateWallet with authorization_context
        try {
          await (walletsService as any).updateWallet?.(
            finalWalletId,
            {
              additional_signers: updatedSigners,
              authorization_context: authorizationContext,
            }
          );
          logger.info({
            message: 'Wallet updated successfully via SDK updateWallet method',
            userId,
            walletId: finalWalletId,
          });
          return;
        } catch (sdkError2: any) {
          logger.error({
            message: 'Both SDK methods failed',
            error1: sdkError1.message,
            error2: sdkError2.message,
            status1: sdkError1?.response?.status,
            status2: sdkError2?.response?.status,
            response1: sdkError1?.response?.data,
            response2: sdkError2?.response?.data,
          });
          throw sdkError2; // Throw the last error
        }
      }

      logger.info({
        message: 'Session signer added successfully',
        userId,
        walletAddress,
        walletId: finalWalletId,
        signerId,
        policyIds,
      });
    } catch (error) {
      logger.error({
        message: 'Error adding session signer',
        userId,
        walletAddress,
        signerId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Verify that a user has an active session signer
   * Returns true if the backend can sign on behalf of the user
   */
  async hasActiveSessionSigner(userId: string): Promise<boolean> {
    if (!this.initialized) {
      return false;
    }

    try {
      // Try to get wallet info - if session signer is active, this will succeed
      const response = await this.client.get(`/api/v1/users/${userId}/wallets`);
      
      // Check if any wallet has delegated access enabled
      const wallets = response.data?.wallets || [];
      return wallets.some((wallet: any) => wallet.delegated === true);
    } catch (error) {
      logger.warn({
        message: 'Could not verify session signer status',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Create an embedded wallet for a user
   * Uses Privy SDK if available, falls back to axios
   * 
   * @param userId - The Privy user ID
   * @returns The wallet address
   */
  async createEmbeddedWallet(userId: string): Promise<{ address: string; walletId?: string }> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    // Check if there's already a wallet creation in progress for this user
    const existingLock = this.walletCreationLocks.get(userId);
    if (existingLock) {
      logger.info({
        message: 'Wallet creation already in progress, waiting for existing request',
        userId,
      });
      return existingLock;
    }

    // Create a new promise for this wallet creation
    const creationPromise = (async (): Promise<{ address: string; walletId?: string }> => {
      try {
        // First, check if user already has an embedded wallet
        logger.info({
          message: 'Checking for existing embedded wallet',
          userId,
        });

        const existingWallet = await this.getEmbeddedWalletAddress(userId);
        if (existingWallet) {
          logger.info({
            message: 'User already has embedded wallet, returning existing address',
            userId,
            walletAddress: existingWallet,
          });
          // Try to get walletId for existing wallet
          const existingWalletId = await this.getWalletIdByAddress(userId, existingWallet);
          return { address: existingWallet, walletId: existingWalletId || undefined };
        }

        // Use SDK if available
        if (this.privyClient) {
          try {
            const walletsService = this.privyClient.wallets();
            
            // Build wallet creation request with app as additional signer
            // According to Privy NodeJS SDK docs: wallets().create({chain_type, owner, additional_signers})
            const createRequest: any = {
              chain_type: 'ethereum',
              owner: {
                user_id: userId,
              },
            };
            
            // Add app as additional signer if signer ID is configured
            if (privyConfig.defaultSignerId) {
              createRequest.additional_signers = [
                {
                  signer_id: privyConfig.defaultSignerId,
                },
              ];
              logger.info({
                message: 'Creating wallet via SDK with app as additional signer',
                userId,
                signerId: privyConfig.defaultSignerId,
              });
            }
            
            // Use SDK wallets().create() method
            const wallet = await walletsService.create(createRequest);
            
            if (!wallet || !wallet.address) {
              throw new Error('Wallet creation returned invalid response');
            }

            logger.info({
              message: 'Wallet created successfully via SDK',
              userId,
              walletAddress: wallet.address,
              walletId: wallet.id,
              hasAdditionalSigners: !!(wallet.additional_signers?.length),
              additionalSigners: wallet.additional_signers,
            });

            return { address: wallet.address, walletId: wallet.id };
          } catch (error: any) {
            // Handle SDK errors - fall through to REST API fallback
            logger.warn({
              message: 'SDK wallet creation failed, falling back to REST API',
              userId,
              error: error.message,
              status: error?.response?.status,
            });
            // Continue to REST API fallback below
          }
        }

        // Fallback to REST API if SDK not available or failed
        logger.info({
          message: 'Creating wallet via Privy REST API',
          userId,
        });

        // Build request body with app as additional signer
        const requestBody: any = {
          chain_type: 'ethereum',
          owner: {
            user_id: userId,
          },
        };
        
        // Add app as additional signer if signer ID is configured
        if (privyConfig.defaultSignerId) {
          requestBody.additional_signers = [
            {
              signer_id: privyConfig.defaultSignerId,
            },
          ];
          logger.info({
            message: 'Creating wallet via REST API with app as additional signer',
            userId,
            signerId: privyConfig.defaultSignerId,
          });
        }

        const response = await this.walletClient.post('/v1/wallets', requestBody);

        const walletAddress = response.data?.address;

        if (!walletAddress) {
          logger.error({
            message: 'Wallet address not found in Privy response',
            userId,
            responseData: response.data,
          });
          throw new Error('Wallet address not found in Privy response');
        }

        logger.info({
          message: 'Wallet created successfully',
          userId,
          walletAddress,
          walletId: response.data?.id,
        });

        return { address: walletAddress, walletId: response.data?.id };
      } catch (error) {
        logger.error({
          message: 'Error creating wallet via Privy',
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        
        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const responseData = error.response?.data;
          
          // Handle specific error cases
          if (status === 404) {
            throw new Error('User not found in Privy. Please ensure the user exists.');
          }
          if (status === 409) {
            const walletAddress = responseData?.wallet?.address || responseData?.address;
            if (walletAddress) {
              return walletAddress;
            }
            throw new Error('Wallet already exists for this user. Please use the existing wallet.');
          }

          const errorMessage = responseData?.error || responseData?.message || error.message;
          throw new Error(errorMessage || `Failed to create wallet (HTTP ${status})`);
        }
        
        throw error;
      } finally {
        // Remove the lock when done (success or failure)
        this.walletCreationLocks.delete(userId);
      }
    })();

    // Store the promise as a lock
    this.walletCreationLocks.set(userId, creationPromise);
    
    return creationPromise;
  }

  /**
   * Send a transaction from an embedded wallet with gas sponsorship
   * Uses Privy SDK to execute transactions with gas sponsorship enabled
   * 
   * @param userId - The Privy user ID
   * @param walletAddress - The embedded wallet address
   * @param transaction - Transaction details (to, data, value)
   * @param options - Options including gas sponsorship
   * @returns Transaction hash
   */
  async sendTransaction(
    userId: string,
    walletAddress: string,
    transaction: {
      to: string;
      data?: string;
      value?: string;
    },
    options?: {
      sponsor?: boolean; // Enable gas sponsorship (default: true)
    }
  ): Promise<{ hash: string }> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    if (!this.privyClient) {
      throw new Error('PrivyClient SDK not initialized');
    }

    // Get wallet ID from address
    const walletId = await this.getWalletIdByAddress(userId, walletAddress);
    if (!walletId) {
      throw new Error(`Wallet not found for address ${walletAddress}`);
    }

    const authorizationContext = this.getAuthorizationContext();
    if (!authorizationContext) {
      throw new Error('Authorization private key not configured. Set PRIVY_AUTHORIZATION_PRIVATE_KEY.');
    }

    // Default to gas sponsorship enabled
    const sponsorGas = options?.sponsor !== false;

    logger.info({
      message: '[AUTO-TRANSFER-FLOW] Sending transaction via Privy SDK',
      flowStep: 'PRIVY_SEND_TX',
      userId,
      walletAddress,
      walletId,
      to: transaction.to,
      hasData: !!transaction.data,
      hasValue: !!transaction.value,
      sponsorGas,
    });

    try {
      const ethereumWallets = this.privyClient.wallets().ethereum();
      
      // Build transaction request
      const txRequest: any = {
        to: transaction.to,
      };
      
      if (transaction.data) {
        txRequest.data = transaction.data;
      }
      
      if (transaction.value) {
        // Convert to hex if not already
        txRequest.value = transaction.value.startsWith('0x') 
          ? transaction.value 
          : '0x' + BigInt(transaction.value).toString(16);
      }

      // Send transaction with gas sponsorship
      // caip2 format for Polygon mainnet: eip155:137
      const response = await ethereumWallets.sendTransaction(
        walletId,
        {
          params: {
            transaction: txRequest,
          },
          caip2: 'eip155:137', // Polygon mainnet chain ID in CAIP-2 format
          authorization_context: authorizationContext,
          sponsor: sponsorGas, // Enable gas sponsorship
        }
      );

      const txHash = (response as any)?.hash || (response as any)?.transactionHash;
      
      if (!txHash) {
        logger.error({
          message: '[AUTO-TRANSFER-FLOW] Transaction response missing hash',
          flowStep: 'PRIVY_SEND_TX_NO_HASH',
          userId,
          walletId,
          response,
        });
        throw new Error('Transaction response missing hash');
      }

      logger.info({
        message: '[AUTO-TRANSFER-FLOW] Transaction sent successfully via Privy SDK',
        flowStep: 'PRIVY_SEND_TX_SUCCESS',
        userId,
        walletId,
        txHash,
        sponsorGas,
        polygonscanUrl: `https://polygonscan.com/tx/${txHash}`,
      });

      return { hash: txHash };
    } catch (error: any) {
      logger.error({
        message: '[AUTO-TRANSFER-FLOW] ❌ Privy sendTransaction FAILED',
        flowStep: 'PRIVY_SEND_TX_FAILED',
        userId,
        walletId,
        error: error.message,
        status: error?.response?.status,
        responseData: error?.response?.data,
        troubleshooting: [
          'Check if gas sponsorship is enabled in Privy dashboard',
          'Check if gas sponsorship has credits ($10 minimum)',
          'Check if Polygon (eip155:137) is enabled for sponsorship',
          'Check if TEE is enabled for wallets',
          'Check if PRIVY_AUTHORIZATION_PRIVATE_KEY is correct',
          'Verify the wallet exists and belongs to the user',
        ],
      });
      throw error;
    }
  }

  /**
   * Get the Solana embedded wallet address for a user
   * Similar to getEmbeddedWalletAddress but filters for Solana chain type
   */
  async getSolanaEmbeddedWalletAddress(userId: string): Promise<{ address: string; walletId: string } | null> {
    try {
      const user = await this.getUser(userId);
      if (!user) return null;

      const userAny = user as any;
      let linkedAccounts: any[] = [];

      if (Array.isArray(userAny?.linkedAccounts)) {
        linkedAccounts = userAny.linkedAccounts;
      } else if (Array.isArray(userAny?.linked_accounts)) {
        linkedAccounts = userAny.linked_accounts;
      } else if (Array.isArray(userAny?.wallets)) {
        linkedAccounts = userAny.wallets;
      }

      if (!Array.isArray(linkedAccounts) || linkedAccounts.length === 0) {
        return null;
      }

      // Find Solana embedded wallet: chain_type = solana AND walletClientType = privy
      const solanaWallet = linkedAccounts.find((account: any) => {
        const chainType = account?.chainType || account?.chain_type;
        const walletClientType = account?.walletClientType || account?.wallet_client_type;
        const type = account?.type || account?.account_type;
        return chainType === 'solana' && (walletClientType === 'privy' || type === 'wallet');
      });

      if (solanaWallet) {
        const address = solanaWallet.address || solanaWallet.wallet_address;
        const walletId = solanaWallet.id || solanaWallet.walletId || solanaWallet.wallet_id;
        if (address && walletId) {
          return { address, walletId };
        }
        // If we have address but no ID, try to look it up
        if (address) {
          const lookedUpId = await this.getWalletIdByAddress(userId, address);
          return { address, walletId: lookedUpId || '' };
        }
      }

      return null;
    } catch (error) {
      logger.error({
        message: 'Error getting Solana embedded wallet address',
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create a Solana embedded wallet for a user
   * Uses Privy SDK (same pattern as createEmbeddedWallet but with chain_type: 'solana')
   *
   * IMPORTANT: EVM wallet MUST be created before Solana wallet (Privy requirement)
   */
  private solanaWalletCreationLocks = new Map<string, Promise<{ address: string; walletId: string }>>();

  async createSolanaEmbeddedWallet(userId: string): Promise<{ address: string; walletId: string }> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    // Check for existing lock
    const existingLock = this.solanaWalletCreationLocks.get(userId);
    if (existingLock) {
      logger.info({
        message: 'Solana wallet creation already in progress, waiting for existing request',
        userId,
      });
      return existingLock;
    }

    const creationPromise = (async (): Promise<{ address: string; walletId: string }> => {
      try {
        // Check if user already has a Solana embedded wallet
        const existingWallet = await this.getSolanaEmbeddedWalletAddress(userId);
        if (existingWallet && existingWallet.address) {
          logger.info({
            message: 'User already has Solana embedded wallet',
            userId,
            walletAddress: existingWallet.address,
          });
          return existingWallet;
        }

        // Use SDK if available
        if (this.privyClient) {
          try {
            const walletsService = this.privyClient.wallets();

            const createRequest: any = {
              chain_type: 'solana',
              owner: {
                user_id: userId,
              },
            };

            // Add app as additional signer (same signer ID as EVM wallet)
            if (privyConfig.defaultSignerId) {
              createRequest.additional_signers = [
                {
                  signer_id: privyConfig.defaultSignerId,
                },
              ];
              logger.info({
                message: 'Creating Solana wallet via SDK with app as additional signer',
                userId,
                signerId: privyConfig.defaultSignerId,
              });
            }

            const wallet = await walletsService.create(createRequest);

            if (!wallet || !wallet.address) {
              throw new Error('Solana wallet creation returned invalid response');
            }

            logger.info({
              message: 'Solana wallet created successfully via SDK',
              userId,
              walletAddress: wallet.address,
              walletId: wallet.id,
            });

            return { address: wallet.address, walletId: wallet.id };
          } catch (error: any) {
            logger.warn({
              message: 'SDK Solana wallet creation failed, falling back to REST API',
              userId,
              error: error.message,
              status: error?.response?.status,
            });
          }
        }

        // Fallback to REST API
        const requestBody: any = {
          chain_type: 'solana',
          owner: {
            user_id: userId,
          },
        };

        if (privyConfig.defaultSignerId) {
          requestBody.additional_signers = [
            {
              signer_id: privyConfig.defaultSignerId,
            },
          ];
        }

        const response = await this.walletClient.post('/v1/wallets', requestBody);
        const walletAddress = response.data?.address;
        const walletId = response.data?.id;

        if (!walletAddress) {
          throw new Error('Solana wallet address not found in Privy response');
        }

        logger.info({
          message: 'Solana wallet created successfully via REST API',
          userId,
          walletAddress,
          walletId,
        });

        return { address: walletAddress, walletId: walletId || '' };
      } catch (error) {
        logger.error({
          message: 'Error creating Solana wallet via Privy',
          userId,
          error: error instanceof Error ? error.message : String(error),
        });

        if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const responseData = error.response?.data;

          if (status === 409) {
            // Wallet already exists — try to retrieve it
            const existing = await this.getSolanaEmbeddedWalletAddress(userId);
            if (existing) return existing;
            throw new Error('Solana wallet already exists but could not be retrieved');
          }

          const errorMessage = responseData?.error || responseData?.message || error.message;
          throw new Error(errorMessage || `Failed to create Solana wallet (HTTP ${status})`);
        }

        throw error;
      } finally {
        this.solanaWalletCreationLocks.delete(userId);
      }
    })();

    this.solanaWalletCreationLocks.set(userId, creationPromise);
    return creationPromise;
  }

  /**
   * Sign and send a Solana transaction using the user's embedded Solana wallet
   * Uses Privy server SDK with gas sponsorship
   *
   * @param walletId - The Privy wallet ID (not the address)
   * @param base64Transaction - Base64-encoded serialized Solana transaction
   * @returns Transaction hash
   */
  async signAndSendSolanaTransaction(
    walletId: string,
    base64Transaction: string
  ): Promise<{ hash: string }> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    if (!this.privyClient) {
      throw new Error('PrivyClient SDK not initialized');
    }

    const authorizationContext = this.getAuthorizationContext();
    if (!authorizationContext) {
      throw new Error('Authorization private key not configured. Set PRIVY_AUTHORIZATION_PRIVATE_KEY.');
    }

    logger.info({
      message: 'Signing and sending Solana transaction via Privy SDK',
      walletId,
      transactionLength: base64Transaction.length,
    });

    try {
      const solanaWallets = this.privyClient.wallets().solana();

      const response = await (solanaWallets as any).signAndSendTransaction(
        walletId,
        {
          caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', // Solana mainnet
          transaction: base64Transaction,
          sponsor: true, // Privy covers SOL gas fees
          authorization_context: authorizationContext,
        }
      );

      const txHash = (response as any)?.hash || (response as any)?.signature || (response as any)?.transactionHash;

      if (!txHash) {
        logger.error({
          message: 'Solana transaction response missing hash',
          walletId,
          response,
        });
        throw new Error('Solana transaction response missing hash');
      }

      logger.info({
        message: 'Solana transaction sent successfully via Privy SDK',
        walletId,
        txHash,
        solscanUrl: `https://solscan.io/tx/${txHash}`,
      });

      return { hash: txHash };
    } catch (error: any) {
      logger.error({
        message: 'Privy Solana signAndSendTransaction FAILED',
        walletId,
        error: error.message,
        status: error?.response?.status,
        responseData: error?.response?.data,
        troubleshooting: [
          'Check if gas sponsorship is enabled in Privy dashboard for Solana',
          'Check if Solana (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp) is enabled for sponsorship',
          'Check if PRIVY_AUTHORIZATION_PRIVATE_KEY is correct',
          'Verify the wallet exists and belongs to the user',
          'Verify the transaction is a valid base64-encoded Solana transaction',
        ],
      });
      throw error;
    }
  }

  /**
   * Sign a message with the user's embedded Solana wallet (no transaction submission).
   * Used for Proof KYC deep link signing.
   *
   * @param walletId - The Privy wallet ID (not the address)
   * @param message - The message bytes to sign
   * @returns Base58-encoded signature
   */
  async signSolanaMessage(
    walletId: string,
    message: Uint8Array
  ): Promise<{ signature: string }> {
    if (!this.initialized) {
      throw new Error('Privy service not initialized');
    }

    if (!this.privyClient) {
      throw new Error('PrivyClient SDK not initialized');
    }

    const authorizationContext = this.getAuthorizationContext();
    if (!authorizationContext) {
      throw new Error('Authorization private key not configured. Set PRIVY_AUTHORIZATION_PRIVATE_KEY.');
    }

    logger.info({
      message: 'Signing Solana message via Privy SDK',
      walletId,
      messageLength: message.length,
    });

    try {
      const solanaWallets = this.privyClient.wallets().solana();

      const response = await (solanaWallets as any).signMessage(
        walletId,
        {
          message,
          authorization_context: authorizationContext,
        }
      );

      const signature = (response as any)?.signature;

      if (!signature) {
        logger.error({
          message: 'Solana signMessage response missing signature',
          walletId,
          response,
        });
        throw new Error('Solana signMessage response missing signature');
      }

      logger.info({
        message: 'Solana message signed successfully via Privy SDK',
        walletId,
      });

      return { signature };
    } catch (error: any) {
      logger.error({
        message: 'Privy Solana signMessage FAILED',
        walletId,
        error: error.message,
        status: error?.response?.status,
        responseData: error?.response?.data,
      });
      throw error;
    }
  }
}

// Export singleton instance
export const privyService = new PrivyService();
