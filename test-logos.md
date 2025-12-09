# Testing the ESPN Logo System

## Overview
The logo system pre-downloads team logos from ESPN API, maps them by abbreviation, and serves them from our server. Much simpler and more reliable than fetching on-demand.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Ensure the server is running:
```bash
npm run dev
```

## How It Works

1. **Logo Mapping**: Logos are mapped by `{league}-{abbreviation}` (e.g., `nfl-KC`, `nba-LAL`)
   - Mapping is stored in `data/logo-mapping.json`
   - Logos are stored in `public/logos/` directory

2. **When teams are fetched/upserted**: The system automatically:
   - Downloads ESPN logos for each team (by abbreviation)
   - Stores logos with format: `{league}-{ABBREVIATION}.{ext}`
   - Updates the mapping file
   - Replaces Polymarket logo URLs with our server URLs

3. **Logo URLs**: Team logos are served from:
   ```
   http://localhost:3000/api/logos/{league}/{abbreviation}.{ext}
   ```
   Example: `http://localhost:3000/api/logos/nfl/KC.png`

4. **Logo Storage**: Logos are stored in `public/logos/` directory with format:
   ```
   {league}-{ABBREVIATION}.{ext}
   ```
   Example: `nfl-KC.png`, `nba-LAL.png`

## Testing Steps

### 1. Test Logo Endpoint Directly

Once you have teams loaded, test accessing a logo by abbreviation:

```bash
# Example: Get Kansas City Chiefs logo (abbreviation: KC)
curl http://localhost:3000/api/logos/nfl/KC.png

# Example: Get Los Angeles Lakers logo (abbreviation: LAL)
curl http://localhost:3000/api/logos/nba/LAL.png

# Or open in browser:
# http://localhost:3000/api/logos/nfl/KC.png
```

### 2. Pre-download Logos for a League

You can pre-download all logos for a league using the script:

```bash
npm run download-logos nfl
npm run download-logos nba
npm run download-logos mlb
```

This will:
- Fetch teams from Polymarket API
- Download ESPN logos for each team
- Store logos in `public/logos/`
- Update `data/logo-mapping.json`

### 3. Test Team Fetching

When teams are fetched/upserted from Polymarket API, logos are automatically downloaded:

```typescript
// Example: Fetch teams for NFL
import { teamsService } from './src/services/polymarket/teams.service';

const teams = await teamsService.refreshLeague('nfl');
// Logos will be automatically downloaded and mapped by abbreviation
```

### 4. Verify Logo URLs in Team Data

Check that team objects have our server URLs instead of Polymarket URLs:

```typescript
const teams = await teamsService.getTeamsByLeague('nfl');
console.log(teams[0].logo);
// Should output: http://localhost:3000/api/logos/nfl/{ABBREVIATION}.png
// Example: http://localhost:3000/api/logos/nfl/KC.png
```

## Supported Leagues

- NFL (`nfl`)
- NBA (`nba`)
- MLB (`mlb`)
- NHL (`nhl`)
- EPL (`epl`)
- La Liga (`lal`)

## Notes

- **Logo Mapping**: Logos are mapped by `{league}-{abbreviation}` (e.g., `nfl-KC`)
- **Mapping File**: Stored in `data/logo-mapping.json` (excluded from git)
- **Logo Storage**: Files stored in `public/logos/` (excluded from git)
- **Automatic Download**: Logos are downloaded when teams are upserted
- **Fallback**: If ESPN logo fetch fails, system uses original Polymarket logo
- **File Extensions**: Supports png, jpg, jpeg, svg (determined from ESPN response)

## Troubleshooting

1. **Logo not found (404)**: 
   - Ensure the team has been fetched/upserted first
   - Check that ESPN API returned a valid logo URL
   - Verify the team abbreviation matches ESPN's format

2. **Logo download fails**:
   - Check ESPN API is accessible
   - Verify team abbreviation is correct
   - Check logs for specific error messages

3. **Logo URL still points to Polymarket**:
   - Ensure `replaceLogoUrl` is being called
   - Check that teams were upserted after logo system was added

