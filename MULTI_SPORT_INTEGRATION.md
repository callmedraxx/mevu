# Multi-Sport Player Stats Integration

## Overview

Extended Ball Don't Lie API integration to support multiple sports: **NBA, NFL, MLB, NHL, and EPL**.

## Supported Sports

Based on the [Ball Don't Lie OpenAPI spec](https://www.balldontlie.io/openapi.yml), the API supports:

1. ✅ **NBA** - Fully supported via SDK
2. ✅ **NFL** - Fully supported via SDK  
3. ✅ **MLB** - Fully supported via SDK
4. ⚠️ **NHL** - API supports it, SDK methods may need verification
5. ⚠️ **EPL** - API supports it, SDK methods may need verification

## Implementation

### Service Updates

**File**: `src/services/balldontlie/balldontlie.service.ts`

#### Key Features:

1. **Sport Mapping**
   ```typescript
   const SPORT_MAPPING: Record<string, 'nba' | 'nfl' | 'mlb' | 'nhl' | 'epl'> = {
     nba: 'nba',
     nfl: 'nfl',
     mlb: 'mlb',
     nhl: 'nhl',
     epl: 'epl',
   };
   ```

2. **Multi-Sport Methods**
   - `getPlayerStats(sport: string, gameIds: number[])` - Get stats for any sport
   - `getGamesByDate(sport: string, date: string)` - Get games for any sport
   - `isSportSupported(sport: string)` - Check if sport is supported

3. **Sport-Specific Stat Extraction**
   - Different sports have different stat fields
   - Stats stored in both normalized columns (for common stats) and JSONB (for sport-specific stats)

### Database Schema Updates

**Migration**: `migrations/016_add_sport_to_player_stats.sql`

#### New Columns:

1. **`sport`** (VARCHAR(50))
   - Tracks which sport the stats are for
   - Values: 'nba', 'nfl', 'mlb', 'nhl', 'epl'

2. **`sport_stats`** (JSONB)
   - Stores sport-specific statistics
   - Different sports have different stat fields:
     - **NBA**: fgm, fga, fg_pct, fg3m, reb, ast, stl, blk, etc.
     - **NFL**: pass_yds, pass_td, rush_yds, rec, rec_yds, etc.
     - **MLB**: ab, h, hr, rbi, era, w, l, sv, etc.
     - **NHL**: goals, assists, points, shots, hits, saves, etc.
     - **EPL**: goals, assists, shots, passes, tackles, saves, etc.

#### Updated Constraints:

- Changed unique constraint from `(game_id, player_id)` to `(game_id, player_id, sport)`
- Allows same player_id in different sports

### Stat Fields by Sport

#### NBA Stats
- `pts`, `reb`, `ast`, `stl`, `blk`
- `fgm`, `fga`, `fg_pct`
- `fg3m`, `fg3a`, `fg3_pct`
- `ftm`, `fta`, `ft_pct`
- `oreb`, `dreb`, `turnover`, `pf`

#### NFL Stats
- `pass_yds`, `pass_td`, `pass_int`
- `rush_yds`, `rush_td`
- `rec`, `rec_yds`, `rec_td`
- `fumbles`, `fumbles_lost`

#### MLB Stats
- `ab`, `h`, `avg`, `hr`, `rbi`, `r`, `sb`
- `bb`, `so`
- `era`, `w`, `l`, `sv`, `ip`
- `h_allowed`, `er`, `k`

#### NHL Stats
- `goals`, `assists`, `points`
- `shots`, `hits`, `pim`
- `plus_minus`, `power_play_goals`
- `wins`, `losses`, `saves`, `save_percentage`

#### EPL Stats
- `goals`, `assists`
- `shots`, `shots_on_target`
- `passes`, `pass_accuracy`
- `tackles`, `interceptions`, `clearances`
- `saves`, `yellow_cards`, `red_cards`

## Usage Examples

### Get Games for Multiple Sports

```typescript
import { ballDontLieClient } from './services/balldontlie/balldontlie.service';

// NBA games
const nbaGames = await ballDontLieClient.getGamesByDate('nba', '2024-12-10');

// NFL games
const nflGames = await ballDontLieClient.getGamesByDate('nfl', '2024-12-10');

// MLB games
const mlbGames = await ballDontLieClient.getGamesByDate('mlb', '2024-12-10');
```

### Get Player Stats for Multiple Sports

```typescript
// NBA stats
const nbaStats = await ballDontLieClient.getPlayerStats('nba', [16968270]);

// NFL stats
const nflStats = await ballDontLieClient.getPlayerStats('nfl', [12345]);

// MLB stats
const mlbStats = await ballDontLieClient.getPlayerStats('mlb', [67890]);
```

### Store Stats for Multiple Sports

```typescript
import { storePlayerStats } from './services/balldontlie/balldontlie.service';

// Store NBA stats
await storePlayerStats('polymarket_game_id', 'nba', 16968270, nbaStats);

// Store NFL stats
await storePlayerStats('polymarket_game_id', 'nfl', 12345, nflStats);

// Store MLB stats
await storePlayerStats('polymarket_game_id', 'mlb', 67890, mlbStats);
```

## Database Queries

### Get Stats by Sport

```sql
SELECT * FROM game_player_stats 
WHERE game_id = 'polymarket_game_id' 
  AND sport = 'nba'
ORDER BY pts DESC;
```

### Get All Sports for a Game

```sql
SELECT DISTINCT sport 
FROM game_player_stats 
WHERE game_id = 'polymarket_game_id';
```

### Query Sport-Specific Stats (JSONB)

```sql
-- Get NFL players with most passing yards
SELECT 
  player_first_name,
  player_last_name,
  sport_stats->>'pass_yds' as pass_yds
FROM game_player_stats
WHERE sport = 'nfl'
  AND game_id = 'polymarket_game_id'
ORDER BY (sport_stats->>'pass_yds')::int DESC;
```

## Testing

Run the multi-sport test:

```bash
BALLDONTLIE_API_KEY=your_key npx ts-node test-multi-sport-stats.ts
```

## Next Steps

1. ✅ Multi-sport service implementation
2. ✅ Database schema updates
3. ⏳ Run migrations: `016_add_sport_to_player_stats.sql`
4. ⏳ Create game mapping service for each sport
5. ⏳ Set up polling service for live games across all sports
6. ⏳ Verify NHL and EPL SDK support (may need manual API calls if SDK doesn't support)

## Files Created/Updated

1. ✅ `src/services/balldontlie/balldontlie.service.ts` - Multi-sport support
2. ✅ `migrations/016_add_sport_to_player_stats.sql` - Database schema
3. ✅ `test-multi-sport-stats.ts` - Multi-sport test script
4. ✅ `MULTI_SPORT_INTEGRATION.md` - This documentation

