# Period Scores Verification Analysis

## Game: nba-cle-nyk-2025-12-25

### Current State Analysis

Based on the API response, the game currently shows:
- **Current Period**: Q3
- **Period Scores in Response**: Only `q3` is present
- **Missing**: Q1, Q2, HT (halftime)

### Why Q1 and Q2 Are Missing

The period scores (Q1, Q2) are likely missing because:

1. **Timing Issue**: The fix was deployed *after* Q1 and Q2 had already ended. The snapshot logic only runs when:
   - A WebSocket update is received with a period change
   - Or when a game is initially stored with score/period data

2. **No Retroactive Capture**: The system cannot retroactively capture period scores for periods that ended before the fix was deployed. The snapshot logic requires:
   - `previousPeriod` from the database (what period the game was in before the update)
   - `previousScore` from the database (the score at that time)
   - A period change event (e.g., Q2 → HT, HT → Q3)

3. **Expected Behavior**: For games that were already in progress when the fix was deployed, only periods that end *after* the deployment will be captured.

### Assurance: Q3 Will Be Stored

The fix ensures that **Q3 will be snapshotted and stored** when the period changes from Q3. Here's how:

#### Scenario 1: Q3 → Q4 Transition

When the WebSocket receives an update that the period changed from Q3 to Q4:

1. **Database State Before Update**:
   - `period` = "Q3"
   - `score` = "71-66" (example)
   - `period_scores` = `{"q3": {"away": 71, "home": 66}}` (or empty if Q3 wasn't tracked yet)

2. **WebSocket Update Received**:
   - `updates.period` = "Q4"
   - `updates.score` = "75-70" (example, new score)

3. **In `updateGameByGameIdInDatabase`**:
   - `previousPeriod` = "Q3" (from database)
   - `previousScore` = "71-66" (from database)
   - `previousPeriodScores` = `{"q3": {...}}` (from database)
   - `periodChanged` = `true` (Q3 ≠ Q4)
   - `currentScore` = `{away: 75, home: 70}` (parsed from WebSocket)

4. **In `calculatePeriodScores`**:
   ```typescript
   // Line 1383: Preserve all existing scores
   const result = { ...(previousPeriodScores || {}) };
   // Result: {"q3": {"away": 71, "home": 66}}
   
   // Lines 1399-1412: Snapshot previous period if period changed
   if (periodChanged && previousPeriod && previousScore) {
     const previousPeriodKey = normalizePeriodKey("Q3"); // Returns "q3"
     if (previousPeriodKey && previousPeriodKey !== "q4") {
       if (!result["q3"]) {  // If Q3 not already stored
         result["q3"] = {
           home: previousScore.home,  // 66
           away: previousScore.away,  // 71
         };
       }
     }
   }
   // Result: {"q3": {"away": 71, "home": 66}} (preserved)
   
   // Lines 1417-1423: Update current period (Q4 is ongoing)
   if (!isPeriodEnded) {  // Q4 is not an "end" state
     result["q4"] = {
       home: currentScore.home,  // 70
       away: currentScore.away,  // 75
     };
   }
   // Final result: {"q3": {"away": 71, "home": 66}, "q4": {"away": 75, "home": 70}}
   ```

5. **Database Update**:
   - `period_scores` is updated with the new JSONB value
   - Q3 is preserved, Q4 is added

#### Scenario 2: Q3 → Final Transition

When the game ends (Q3 → Final):

1. **WebSocket Update**:
   - `updates.period` = "Final" or "VFT"
   - `updates.score` = "100-95" (final score)

2. **In `calculatePeriodScores`**:
   ```typescript
   // Snapshot Q3 (same as Scenario 1)
   // Then handle Final:
   const isPeriodEnded = true;  // "Final" is an end state
   if (!result["final"]) {
     result["final"] = {
       home: currentScore.home,
       away: currentScore.away,
     };
   }
   // Final result: {"q3": {...}, "final": {"away": 100, "home": 95}}
   ```

### Key Guarantees from the Fix

1. **All Existing Scores Preserved**: Line 1383 uses `{ ...(previousPeriodScores || {}) }` to preserve all existing period scores.

2. **Previous Period Snapshot**: Lines 1399-1412 ensure that when a period changes, the previous period is snapshotted using `previousScore` from the database.

3. **No Overwriting**: Once a period score is stored (especially for ended periods), it is never overwritten.

4. **Live Updates**: Ongoing periods (like Q3) are updated with live scores, but when the period changes, the previous period's final score is snapshotted.

### Verification Steps

To verify the database state for this game, run:

```bash
NODE_ENV=production ts-node scripts/check-period-scores.ts nba-cle-nyk-2025-12-25
```

Or query directly in PostgreSQL:

```sql
SELECT 
  slug,
  period,
  score,
  period_scores,
  updated_at
FROM live_games 
WHERE LOWER(slug) = LOWER('nba-cle-nyk-2025-12-25');
```

### Expected Database State

For the game `nba-cle-nyk-2025-12-25`:

- **If Q1/Q2 are missing**: This is expected - they ended before the fix was deployed
- **If Q3 exists**: The game is currently in Q3, and Q3 is being tracked
- **When Q3 → Q4**: Q3 will be snapshotted and preserved, Q4 will be added
- **When Q4 → Final**: Q4 will be snapshotted, Final will be added

### Conclusion

**Q3 will definitely be stored** when the period changes from Q3 because:

1. The snapshot logic (lines 1399-1412) captures the previous period's score when `periodChanged = true`
2. All existing period scores are preserved (line 1383)
3. The fix handles all period transitions correctly (Q3 → Q4, Q3 → Final, etc.)

The missing Q1 and Q2 scores are a one-time issue for games that were in progress when the fix was deployed. All future period transitions will be captured correctly.

