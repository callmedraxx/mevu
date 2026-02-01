/**
 * Webhook Routes
 * Handles incoming webhooks from external services (Alchemy, etc.)
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { alchemyWebhookService } from '../services/alchemy/alchemy-webhook.service';

const router = Router();

/**
 * @swagger
 * tags:
 *   - name: Webhooks
 *     description: Webhook endpoints for external service integrations
 */

/**
 * @swagger
 * /api/webhooks/alchemy:
 *   post:
 *     summary: Receive Alchemy Address Activity webhook notifications
 *     description: Endpoint for Alchemy to send USDC.e transfer notifications. Updates user balances in real-time.
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               webhookId:
 *                 type: string
 *               id:
 *                 type: string
 *               createdAt:
 *                 type: string
 *               type:
 *                 type: string
 *                 enum: [ADDRESS_ACTIVITY]
 *               event:
 *                 type: object
 *                 properties:
 *                   network:
 *                     type: string
 *                   activity:
 *                     type: array
 *                     items:
 *                       type: object
 *     responses:
 *       200:
 *         description: Webhook processed successfully
 *       401:
 *         description: Invalid signature
 *       500:
 *         description: Error processing webhook
 */
router.post('/alchemy', async (req: Request, res: Response) => {
  try {
    // Get raw body for signature verification
    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-alchemy-signature'] as string;

    // Verify signature if signing key is configured
    if (signature && !alchemyWebhookService.verifySignature(rawBody, signature)) {
      logger.warn({
        message: 'Invalid Alchemy webhook signature',
        webhookId: req.body?.webhookId,
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = req.body;

    // logger.info({
    //   message: 'Received Alchemy webhook',
    //   webhookId: payload.webhookId,
    //   type: payload.type,
    //   activityCount: payload.event?.activity?.length || 0,
    // });

    // Process the webhook asynchronously
    // Respond immediately to avoid timeout
    res.status(200).json({ success: true, message: 'Webhook received' });

    // Process in background
    try {
      await alchemyWebhookService.processWebhook(payload);
    } catch (processError) {
      logger.error({
        message: 'Error processing Alchemy webhook',
        webhookId: payload.webhookId,
        error: processError instanceof Error ? processError.message : String(processError),
      });
    }
  } catch (error) {
    logger.error({
      message: 'Error handling Alchemy webhook',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Still return 200 to prevent Alchemy from retrying
    res.status(200).json({ success: false, error: 'Processing error' });
  }
});

/**
 * @swagger
 * /api/webhooks/alchemy/test:
 *   post:
 *     summary: Test webhook endpoint (for development)
 *     description: Simulates an Alchemy webhook for testing purposes
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               address:
 *                 type: string
 *                 description: Proxy wallet address to test
 *               amount:
 *                 type: string
 *                 description: Amount in USDC
 *               type:
 *                 type: string
 *                 enum: [in, out]
 *     responses:
 *       200:
 *         description: Test webhook processed
 */
router.post('/alchemy/test', async (req: Request, res: Response) => {
  try {
    const { address, amount = '1', type = 'in' } = req.body;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Create a mock webhook payload
    const mockPayload = {
      webhookId: 'test-webhook',
      id: `test-${Date.now()}`,
      createdAt: new Date().toISOString(),
      type: 'ADDRESS_ACTIVITY',
      event: {
        network: 'MATIC_MAINNET',
        activity: [
          {
            blockNum: '0x' + (50000000).toString(16),
            hash: '0x' + 'test'.padEnd(64, '0'),
            fromAddress: type === 'in' ? '0x0000000000000000000000000000000000000000' : address,
            toAddress: type === 'in' ? address : '0x0000000000000000000000000000000000000000',
            value: parseFloat(amount),
            asset: 'USDC',
            category: 'token',
            rawContract: {
              rawValue: '0x' + (parseFloat(amount) * 1e6).toString(16),
              address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
              decimals: 6,
            },
          },
        ],
      },
    };

    await alchemyWebhookService.processWebhook(mockPayload as any);

    res.json({
      success: true,
      message: 'Test webhook processed',
      payload: mockPayload,
    });
  } catch (error) {
    logger.error({
      message: 'Error processing test webhook',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * @swagger
 * /api/webhooks/alchemy/status:
 *   get:
 *     summary: Get Alchemy webhook service status
 *     tags: [Webhooks]
 *     responses:
 *       200:
 *         description: Webhook service status
 */
router.get('/alchemy/status', async (req: Request, res: Response) => {
  res.json({
    success: true,
    isReady: alchemyWebhookService.isReady(),
    webhookConfigured: !!process.env.ALCHEMY_WEBHOOK_ID || !!process.env.ALCHEMY_WEBHOOK_URL,
    authTokenConfigured: !!process.env.ALCHEMY_AUTH_TOKEN,
    signingKeyConfigured: !!process.env.ALCHEMY_SIGNING_KEY,
  });
});

/**
 * @swagger
 * /api/webhooks/deposits/stream/{privyUserId}:
 *   get:
 *     summary: Stream real-time deposit notifications via SSE
 *     description: Opens an SSE connection that streams deposit notifications when USDC.e is deposited to the user's proxy wallet
 *     tags: [Webhooks]
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
 *         description: SSE stream opened successfully
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: object
 *               properties:
 *                 type:
 *                   type: string
 *                   enum: [deposit, connected, heartbeat]
 *                 amount:
 *                   type: string
 *                   description: Human-readable deposit amount
 *                 txHash:
 *                   type: string
 *                   description: Transaction hash
 *                 newBalance:
 *                   type: string
 *                   description: New balance after deposit
 *       400:
 *         description: Invalid request
 */
router.get('/deposits/stream/:privyUserId', async (req: Request, res: Response) => {
  const { privyUserId } = req.params;

  if (!privyUserId) {
    return res.status(400).json({ error: 'privyUserId is required' });
  }

  // logger.info({
  //   message: 'Opening deposit notification SSE stream',
  //   privyUserId,
  // });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send connected message
  res.write(`data: ${JSON.stringify({ type: 'connected', privyUserId, timestamp: new Date().toISOString() })}\n\n`);

  // Subscribe to deposit notifications
  const unsubscribe = alchemyWebhookService.subscribeToDeposits(privyUserId, (notification) => {
    try {
      res.write(`data: ${JSON.stringify(notification)}\n\n`);
    } catch (error) {
      logger.error({
        message: 'Error writing deposit notification to SSE stream',
        privyUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Keep connection alive with periodic heartbeat
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(`: heartbeat\n\n`);
    } catch (error) {
      clearInterval(heartbeatInterval);
      unsubscribe();
    }
  }, 30000); // Every 30 seconds

  // Handle client disconnect
  req.on('close', () => {
    // logger.info({
    //   message: 'Deposit notification SSE stream closed',
    //   privyUserId,
    // });
    clearInterval(heartbeatInterval);
    unsubscribe();
    res.end();
  });
});

export default router;
