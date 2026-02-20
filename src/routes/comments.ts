/**
 * Comments Routes
 * Polymarket comments for markets/events, with request coalescing on the backend.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getCommentsBySlug } from '../services/polymarket/polymarket-comments.service';

const router = Router();

/**
 * @swagger
 * /api/comments/{slug}:
 *   get:
 *     summary: Get comments for a market by slug
 *     description: |
 *       Fetches Polymarket comments for the given market/event slug.
 *       Uses request coalescing: concurrent requests for the same slug share a single
 *       Polymarket API call. Works for crypto and politics markets.
 *     tags: [Comments]
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema:
 *           type: string
 *         description: Market or event slug (e.g. btc-updown-15m-1771235100)
 *     responses:
 *       200:
 *         description: List of comments
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 comments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       body: { type: string }
 *                       user: { type: string }
 *                       userImage: { type: string }
 *                       time: { type: string }
 *                       likes: { type: integer }
 *       500:
 *         description: Server error
 */
router.get('/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;
    if (!slug) {
      return res.status(400).json({ success: false, error: 'Slug is required' });
    }

    const comments = await getCommentsBySlug(slug);
    return res.json({
      success: true,
      comments,
    });
  } catch (error) {
    logger.error({
      message: 'Error fetching comments',
      slug: req.params.slug,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch comments',
    });
  }
});

export default router;
