/**
 * Users API Routes
 * Handles user registration, profile management, and wallet operations
 */

import { Router, Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import { logger } from '../config/logger';
import { ingestDebugLog } from '../config/debug-ingest';
import { getCache, setCache } from '../utils/cache';
import {
  registerUserAndDeployWallet,
  setupTokenApprovals,
  getUserByPrivyId,
  getUserByUsername,
  getUserWalletInfo,
  updateUserSessionSigner,
  markOnboardingComplete,
  isUsernameAvailable,
  deployProxyWallet,
  updateUserProxyWallet,
  updateUserEmbeddedWalletAddress,
  deleteAllUsers,
} from '../services/privy';
import { createSolanaWallet } from '../services/solana/solana-wallet.service';
import { updateUserTradingRegion, updateUserKalshiOnboarding } from '../services/privy/kalshi-user.service';
import { privyService } from '../services/privy/privy.service';

const router = Router();

/**
 * Cache TTL for supported assets: 24 hours (86400 seconds)
 */
const SUPPORTED_ASSETS_CACHE_TTL = 86400;
const SUPPORTED_ASSETS_CACHE_KEY = 'polymarket:supported-assets';

/**
 * Fetch supported assets from Polymarket bridge API
 * Results are cached for 24 hours
 */
async function getSupportedAssets(): Promise<any[]> {
  // Check cache first
  const cached = await getCache(SUPPORTED_ASSETS_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      logger.info({
        message: 'Using cached supported assets',
        assetCount: parsed?.supportedAssets?.length || 0,
      });
      return parsed.supportedAssets || [];
    } catch (parseError) {
      logger.warn({
        message: 'Failed to parse cached supported assets, fetching fresh',
        error: parseError instanceof Error ? parseError.message : String(parseError),
      });
    }
  }

  // Fetch from API
  const bridgeApiUrl = process.env.POLYMARKET_BRIDGE_API_URL || 'https://bridge.polymarket.com';
  
  try {
    const response = await axios.get(`${bridgeApiUrl}/supported-assets`, {
      headers: {
        'Accept': 'application/json',
      },
      timeout: 10000,
    });

    const supportedAssets = response.data?.supportedAssets || [];
    
    // Cache for 24 hours
    await setCache(SUPPORTED_ASSETS_CACHE_KEY, JSON.stringify(response.data), SUPPORTED_ASSETS_CACHE_TTL);
    
    logger.info({
      message: 'Fetched supported assets from Polymarket bridge',
      assetCount: supportedAssets.length,
    });

    return supportedAssets;
  } catch (error) {
    logger.error({
      message: 'Error fetching supported assets from Polymarket bridge',
      error: error instanceof Error ? error.message : String(error),
    });
    
    // If we have cached data, use it even if expired
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        logger.warn({
          message: 'Using stale cached supported assets due to API error',
        });
        return parsed.supportedAssets || [];
      } catch {
        // Ignore parse errors
      }
    }
    
    throw error;
  }
}

/**
 * Helper function to extract error message from various error types
 */
function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const errorObj = error as any;
    return errorObj.message || errorObj.error || errorObj.reason || errorObj.toString() || JSON.stringify(error);
  }
  return String(error) || 'Unknown error';
}

/**
 * @swagger
 * tags:
 *   - name: Users
 *     description: User registration, profile management, and wallet operations
 */

/**
 * @swagger
 * /api/users/register:
 *   post:
 *     summary: Register a new user and deploy their proxy wallet
 *     description: Creates a new user profile with their Privy embedded wallet and deploys a Gnosis Safe proxy wallet via Polymarket relayer (gasless).
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *               - username
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: The Privy user ID from authentication
 *                 example: "did:privy:clx1234567890"
 *               username:
 *                 type: string
 *                 description: Desired username (3-50 characters, alphanumeric and underscores)
 *                 example: "cryptotrader"
 *     responses:
 *       201:
 *         description: User registered and proxy wallet deployed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     username:
 *                       type: string
 *                     embeddedWalletAddress:
 *                       type: string
 *                     proxyWalletAddress:
 *                       type: string
 *                 embeddedWalletAddress:
 *                   type: string
 *                   description: The embedded wallet address (created or existing)
 *                   example: "0x1234567890abcdef1234567890abcdef12345678"
 *                 proxyWalletAddress:
 *                   type: string
 *                   description: The deployed proxy wallet (Gnosis Safe) address
 *                   example: "0xabcdef1234567890abcdef1234567890abcdef12"
 *                 nextStep:
 *                   type: string
 *                   example: "User must authorize session signer, then call POST /api/users/session-signer/confirm"
 *       400:
 *         description: Invalid request (missing fields, invalid format, username taken)
 *       500:
 *         description: Server error during registration or wallet deployment
 */
/**
 * @swagger
 * /api/users/check-privy-config:
 *   get:
 *     summary: Check Privy app configuration and dashboard settings
 *     tags: [Users]
 *     description: Checks Privy configuration and provides dashboard verification checklist
 *     responses:
 *       200:
 *         description: Privy configuration status
 */
// IMPORTANT: This route must be defined BEFORE parameterized routes like /:privyUserId
router.get('/check-privy-config', async (req: Request, res: Response) => {
  try {
    const { privyConfig } = await import('../services/privy/privy.config');
    const { privyService } = await import('../services/privy/privy.service');
    
    const config: any = {
      environment: {
        PRIVY_APP_ID: privyConfig.appId ? '✓ Set' : '✗ Missing',
        PRIVY_APP_SECRET: privyConfig.appSecret ? '✓ Set' : '✗ Missing',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: privyConfig.authorizationPrivateKey ? '✓ Set' : '✗ Missing',
        PRIVY_SIGNER_ID: privyConfig.defaultSignerId ? `✓ Set (${privyConfig.defaultSignerId})` : '✗ Missing',
      },
      dashboardChecklist: {
        sessionSigners: {
          location: 'Settings → Session Signers',
          items: [
            'Ensure "Session Signers" feature is ENABLED',
            'Check that your authorization key quorum is configured',
            'Verify the Signer ID matches PRIVY_SIGNER_ID in your .env',
          ],
        },
        wallets: {
          location: 'Settings → Wallets',
          items: [
            'Ensure "Embedded Wallets" are enabled',
            'Check wallet creation settings',
          ],
        },
        appSettings: {
          location: 'Settings → General',
          items: [
            'Verify App ID matches PRIVY_APP_ID',
            'Check that the app is in the correct environment (dev/prod)',
          ],
        },
        authorizationKeys: {
          location: 'Settings → Authorization Keys',
          items: [
            'Verify your authorization private key is configured',
            'Check that the key has signing permissions',
          ],
        },
      },
      recommendations: [] as string[],
      nextSteps: [
        'Verify session signers are enabled in Privy Dashboard',
        'Ensure PRIVY_AUTHORIZATION_PRIVATE_KEY is set correctly',
        'Test the /api/users/add-session-signer endpoint',
        'Then test proxy wallet deployment',
      ],
    };

    // Add recommendations based on configuration
    if (!privyConfig.authorizationPrivateKey) {
      config.recommendations.push(
        'CRITICAL: PRIVY_AUTHORIZATION_PRIVATE_KEY is not set. You need either:',
        '  1. Set PRIVY_AUTHORIZATION_PRIVATE_KEY in your .env file, OR',
        '  2. Enable Session Signers in the Privy Dashboard'
      );
    }

    if (!privyConfig.defaultSignerId && privyConfig.authorizationPrivateKey) {
      config.recommendations.push(
        'PRIVY_SIGNER_ID is not set (optional if using authorization private key)'
      );
    }

    // Try to check if Privy service is initialized
    try {
      const isInitialized = (privyService as any).initialized;
      config.environment['Privy Service'] = isInitialized ? '✓ Initialized' : '✗ Not Initialized';
    } catch (error) {
      config.environment['Privy Service'] = '⚠ Could not check';
    }

    res.json({
      success: true,
      message: 'Privy configuration check complete',
      config,
      dashboardUrl: 'https://dashboard.privy.io',
    });
  } catch (error) {
    logger.error({
      message: 'Error checking Privy configuration',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to check Privy configuration',
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });
  }
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { privyUserId, username, userJwt } = req.body;

    if (!privyUserId || !username) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: privyUserId, username',
      });
    }

    const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        success: false,
        error: 'Username must be 3-50 characters, alphanumeric and underscores only',
      });
    }

    // Register user and deploy proxy wallet
    // Flow:
    // 1. Creates user record
    // 2. Gets/creates embedded wallet
    // 3. Adds session signer (using userJwt if provided, otherwise uses authorization private key)
    // 4. Deploys proxy wallet (now works because session signer is added)
    // 
    // If userJwt is provided, it will be used to authorize adding the session signer.
    // If not provided, the backend will use PRIVY_AUTHORIZATION_PRIVATE_KEY if configured.
    const result = await registerUserAndDeployWallet(
      privyUserId,
      username,
      userJwt // Optional: User JWT for session signer authorization
    );

    // Determine next step based on whether proxy wallet was deployed
    let nextStep: string;
    if (result.proxyWalletAddress) {
      nextStep = 'Registration complete! Proxy wallet deployed successfully.';
    } else {
      nextStep = 'Registration complete, but proxy wallet deployment failed. Call POST /api/users/:privyUserId/deploy-proxy-wallet to retry.';
    }

    res.status(201).json({
      success: true,
      user: result.user,
      embeddedWalletAddress: result.embeddedWalletAddress,
      proxyWalletAddress: result.proxyWalletAddress,
      nextStep,
      sessionSignerEnabled: result.user.sessionSignerEnabled,
    });
  } catch (error) {
    // Enhanced error logging
    const errorDetails: any = {
      message: 'Error registering user',
      privyUserId: req.body.privyUserId,
      username: req.body.username,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      errorType: error?.constructor?.name,
    };

    // If it's an Axios error, log the full response
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as any;
      errorDetails.httpStatus = axiosError.response?.status;
      errorDetails.responseData = axiosError.response?.data;
      errorDetails.responseHeaders = axiosError.response?.headers;
    }

    logger.error(errorDetails);

    // Extract error message
    const errorMessage = error instanceof Error ? error.message : 'Failed to register user';

    // Handle specific error cases
    if (errorMessage.includes('Username is already taken')) {
      return res.status(400).json({
        success: false,
        error: 'Username is already taken',
      });
    }
    
    if (errorMessage.includes('already deployed') || errorMessage.includes('already exists')) {
      return res.status(400).json({
        success: false,
        error: 'User already has a proxy wallet',
      });
    }

    if (errorMessage.includes('Signer address does not match')) {
      return res.status(400).json({
        success: false,
        error: 'Embedded wallet address mismatch. Please verify the wallet address.',
      });
    }

    // Return more detailed error in development, generic in production
    const isDevelopment = process.env.NODE_ENV !== 'production';
    res.status(500).json({
      success: false,
      error: isDevelopment ? errorMessage : 'Failed to register user',
      ...(isDevelopment && { details: errorDetails }),
    });
  }
});

/**
 * @swagger
 * /api/users/check-privy-config:
 *   get:
 *     summary: Check Privy app configuration and dashboard settings
 *     tags: [Users]
 *     description: Checks Privy configuration and provides dashboard verification checklist
 *     responses:
 *       200:
 *         description: Privy configuration status
 */
// IMPORTANT: This route must be defined BEFORE parameterized routes like /:privyUserId
router.get('/check-privy-config', async (req: Request, res: Response) => {
  try {
    const { privyConfig } = await import('../services/privy/privy.config');
    const { privyService } = await import('../services/privy/privy.service');
    
    const config: any = {
      environment: {
        PRIVY_APP_ID: privyConfig.appId ? '✓ Set' : '✗ Missing',
        PRIVY_APP_SECRET: privyConfig.appSecret ? '✓ Set' : '✗ Missing',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: privyConfig.authorizationPrivateKey ? '✓ Set' : '✗ Missing',
        PRIVY_SIGNER_ID: privyConfig.defaultSignerId ? `✓ Set (${privyConfig.defaultSignerId})` : '✗ Missing',
      },
      dashboardChecklist: {
        sessionSigners: {
          location: 'Settings → Session Signers',
          items: [
            'Ensure "Session Signers" feature is ENABLED',
            'Check that your authorization key quorum is configured',
            'Verify the Signer ID matches PRIVY_SIGNER_ID in your .env',
          ],
        },
        wallets: {
          location: 'Settings → Wallets',
          items: [
            'Ensure "Embedded Wallets" are enabled',
            'Check wallet creation settings',
          ],
        },
        appSettings: {
          location: 'Settings → General',
          items: [
            'Verify App ID matches PRIVY_APP_ID',
            'Check that the app is in the correct environment (dev/prod)',
          ],
        },
        authorizationKeys: {
          location: 'Settings → Authorization Keys',
          items: [
            'Verify your authorization private key is configured',
            'Check that the key has signing permissions',
          ],
        },
      },
      recommendations: [] as string[],
      nextSteps: [
        'Verify session signers are enabled in Privy Dashboard',
        'Ensure PRIVY_AUTHORIZATION_PRIVATE_KEY is set correctly',
        'Test the /api/users/add-session-signer endpoint',
        'Then test proxy wallet deployment',
      ],
    };

    // Add recommendations based on configuration
    if (!privyConfig.authorizationPrivateKey) {
      config.recommendations.push(
        'CRITICAL: PRIVY_AUTHORIZATION_PRIVATE_KEY is not set. You need either:',
        '  1. Set PRIVY_AUTHORIZATION_PRIVATE_KEY in your .env file, OR',
        '  2. Enable Session Signers in the Privy Dashboard'
      );
    }

    if (!privyConfig.defaultSignerId && privyConfig.authorizationPrivateKey) {
      config.recommendations.push(
        'PRIVY_SIGNER_ID is not set (optional if using authorization private key)'
      );
    }

    // Try to check if Privy service is initialized
    try {
      const isInitialized = (privyService as any).initialized;
      config.environment['Privy Service'] = isInitialized ? '✓ Initialized' : '✗ Not Initialized';
    } catch (error) {
      config.environment['Privy Service'] = '⚠ Could not check';
    }

    res.json({
      success: true,
      message: 'Privy configuration check complete',
      config,
      dashboardUrl: 'https://dashboard.privy.io',
    });
  } catch (error) {
    logger.error({
      message: 'Error checking Privy configuration',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to check Privy configuration',
      errorType: error instanceof Error ? error.constructor.name : 'Unknown',
    });
  }
});

/**
 * @swagger
 * /api/users/check-username/{username}:
 *   get:
 *     summary: Check if a username is available
 *     description: Returns whether the specified username is available for registration
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: The username to check
 *         example: "cryptotrader"
 *     responses:
 *       200:
 *         description: Username availability status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 available:
 *                   type: boolean
 *                   example: true
 *                 username:
 *                   type: string
 *                   example: "cryptotrader"
 */
router.get('/check-username/:username', async (req: Request, res: Response) => {
  // #region agent log
  const fs = require('fs');
  try {
    const logEntry = {
      location: 'users.ts:536',
      message: 'check-username endpoint called',
      data: {
        username: req.params.username,
        method: req.method,
        url: req.url,
        headers: Object.keys(req.headers),
        origin: req.headers.origin,
      },
      timestamp: Date.now(),
      sessionId: 'debug-session',
      runId: 'run1',
      hypothesisId: 'A',
    };
    fs.appendFileSync('/root/mevu/.cursor/debug.log', JSON.stringify(logEntry) + '\n');
  } catch (logErr) {
    // Ignore logging errors
  }
  // #endregion
  logger.info({ message: '[DEBUG] check-username endpoint called', username: req.params.username, origin: req.headers.origin });
  
  try {
    const { username } = req.params;
    // #region agent log
    try {
      const logEntry2 = {
        location: 'users.ts:547',
        message: 'calling isUsernameAvailable',
        data: { username },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'A',
      };
      fs.appendFileSync('/root/mevu/.cursor/debug.log', JSON.stringify(logEntry2) + '\n');
    } catch (logErr) {
      // Ignore logging errors
    }
    // #endregion
    const available = await isUsernameAvailable(username);
    // #region agent log
    try {
      const logEntry3 = {
        location: 'users.ts:551',
        message: 'isUsernameAvailable completed',
        data: { username, available },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'A',
      };
      fs.appendFileSync('/root/mevu/.cursor/debug.log', JSON.stringify(logEntry3) + '\n');
    } catch (logErr) {
      // Ignore logging errors
    }
    // #endregion
    // #region agent log
    try {
      const logEntry4 = {
        location: 'users.ts:559',
        message: 'sending response',
        data: { username, available },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'A',
      };
      fs.appendFileSync('/root/mevu/.cursor/debug.log', JSON.stringify(logEntry4) + '\n');
    } catch (logErr) {
      // Ignore logging errors
    }
    // #endregion
    res.json({ available, username });
  } catch (error) {
    // #region agent log
    try {
      const logEntry5 = {
        location: 'users.ts:570',
        message: 'error in check-username endpoint',
        data: {
          username: req.params.username,
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof Error ? error.constructor.name : typeof error,
        },
        timestamp: Date.now(),
        sessionId: 'debug-session',
        runId: 'run1',
        hypothesisId: 'A',
      };
      fs.appendFileSync('/root/mevu/.cursor/debug.log', JSON.stringify(logEntry5) + '\n');
    } catch (logErr) {
      // Ignore logging errors
    }
    // #endregion
    logger.error({
      message: 'Error checking username availability',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to check username availability' });
  }
});

/**
 * @swagger
 * /api/users/session-signer/confirm:
 *   post:
 *     summary: Confirm session signer authorization
 *     description: Called by frontend after user has authorized the session signer via Privy SDK. Updates the user record to indicate session signer is enabled.
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: The Privy user ID
 *                 example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Session signer confirmation recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Session signer enabled"
 *                 nextStep:
 *                   type: string
 *                   example: "Call POST /api/users/approve-tokens to set up trading approvals"
 *       404:
 *         description: User not found
 */
router.post('/session-signer/confirm', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.body;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: privyUserId',
      });
    }

    const user = await updateUserSessionSigner(privyUserId, true);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      message: 'Session signer enabled',
      nextStep: 'Call POST /api/users/approve-tokens to set up trading approvals',
    });
  } catch (error) {
    logger.error({
      message: 'Error confirming session signer',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to confirm session signer' });
  }
});

/**
 * @swagger
 * /api/users/add-session-signer:
 *   post:
 *     summary: Add session signer to user's embedded wallet (Backend-managed)
 *     description: |
 *       Adds a session signer (authorization key) to the user's embedded wallet using Privy SDK.
 *       Requires PRIVY_AUTHORIZATION_PRIVATE_KEY to be configured.
 *       
 *       Note: This endpoint requires the authorization private key to sign the wallet update request.
 *       The signerId should be the authorization key quorum ID from your Privy Dashboard.
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: The Privy user ID
 *                 example: "did:privy:clx1234567890"
 *               walletAddress:
 *                 type: string
 *                 description: The embedded wallet address to add the session signer to
 *                 example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
 *               signerId:
 *                 type: string
 *                 description: The authorization key quorum ID from Privy Dashboard (or set PRIVY_SIGNER_ID env var)
 *                 example: "your-signer-id-from-dashboard"
 *               policyIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional policy IDs to apply to the signer
 *                 example: ["policy-id-1"]
 *     responses:
 *       200:
 *         description: Session signer added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Session signer added successfully"
 *                 walletAddress:
 *                   type: string
 *                   description: The wallet address that was used (may differ from provided address if database was stale)
 *                   example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
 *                 nextStep:
 *                   type: string
 *                   example: "You can now deploy proxy wallet or sign transactions"
 *       400:
 *         description: Bad request - missing fields or invalid input
 *       404:
 *         description: User or wallet not found
 *       500:
 *         description: Failed to add session signer
 */
router.post('/add-session-signer', async (req: Request, res: Response) => {
  try {
    const { privyUserId, walletAddress, signerId, policyIds, userJwt } = req.body;

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: privyUserId',
      });
    }

    // Verify user exists in our database
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Fetch actual embedded wallet address from Privy (not from database)
    // This ensures we use the current wallet address, even if database is stale
    logger.info({
      message: 'Fetching embedded wallet address from Privy',
      privyUserId,
      storedAddress: user.embeddedWalletAddress,
    });

    const actualEmbeddedWalletAddress = await privyService.getEmbeddedWalletAddress(privyUserId);
    
    if (!actualEmbeddedWalletAddress) {
      return res.status(404).json({
        success: false,
        error: 'Embedded wallet not found in Privy. Please ensure the user has an embedded wallet.',
      });
    }

    // Use provided walletAddress or fall back to actual Privy wallet address
    let finalWalletAddress = walletAddress;
    
    if (walletAddress) {
      // Validate wallet address format if provided
      const addressRegex = /^0x[a-fA-F0-9]{40}$/;
      if (!addressRegex.test(walletAddress)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid wallet address format',
        });
      }

      // If provided address doesn't match Privy's actual address, use Privy's address
      if (walletAddress.toLowerCase() !== actualEmbeddedWalletAddress.toLowerCase()) {
        logger.warn({
          message: 'Provided wallet address does not match Privy wallet address, using Privy address',
          privyUserId,
          providedAddress: walletAddress,
          actualAddress: actualEmbeddedWalletAddress,
        });
        finalWalletAddress = actualEmbeddedWalletAddress;
      }
    } else {
      // No wallet address provided, use the actual one from Privy
      finalWalletAddress = actualEmbeddedWalletAddress;
    }

      // Update database if stored address is different from actual Privy address
      if (user.embeddedWalletAddress.toLowerCase() !== actualEmbeddedWalletAddress.toLowerCase()) {
        logger.info({
          message: 'Updating stored wallet address to match Privy',
          privyUserId,
          oldAddress: user.embeddedWalletAddress,
          newAddress: actualEmbeddedWalletAddress,
        });
        
        // Update user's embedded wallet address in database
        try {
          await updateUserEmbeddedWalletAddress(privyUserId, actualEmbeddedWalletAddress);
        } catch (updateError) {
          logger.warn({
            message: 'Failed to update stored wallet address, continuing anyway',
            privyUserId,
            error: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
      }

    // Use default signerId from config if not provided
    const { privyConfig } = await import('../services/privy/privy.config');
    const finalSignerId = signerId || privyConfig.defaultSignerId;
    
    if (!finalSignerId) {
      return res.status(400).json({
        success: false,
        error: 'signerId is required. Either provide it in the request or set PRIVY_SIGNER_ID environment variable.',
      });
    }

    logger.info({
      message: 'Adding session signer to wallet via backend',
      privyUserId,
      walletAddress: finalWalletAddress,
      signerId: finalSignerId,
      usingPrivyAddress: !walletAddress || walletAddress.toLowerCase() !== actualEmbeddedWalletAddress.toLowerCase(),
    });

    // Debug: Log what we're about to pass to addSessionSigner
    logger.debug({
      message: 'Calling addSessionSigner',
      privyUserId,
      finalWalletAddress,
      finalSignerId,
      hasUserJwt: !!userJwt,
    });

    // Add session signer using Privy SDK
    // Note: Requires either userJwt (wallet owner signs) or PRIVY_AUTHORIZATION_PRIVATE_KEY (if configured as signer)
    try {
      await privyService.addSessionSigner(
        privyUserId,
        finalWalletAddress,
        finalSignerId,
        policyIds,
        userJwt
      );
    } catch (addSignerError) {
      logger.error({
        message: 'addSessionSigner failed',
        privyUserId,
        walletAddress: finalWalletAddress,
        error: addSignerError instanceof Error ? addSignerError.message : String(addSignerError),
        stack: addSignerError instanceof Error ? addSignerError.stack : undefined,
      });
      throw addSignerError;
    }

    // Update user record to indicate session signer is enabled
    await updateUserSessionSigner(privyUserId, true);

    res.json({
      success: true,
      message: 'Session signer added successfully',
      walletAddress: finalWalletAddress,
      nextStep: 'You can now deploy proxy wallet or sign transactions',
    });
  } catch (error) {
    logger.error({
      message: 'Error adding session signer',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage = error instanceof Error ? error.message : 'Failed to add session signer';

    if (errorMessage.includes('Authorization private key not configured')) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: PRIVY_AUTHORIZATION_PRIVATE_KEY is not set. This is required to add session signers.',
      });
    }

    if (errorMessage.includes('Wallet not found')) {
      return res.status(404).json({
        success: false,
        error: 'Wallet not found in Privy. The wallet address may be invalid or the wallet may have been deleted.',
      });
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/users/approve-tokens:
 *   post:
 *     summary: Set up token approvals for Polymarket trading
 *     description: Sets up USDC and CTF (Conditional Token Framework) approvals for the user proxy wallet. This enables trading on Polymarket.
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: The Privy user ID
 *                 example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Token approvals set successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 approvals:
 *                   type: object
 *                   properties:
 *                     usdc:
 *                       type: boolean
 *                       example: true
 *                     ctf:
 *                       type: boolean
 *                       example: true
 *                 transactionHashes:
 *                   type: array
 *                   items:
 *                     type: string
 *                   example: ["0x123abc..."]
 *       400:
 *         description: User not found or missing proxy wallet
 *       500:
 *         description: Failed to set up approvals
 */
router.post('/approve-tokens', async (req: Request, res: Response) => {
  // #region agent log
  fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'users.ts:912',message:'approve-tokens endpoint called',data:{body:req.body,headers:Object.keys(req.headers),method:req.method,url:req.url},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion
  try {
    const { privyUserId } = req.body;

    // #region agent log
    ingestDebugLog({location:'users.ts:915',message:'extracted privyUserId from body',data:{privyUserId:privyUserId,hasPrivyUserId:!!privyUserId,bodyKeys:Object.keys(req.body)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'});
    // #endregion

    if (!privyUserId) {
      // #region agent log
      fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'users.ts:917',message:'missing privyUserId - returning 400',data:{body:req.body},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      return res.status(400).json({
        success: false,
        error: 'Missing required field: privyUserId',
      });
    }

    // #region agent log
    ingestDebugLog({location:'users.ts:923',message:'calling setupTokenApprovals',data:{privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'});
    // #endregion
    const result = await setupTokenApprovals(privyUserId);

    // #region agent log
    fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'users.ts:925',message:'setupTokenApprovals succeeded',data:{success:result.success,transactionHashes:result.transactionHashes},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion

    res.json({
      success: true,
      approvals: { usdc: true, ctf: true },
      transactionHashes: result.transactionHashes,
    });
  } catch (error) {
    // #region agent log
    ingestDebugLog({location:'users.ts:930',message:'error in approve-tokens endpoint',data:{error:error instanceof Error ? error.message : String(error),errorType:error instanceof Error ? error.constructor.name : typeof error,hasMessage:error instanceof Error && 'message' in error},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'});
    // #endregion
    logger.error({
      message: 'Error setting up token approvals',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error) {
      if (error.message.includes('User not found')) {
        // #region agent log
        fetch('http://localhost:7245/ingest/60ddb764-e4c3-47f8-bbea-98f9add98263',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'users.ts:937',message:'user not found error',data:{privyUserId:req.body.privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
        return res.status(400).json({ success: false, error: 'User not found' });
      }
      if (error.message.includes('does not have a proxy wallet')) {
        // #region agent log
        ingestDebugLog({location:'users.ts:940',message:'no proxy wallet error',data:{privyUserId:req.body.privyUserId},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'});
        // #endregion
        return res.status(400).json({
          success: false,
          error: 'User does not have a proxy wallet. Register first.',
        });
      }
    }

    // #region agent log
    ingestDebugLog({location:'users.ts:947',message:'returning generic 500 error',data:{error:error instanceof Error ? error.message : String(error)},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'});
    // #endregion
    res.status(500).json({ success: false, error: 'Failed to set up token approvals' });
  }
});

/**
 * @swagger
 * /api/users/complete-onboarding:
 *   post:
 *     summary: Mark user onboarding as complete
 *     description: Called when user clicks "Start Trading" after completing all onboarding steps. This persists the completion state server-side to prevent the onboarding modal from showing again.
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - privyUserId
 *             properties:
 *               privyUserId:
 *                 type: string
 *                 description: The Privy user ID
 *                 example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Onboarding marked as complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Onboarding completed successfully"
 *                 user:
 *                   type: object
 *                   description: Updated user profile
 *       400:
 *         description: Missing privyUserId or user not ready for completion
 *       404:
 *         description: User not found
 */
router.post('/complete-onboarding', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.body;

    logger.info({
      message: '[Onboarding] complete-onboarding endpoint called',
      privyUserId,
      body: req.body,
    });

    if (!privyUserId) {
      logger.warn({
        message: '[Onboarding] Missing privyUserId in complete-onboarding request',
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required field: privyUserId',
      });
    }

    // Get user to verify they exist and check their current state
    const user = await getUserByPrivyId(privyUserId);
    
    if (!user) {
      logger.warn({
        message: '[Onboarding] User not found for complete-onboarding',
        privyUserId,
      });
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Log current user state for debugging
    logger.info({
      message: '[Onboarding] User state before marking complete',
      privyUserId,
      username: user.username,
      sessionSignerEnabled: user.sessionSignerEnabled,
      usdcApprovalEnabled: user.usdcApprovalEnabled,
      ctfApprovalEnabled: user.ctfApprovalEnabled,
      proxyWalletAddress: user.proxyWalletAddress,
      onboardingCompleted: user.onboardingCompleted,
    });

    // Verify user has completed all required steps
    if (!user.sessionSignerEnabled) {
      logger.warn({
        message: '[Onboarding] User tried to complete onboarding without session signer',
        privyUserId,
      });
      return res.status(400).json({
        success: false,
        error: 'Session signer not enabled. Please complete the authorization step first.',
        currentStep: 'session_signer',
      });
    }

    if (!user.proxyWalletAddress) {
      logger.warn({
        message: '[Onboarding] User tried to complete onboarding without proxy wallet',
        privyUserId,
      });
      return res.status(400).json({
        success: false,
        error: 'Proxy wallet not deployed. Please complete the authorization step first.',
        currentStep: 'session_signer',
      });
    }

    if (!user.usdcApprovalEnabled || !user.ctfApprovalEnabled) {
      logger.warn({
        message: '[Onboarding] User tried to complete onboarding without token approvals',
        privyUserId,
        usdcApprovalEnabled: user.usdcApprovalEnabled,
        ctfApprovalEnabled: user.ctfApprovalEnabled,
      });
      return res.status(400).json({
        success: false,
        error: 'Token approvals not complete. Please complete the approval step first.',
        currentStep: 'token_approval',
      });
    }

    // Mark onboarding as complete
    const updatedUser = await markOnboardingComplete(privyUserId);

    if (!updatedUser) {
      logger.error({
        message: '[Onboarding] Failed to mark onboarding as complete',
        privyUserId,
      });
      return res.status(500).json({
        success: false,
        error: 'Failed to mark onboarding as complete',
      });
    }

    logger.info({
      message: '[Onboarding] Successfully marked onboarding as complete',
      privyUserId,
      username: updatedUser.username,
      onboardingCompleted: updatedUser.onboardingCompleted,
    });

    res.json({
      success: true,
      message: 'Onboarding completed successfully',
      user: updatedUser,
    });
  } catch (error) {
    logger.error({
      message: '[Onboarding] Error in complete-onboarding endpoint',
      privyUserId: (req as any).body?.privyUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({
      success: false,
      error: 'Failed to complete onboarding',
    });
  }
});

/**
 * POST /api/users/register-kalshi - US user registration (creates Solana wallet)
 */
router.post('/register-kalshi', async (req: Request, res: Response) => {
  try {
    const { privyUserId, username } = req.body;
    if (!privyUserId || !username) {
      return res.status(400).json({ success: false, error: 'Missing privyUserId or username' });
    }
    const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        success: false,
        error: 'Username must be 3-50 characters, alphanumeric and underscores only',
      });
    }

    const existingUser = await getUserByPrivyId(privyUserId);
    if (existingUser) {
      if (existingUser.solanaWalletAddress) {
        return res.status(201).json({
          success: true,
          user: existingUser,
          solanaWalletAddress: existingUser.solanaWalletAddress,
          message: 'User already registered with Solana wallet',
        });
      }
      const wallet = await createSolanaWallet(privyUserId);
      await updateUserTradingRegion(privyUserId, 'us');
      const updated = await getUserByPrivyId(privyUserId);
      return res.status(201).json({
        success: true,
        user: updated,
        solanaWalletAddress: wallet.address,
      });
    }

    const embeddedAddress = await privyService.getEmbeddedWalletAddress(privyUserId);
    if (!embeddedAddress) {
      return res.status(400).json({ success: false, error: 'No embedded wallet found. Create a user first.' });
    }

    const { createUser } = await import('../services/privy/user.service');
    const user = await createUser({
      privyUserId,
      username,
      embeddedWalletAddress: embeddedAddress,
    });
    await updateUserTradingRegion(privyUserId, 'us');
    const wallet = await createSolanaWallet(privyUserId);
    const finalUser = await getUserByPrivyId(privyUserId);

    res.status(201).json({
      success: true,
      user: finalUser,
      solanaWalletAddress: wallet.address,
    });
  } catch (error) {
    logger.error({
      message: 'Error in register-kalshi',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to register Kalshi user',
    });
  }
});

/**
 * POST /api/users/complete-kalshi-onboarding - Mark Kalshi onboarding done
 */
router.post('/complete-kalshi-onboarding', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.body;
    if (!privyUserId) {
      return res.status(400).json({ success: false, error: 'Missing privyUserId' });
    }

    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    await updateUserKalshiOnboarding(privyUserId, true);
    const updated = await getUserByPrivyId(privyUserId);

    res.json({
      success: true,
      message: 'Kalshi onboarding completed',
      user: updated,
    });
  } catch (error) {
    logger.error({
      message: 'Error in complete-kalshi-onboarding',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to complete Kalshi onboarding',
    });
  }
});

/**
 * @swagger
 * /api/users/by-username/{username}:
 *   get:
 *     summary: Get user profile by username
 *     description: Returns the user profile for a given username
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: The username
 *         example: "cryptotrader"
 *     responses:
 *       200:
 *         description: User profile found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 user:
 *                   type: object
 *       404:
 *         description: User not found
 */
router.get('/by-username/:username', async (req: Request, res: Response) => {
  try {
    const { username } = req.params;
    const user = await getUserByUsername(username);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user });
  } catch (error) {
    logger.error({
      message: 'Error fetching user by username',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

/**
 * @swagger
 * /api/users/profiles/{privyUserId}:
 *   get:
 *     summary: Get user profile by Privy user ID
 *     description: Returns the full user profile including wallet addresses. Use this endpoint to check if a user is already registered.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: User profile found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     privyUserId:
 *                       type: string
 *                     username:
 *                       type: string
 *                     embeddedWalletAddress:
 *                       type: string
 *                     proxyWalletAddress:
 *                       type: string
 *                     sessionSignerEnabled:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                     updatedAt:
 *                       type: string
 *       404:
 *         description: User not found (not registered yet)
 */
router.get('/profiles/:privyUserId', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        error: 'User not found',
        message: 'User has not registered yet. Please complete registration first.',
      });
    }

    res.json({ success: true, user });
  } catch (error) {
    logger.error({
      message: 'Error fetching user profile',
      privyUserId: req.params.privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch user profile' });
  }
});

/**
 * @swagger
 * /api/users/{privyUserId}/deploy-proxy-wallet:
 *   post:
 *     summary: Deploy proxy wallet for an existing user with null proxy wallet
 *     description: Deploys a proxy wallet (Gnosis Safe) for a user who already exists but has a null proxy wallet address. This endpoint is specifically for users who registered but their proxy wallet deployment failed or was not completed. The user must have an embedded wallet address to deploy the proxy wallet.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:cmj5oegh800h9js0c47xg0it0"
 *     responses:
 *       200:
 *         description: Proxy wallet deployed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 proxyWalletAddress:
 *                   type: string
 *                   description: The newly deployed proxy wallet (Gnosis Safe) address
 *                   example: "0xabcdef1234567890abcdef1234567890abcdef12"
 *                 user:
 *                   type: object
 *                   description: Updated user object with the new proxy wallet address
 *                   properties:
 *                     id:
 *                       type: string
 *                     privyUserId:
 *                       type: string
 *                     username:
 *                       type: string
 *                     embeddedWalletAddress:
 *                       type: string
 *                     proxyWalletAddress:
 *                       type: string
 *                     sessionSignerEnabled:
 *                       type: boolean
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *                     updatedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Bad request - User already has a proxy wallet, missing embedded wallet, or invalid request
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "User already has a proxy wallet"
 *                 proxyWalletAddress:
 *                   type: string
 *                   description: Present if user already has a proxy wallet
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "User not found"
 *       500:
 *         description: Failed to deploy proxy wallet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Failed to deploy proxy wallet"
 */
router.post('/:privyUserId/deploy-proxy-wallet', async (req: Request, res: Response) => {
  try {
    // Decode URL-encoded privyUserId (e.g., did:privy:... might be encoded as did%3Aprivy%3A...)
    let { privyUserId } = req.params;
    privyUserId = decodeURIComponent(privyUserId);

    if (!privyUserId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    // Get the user
    let user;
    try {
      user = await getUserByPrivyId(privyUserId);
    } catch (dbError) {
      logger.error({
        message: 'Database error fetching user',
        privyUserId,
        error: dbError instanceof Error ? dbError.message : String(dbError),
      });
      return res.status(500).json({
        success: false,
        error: 'Database error while fetching user',
        errorType: 'Database error',
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Check if user already has a proxy wallet
    if (user.proxyWalletAddress) {
      return res.status(400).json({
        success: false,
        error: 'User already has a proxy wallet',
        proxyWalletAddress: user.proxyWalletAddress,
      });
    }

    // Check if user has an embedded wallet address
    if (!user.embeddedWalletAddress) {
      return res.status(400).json({
        success: false,
        error: 'User does not have an embedded wallet address. Cannot deploy proxy wallet.',
      });
    }

    logger.info({
      message: 'Deploying proxy wallet for existing user',
      privyUserId,
      embeddedWalletAddress: user.embeddedWalletAddress,
    });

    // Deploy the proxy wallet
    let proxyWalletAddress: string;
    try {
      proxyWalletAddress = await deployProxyWallet(privyUserId, user.embeddedWalletAddress);
    } catch (deployError) {
      // Re-throw to be caught by outer catch block
      throw deployError;
    }

    // Update user record with proxy wallet address
    const updatedUser = await updateUserProxyWallet(privyUserId, proxyWalletAddress);

    if (!updatedUser) {
      throw new Error('Failed to update user with proxy wallet address');
    }

    logger.info({
      message: 'Proxy wallet deployed successfully for existing user',
      privyUserId,
      proxyWalletAddress,
    });

    res.json({
      success: true,
      proxyWalletAddress,
      user: updatedUser,
    });
  } catch (error) {
    // Enhanced error logging - always log full details
    // Extract error message using helper function
    const baseErrorMessage = extractErrorMessage(error);
    let errorMessage = baseErrorMessage || 'Failed to deploy proxy wallet';
    
    // Check for nested errors
    let nestedMessage = '';
    if (error && typeof error === 'object') {
      const nestedError = (error as any).error || (error as any).cause;
      if (nestedError) {
        nestedMessage = extractErrorMessage(nestedError);
        if (nestedMessage && nestedMessage !== errorMessage) {
          errorMessage = `${errorMessage}. Nested error: ${nestedMessage}`;
        }
      }
    }
    
    const errorDetails: any = {
      message: 'Error deploying proxy wallet',
      privyUserId: req.params.privyUserId || 'unknown',
      error: errorMessage,
      errorType: error?.constructor?.name || typeof error,
      errorString: String(error),
    };

    if (error instanceof Error) {
      errorDetails.stack = error.stack;
      errorDetails.name = error.name;
    }
    
    if (nestedMessage) {
      errorDetails.nestedError = nestedMessage;
    }

    // If it's an Axios error, log the full response
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as any;
      errorDetails.httpStatus = axiosError.response?.status;
      errorDetails.responseData = axiosError.response?.data;
      errorDetails.responseHeaders = axiosError.response?.headers;
    }

    logger.error(errorDetails);

    // Ensure we have a non-empty error message
    if (!errorMessage || errorMessage.trim() === '' || errorMessage === 'Unknown error' || errorMessage === 'Failed to deploy proxy wallet') {
      errorMessage = 'Failed to deploy proxy wallet: An unexpected error occurred';
    }
    
    const errorLower = errorMessage.toLowerCase();
    
    // If error message is still generic, try to extract more details
    if (errorMessage === 'Failed to deploy proxy wallet: An unexpected error occurred' && error && typeof error === 'object') {
      const errorObj = error as any;
      // Try to get more specific error information
      if (errorObj.code) {
        errorMessage = `${errorMessage} (Code: ${errorObj.code})`;
      }
      if (errorObj.status) {
        errorMessage = `${errorMessage} (Status: ${errorObj.status})`;
      }
      if (errorObj.response?.data) {
        const responseData = typeof errorObj.response.data === 'string' 
          ? errorObj.response.data 
          : JSON.stringify(errorObj.response.data);
        errorMessage = `${errorMessage} (Response: ${responseData.substring(0, 200)})`;
      }
    }

    // Handle specific error cases
    if (errorMessage.includes('Signer address does not match')) {
      return res.status(400).json({
        success: false,
        error: 'Embedded wallet address mismatch. Please verify the wallet address.',
      });
    }

    if (errorMessage.includes('already deployed')) {
      return res.status(400).json({
        success: false,
        error: 'Proxy wallet already deployed. Please contact support to recover your wallet address.',
      });
    }

    // Check for specific builder signing server connection errors (but not configuration errors)
    // Only catch actual connection failures, not generic mentions of "builder" or "signing server"
    if ((errorLower.includes('builder signing server is not accessible') || 
         errorLower.includes('connection refused') || 
         errorLower.includes('econnrefused')) && 
        errorLower.includes('builder')) {
      return res.status(500).json({
        success: false,
        error: `Builder signing server is not accessible. If running in Docker with localhost, you may need to use 'host.docker.internal' instead of 'localhost', or configure Docker networking.`,
        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
        builderSigningServerUrl: process.env.BUILDER_SIGNING_SERVER_URL || 'not set',
      });
    }

    if (errorLower.includes('relayer') || errorLower.includes('relayer url')) {
      return res.status(500).json({
        success: false,
        error: 'Polymarket relayer configuration error. Please check POLYMARKET_RELAYER_URL environment variable.',
        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
      });
    }

    if (errorLower.includes('privy') || errorLower.includes('session signer')) {
      // Check if it's a session signer authorization error
      if (errorLower.includes('session signer not authorized') || errorLower.includes('session signers are not enabled')) {
        return res.status(400).json({
          success: false,
          error: 'Session signer not authorized. User must authorize a session signer on the frontend, or session signers may not be enabled for this Privy app.',
          errorType: 'Session signer error',
          details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
        });
      }
      return res.status(500).json({
        success: false,
        error: 'Privy service error. Please verify PRIVY_APP_ID and PRIVY_APP_SECRET are configured correctly.',
        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
      });
    }

    if (errorLower.includes('network') || errorLower.includes('connection') || errorLower.includes('timeout') || errorLower.includes('econnrefused')) {
      return res.status(500).json({
        success: false,
        error: 'Network error connecting to external service. Please try again later.',
        details: process.env.NODE_ENV !== 'production' ? errorMessage : undefined,
      });
    }

    // Return error with helpful context
    // In production, include error category but not full stack trace
    const isDevelopment = process.env.NODE_ENV !== 'production';
    
    // Extract error category for better debugging - check multiple patterns
    let errorCategory = 'Unknown error';
    const errorLowerFull = errorLower + ' ' + (errorDetails.nestedError || '').toLowerCase();
    
    if (errorLowerFull.includes('builder') || errorLowerFull.includes('signing server') || errorLowerFull.includes('builder signing')) {
      errorCategory = 'Builder signing server error';
    } else if (errorLowerFull.includes('relayer') || errorLowerFull.includes('polymarket relayer')) {
      errorCategory = 'Polymarket relayer error';
    } else if (errorLowerFull.includes('privy') || errorLowerFull.includes('session signer') || errorLowerFull.includes('embedded wallet')) {
      errorCategory = 'Privy service error';
    } else if (errorLowerFull.includes('network') || errorLowerFull.includes('connection') || errorLowerFull.includes('timeout') || errorLowerFull.includes('econnrefused') || errorLowerFull.includes('fetch failed') || errorLowerFull.includes('eai_again')) {
      errorCategory = 'Network connectivity error';
    } else if (errorLowerFull.includes('database') || errorLowerFull.includes('user not found') || errorLowerFull.includes('query')) {
      errorCategory = 'Database error';
    } else if (errorLowerFull.includes('signer address') || errorLowerFull.includes('address mismatch')) {
      errorCategory = 'Wallet address validation error';
    } else if (errorLowerFull.includes('safe') || errorLowerFull.includes('deployment failed') || errorLowerFull.includes('proxy address')) {
      errorCategory = 'Wallet deployment error';
    }
    
    // Always include the actual error message in development, and error category in production
    // But if errorCategory is "Unknown error", use errorMessage if it's meaningful
    let responseError: string;
    if (isDevelopment) {
      responseError = errorMessage;
    } else {
      // In production, prefer errorCategory unless it's "Unknown error"
      if (errorCategory === 'Unknown error' && errorMessage && errorMessage !== 'Failed to deploy proxy wallet: An unexpected error occurred') {
        responseError = errorMessage.length > 200 ? errorMessage.substring(0, 200) + '...' : errorMessage;
      } else {
        responseError = `Failed to deploy proxy wallet: ${errorCategory}`;
      }
    }
    
    // Final safety check - ensure we never return an empty or generic "Unknown error" message
    if (!responseError || responseError.trim() === '' || responseError === 'Unknown error') {
      responseError = 'Failed to deploy proxy wallet: An unexpected error occurred. Please check server logs for details.';
    }
    
    res.status(500).json({
      success: false,
      error: responseError,
      errorType: errorCategory === 'Unknown error' ? 'Unexpected error' : errorCategory,
      ...(isDevelopment && { 
        details: errorDetails,
        fullError: errorMessage,
      }),
    });
  }
});

/**
 * @swagger
 * /api/users/{privyUserId}/wallet:
 *   get:
 *     summary: Get user wallet information
 *     description: Returns wallet addresses and approval status for a user
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Wallet information found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 wallet:
 *                   type: object
 *                   properties:
 *                     embeddedWalletAddress:
 *                       type: string
 *                     proxyWalletAddress:
 *                       type: string
 *                     hasApprovals:
 *                       type: boolean
 *       404:
 *         description: User not found
 */
router.get('/:privyUserId/wallet', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const walletInfo = await getUserWalletInfo(privyUserId);

    if (!walletInfo) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, wallet: walletInfo });
  } catch (error) {
    logger.error({
      message: 'Error fetching wallet info',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch wallet info' });
  }
});

/**
 * @swagger
 * /api/users/{privyUserId}:
 *   get:
 *     summary: Get user profile by Privy user ID (legacy endpoint)
 *     description: Returns the full user profile including wallet addresses. Use /profiles/{privyUserId} instead.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: User profile found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 user:
 *                   type: object
 *       404:
 *         description: User not found
 */
router.get('/:privyUserId', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;
    const user = await getUserByPrivyId(privyUserId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, user });
  } catch (error) {
    logger.error({
      message: 'Error fetching user',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch user' });
  }
});

/**
 * @swagger
 * /api/users/delete-all:
 *   delete:
 *     summary: Delete all users (DANGEROUS - for testing only)
 *     description: WARNING: This will delete ALL users from the database. Use with extreme caution!
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: All users deleted successfully
 *       500:
 *         description: Error deleting users
 */
router.delete('/delete-all', async (req: Request, res: Response) => {
  try {
    const count = await deleteAllUsers();
    
    logger.info({
      message: 'All users deleted via API',
      deletedCount: count,
    });
    
    res.json({
      success: true,
      message: `Deleted ${count} users from the database`,
      deletedCount: count,
    });
  } catch (error) {
    logger.error({
      message: 'Error deleting all users',
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Failed to delete all users',
      details: extractErrorMessage(error),
    });
  }
});

/**
 * @swagger
 * /api/users/{privyUserId}/deposit-addresses:
 *   post:
 *     summary: Get deposit addresses for Polymarket bridge
 *     description: Generates unique deposit addresses for bridging assets (ETH, Base, Solana, Polygon USDC.e) to Polymarket. Assets are automatically bridged and swapped to USDC.e on Polygon. Response includes enriched chain information with minimum checkout amounts.
 *     tags: [Users]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Deposit addresses retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 addresses:
 *                   type: array
 *                   description: Enriched deposit addresses with chain information
 *                   items:
 *                     type: object
 *                     properties:
 *                       chain:
 *                         type: string
 *                         example: "Polygon"
 *                       address:
 *                         type: string
 *                         example: "0x7d597d8ce27e13ab65e4613db6dcfcbbdde8816a"
 *                       minCheckoutUsd:
 *                         type: number
 *                         example: 2
 *                       token:
 *                         type: string
 *                         example: "USDC.e"
 *                 note:
 *                   type: string
 *                   description: Additional information about supported assets
 *                   example: "Only certain chains and tokens are supported. See /supported-assets for details."
 *       400:
 *         description: User does not have a proxy wallet
 *       404:
 *         description: User not found
 *       500:
 *         description: Error fetching deposit addresses
 */
router.post('/:privyUserId/deposit-addresses', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.params;

    // Get user and verify they have a proxy wallet
    const user = await getUserByPrivyId(privyUserId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    if (!user.proxyWalletAddress) {
      return res.status(400).json({
        success: false,
        error: 'User does not have a proxy wallet. Please deploy a proxy wallet first.',
      });
    }

    logger.info({
      message: 'Fetching deposit addresses from Polymarket bridge',
      privyUserId,
      proxyWalletAddress: user.proxyWalletAddress,
    });

    // Call Polymarket bridge API to create deposit addresses
    // Ensure no trailing slash on base URL
    let bridgeApiUrl = process.env.POLYMARKET_BRIDGE_API_URL || 'https://bridge.polymarket.com';
    bridgeApiUrl = bridgeApiUrl.replace(/\/$/, ''); // Remove trailing slash if present
    const depositUrl = `${bridgeApiUrl}/deposit`;
    const requestBody = {
      address: user.proxyWalletAddress,
    };
    
    logger.info({
      message: 'Calling Polymarket bridge API for deposit addresses',
      method: 'POST',
      url: depositUrl,
      baseUrl: bridgeApiUrl,
      requestBody,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    
    try {
      const response = await axios.post(
        depositUrl,
        requestBody,
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          timeout: 10000, // 10 second timeout
        }
      );

      logger.info({
        message: 'Successfully fetched deposit addresses from Polymarket bridge',
        privyUserId,
        proxyWalletAddress: user.proxyWalletAddress,
        hasEvm: !!response.data?.address?.evm,
        hasSvm: !!response.data?.address?.svm,
        hasBtc: !!response.data?.address?.btc,
      });

      // Get supported assets to enrich the response
      let supportedAssets: any[] = [];
      try {
        supportedAssets = await getSupportedAssets();
      } catch (assetsError) {
        logger.warn({
          message: 'Failed to fetch supported assets, returning basic deposit addresses',
          error: assetsError instanceof Error ? assetsError.message : String(assetsError),
        });
      }

      // Enrich deposit addresses with chain-specific information
      const enrichedAddresses: any[] = [];
      const depositAddresses = response.data.address || {};

      // Polygon: Use proxy wallet address, find USDC.e token (address: 0x2791bca1f2de4661ed88a30c99a7a9449aa84174)
      const polygonAssets = supportedAssets.filter(
        (asset) => asset.chainId === '137' && asset.chainName === 'Polygon'
      );
      const polygonUsdce = polygonAssets.find(
        (asset) => asset.token?.address?.toLowerCase() === '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
      );
      
      if (polygonUsdce) {
        enrichedAddresses.push({
          chain: 'Polygon',
          address: user.proxyWalletAddress, // Use proxy wallet for Polygon
          minCheckoutUsd: polygonUsdce.minCheckoutUsd,
          token: 'USDC.e',
        });
      }

      // Ethereum: Use evm address, find USDC token (address: 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)
      if (depositAddresses.evm) {
        const ethereumAssets = supportedAssets.filter(
          (asset) => asset.chainId === '1' && asset.chainName === 'Ethereum'
        );
        const ethereumUsdc = ethereumAssets.find(
          (asset) => asset.token?.address?.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
        );
        
        if (ethereumUsdc) {
          enrichedAddresses.push({
            chain: 'Ethereum',
            address: depositAddresses.evm,
            minCheckoutUsd: ethereumUsdc.minCheckoutUsd,
            token: 'USDC',
          });
        }
      }

      // Solana: Use svm address, find SOL token (address: 11111111111111111111111111111111)
      if (depositAddresses.svm) {
        const solanaAssets = supportedAssets.filter(
          (asset) => asset.chainId === '1151111081099710' && asset.chainName === 'Solana'
        );
        const solanaSol = solanaAssets.find(
          (asset) => asset.token?.address === '11111111111111111111111111111111'
        );
        
        if (solanaSol) {
          enrichedAddresses.push({
            chain: 'Solana',
            address: depositAddresses.svm,
            minCheckoutUsd: solanaSol.minCheckoutUsd,
            token: 'SOL',
          });
        }
      }

      // Base: Use evm address (same as Ethereum), find USDC token (address: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)
      const baseAssets = supportedAssets.filter(
        (asset) => asset.chainId === '8453' && asset.chainName === 'Base'
      );
      if (baseAssets.length > 0 && depositAddresses.evm) {
        const baseUsdc = baseAssets.find(
          (asset) => asset.token?.address?.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
        );
        
        if (baseUsdc) {
          enrichedAddresses.push({
            chain: 'Base',
            address: depositAddresses.evm, // Base uses the same evm address
            minCheckoutUsd: baseUsdc.minCheckoutUsd,
            token: 'USDC',
          });
        }
      }

      logger.info({
        message: 'Enriched deposit addresses with chain information',
        privyUserId,
        enrichedCount: enrichedAddresses.length,
        chains: enrichedAddresses.map((a) => a.chain),
      });

      res.json({
        success: true,
        addresses: enrichedAddresses,
        note: response.data.note || 'Only certain chains and tokens are supported. See /supported-assets for details.',
      });
    } catch (bridgeError) {
      const axiosError = bridgeError as AxiosError;
      
      logger.error({
        message: 'Error calling Polymarket bridge API',
        privyUserId,
        proxyWalletAddress: user.proxyWalletAddress,
        status: axiosError.response?.status,
        statusText: axiosError.response?.statusText,
        error: axiosError.message,
        responseData: axiosError.response?.data,
      });

      if (axiosError.response) {
        // Forward the error response from Polymarket bridge API
        return res.status(axiosError.response.status).json({
          success: false,
          error: axiosError.response.data || axiosError.message,
        });
      }

      // Network or timeout error
      throw new Error(`Failed to connect to Polymarket bridge API: ${axiosError.message}`);
    }
  } catch (error) {
    logger.error({
      message: 'Error fetching deposit addresses',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: extractErrorMessage(error),
    });
  }
});

export default router;
