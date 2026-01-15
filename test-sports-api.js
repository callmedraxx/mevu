/**
 * Test the Polymarket Gamma API /events endpoint directly
 */

const axios = require('axios');

const API_BASE_URL = 'https://gamma-api.polymarket.com';
const NFL_SERIES_ID = '10187';

async function testSportsGamesAPI() {
  try {
    const url = `${API_BASE_URL}/events?` +
      `series_id=${NFL_SERIES_ID}&` +
      `limit=100&` +
      `order=startTime&` +
      `ascending=true&` +
      `include_chat=false&` +
      `closed=false&` +
      `active=true`;
    
    console.log('Fetching from:', url);
    console.log('');
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout: 30000,
      validateStatus: (status) => status < 500,
    });
    
    console.log(`Response status: ${response.status}`);
    console.log(`Response headers:`, JSON.stringify(response.headers, null, 2));
    console.log('');
    
    // Handle different response formats
    let events = [];
    if (Array.isArray(response.data)) {
      events = response.data;
      console.log('Response is an array');
    } else if (response.data && typeof response.data === 'object') {
      if (Array.isArray(response.data.data)) {
        events = response.data.data;
        console.log('Response has data.data array');
      } else if (Array.isArray(response.data.events)) {
        events = response.data.events;
        console.log('Response has data.events array');
      } else {
        console.log('Response structure:', Object.keys(response.data));
        events = [];
      }
    }
    
    console.log(`\nTotal events fetched: ${events.length}`);
    
    // Look for the specific game
    const targetGame = events.find(e => e.slug === 'nfl-gb-chi-2026-01-10');
    if (targetGame) {
      console.log('\n✓ Found nfl-gb-chi-2026-01-10!');
      console.log('  Title:', targetGame.title);
      console.log('  Start Date:', targetGame.startDate);
      console.log('  End Date:', targetGame.endDate);
      console.log('  Active:', targetGame.active);
      console.log('  Closed:', targetGame.closed);
      console.log('  Archived:', targetGame.archived);
    } else {
      console.log('\n✗ nfl-gb-chi-2026-01-10 NOT found in API response');
      
      // Look for games with gb-chi
      const gbChiGames = events.filter(e => 
        e.slug && (e.slug.includes('gb-chi') || e.slug.includes('chi-gb'))
      );
      console.log(`\nGames with 'gb-chi' or 'chi-gb': ${gbChiGames.length}`);
      gbChiGames.forEach(game => {
        console.log(`  - ${game.slug} (${game.startDate})`);
      });
      
      // Look for games on 2026-01-10
      const jan10Games = events.filter(e => 
        (e.slug && e.slug.includes('2026-01-10')) ||
        (e.startDate && e.startDate.includes('2026-01-10'))
      );
      console.log(`\nGames on 2026-01-10: ${jan10Games.length}`);
      jan10Games.slice(0, 10).forEach(game => {
        console.log(`  - ${game.slug || game.id} (${game.title})`);
      });
      
      // Check if games are being filtered out (closed/archived)
      const closedGames = events.filter(e => e.closed === true || e.archived === true);
      console.log(`\nClosed/Archived games: ${closedGames.length}`);
      
      const activeGames = events.filter(e => e.active === true && e.closed === false && e.archived === false);
      console.log(`Active games: ${activeGames.length}`);
    }
    
    // Show first few games
    console.log('\n=== First 5 games ===');
    events.slice(0, 5).forEach((game, i) => {
      console.log(`${i + 1}. ${game.slug || game.id}`);
      console.log(`   Title: ${game.title}`);
      console.log(`   Start: ${game.startDate}`);
      console.log(`   Active: ${game.active}, Closed: ${game.closed}`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testSportsGamesAPI().catch(console.error);

