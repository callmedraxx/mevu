/**
 * Announcement banner API
 * Returns configurable messages for the frontend announcement banner.
 * Configure via ANNOUNCEMENT_BANNER_MESSAGES (comma-separated) or ANNOUNCEMENT_BANNER_MESSAGE (single).
 */

import { Router, Request, Response } from 'express';

const DEFAULT_MESSAGE = 'Kalshi prices for certain games may update within 24–48 hours of game start.';

function getAnnouncements(): string[] {
  const multi = process.env.ANNOUNCEMENT_BANNER_MESSAGES;
  const single = process.env.ANNOUNCEMENT_BANNER_MESSAGE;
  if (multi) {
    return multi.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (single) {
    return [single.trim()];
  }
  return [DEFAULT_MESSAGE];
}

const router = Router();

/**
 * @swagger
 * /api/announcements:
 *   get:
 *     summary: Get announcement banner messages
 *     description: Returns messages for the frontend announcement banner. Configure via ANNOUNCEMENT_BANNER_MESSAGES or ANNOUNCEMENT_BANNER_MESSAGE.
 *     tags: [Config]
 *     responses:
 *       200:
 *         description: List of announcement messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 announcements:
 *                   type: array
 *                   items:
 *                     type: string
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({ announcements: getAnnouncements() });
});

export default router;
