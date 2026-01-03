/**
 * Test P&L Tracking Script
 * Tests the P&L tracking endpoints with Draxx account
 */

import { calculatePnLSnapshot, getHistoricalPnL, updatePnLSnapshot } from '../services/positions/pnl-tracking.service';
import { logger } from '../config/logger';

// Draxx account details
const DRAXX_PRIVY_USER_ID = 'did:privy:cmj921f4201dql40c3nubss93';

async function testPnLTracking() {
  try {
    logger.info({
      message: 'Starting P&L tracking test',
      privyUserId: DRAXX_PRIVY_USER_ID,
    });

    // Test 1: Calculate current P&L snapshot
    console.log('\n1. Calculating current P&L snapshot...');
    const snapshot = await calculatePnLSnapshot(DRAXX_PRIVY_USER_ID);
    console.log('✅ P&L Snapshot:');
    console.log(`   Total P&L: $${snapshot.totalPnl.toFixed(2)}`);
    console.log(`   Realized P&L: $${snapshot.realizedPnl.toFixed(2)}`);
    console.log(`   Unrealized P&L: $${snapshot.unrealizedPnl.toFixed(2)}`);
    console.log(`   Portfolio Value: $${snapshot.portfolioValue.toFixed(2)}`);
    console.log(`   USDC Balance: $${snapshot.usdcBalance.toFixed(2)}`);
    console.log(`   Total Value: $${snapshot.totalValue.toFixed(2)}`);
    console.log(`   Total % P&L: ${snapshot.totalPercentPnl.toFixed(2)}%`);
    console.log(`   Active Positions: ${snapshot.activePositionsCount}`);
    console.log(`   Total Positions: ${snapshot.totalPositionsCount}`);

    // Test 2: Store snapshot
    console.log('\n2. Storing P&L snapshot...');
    await updatePnLSnapshot(DRAXX_PRIVY_USER_ID);
    console.log('✅ Snapshot stored successfully');

    // Test 3: Get historical P&L data
    console.log('\n3. Fetching historical P&L data...');
    const historicalData = await getHistoricalPnL(DRAXX_PRIVY_USER_ID, {
      days: 30,
      limit: 100,
    });
    console.log(`✅ Found ${historicalData.length} historical data points`);
    if (historicalData.length > 0) {
      console.log('   Sample data points:');
      historicalData.slice(0, 3).forEach((point, index) => {
        console.log(`   ${index + 1}. ${point.date}: $${point.totalPnl.toFixed(2)}`);
      });
    }

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Test failed:');
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run the test
testPnLTracking()
  .then(() => {
    console.log('\n✅ Test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  });

