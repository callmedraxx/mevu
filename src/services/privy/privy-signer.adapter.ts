/**
 * Privy Signer Adapter
 * 
 * A custom ethers.js Signer implementation that uses Privy's session signer API
 * to sign transactions and messages. This adapter allows the Polymarket RelayerClient
 * to work with Privy embedded wallets.
 * 
 * IMPORTANT: This adapter is designed for use with the Polymarket Relayer,
 * which handles transaction execution. The signer only needs to provide
 * signatures - it doesn't send transactions directly.
 */

import { ethers } from 'ethers';
import { logger } from '../../config/logger';
import { privyService } from './privy.service';
import { privyConfig } from './privy.config';
import { EIP712TypedData } from './privy.types';

/**
 * Custom Signer that uses Privy's session signer for signing
 * Compatible with ethers.js v5 and Polymarket RelayerClient
 */
export class PrivySignerAdapter extends ethers.Signer {
  private userId: string;
  private walletAddress: string;
  readonly provider: ethers.providers.Provider;

  constructor(
    userId: string,
    walletAddress: string,
    provider?: ethers.providers.Provider
  ) {
    super();
    this.userId = userId;
    // Normalize address: convert to lowercase first to avoid checksum errors, then get proper checksum
    const normalized = walletAddress.toLowerCase();
    this.walletAddress = ethers.utils.getAddress(normalized);
    
    // Create provider if not provided
    this.provider = provider || new ethers.providers.JsonRpcProvider(privyConfig.rpcUrl);
    
    // Bind provider to this signer
    ethers.utils.defineReadOnly(this, 'provider', this.provider);
  }

  /**
   * Get the wallet address
   */
  async getAddress(): Promise<string> {
    return this.walletAddress;
  }

  /**
   * Sign a message using Privy session signer
   */
  async signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    const messageString = typeof message === 'string' 
      ? message 
      : ethers.utils.toUtf8String(message);

    logger.info({
      message: 'Signing message via Privy session signer',
      userId: this.userId,
      walletAddress: this.walletAddress,
    });

    try {
      const signature = await privyService.signMessage({
        userId: this.userId,
        message: messageString,
      });

      return signature;
    } catch (error) {
      logger.error({
        message: 'Failed to sign message via Privy',
        userId: this.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sign EIP-712 typed data using Privy session signer
   * This is the primary method used by Polymarket for order signing
   */
  async _signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, ethers.TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    logger.info({
      message: 'Signing typed data via Privy session signer',
      userId: this.userId,
      walletAddress: this.walletAddress,
      domain: domain.name,
    });

    // Helper function to serialize BigInt values to strings (Privy API doesn't accept BigInt)
    const serializeBigInt = (obj: any): any => {
      if (obj === null || obj === undefined) {
        return obj;
      }
      if (typeof obj === 'bigint') {
        return obj.toString();
      }
      if (typeof obj === 'object' && obj.constructor === Object) {
        const result: any = {};
        for (const [key, val] of Object.entries(obj)) {
          result[key] = serializeBigInt(val);
        }
        return result;
      }
      if (Array.isArray(obj)) {
        return obj.map(serializeBigInt);
      }
      // Handle ethers BigNumber
      if (obj && typeof obj === 'object' && 'toString' in obj && typeof obj.toString === 'function' && '_hex' in obj) {
        return obj.toString();
      }
      return obj;
    };

    // Convert to Privy expected format
    // Serialize BigInt values in the message to strings
    const serializedMessage = serializeBigInt(value);
    
    const typedData: EIP712TypedData = {
      domain: {
        name: domain.name,
        version: domain.version,
        chainId: domain.chainId ? Number(domain.chainId) : undefined,
        verifyingContract: domain.verifyingContract,
        salt: domain.salt ? String(domain.salt) : undefined,
      },
      types: types as Record<string, { name: string; type: string }[]>,
      primaryType: Object.keys(types).find(key => key !== 'EIP712Domain') || '',
      message: serializedMessage,
    };

    try {
      const signature = await privyService.signTypedData({
        userId: this.userId,
        typedData,
      });

      return signature;
    } catch (error) {
      logger.error({
        message: 'Failed to sign typed data via Privy',
        userId: this.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Sign a transaction
   * Note: For Polymarket Relayer, we typically do not sign raw transactions
   * as the relayer handles transaction execution.
   */
  async signTransaction(transaction: ethers.utils.Deferrable<ethers.providers.TransactionRequest>): Promise<string> {
    const tx = await ethers.utils.resolveProperties(transaction);
    
    logger.info({
      message: 'Signing transaction via Privy session signer',
      userId: this.userId,
      walletAddress: this.walletAddress,
      to: tx.to,
    });

    const serialized = ethers.utils.serializeTransaction({
      to: tx.to,
      data: tx.data ? ethers.utils.hexlify(tx.data) : undefined,
      value: tx.value ? ethers.BigNumber.from(tx.value) : undefined,
      gasLimit: tx.gasLimit ? ethers.BigNumber.from(tx.gasLimit) : undefined,
      gasPrice: tx.gasPrice ? ethers.BigNumber.from(tx.gasPrice) : undefined,
      nonce: tx.nonce ? Number(tx.nonce) : undefined,
      chainId: tx.chainId ? Number(tx.chainId) : privyConfig.chainId,
    });

    const hash = ethers.utils.keccak256(serialized);
    const signature = await this.signMessage(ethers.utils.arrayify(hash));

    return ethers.utils.serializeTransaction(
      {
        to: tx.to,
        data: tx.data ? ethers.utils.hexlify(tx.data) : undefined,
        value: tx.value ? ethers.BigNumber.from(tx.value) : undefined,
        gasLimit: tx.gasLimit ? ethers.BigNumber.from(tx.gasLimit) : undefined,
        gasPrice: tx.gasPrice ? ethers.BigNumber.from(tx.gasPrice) : undefined,
        nonce: tx.nonce ? Number(tx.nonce) : undefined,
        chainId: tx.chainId ? Number(tx.chainId) : privyConfig.chainId,
      },
      ethers.utils.splitSignature(signature)
    );
  }

  /**
   * Connect to a new provider
   */
  connect(provider: ethers.providers.Provider): PrivySignerAdapter {
    return new PrivySignerAdapter(this.userId, this.walletAddress, provider);
  }
}

/**
 * Create a PrivySignerAdapter for a user
 */
export function createPrivySigner(
  userId: string,
  walletAddress: string,
  provider?: ethers.providers.Provider
): PrivySignerAdapter {
  return new PrivySignerAdapter(userId, walletAddress, provider);
}
