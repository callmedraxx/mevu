/**
 * Script to update user token approval statuses
 * Usage: npx tsx src/scripts/update-user-approvals.ts <privyUserId> <usdcEnabled> <ctfEnabled>
 * Example: npx tsx src/scripts/update-user-approvals.ts did:privy:cmj921f4201dql40c3nubss93 true true
 */

import { updateUserTokenApprovals } from '../services/privy/user.service';
import { logger } from '../config/logger';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.error('Usage: npx tsx src/scripts/update-user-approvals.ts <privyUserId> <usdcEnabled> <ctfEnabled>');
    console.error('Example: npx tsx src/scripts/update-user-approvals.ts did:privy:cmj921f4201dql40c3nubss93 true true');
    process.exit(1);
  }

  const [privyUserId, usdcEnabledStr, ctfEnabledStr] = args;
  
  const usdcEnabled = usdcEnabledStr.toLowerCase() === 'true';
  const ctfEnabled = ctfEnabledStr.toLowerCase() === 'true';

  try {
    logger.info({
      message: 'Updating user token approval statuses',
      privyUserId,
      usdcEnabled,
      ctfEnabled,
    });

    const updatedUser = await updateUserTokenApprovals(
      privyUserId,
      usdcEnabled,
      ctfEnabled
    );

    if (!updatedUser) {
      logger.error({
        message: 'User not found',
        privyUserId,
      });
      console.error(`User not found: ${privyUserId}`);
      process.exit(1);
    }

    logger.info({
      message: 'Successfully updated user token approval statuses',
      privyUserId,
      userId: updatedUser.id,
      username: updatedUser.username,
      usdcApprovalEnabled: updatedUser.usdcApprovalEnabled,
      ctfApprovalEnabled: updatedUser.ctfApprovalEnabled,
    });

    console.log('\n✅ Successfully updated user token approval statuses:');
    console.log(JSON.stringify({
      id: updatedUser.id,
      privyUserId: updatedUser.privyUserId,
      username: updatedUser.username,
      usdcApprovalEnabled: updatedUser.usdcApprovalEnabled,
      ctfApprovalEnabled: updatedUser.ctfApprovalEnabled,
    }, null, 2));

    process.exit(0);
  } catch (error) {
    logger.error({
      message: 'Failed to update user token approval statuses',
      privyUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
