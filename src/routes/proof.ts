/**
 * Proof KYC Verification Routes
 * Endpoints for checking DFlow Proof verification status and generating deep links.
 */

import { Router, Request, Response } from 'express';
import { logger } from '../config/logger';
import { getUserByPrivyId } from '../services/privy/user.service';
import { checkVerification, generateProofDeepLink } from '../services/proof/proof.service';

const router = Router();

/**
 * GET /api/proof/status?privyUserId={id}
 * Check if a user's Solana wallet is Proof-verified.
 */
router.get('/status', async (req: Request, res: Response) => {
  const privyUserId = req.query.privyUserId as string;
  if (!privyUserId) {
    return res.status(400).json({ success: false, error: 'Missing privyUserId' });
  }

  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const solanaAddress = (user as any).solanaWalletAddress;
    if (!solanaAddress) {
      return res.json({ verified: false, solanaAddress: null });
    }

    const verified = await checkVerification(solanaAddress);
    return res.json({ verified, solanaAddress });
  } catch (error) {
    logger.error({
      message: 'Error checking Proof verification status',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to check verification status' });
  }
});

/**
 * POST /api/proof/create-link
 * Generate a Proof deep link for identity verification.
 * Body: { privyUserId, redirectUri }
 */
router.post('/create-link', async (req: Request, res: Response) => {
  const { privyUserId, redirectUri } = req.body;
  if (!privyUserId || !redirectUri) {
    return res.status(400).json({ success: false, error: 'Missing privyUserId or redirectUri' });
  }

  try {
    const user = await getUserByPrivyId(privyUserId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const solanaAddress = (user as any).solanaWalletAddress;
    const solanaWalletId = (user as any).solanaWalletId;
    if (!solanaAddress || !solanaWalletId) {
      return res.status(400).json({ success: false, error: 'User has no Solana wallet' });
    }

    // Check if already verified (may have verified via external partner)
    const alreadyVerified = await checkVerification(solanaAddress);
    if (alreadyVerified) {
      return res.json({ alreadyVerified: true, url: null });
    }

    const { url } = await generateProofDeepLink(solanaWalletId, solanaAddress, redirectUri);
    return res.json({ url });
  } catch (error) {
    logger.error({
      message: 'Error generating Proof deep link',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
    return res.status(500).json({ success: false, error: 'Failed to generate verification link' });
  }
});

export default router;
