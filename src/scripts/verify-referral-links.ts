/**
 * Script to verify referral codes and show referral links in the new format
 * This script shows all users' referral codes and generates their referral links
 * using the updated format (/?ref=CODE instead of /signup?ref=CODE)
 */

import { pool, getDatabaseConfig } from '../config/database';
import { logger } from '../config/logger';
import { getReferralLink } from '../services/referral/referral.service';

const REFERRAL_BASE_URL = process.env.REFERRAL_BASE_URL || 'https://app.mevu.com';

async function verifyReferralLinks() {
  const dbConfig = getDatabaseConfig();
  
  if (dbConfig.type !== 'postgres') {
    console.log('⚠️  This script only works with PostgreSQL database');
    process.exit(1);
  }

  const client = await pool.connect();
  
  try {
    console.log('\n📋 Verifying referral codes and generating updated referral links...\n');
    
    // Get all users with their referral codes
    const result = await client.query(`
      SELECT 
        id,
        privy_user_id,
        username,
        referral_code,
        referral_code_created_at,
        created_at
      FROM users
      ORDER BY created_at DESC
    `);

    const users = result.rows;
    const totalUsers = users.length;
    const usersWithCodes = users.filter(u => u.referral_code).length;
    const usersWithoutCodes = totalUsers - usersWithCodes;

    console.log(`Total users: ${totalUsers}`);
    console.log(`Users with referral codes: ${usersWithCodes}`);
    console.log(`Users without referral codes: ${usersWithoutCodes}\n`);

    if (users.length === 0) {
      console.log('No users found in the database.');
      process.exit(0);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('USER REFERRAL LINKS (New Format: /?ref=CODE)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    for (const user of users) {
      const username = user.username || 'N/A';
      const privyUserId = user.privy_user_id;
      const referralCode = user.referral_code;
      
      if (referralCode) {
        // Generate referral link using the updated service (which now uses /?ref=CODE)
        try {
          const referralLink = await getReferralLink(privyUserId);
          console.log(`👤 ${username}`);
          console.log(`   Code: ${referralCode}`);
          console.log(`   Link: ${referralLink}`);
          console.log(`   Created: ${user.referral_code_created_at ? new Date(user.referral_code_created_at).toLocaleString() : 'N/A'}\n`);
        } catch (error) {
          console.log(`👤 ${username}`);
          console.log(`   Code: ${referralCode}`);
          console.log(`   Link: ${REFERRAL_BASE_URL}/?ref=${referralCode} (manually generated)`);
          console.log(`   ⚠️  Error generating link: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      } else {
        console.log(`👤 ${username}`);
        console.log(`   ⚠️  No referral code (will be generated on first request)`);
        console.log(`   User ID: ${privyUserId}\n`);
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\n✅ Verification complete!');
    console.log('\n📝 Note: Referral links are generated dynamically, so all new requests');
    console.log('   will automatically use the new format (/?ref=CODE).');
    console.log('   Old links with /signup?ref=CODE will be redirected automatically.\n');

  } catch (error) {
    logger.error({
      message: 'Error verifying referral links',
      error: error instanceof Error ? error.message : String(error),
    });
    
    console.error('❌ Error verifying referral links:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

verifyReferralLinks();

