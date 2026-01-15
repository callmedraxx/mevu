/**
 * Test the sports games refresh function directly to see what's happening
 */

require('ts-node/register');
const { refreshSportsGames, fetchSportsGames } = require('./src/services/polymarket/sports-games.service');

async function testRefresh() {
  try {
    console.log('Testing fetchSportsGames()...\n');
    
    const events = await fetchSportsGames();
    console.log(`\nFetched ${events.length} events from API`);
    
    if (events.length > 0) {
      console.log('\nFirst 5 events:');
      events.slice(0, 5).forEach((event, i) => {
        console.log(`${i + 1}. ${event.slug || event.id}`);
        console.log(`   Title: ${event.title}`);
        console.log(`   Sport: ${event.sport || 'unknown'}`);
        console.log(`   Active: ${event.active}, Closed: ${event.closed}`);
        console.log('');
      });
      
      // Check if nfl-gb-chi-2026-01-10 is in the results
      const targetGame = events.find(e => e.slug === 'nfl-gb-chi-2026-01-10');
      if (targetGame) {
        console.log('✓ Found nfl-gb-chi-2026-01-10 in fetched events!');
      } else {
        console.log('✗ nfl-gb-chi-2026-01-10 NOT in fetched events');
        console.log('Looking for games with "gb-chi":');
        const gbChiGames = events.filter(e => e.slug && e.slug.includes('gb-chi'));
        console.log(`Found ${gbChiGames.length} games with "gb-chi":`);
        gbChiGames.forEach(g => console.log(`  - ${g.slug}`));
      }
    } else {
      console.log('⚠️  No events fetched from API!');
    }
    
    console.log('\n\nTesting refreshSportsGames()...\n');
    const count = await refreshSportsGames();
    console.log(`\nRefresh completed. Games stored: ${count}`);
    
  } catch (error) {
    console.error('Error:', error);
    console.error('Stack:', error.stack);
  }
  
  process.exit(0);
}

testRefresh();

