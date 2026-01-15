/**
 * Wallets API Routes
 * Handles wallet creation and management operations
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { privyService } from '../services/privy';
import { transferFromEmbeddedToProxy } from '../services/privy/embedded-to-proxy-transfer.service';
import { depositProgressService, DepositProgressEvent } from '../services/privy/deposit-progress.service';

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
    const walletResult = await privyService.createEmbeddedWallet(privyUserId);
    const walletAddress = walletResult.address;

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

/**
 * @swagger
 * /api/wallets/transfer-to-proxy:
 *   post:
 *     summary: Transfer USDC from embedded wallet to proxy wallet
 *     description: Transfers all available USDC from the user's embedded wallet to their proxy wallet. Automatically swaps Native USDC to USDC.e if needed.
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
 *               amountUsdc:
 *                 type: number
 *                 description: Optional specific amount to transfer (transfers all if omitted)
 *                 example: 10.5
 *     responses:
 *       200:
 *         description: Transfer successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transactionHash:
 *                   type: string
 *                   example: "0x123..."
 *                 fromAddress:
 *                   type: string
 *                 toAddress:
 *                   type: string
 *                 amountUsdc:
 *                   type: string
 *       400:
 *         description: Bad request - missing privyUserId
 *       500:
 *         description: Transfer failed
 */
router.post('/transfer-to-proxy', async (req: Request, res: Response) => {
  const { privyUserId, amountUsdc } = req.body;

  if (!privyUserId) {
    return res.status(400).json({
      success: false,
      error: 'privyUserId is required',
    });
  }

  logger.info({
    message: 'Transfer to proxy wallet requested',
    privyUserId,
    amountUsdc,
  });

  try {
    const result = await transferFromEmbeddedToProxy({
      privyUserId,
      amountUsdc,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Transfer failed';
    logger.error({
      message: 'Transfer to proxy wallet failed',
      privyUserId,
      error: errorMessage,
    });

    res.status(500).json({
      success: false,
      error: errorMessage,
    });
  }
});

/**
 * @swagger
 * /api/wallets/deposit-progress/{privyUserId}:
 *   get:
 *     summary: Stream deposit progress updates via SSE
 *     description: Opens an SSE connection for real-time deposit progress updates as funds move through the auto-transfer pipeline
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: SSE stream established
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 */
router.get('/deposit-progress/:privyUserId', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  if (!privyUserId) {
    return res.status(400).json({
      success: false,
      error: 'privyUserId is required',
    });
  }

  logger.info({
    message: '[DEPOSIT-PROGRESS] SSE connection opened',
    privyUserId,
  });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial state with any active deposits
  const activeDeposits = depositProgressService.getAllDepositsForUser(privyUserId);
  res.write(`data: ${JSON.stringify({ 
    type: 'initial', 
    deposits: activeDeposits 
  })}\n\n`);

  // Listen for progress updates for this user
  const progressListener = (event: DepositProgressEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (error) {
      logger.error({
        message: '[DEPOSIT-PROGRESS] Error writing to SSE',
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  depositProgressService.on(`progress:${privyUserId}`, progressListener);

  // Heartbeat to keep connection alive
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch {
      clearInterval(heartbeatInterval);
      depositProgressService.off(`progress:${privyUserId}`, progressListener);
    }
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    depositProgressService.off(`progress:${privyUserId}`, progressListener);
    
    logger.info({
      message: '[DEPOSIT-PROGRESS] SSE connection closed',
      privyUserId,
    });
    
    res.end();
  });
});

/**
 * @swagger
 * /api/wallets/deposit-progress/{privyUserId}/active:
 *   get:
 *     summary: Get active deposits for a user
 *     description: Returns any deposits currently in progress for the user
 *     tags: [Wallets]
 *     parameters:
 *       - in: path
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: User's Privy ID
 *     responses:
 *       200:
 *         description: Active deposits retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 deposits:
 *                   type: array
 */
router.get('/deposit-progress/:privyUserId/active', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  if (!privyUserId) {
    return res.status(400).json({
      success: false,
      error: 'privyUserId is required',
    });
  }

  const activeDeposits = depositProgressService.getActiveDepositsForUser(privyUserId);

  res.json({
    success: true,
    deposits: activeDeposits,
    hasActiveDeposit: activeDeposits.length > 0,
  });
});

export default router;
