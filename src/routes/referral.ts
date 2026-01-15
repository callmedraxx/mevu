/**
 * Referral API Routes
 * Handles referral link generation, statistics, and earnings tracking
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import {
  getReferralLink,
  getReferralStats,
  getReferralEarnings,
  getReferralBalance,
  getReferredUsers,
} from '../services/referral/referral.service';

const router = Router();

/**
 * @swagger
 * tags:
 *   - name: Referral
 *     description: Referral program endpoints
 */

/**
 * @swagger
 * /api/referral/link:
 *   get:
 *     summary: Get user's referral link
 *     description: Returns the unique referral link for the authenticated user
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Referral link retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 referralLink:
 *                   type: string
 *                   example: "https://app.mevu.com/?ref=ABC12345"
 *                 referralCode:
 *                   type: string
 *                   example: "ABC12345"
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/link', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.query;

    if (!privyUserId || typeof privyUserId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    const referralLink = await getReferralLink(privyUserId);
    const referralCode = referralLink.split('ref=')[1] || '';

    res.json({
      success: true,
      referralLink,
      referralCode,
    });
  } catch (error) {
    logger.error({
      message: 'Error getting referral link',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get referral link',
    });
  }
});

/**
 * @swagger
 * /api/referral/stats:
 *   get:
 *     summary: Get referral statistics
 *     description: Returns referral statistics including total referrals, earnings, and balance
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Referral statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalReferrals:
 *                       type: number
 *                       example: 10
 *                     totalEarnings:
 *                       type: number
 *                       example: 250.50
 *                     lifetimeEarnings:
 *                       type: number
 *                       example: 250.50
 *                     withdrawableBalance:
 *                       type: number
 *                       example: 200.00
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.query;

    if (!privyUserId || typeof privyUserId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    const stats = await getReferralStats(privyUserId);

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    logger.error({
      message: 'Error getting referral stats',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get referral stats',
    });
  }
});

/**
 * @swagger
 * /api/referral/earnings:
 *   get:
 *     summary: Get referral earnings history
 *     description: Returns paginated list of referral earnings from trades
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of earnings to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Number of earnings to skip
 *     responses:
 *       200:
 *         description: Earnings history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 earnings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       referredUserId:
 *                         type: string
 *                       referredUsername:
 *                         type: string
 *                       tradeId:
 *                         type: string
 *                       tradeCostUsdc:
 *                         type: number
 *                       platformFeeUsdc:
 *                         type: number
 *                       referralEarningsUsdc:
 *                         type: number
 *                       status:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       creditedAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/earnings', async (req: Request, res: Response) => {
  try {
    const { privyUserId, limit, offset } = req.query;

    if (!privyUserId || typeof privyUserId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    const limitNum = limit ? parseInt(String(limit), 10) : 50;
    const offsetNum = offset ? parseInt(String(offset), 10) : 0;

    const earnings = await getReferralEarnings(privyUserId, limitNum, offsetNum);

    res.json({
      success: true,
      earnings,
    });
  } catch (error) {
    logger.error({
      message: 'Error getting referral earnings',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get referral earnings',
    });
  }
});

/**
 * @swagger
 * /api/referral/balance:
 *   get:
 *     summary: Get current referral earnings balance
 *     description: Returns the current withdrawable referral earnings balance
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *     responses:
 *       200:
 *         description: Balance retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 balance:
 *                   type: number
 *                   example: 200.50
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/balance', async (req: Request, res: Response) => {
  try {
    const { privyUserId } = req.query;

    if (!privyUserId || typeof privyUserId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    const balance = await getReferralBalance(privyUserId);

    res.json({
      success: true,
      balance,
    });
  } catch (error) {
    logger.error({
      message: 'Error getting referral balance',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get referral balance',
    });
  }
});

/**
 * @swagger
 * /api/referral/referrals:
 *   get:
 *     summary: Get list of referred users
 *     description: Returns paginated list of users referred by the authenticated user
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: privyUserId
 *         required: true
 *         schema:
 *           type: string
 *         description: The Privy user ID
 *         example: "did:privy:clx1234567890"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of referrals to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *           minimum: 0
 *         description: Number of referrals to skip
 *     responses:
 *       200:
 *         description: Referrals list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 referrals:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId:
 *                         type: string
 *                       username:
 *                         type: string
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                       totalTrades:
 *                         type: number
 *                       totalEarnings:
 *                         type: number
 *       404:
 *         description: User not found
 *       500:
 *         description: Server error
 */
router.get('/referrals', async (req: Request, res: Response) => {
  try {
    const { privyUserId, limit, offset } = req.query;

    if (!privyUserId || typeof privyUserId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: privyUserId',
      });
    }

    const limitNum = limit ? parseInt(String(limit), 10) : 50;
    const offsetNum = offset ? parseInt(String(offset), 10) : 0;

    const referrals = await getReferredUsers(privyUserId, limitNum, offsetNum);

    res.json({
      success: true,
      referrals,
    });
  } catch (error) {
    logger.error({
      message: 'Error getting referrals list',
      error: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get referrals list',
    });
  }
});

/**
 * @swagger
 * /api/referral/redirect:
 *   get:
 *     summary: Redirect from old signup link to home page
 *     description: Handles backward compatibility for old referral links that point to /signup?ref=CODE. Redirects to home page with the referral code.
 *     tags: [Referral]
 *     parameters:
 *       - in: query
 *         name: ref
 *         required: true
 *         schema:
 *           type: string
 *         description: The referral code
 *         example: "ABC12345"
 *     responses:
 *       302:
 *         description: Redirect to home page with referral code
 *       400:
 *         description: Missing referral code parameter
 */
router.get('/redirect', async (req: Request, res: Response) => {
  try {
    const { ref } = req.query;

    if (!ref || typeof ref !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: ref',
      });
    }

    // Redirect to home page with referral code
    const homeUrl = process.env.REFERRAL_BASE_URL || 'https://app.mevu.com';
    res.redirect(302, `${homeUrl}/?ref=${encodeURIComponent(ref)}`);
  } catch (error) {
    logger.error({
      message: 'Error redirecting referral link',
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Failed to redirect referral link',
    });
  }
});

export default router;

