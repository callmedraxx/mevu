/**
 * On-Ramp Webhook Service
 * Handles deposit confirmation webhooks from on-ramp providers
 */

import { logger } from '../../config/logger';
import { updateUserKalshiUsdcBalance } from '../privy/kalshi-user.service';
import { getUserByPrivyId } from '../privy/user.service';
import { publishKalshiPositionUpdate } from '../redis-cluster-broadcast.service';

const ONRAMP_WEBHOOK_SECRET = process.env.ONRAMP_WEBHOOK_SECRET || '';

export interface OnrampWebhookPayload {
  provider: string;
  walletAddress?: string;
  privyUserId?: string;
  amount?: string;
  currency?: string;
  status?: string;
}

/**
 * Process on-ramp deposit webhook
 */
export async function handleOnrampWebhook(
  payload: OnrampWebhookPayload,
  signature?: string
): Promise<{ success: boolean; error?: string }> {
  if (ONRAMP_WEBHOOK_SECRET && signature) {
    // Verify webhook signature (provider-specific)
    // MoonPay/Transak use different verification - stub for now
  }

  const { walletAddress, privyUserId, amount, status } = payload;
  if (status !== 'completed' && status !== 'finished') {
    return { success: true };
  }

  if (!amount || !privyUserId) {
    return { success: false, error: 'Missing amount or privyUserId' };
  }

  const user = await getUserByPrivyId(privyUserId);
  if (!user) {
    return { success: false, error: 'User not found' };
  }

  await updateUserKalshiUsdcBalance(privyUserId, amount);
  publishKalshiPositionUpdate(privyUserId, { type: 'balance_update', amount });

  logger.info({
    message: 'Onramp deposit processed',
    privyUserId,
    amount,
    provider: payload.provider,
  });

  return { success: true };
}
