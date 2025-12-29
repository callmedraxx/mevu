# Price History API Documentation

## Overview

The Price History API allows you to fetch historical price data for CLOB tokens from Polymarket. The API fetches fresh data from Polymarket, stores it in our database, and returns it to you. Each request always fetches the latest data from Polymarket.

## Endpoint

**GET** `/api/price-history/:clobTokenId`

## URL Parameters

- **clobTokenId** (required): The CLOB token ID for the outcome you want price history for
  - For 2-way moneyline games: Use the clobTokenId of the moneyline outcome
  - For 3-way soccer games: Use the clobTokenId of the "yes" outcome for the home or away team

## Query Parameters

- **interval** (required): The time range for the price history. Must be one of:
  - `1h` - Last 1 hour
  - `6h` - Last 6 hours
  - `1d` - Last 1 day
  - `1w` - Last 1 week
  - `1m` - Last 1 month
  - `max` - All available history

- **fidelity** (optional): The resolution of the data in minutes. The API automatically applies minimum fidelity values required by Polymarket for each interval:
  - `1h`, `6h`, `1d`: minimum 1 minute
  - `1w`: minimum 5 minutes
  - `1m`, `max`: minimum 60 minutes
  
  If you don't provide fidelity, the API uses the minimum required for that interval. If you provide a value below the minimum, it will be automatically adjusted.

## Response Format

The API returns a JSON object with the following structure:

```
{
  "success": true,
  "clobTokenId": "string",
  "interval": "string",
  "pointCount": number,
  "history": [
    {
      "timestamp": number,  // Unix timestamp in seconds
      "price": number       // Price value (probability 0-100 or decimal 0-1)
    }
  ],
  "cached": boolean  // Only present if returning cached data (when Polymarket fetch fails)
}
```

## Response Fields

- **success**: Boolean indicating if the request was successful
- **clobTokenId**: The CLOB token ID that was queried
- **interval**: The time interval that was requested
- **pointCount**: The number of data points in the history array
- **history**: Array of price history points, ordered by timestamp (oldest first)
  - **timestamp**: Unix timestamp in seconds
  - **price**: The price value at that timestamp
- **cached**: (Optional) Present and set to `true` if the response contains cached data from our database instead of fresh data from Polymarket (this happens if Polymarket is unavailable)

## Error Responses

### 400 Bad Request
Returned when required parameters are missing or invalid:

```
{
  "success": false,
  "error": "error message describing what went wrong"
}
```

Common errors:
- `interval query parameter is required`
- `interval must be one of: 1h, 6h, 1d, 1w, 1m, max`
- `fidelity must be a positive integer` (if fidelity is provided but invalid)

### 500 Internal Server Error
Returned when the request fails due to server errors:

```
{
  "success": false,
  "error": "Failed to fetch price history",
  "details": "additional error details"  // Only in development mode
}
```

## Important Notes

1. **Always Fresh Data**: The API always fetches fresh data from Polymarket on each request. It stores this data in our database for future use, but every request triggers a new fetch from Polymarket.

2. **Fallback to Cache**: If the Polymarket API is unavailable, the API will automatically return cached data from our database if available. The response will include a `cached: true` field to indicate this.

3. **Fidelity Parameter**: In most cases, you don't need to provide the `fidelity` parameter. The API automatically applies the minimum fidelity required by Polymarket for each interval. Only include it if you want a higher value (less data points) to reduce data size.

4. **Timestamp Format**: All timestamps are Unix timestamps in seconds (not milliseconds).

5. **Price Values**: Price values represent probabilities and can be in the range 0-100 (percentages) or 0-1 (decimals) depending on the data source from Polymarket.

## Usage Example

To get 1 day of price history for a specific CLOB token:

```
GET /api/price-history/0x1234...?interval=1d
```

To get 1 week of price history with custom resolution:

```
GET /api/price-history/0x1234...?interval=1w&fidelity=30
```

## Integration Tips

- Use `1h` or `6h` intervals for live/real-time price charts
- Use `1d` for daily price movement charts
- Use `1w` or `1m` for longer-term trend analysis
- Use `max` to get all available historical data for a token
- The history array is sorted by timestamp in ascending order (oldest first), which is ideal for charting libraries
- Consider caching responses on the frontend for a short period (e.g., 1-5 minutes) to reduce API calls, since each request fetches fresh data from Polymarket

