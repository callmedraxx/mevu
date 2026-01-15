/**
 * Debug script to check for Jan 4, 2026 NFL games in Polymarket endpoint
 * Run with: npx ts-node scripts/debug-jan4-nfl-games.ts
 */

import axios from 'axios';

let currentBuildId = '6w0cVAj-lCsqW5cBTIuDH'; // Default build ID

async function fetchBuildId(): Promise<string | null> {
  try {
    const response = await axios.get('https://polymarket.com/sports/live', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      },
      timeout: 10000,
    });
    
    // Extract build ID from __NEXT_DATA__ script tag
    const html = response.data as string;
    const buildIdMatch = html.match(/"buildId":"([^"]+)"/);
    if (buildIdMatch && buildIdMatch[1]) {
      return buildIdMatch[1];
    }
    
    // Try alternative pattern
    const altMatch = html.match(/"buildId":\s*"([^"]+)"/);
    if (altMatch && altMatch[1]) {
      return altMatch[1];
    }
    
    return null;
  } catch (error: any) {
    console.error('Error fetching build ID:', error.message);
    return null;
  }
}

function getLiveEndpoint(buildId: string): string {
  return `https://polymarket.com/_next/data/${buildId}/sports/live.json?slug=live`;
}

async function checkJan4NFLGames() {
  try {
    console.log('Fetching current build ID from Polymarket...');
    const buildId = await fetchBuildId();
    
    if (buildId) {
      currentBuildId = buildId;
      console.log(`Using build ID: ${buildId}`);
    } else {
      console.log(`Using default build ID: ${currentBuildId}`);
    }
    
    const LIVE_ENDPOINT = getLiveEndpoint(currentBuildId);
    console.log('\nFetching games from Polymarket endpoint...');
    console.log('Endpoint:', LIVE_ENDPOINT);
    
    const response = await axios.get(LIVE_ENDPOINT, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    const queries = response.data?.pageProps?.dehydratedState?.queries || [];
    let events: Record<string, any> = {};
    
    for (const query of queries) {
      const data = query.state?.data;
      if (data && typeof data === 'object' && 'events' in data) {
        events = { ...events, ...(data.events || {}) };
      }
    }

    const eventArray = Object.values(events);
    processGames(eventArray);
  } catch (error: any) {
    console.error('Error fetching games:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      if (error.response.status === 404) {
        console.log('\nTrying to fetch new build ID and retry...');
        const newBuildId = await fetchBuildId();
        if (newBuildId) {
          currentBuildId = newBuildId;
          const retryEndpoint = getLiveEndpoint(currentBuildId);
          console.log(`Retrying with new build ID: ${newBuildId}`);
          try {
            const retryResponse = await axios.get(retryEndpoint, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                'Accept': 'application/json',
              },
              timeout: 30000,
            });
            
            const queries = retryResponse.data?.pageProps?.dehydratedState?.queries || [];
            let events: Record<string, any> = {};
            
            for (const query of queries) {
              const data = query.state?.data;
              if (data && typeof data === 'object' && 'events' in data) {
                events = { ...events, ...(data.events || {}) };
              }
            }
            
            const eventArray = Object.values(events);
            processGames(eventArray);
            return;
          } catch (retryError: any) {
            console.error('Retry also failed:', retryError.message);
            process.exit(1);
          }
        }
      } else {
        console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      }
    }
    process.exit(1);
  }
}

function processGames(eventArray: any[]) {
  console.log(`\nTotal games from API: ${eventArray.length}`);

    // Find all NFL games
    const nflGames = eventArray.filter((g: any) => {
      const slug = (g.slug || '').toLowerCase();
      const title = (g.title || '').toLowerCase();
      return slug.includes('nfl') || slug.includes('football') || 
             title.includes('nfl') || title.includes('football');
    });

    console.log(`\nTotal NFL games: ${nflGames.length}`);

    // Find Jan 4, 2026 NFL games specifically
    const jan4Games = nflGames.filter((g: any) => {
      const slug = g.slug || '';
      const endDate = g.endDate || '';
      const gameStartTime = (g as any).gameStartTime || '';
      return slug.includes('2026-01-04') || 
             endDate.includes('2026-01-04') || 
             gameStartTime.includes('2026-01-04');
    });

    console.log(`\nJan 4, 2026 NFL games found: ${jan4Games.length}`);

    if (jan4Games.length > 0) {
      console.log('\n=== Jan 4, 2026 NFL Games Details ===');
      jan4Games.forEach((game: any, index: number) => {
        console.log(`\n${index + 1}. ${game.title || game.slug}`);
        console.log(`   Slug: ${game.slug}`);
        console.log(`   ID: ${game.id}`);
        console.log(`   endDate: ${game.endDate}`);
        console.log(`   gameStartTime: ${(game as any).gameStartTime || 'N/A'}`);
        console.log(`   live: ${game.live}`);
        console.log(`   ended: ${game.ended}`);
        console.log(`   closed: ${game.closed}`);
        console.log(`   active: ${game.active}`);
        
        // Check date parsing
        if (game.endDate) {
          const endDateParsed = new Date(game.endDate);
          console.log(`   endDate parsed: ${endDateParsed.toISOString()}`);
          console.log(`   endDate valid: ${!isNaN(endDateParsed.getTime())}`);
          console.log(`   endDate + 3h: ${new Date(endDateParsed.getTime() + 3 * 60 * 60 * 1000).toISOString()}`);
          console.log(`   Now: ${new Date().toISOString()}`);
          console.log(`   Is in past: ${(endDateParsed.getTime() + 3 * 60 * 60 * 1000) < Date.now()}`);
        }
      });
    } else {
      console.log('\n=== No Jan 4, 2026 NFL games found in API response ===');
      console.log('\nShowing first 10 NFL games for reference:');
      nflGames.slice(0, 10).forEach((game: any, index: number) => {
        console.log(`\n${index + 1}. ${game.title || game.slug}`);
        console.log(`   Slug: ${game.slug}`);
        console.log(`   endDate: ${game.endDate}`);
        console.log(`   gameStartTime: ${(game as any).gameStartTime || 'N/A'}`);
      });
    }

    // Check for any 2026 NFL games
    const nfl2026Games = nflGames.filter((g: any) => {
      const slug = g.slug || '';
      const endDate = g.endDate || '';
      return slug.includes('2026') || endDate.includes('2026');
    });

  console.log(`\n\nTotal NFL games with 2026 in slug/endDate: ${nfl2026Games.length}`);
  if (nfl2026Games.length > 0) {
    console.log('\n=== All 2026 NFL Games ===');
    nfl2026Games.forEach((game: any, index: number) => {
      console.log(`${index + 1}. ${game.slug} - endDate: ${game.endDate}`);
    });
  }
}

checkJan4NFLGames();
