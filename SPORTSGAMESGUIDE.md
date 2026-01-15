# Complete Guide: Getting All Sports Games from Polymarket API

This guide explains how to fetch all upcoming sports games for all standard leagues, including the current week and all upcoming weeks, using the Polymarket Gamma API.

## API Base URL

```
https://gamma-api.polymarket.com
```

---

## Standard Leagues Configuration

Each sport has a **Series ID** that identifies the league/season in Polymarket's system. Here are the configured series IDs:

| Sport | Series ID | Label |
|-------|-----------|-------|
| NFL | `10187` | NFL |
| NBA | `10345` | NBA |
| NHL | `10346` | NHL |
| MLB | `3` | MLB |
| EPL | `10188` | English Premier League |
| La Liga | `10193` | La Liga |

**Note**: Series IDs can change per season/year. To find the current Series ID:
1. Inspect network requests on polymarket.com
2. Call `/series-summary/{seriesId}` and check which IDs return valid data
3. Check the Polymarket API documentation (if available)

---

## Approach 1: Fetch ALL Upcoming Games (Recommended - Simpler)

This approach fetches ALL upcoming games for a sport in one API call, without specifying a week. The API automatically returns all upcoming games across all weeks.

### Endpoint

```
GET /events
```

### Parameters

```typescript
{
  series_id: string,      // Required: Sport series ID (e.g., '10187' for NFL)
  limit: 100,             // Max games to return (default: 100, max: likely 500)
  order: 'startTime',     // Sort by start time
  ascending: true,        // true = oldest first (upcoming), false = newest first
  include_chat: false,    // Exclude chat data (faster)
  closed: false,          // Exclude closed/finished games
  active: true            // Only active games
}
```

**Key Point**: Do NOT include `event_week` parameter - this ensures you get games from ALL upcoming weeks.

### Example Request

```bash
GET https://gamma-api.polymarket.com/events?series_id=10187&limit=100&order=startTime&ascending=true&include_chat=false&closed=false&active=true
```

### Response Format

The API returns an array of events (or wrapped in a `data` field):

```json
[
  {
    "id": "0x...",
    "slug": "nfl-hou-ind-2025-11-30",
    "title": "Texans vs. Colts",
    "description": "...",
    "startDate": "2025-11-30T13:00:00Z",
    "endDate": "2025-11-30T16:00:00Z",
    "image": "https://...",
    "active": true,
    "closed": false,
    "archived": false,
    "isResolved": false,
    "markets": [...],
    "tags": [...],
    ...
  },
  ...
]
```

### Getting All Leagues in Parallel

To get games for all leagues simultaneously:

```typescript
const SPORTS_CONFIG = {
  nfl: { seriesId: '10187', label: 'NFL' },
  nba: { seriesId: '10345', label: 'NBA' },
  nhl: { seriesId: '10346', label: 'NHL' },
  mlb: { seriesId: '3', label: 'MLB' },
  epl: { seriesId: '10188', label: 'English Premier League' },
  lal: { seriesId: '10193', label: 'La Liga' },
};

async function getAllSportsGames() {
  const sports = Object.keys(SPORTS_CONFIG);
  
  // Fetch all sports in parallel
  const results = await Promise.all(
    sports.map(async (sport) => {
      const config = SPORTS_CONFIG[sport];
      try {
        const response = await fetch(
          `https://gamma-api.polymarket.com/events?` +
          `series_id=${config.seriesId}&` +
          `limit=100&` +
          `order=startTime&` +
          `ascending=true&` +
          `include_chat=false&` +
          `closed=false&` +
          `active=true`
        );
        const events = await response.json();
        
        // Handle both array and wrapped responses
        const games = Array.isArray(events) 
          ? events 
          : (events.data || []);
        
        return {
          sport,
          sportLabel: config.label,
          events: games,
        };
      } catch (error) {
        return {
          sport,
          sportLabel: config.label,
          events: [],
          error: error.message,
        };
      }
    })
  );
  
  return results;
}
```

---

## Approach 2: Fetch by Week (More Control)

If you need to fetch games week-by-week (e.g., for pagination or specific week queries), you can use the `event_week` parameter.

### Step 1: Get Series Summary (Available Weeks)

First, get the series summary to find available weeks:

#### Endpoint

```
GET /series-summary/{seriesId}
```

#### Example Request

```bash
GET https://gamma-api.polymarket.com/series-summary/10187
```

#### Response

```json
{
  "id": "10187",
  "title": "NFL 2025",
  "slug": "nfl-2025",
  "eventDates": ["2025-09-07", "2025-09-14", ...],
  "eventWeeks": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  "earliest_open_week": 13,
  "earliest_open_date": "2025-11-30"
}
```

**Key Fields**:
- `eventWeeks`: Array of all available week numbers
- `earliest_open_week`: The current/earliest week that has open games
- `eventDates`: Array of dates when games occur

### Step 2: Fetch Games for Each Week

Once you have the available weeks, fetch games for each week:

#### Endpoint

```
GET /events
```

#### Parameters (with week)

```typescript
{
  series_id: string,      // Required: Sport series ID
  event_week: number,     // Required: Week number (e.g., 13)
  limit: 100,             // Max games per week
  order: 'startTime',     // Sort by start time
  ascending: false,       // false = newest first, true = oldest first
  include_chat: false,    // Exclude chat data
  closed: false,          // Exclude closed games
  active: true            // Only active games
}
```

#### Example Request

```bash
GET https://gamma-api.polymarket.com/events?series_id=10187&event_week=13&limit=100&order=startTime&ascending=false&include_chat=false&closed=false&active=true
```

### Getting All Weeks for All Sports

```typescript
async function getAllSportsGamesByWeek() {
  const SPORTS_CONFIG = {
    nfl: { seriesId: '10187', label: 'NFL' },
    nba: { seriesId: '10345', label: 'NBA' },
    nhl: { seriesId: '10346', label: 'NHL' },
    mlb: { seriesId: '3', label: 'MLB' },
    epl: { seriesId: '10188', label: 'English Premier League' },
    lal: { seriesId: '10193', label: 'La Liga' },
  };

  const results = {};

  // Process each sport
  for (const [sport, config] of Object.entries(SPORTS_CONFIG)) {
    try {
      // Step 1: Get series summary
      const summaryResponse = await fetch(
        `https://gamma-api.polymarket.com/series-summary/${config.seriesId}`
      );
      const summary = await summaryResponse.json();
      
      // Step 2: Determine which weeks to fetch
      // Option A: Fetch earliest_open_week (current week)
      let weeksToFetch = [];
      if (summary.earliest_open_week !== undefined && summary.earliest_open_week !== null) {
        // Fetch from current week onwards
        const currentWeek = summary.earliest_open_week;
        const allWeeks = summary.eventWeeks || [];
        weeksToFetch = allWeeks.filter(week => week >= currentWeek);
      } else if (summary.eventWeeks && summary.eventWeeks.length > 0) {
        // Fallback: use all available weeks
        weeksToFetch = summary.eventWeeks;
      } else {
        console.warn(`No weeks available for ${sport}`);
        continue;
      }
      
      // Step 3: Fetch games for each week
      const weekPromises = weeksToFetch.map(async (week) => {
        try {
          const eventsResponse = await fetch(
            `https://gamma-api.polymarket.com/events?` +
            `series_id=${config.seriesId}&` +
            `event_week=${week}&` +
            `limit=100&` +
            `order=startTime&` +
            `ascending=false&` +
            `include_chat=false&` +
            `closed=false&` +
            `active=true`
          );
          const events = await eventsResponse.json();
          const games = Array.isArray(events) ? events : (events.data || []);
          
          return {
            week,
            games,
          };
        } catch (error) {
          console.error(`Error fetching week ${week} for ${sport}:`, error);
          return { week, games: [] };
        }
      });
      
      const weekResults = await Promise.all(weekPromises);
      
      // Combine all games from all weeks
      const allGames = weekResults.flatMap(wr => wr.games);
      
      results[sport] = {
        sport,
        sportLabel: config.label,
        seriesId: config.seriesId,
        weeks: weeksToFetch,
        totalGames: allGames.length,
        games: allGames,
      };
    } catch (error) {
      console.error(`Error processing ${sport}:`, error);
      results[sport] = {
        sport,
        sportLabel: config.label,
        error: error.message,
        games: [],
      };
    }
  }
  
  return results;
}
```

---

## Filtering for Upcoming Games

The API parameters (`closed=false`, `active=true`) should filter out finished games, but you should also do client-side filtering to be safe:

```typescript
function isUpcomingGame(event) {
  const now = new Date();
  
  // Explicitly closed
  if (event.closed === true) return false;
  
  // Resolved (game finished)
  if (event.isResolved === true) return false;
  
  // Archived
  if (event.archived === true) return false;
  
  // Not active
  if (event.active === false) return false;
  
  // All markets closed (game finished even if event.closed is false)
  if (event.markets && event.markets.length > 0) {
    const allMarketsClosed = event.markets.every(m => m.closed === true);
    if (allMarketsClosed) return false;
    
    // No active markets
    const hasActiveMarket = event.markets.some(
      m => m.active === true && m.closed === false
    );
    if (!hasActiveMarket) return false;
  }
  
  // Check end date
  if (event.endDate) {
    const endDate = new Date(event.endDate);
    if (endDate < now) return false;
  }
  
  return true;
}

// Filter games
const upcomingGames = allGames.filter(isUpcomingGame);
```

---

## Complete Implementation Example

Here's a complete example that fetches all upcoming games for all leagues:

```typescript
const SPORTS_CONFIG = {
  nfl: { seriesId: '10187', label: 'NFL' },
  nba: { seriesId: '10345', label: 'NBA' },
  nhl: { seriesId: '10346', label: 'NHL' },
  mlb: { seriesId: '3', label: 'MLB' },
  epl: { seriesId: '10188', label: 'English Premier League' },
  lal: { seriesId: '10193', label: 'La Liga' },
};

const API_BASE_URL = 'https://gamma-api.polymarket.com';
const TIMEOUT_MS = 10000; // 10 seconds per request

async function fetchWithTimeout(url, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

function isUpcomingGame(event) {
  const now = new Date();
  
  if (event.closed === true) return false;
  if (event.isResolved === true) return false;
  if (event.archived === true) return false;
  if (event.active === false) return false;
  
  if (event.markets && event.markets.length > 0) {
    const allMarketsClosed = event.markets.every(m => m.closed === true);
    if (allMarketsClosed) return false;
    
    const hasActiveMarket = event.markets.some(
      m => m.active === true && m.closed === false
    );
    if (!hasActiveMarket) return false;
  }
  
  if (event.endDate) {
    const endDate = new Date(event.endDate);
    if (endDate < now) return false;
  }
  
  return true;
}

async function getAllUpcomingSportsGames() {
  const startTime = Date.now();
  const sports = Object.keys(SPORTS_CONFIG);
  
  // Fetch all sports in parallel
  const results = await Promise.allSettled(
    sports.map(async (sport) => {
      const config = SPORTS_CONFIG[sport];
      
      try {
        const url = `${API_BASE_URL}/events?` +
          `series_id=${config.seriesId}&` +
          `limit=100&` +
          `order=startTime&` +
          `ascending=true&` +
          `include_chat=false&` +
          `closed=false&` +
          `active=true`;
        
        const response = await fetchWithTimeout(url);
        
        // Handle response format
        let events = [];
        if (Array.isArray(response)) {
          events = response;
        } else if (response?.data && Array.isArray(response.data)) {
          events = response.data;
        }
        
        // Filter for upcoming games
        const upcomingGames = events.filter(isUpcomingGame);
        
        return {
          sport,
          sportLabel: config.label,
          seriesId: config.seriesId,
          totalFromAPI: events.length,
          upcomingCount: upcomingGames.length,
          games: upcomingGames,
        };
      } catch (error) {
        return {
          sport,
          sportLabel: config.label,
          error: error.message,
          games: [],
        };
      }
    })
  );
  
  // Process results
  const allGames = [];
  const sportsData = {};
  let sportsProcessed = 0;
  let sportsFailed = 0;
  
  results.forEach((result, index) => {
    const sport = sports[index];
    
    if (result.status === 'fulfilled' && !result.value.error) {
      sportsProcessed++;
      const data = result.value;
      allGames.push(...data.games);
      sportsData[sport] = {
        sport: data.sport,
        sportLabel: data.sportLabel,
        seriesId: data.seriesId,
        eventCount: data.upcomingCount,
        games: data.games,
      };
    } else {
      sportsFailed++;
      sportsData[sport] = {
        sport,
        sportLabel: SPORTS_CONFIG[sport].label,
        error: result.status === 'rejected' 
          ? result.reason?.message 
          : result.value?.error || 'Unknown error',
        games: [],
      };
    }
  });
  
  // Sort all games by start time (soonest first)
  allGames.sort((a, b) => {
    const aTime = a.startDate ? new Date(a.startDate).getTime() : Infinity;
    const bTime = b.startDate ? new Date(b.startDate).getTime() : Infinity;
    return aTime - bTime;
  });
  
  const latencyMs = Date.now() - startTime;
  
  return {
    games: {
      events: allGames,
      sports: sportsData,
      totalEvents: allGames.length,
      sportsProcessed,
      sportsFailed,
    },
    metadata: {
      fetchedAt: new Date().toISOString(),
      latencyMs,
    },
  };
}

// Usage
getAllUpcomingSportsGames()
  .then(result => {
    console.log(`Fetched ${result.games.totalEvents} games across ${result.games.sportsProcessed} sports`);
    console.log(`Latency: ${result.metadata.latencyMs}ms`);
    
    // Access games by sport
    Object.values(result.games.sports).forEach(sportData => {
      console.log(`${sportData.sportLabel}: ${sportData.eventCount} upcoming games`);
    });
    
    // Access all games
    result.games.events.forEach(game => {
      console.log(`${game.title} - ${game.startDate}`);
    });
  })
  .catch(error => {
    console.error('Error fetching sports games:', error);
  });
```

---

## Important Notes

### 1. Rate Limiting
- Add appropriate delays between requests if you're making many calls
- Consider implementing retry logic with exponential backoff
- Use parallel requests with caution (don't overload the API)

### 2. Series ID Updates
- Series IDs change each season/year
- NFL 2025 = `10187`, but NFL 2026 might be different
- You'll need to update Series IDs periodically
- Consider fetching available series from the API if possible

### 3. Response Format Variations
- Sometimes the API returns `Array` directly
- Sometimes it's wrapped: `{ data: Array }`
- Handle both formats in your code

### 4. Pagination
- The `limit` parameter may have a maximum (likely 100-500)
- If you need more games, you may need to:
  - Use the week-by-week approach (Approach 2)
  - Implement pagination with `offset` parameter (if supported)
  - Make multiple requests with different filters

### 5. Caching
- Series summaries change infrequently (update weekly)
- Game data changes frequently (update every 20-30 minutes)
- Consider caching series summaries for 1 hour
- Consider caching game data for 5-10 minutes

### 6. Error Handling
- Handle timeouts (set reasonable timeout values)
- Handle network errors
- Handle invalid Series IDs
- Handle missing/empty responses
- Use `Promise.allSettled` instead of `Promise.all` to continue processing if one sport fails

---

## Summary

**For getting ALL upcoming games for ALL leagues:**

1. **Use Approach 1** (simpler): Call `/events` with `series_id` but WITHOUT `event_week`
   - Gets all upcoming games across all weeks in one call
   - Fastest and simplest approach

2. **Required Parameters**:
   - `series_id`: Sport's series ID (see table above)
   - `closed=false`: Exclude finished games
   - `active=true`: Only active games
   - `limit=100`: Max games per request

3. **Filter client-side**: Use `isUpcomingGame()` function to double-check

4. **Process in parallel**: Fetch all sports simultaneously for better performance

5. **Handle errors gracefully**: Use `Promise.allSettled` and continue if one sport fails

This approach will get you all upcoming games (current week + all future weeks) for all standard leagues in the most efficient way.

