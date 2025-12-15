/**
 * Script to delete all users from the database
 * WARNING: This will delete ALL users!
 */

import { deleteAllUsers } from '../services/privy/user.service';
import { logger } from '../config/logger';

async function main() {
  try {
    logger.info({ message: 'Starting deletion of all users...' });
    
    const count = await deleteAllUsers();
    
    logger.info({ 
      message: 'Successfully deleted all users',
      deletedCount: count,
    });
    
    console.log(`✅ Deleted ${count} users from the database`);
    process.exit(0);
  } catch (error) {
    logger.error({
      message: 'Failed to delete all users',
      error: error instanceof Error ? error.message : String(error),
    });
    
    console.error('❌ Error deleting users:', error);
    process.exit(1);
  }
}

main();
