/**
 * Test Trading Script with Real Market Data
 * Gets a live game from database, picks a market/outcome, and tests trading
 */

import { pool } from '../config/database';
import { executeTrade } from '../services/polymarket/trading/trading.service';
import { getTradeHistory } from '../services/polymarket/trading/trades-history.service';
import { TradeSide, OrderType } from '../services/polymarket/trading/trading.types';
import { logger } from '../config/logger';
import { privyService } from '../services/privy/privy.service';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Draxx account details
const DRAXX_PRIVY_USER_ID = 'did:privy:cmj921f4201dql40c3nubss93';

async function testTradeWithRealMarket() {
  // Initialize Privy service first
  logger.info({
    message: 'Initializing Privy service',
  });
  privyService.initialize();
  const client = await pool.connect();

  try {
    logger.info({
      message: 'Fetching live game from database',
    });

    // Get a live game with markets
    const result = await client.query(
      `SELECT id, title, transformed_data, raw_data 
       FROM live_games 
       WHERE active = true AND closed = false 
       ORDER BY volume_24hr DESC NULLS LAST, liquidity DESC NULLS LAST
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      console.log('❌ No active live games found in database');
      console.log('Please ensure games are being fetched and stored.');
      process.exit(1);
    }

    const game = result.rows[0];
    const transformedData = game.transformed_data;
    const rawData = game.raw_data;

    console.log('\n📊 Found Live Game:');
    console.log(`  ID: ${game.id}`);
    console.log(`  Title: ${game.title}`);

    // Try to get markets from transformed_data or raw_data
    let markets: any[] = [];
    
    if (transformedData?.markets && Array.isArray(transformedData.markets)) {
      markets = transformedData.markets;
    } else if (rawData?.markets && Array.isArray(rawData.markets)) {
      markets = rawData.markets;
    } else if (transformedData?.structuredOutcomes && Array.isArray(transformedData.structuredOutcomes)) {
      // If structuredOutcomes exist, create a market from them
      const structuredOutcomes = transformedData.structuredOutcomes;
      if (structuredOutcomes.length > 0) {
        markets = [{
          id: game.id,
          question: game.title,
          structuredOutcomes: structuredOutcomes,
          clobTokenIds: structuredOutcomes.map((o: any) => o.clobTokenId).filter(Boolean),
        }];
      }
    }

    if (markets.length === 0) {
      console.log('\n❌ No markets found in game data');
      console.log('Game data structure:', JSON.stringify(transformedData, null, 2).substring(0, 500));
      process.exit(1);
    }

    // Pick the first market with clobTokenIds
    let selectedMarket: any = null;
    let selectedOutcome: any = null;

    for (const market of markets) {
      // Check structuredOutcomes first
      if (market.structuredOutcomes && Array.isArray(market.structuredOutcomes)) {
        for (const outcome of market.structuredOutcomes) {
          if (outcome.clobTokenId && outcome.clobTokenId.length > 0) {
            selectedMarket = market;
            selectedOutcome = outcome;
            break;
        }
        }
        if (selectedMarket) break;
      }
      
      // Check clobTokenIds array
      if (market.clobTokenIds && Array.isArray(market.clobTokenIds) && market.clobTokenIds.length > 0) {
        // Get outcomes from market
        const outcomes = market.outcomes || market.structuredOutcomes || [];
        if (outcomes.length > 0 && market.clobTokenIds.length >= outcomes.length) {
          selectedMarket = market;
          selectedOutcome = {
            label: outcomes[0] || 'Yes',
            clobTokenId: market.clobTokenIds[0],
          };
          break;
        }
      }
    }

    if (!selectedMarket || !selectedOutcome) {
      console.log('\n❌ No market with clobTokenIds found');
      console.log('Available markets:', markets.map(m => ({
        id: m.id,
        question: m.question,
        hasClobTokenIds: !!(m.clobTokenIds && m.clobTokenIds.length > 0),
        hasStructuredOutcomes: !!(m.structuredOutcomes && m.structuredOutcomes.length > 0),
      })));
      process.exit(1);
    }

    const clobTokenId = selectedOutcome.clobTokenId || selectedMarket.clobTokenIds?.[0];
    const outcomeLabel = selectedOutcome.label || selectedOutcome.name || 'Yes';
    const marketId = selectedMarket.id || game.id;
    const marketQuestion = selectedMarket.question || game.title;

    console.log('\n🎯 Selected Market:');
    console.log(`  Market ID: ${marketId}`);
    console.log(`  Question: ${marketQuestion}`);
    console.log(`  Outcome: ${outcomeLabel}`);
    console.log(`  CLOB Token ID: ${clobTokenId}`);

    if (!clobTokenId || clobTokenId.length < 10) {
      console.log('\n❌ Invalid clobTokenId');
      process.exit(1);
    }

    // Calculate trade size for ~$1
    // For a $1 trade, if price is 0.50, we need 2 shares (2 * 0.50 = $1)
    // Use a conservative price estimate of 0.50 for calculation
    const estimatedPrice = 0.50;
    const targetCost = 1.0; // $1
    const tradeSize = Math.floor((targetCost / estimatedPrice) * 100) / 100; // Round to 2 decimals
    const tradePrice = estimatedPrice.toString();

    console.log('\n💰 Trade Details:');
    console.log(`  Side: BUY`);
    console.log(`  Order Type: FOK (Fill or Kill)`);
    console.log(`  Size: ${tradeSize} shares`);
    console.log(`  Estimated Price: $${tradePrice} per share`);
    console.log(`  Estimated Cost: ~$${targetCost} USDC`);

    // Execute buy order
    logger.info({
      message: 'Executing test trade',
      privyUserId: DRAXX_PRIVY_USER_ID,
      marketId,
      clobTokenId,
      outcome: outcomeLabel,
      size: tradeSize.toString(),
      price: tradePrice,
    });

    const tradeResult = await executeTrade({
      privyUserId: DRAXX_PRIVY_USER_ID,
      marketInfo: {
        marketId,
        marketQuestion,
        clobTokenId,
        outcome: outcomeLabel,
        metadata: {
          gameId: game.id,
          gameTitle: game.title,
        },
      },
      side: TradeSide.BUY,
      orderType: OrderType.FOK,
      size: tradeSize.toString(),
      price: tradePrice,
    });

    console.log('\n📈 Trade Result:');
    if (tradeResult.success) {
      console.log('✅ Trade executed successfully!');
      console.log(`  Order ID: ${tradeResult.orderId}`);
      console.log(`  Status: ${tradeResult.status}`);
      if (tradeResult.transactionHash) {
        console.log(`  Transaction Hash: ${tradeResult.transactionHash}`);
      }
      if (tradeResult.trade) {
        console.log(`  Trade Record ID: ${tradeResult.trade.id}`);
        console.log(`  Cost: $${tradeResult.trade.costUsdc} USDC`);
      }
    } else {
      console.log('❌ Trade failed');
      console.log(`  Error: ${tradeResult.message}`);
    }

    // Wait a moment before checking history
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get trade history
    console.log('\n📊 Fetching trade history...');
    const history = await getTradeHistory({
      privyUserId: DRAXX_PRIVY_USER_ID,
      limit: 5,
    });

    console.log(`\n📋 Recent Trades (${history.length}):`);
    history.forEach((trade, index) => {
      console.log(`\n  Trade ${index + 1}:`);
      console.log(`    Side: ${trade.side}`);
      console.log(`    Market: ${trade.marketQuestion || trade.marketId}`);
      console.log(`    Outcome: ${trade.outcome}`);
      console.log(`    Size: ${trade.size} shares`);
      console.log(`    Price: $${trade.price}`);
      console.log(`    Cost: $${trade.costUsdc} USDC`);
      console.log(`    Status: ${trade.status}`);
      console.log(`    Order ID: ${trade.orderId}`);
      if (trade.transactionHash) {
        console.log(`    TX Hash: ${trade.transactionHash}`);
      }
    });

    logger.info({
      message: 'Test trade completed',
      success: tradeResult.success,
    });

  } catch (error) {
    logger.error({
      message: 'Test trade failed',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    console.error('\n❌ Test failed:', error);
    process.exit(1);
  } finally {
    client.release();
  }
}

// Run test if executed directly
if (require.main === module) {
  testTradeWithRealMarket()
    .then(() => {
      logger.info({ message: 'Test trade script completed successfully' });
      process.exit(0);
    })
    .catch((error) => {
      logger.error({
        message: 'Test trade script failed',
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
}

export { testTradeWithRealMarket };
