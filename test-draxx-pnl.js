/**
 * Test P&L calculation for Draxx user
 * Run with: docker compose exec app node test-draxx-pnl.js
 */

const DRAXX_PRIVY_USER_ID = 'did:privy:cmj921f4201dql40c3nubss93';

async function testPnL() {
  try {
    // Import the service
    const { calculatePnLSnapshot, calculateRealizedPnl, calculateNetInvested } = require('./dist/services/positions/pnl-tracking.service.js');
    const { getPortfolioSummary } = require('./dist/services/positions/positions.service.js');
    const { getBalanceFromDb } = require('./dist/services/alchemy/balance.service.js');
    const { getUserByPrivyId } = require('./dist/services/privy/user.service.js');
    const { pool } = require('./dist/config/database.js');

    console.log('\n=== Testing P&L Calculation for Draxx ===\n');
    console.log('User ID:', DRAXX_PRIVY_USER_ID);

    // Get user info
    const user = await getUserByPrivyId(DRAXX_PRIVY_USER_ID);
    console.log('\n1. User Info:');
    console.log('   Proxy Wallet:', user?.proxyWalletAddress || 'N/A');

    // Get current balance
    let balance = 0;
    if (user?.proxyWalletAddress) {
      const balanceResult = await getBalanceFromDb(user.proxyWalletAddress);
      balance = parseFloat(balanceResult?.balanceHuman || '0');
      console.log('\n2. Current Balance:', `$${balance.toFixed(2)}`);
    }

    // Get portfolio summary
    console.log('\n3. Portfolio Summary:');
    const portfolioSummary = await getPortfolioSummary(DRAXX_PRIVY_USER_ID);
    console.log('   Portfolio Value:', `$${portfolioSummary.portfolio.toFixed(2)}`);
    console.log('   Active Positions:', portfolioSummary.totalPositions);
    console.log('   Unrealized P&L:', `$${portfolioSummary.totalPnl.toFixed(2)}`);

    // Calculate net invested
    console.log('\n4. Trade History Analysis:');
    const client = await pool.connect();
    try {
      // Get trade statistics
      const tradeStats = await client.query(
        `SELECT 
          COUNT(*) as total_trades,
          SUM(CASE WHEN side = 'BUY' THEN cost_usdc ELSE 0 END) as total_buy_cost,
          SUM(CASE WHEN side = 'SELL' AND price < 0.99 THEN cost_usdc ELSE 0 END) as total_sell_proceeds,
          SUM(CASE WHEN side = 'SELL' AND price >= 0.99 THEN size * 1.0 ELSE 0 END) as total_redeem_proceeds
         FROM trades_history
         WHERE privy_user_id = $1 AND status = 'FILLED'`,
        [DRAXX_PRIVY_USER_ID]
      );

      const stats = tradeStats.rows[0];
      const totalBuyCost = parseFloat(stats.total_buy_cost || '0');
      const totalSellProceeds = parseFloat(stats.total_sell_proceeds || '0');
      const totalRedeemProceeds = parseFloat(stats.total_redeem_proceeds || '0');
      
      console.log('   Total Trades:', stats.total_trades);
      console.log('   Total BUY Cost:', `$${totalBuyCost.toFixed(2)}`);
      console.log('   Total SELL Proceeds:', `$${totalSellProceeds.toFixed(2)}`);
      console.log('   Total REDEEM Proceeds:', `$${totalRedeemProceeds.toFixed(2)}`);
      console.log('   Net Cash Flow (BUY - SELL/REDEEM):', `$${(totalBuyCost - totalSellProceeds - totalRedeemProceeds).toFixed(2)}`);

      // Get withdrawals
      const withdrawalStats = await client.query(
        `SELECT COALESCE(SUM(amount_usdc), 0) as total_withdrawn
         FROM withdrawals
         WHERE privy_user_id = $1 AND status = 'SUCCESS'`,
        [DRAXX_PRIVY_USER_ID]
      );
      const totalWithdrawn = parseFloat(withdrawalStats.rows[0]?.total_withdrawn || '0');
      console.log('   Total Withdrawn:', `$${totalWithdrawn.toFixed(2)}`);
      
      const netInvested = (totalBuyCost - totalSellProceeds - totalRedeemProceeds) + totalWithdrawn;
      console.log('   Net Invested:', `$${netInvested.toFixed(2)}`);
    } finally {
      client.release();
    }

    // Calculate comprehensive P&L
    console.log('\n5. Comprehensive P&L Calculation:');
    const snapshot = await calculatePnLSnapshot(DRAXX_PRIVY_USER_ID);
    console.log('   Total P&L:', `$${snapshot.totalPnl.toFixed(2)}`);
    console.log('   Realized P&L:', `$${snapshot.realizedPnl.toFixed(2)}`);
    console.log('   Unrealized P&L:', `$${snapshot.unrealizedPnl.toFixed(2)}`);
    console.log('   Portfolio Value:', `$${snapshot.portfolioValue.toFixed(2)}`);
    console.log('   USDC Balance:', `$${snapshot.usdcBalance.toFixed(2)}`);
    console.log('   Total Value:', `$${snapshot.totalValue.toFixed(2)}`);
    console.log('   Total % P&L:', `${snapshot.totalPercentPnl.toFixed(2)}%`);

    console.log('\n=== Test Complete ===\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

testPnL();

