/**
 * Test Trading Script
 * Tests buy/sell functionality with Draxx account
 */

import { executeTrade } from '../services/polymarket/trading/trading.service';
import { getTradeHistory } from '../services/polymarket/trading/trades-history.service';
import { TradeSide, OrderType } from '../services/polymarket/trading/trading.types';
import { logger } from '../config/logger';

// Draxx account details from database
const DRAXX_PRIVY_USER_ID = 'did:privy:cmj921f4201dql40c3nubss93';

async function testTrading() {
  try {
    logger.info({
      message: 'Starting trading test',
      privyUserId: DRAXX_PRIVY_USER_ID,
    });

    // Example market info - you'll need to replace with actual market data
    // Get a real clobTokenId from Polymarket API
    const testMarketInfo = {
      marketId: 'test-market-id',
      marketQuestion: 'Test Market Question',
      clobTokenId: '16678291189211314787145083999015737376658799626130630684070927984975568281601', // Example - replace with real token ID
      outcome: 'Yes',
      metadata: {
        test: true,
      },
    };

    // Test buy order
    logger.info({
      message: 'Testing buy order',
    });

    const buyResult = await executeTrade({
      privyUserId: DRAXX_PRIVY_USER_ID,
      marketInfo: testMarketInfo,
      side: TradeSide.BUY,
      orderType: OrderType.FOK,
      size: '1', // Buy 1 share
      price: '0.50', // At 50 cents per share
    });

    logger.info({
      message: 'Buy order result',
      result: buyResult,
    });

    if (buyResult.success) {
      console.log('\n✅ Buy order successful!');
      console.log(`Order ID: ${buyResult.orderId}`);
      console.log(`Status: ${buyResult.status}`);
      if (buyResult.transactionHash) {
        console.log(`Transaction Hash: ${buyResult.transactionHash}`);
      }
    } else {
      console.log('\n❌ Buy order failed');
      console.log(`Error: ${buyResult.message}`);
    }

    // Wait a bit before checking history
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get trade history
    logger.info({
      message: 'Fetching trade history',
    });

    const history = await getTradeHistory({
      privyUserId: DRAXX_PRIVY_USER_ID,
      limit: 10,
    });

    console.log('\n📊 Trade History:');
    console.log(`Total trades: ${history.length}`);
    history.forEach((trade, index) => {
      console.log(`\nTrade ${index + 1}:`);
      console.log(`  Side: ${trade.side}`);
      console.log(`  Size: ${trade.size} shares`);
      console.log(`  Price: $${trade.price}`);
      console.log(`  Cost: $${trade.costUsdc} USDC`);
      console.log(`  Status: ${trade.status}`);
      console.log(`  Order ID: ${trade.orderId}`);
    });

    logger.info({
      message: 'Trading test completed',
    });
  } catch (error) {
    logger.error({
      message: 'Trading test failed',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run test if executed directly
if (require.main === module) {
  testTrading()
    .then(() => {
      logger.info({ message: 'Trading test script completed successfully' });
      process.exit(0);
    })
    .catch((error) => {
      logger.error({
        message: 'Trading test script failed',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}

export { testTrading };
