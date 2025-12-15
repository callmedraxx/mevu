/**
 * Wallets API Routes
 * Handles wallet creation and management operations
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { privyService } from '../services/privy';

const router = Router();

/**
 * @swagger
 * tags:
 *   - name: Wallets
 *     description: Wallet creation and management operations
 */

/**
 * @swagger
 * /api/wallets/create:
 *   post:
 *     summary: Create an embedded wallet for a user
 *     description: Creates a Privy embedded wallet for the specified user via Privy's server API
 *     tags: [Wallets]
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
 *                 example: "did:privy:cmj5oegh800h9js0c47xg0it0"
 *     responses:
 *       200:
 *         description: Wallet created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 walletAddress:
 *                   type: string
 *                   example: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0"
 *       400:
 *         description: Invalid request (missing privyUserId)
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
 *                   example: "Missing required field: privyUserId"
 *       500:
 *         description: Server error during wallet creation
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
 *                   example: "Failed to create embedded wallet"
 */
router.post('/create', async (req: Request, res: Response) => {
  try {
    // Log incoming request for debugging
    logger.info({
      message: 'POST /api/wallets/create request received',
      body: req.body,
      headers: req.headers,
    });

    const { privyUserId } = req.body;

    if (!privyUserId) {
      logger.warn({
        message: 'Missing privyUserId in request',
        body: req.body,
      });
      return res.status(400).json({
        success: false,
        error: 'Missing required field: privyUserId',
      });
    }

    // Validate privyUserId format (should start with "did:privy:")
    if (!privyUserId.startsWith('did:privy:')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid privyUserId format. Must start with "did:privy:"',
      });
    }

    // Check if Privy service is initialized
    if (!privyService.isInitialized()) {
      logger.error({
        message: 'Privy service not initialized',
      });
      return res.status(500).json({
        success: false,
        error: 'Privy service not configured. Please check server configuration.',
      });
    }

    logger.info({
      message: 'Creating embedded wallet for user',
      privyUserId,
    });

    // Create the embedded wallet via Privy API
    const walletAddress = await privyService.createEmbeddedWallet(privyUserId);

    logger.info({
      message: 'Embedded wallet created successfully',
      privyUserId,
      walletAddress,
    });

    res.json({
      success: true,
      walletAddress,
    });
  } catch (error) {
    // Enhanced error logging
    const errorDetails: any = {
      message: 'Error creating embedded wallet',
      privyUserId: req.body.privyUserId,
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
    const errorMessage = error instanceof Error ? error.message : 'Failed to create embedded wallet';

    // Check if it's a user-friendly error from Privy
    if (errorMessage.includes('not found') || errorMessage.includes('404')) {
      return res.status(404).json({
        success: false,
        error: 'User not found in Privy. Please ensure the user exists.',
      });
    }

    if (errorMessage.includes('already exists') || errorMessage.includes('409')) {
      // Wallet already exists - return a helpful error message
      return res.status(409).json({
        success: false,
        error: 'Wallet already exists for this user. Please use the existing wallet.',
      });
    }

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

export default router;
