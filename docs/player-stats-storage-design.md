# Player Stats Storage Design

## Overview
This document explains how NBA player statistics from Ball Don't Lie API are stored and linked to games in our system.

## Database Schema

### 1. `live_games` Table (Existing)
- **Primary Key**: `id` (VARCHAR) - Polymarket event ID
- **New Column**: `balldontlie_game_id` (INTEGER) - Maps to Ball Don't Lie game ID
- **Other columns**: `game_id` (INTEGER) - Polymarket's internal game ID from WebSocket

### 2. `game_player_stats` Table (New)
- **Primary Key**: `id` (SERIAL)
- **Foreign Key**: `game_id` → `live_games.id`
- **Unique Constraint**: `(game_id, player_id)` - One stat record per player per game
- **Columns**: All player statistics (pts, reb, ast, etc.)

## Data Flow

```
┌─────────────────────┐
│  Polymarket API     │
│  (Live Games)       │
└──────────┬──────────┘
           │
           │ Stores game with:
           │ - id (Polymarket event ID)
           │ - game_id (Polymarket game ID)
           │ - sport, teams, etc.
           ▼
┌─────────────────────┐
│   live_games        │
│   table             │
│                     │
│  id: "evt_123"      │
│  game_id: 456       │
│  balldontlie_game_id│
│    : 789 (mapped)   │
└──────────┬──────────┘
           │
           │ Links via game_id
           ▼
┌─────────────────────┐
│ game_player_stats   │
│ table               │
│                     │
│  game_id: "evt_123" │
│  player_id: 101     │
│  pts: 25, reb: 10   │
│  ...                │
└─────────────────────┘
```

## ID Mapping Strategy

### Challenge
- **Polymarket** uses its own game IDs (`game_id` column)
- **Ball Don't Lie** uses different game IDs
- We need to map between them

### Solution
1. **Store `balldontlie_game_id` in `live_games` table**
   - This creates a direct mapping
   - Can be populated by:
     - Matching games by date + teams
     - Manual mapping
     - API lookup service

2. **Denormalize in `game_player_stats`**
   - Store `balldontlie_game_id` in player stats table
   - Allows fast queries without joins
   - Updated when stats are refreshed

## Querying Player Stats

### Get stats for a game:
```sql
SELECT * FROM game_player_stats 
WHERE game_id = 'polymarket_event_id'
ORDER BY is_home DESC, pts DESC;
```

### Get stats by Ball Don't Lie game ID:
```sql
SELECT * FROM game_player_stats 
WHERE balldontlie_game_id = 789
ORDER BY is_home DESC, pts DESC;
```

### Get stats for all live NBA games:
```sql
SELECT gps.* 
FROM game_player_stats gps
JOIN live_games lg ON gps.game_id = lg.id
WHERE lg.sport = 'nba' 
  AND lg.live = true
ORDER BY lg.start_date, gps.is_home DESC, gps.pts DESC;
```

## Integration Points

### 1. Game Mapping Service
- Maps Polymarket games to Ball Don't Lie games
- Uses: date, team names/abbreviations
- Stores mapping in `live_games.balldontlie_game_id`

### 2. Stats Polling Service
- Polls Ball Don't Lie API every 30-60 seconds for live games
- Fetches stats using `balldontlie_game_id`
- Updates `game_player_stats` table

### 3. Live Stats API
- Extends `/api/live-stats/{gameIdentifier}` endpoint
- Adds `playerStats` array to response
- Groups by home/away teams

## Example Data Structure

### live_games row:
```json
{
  "id": "evt_abc123",
  "game_id": 456,
  "balldontlie_game_id": 789,
  "sport": "nba",
  "title": "Lakers vs Warriors",
  "live": true
}
```

### game_player_stats rows:
```json
[
  {
    "game_id": "evt_abc123",
    "balldontlie_game_id": 789,
    "player_id": 101,
    "player_first_name": "LeBron",
    "player_last_name": "James",
    "team_abbreviation": "LAL",
    "is_home": true,
    "pts": 25,
    "reb": 10,
    "ast": 8
  },
  {
    "game_id": "evt_abc123",
    "balldontlie_game_id": 789,
    "player_id": 102,
    "player_first_name": "Stephen",
    "player_last_name": "Curry",
    "team_abbreviation": "GSW",
    "is_home": false,
    "pts": 30,
    "reb": 5,
    "ast": 7
  }
]
```

## Benefits of This Design

1. **Normalized**: Player stats in separate table, avoids JSONB bloat
2. **Queryable**: Can efficiently query by game, player, team
3. **Scalable**: Indexes support fast lookups
4. **Flexible**: Can add more stats columns without changing game table
5. **Maintainable**: Clear foreign key relationships
6. **Denormalized**: `balldontlie_game_id` stored in both tables for performance

