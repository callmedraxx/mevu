# Kalshi partial update plan (tennis/soccer – avoid price swap)

## Goal
For sports with **two tickers per game** (tennis, soccer), we must not overwrite one team’s real Kalshi price with the other ticker’s derived NO price. We do that by marking which side(s) an update is for and having the frontend merge by side.

## Current behavior (problem)
- **Backend**: For every ticker we build one message with both `awayTeam` and `homeTeam`. For a single ticker we put real YES on one side and derived NO on the other → one side is wrong.
- **Frontend**: Replaces both sides with the payload → when the second ticker’s message arrives it overwrites the first side with wrong data (swap).

## Target behavior
- **Backend**: For tennis/soccer, when we have only one ticker (no merge), send a **partial** update: add `updatedSides: ['away']` or `['home']` and send real prices only for that side; the other side can be dummy (frontend will ignore it when `updatedSides` is present). When we have merged (both tickers), send full update and omit `updatedSides` (or set `['away','home']).
- **Frontend**: If `updatedSides` is present, only apply Kalshi prices for those sides (merge; keep existing for other sides). If `updatedSides` is absent, keep current behavior (replace both).

## What stays the same (no regression)
- **Single-ticker sports (NBA, NFL, UFC, etc.)**: No `updatedSides`; message always has both sides from one ticker (YES/NO). Frontend keeps replacing both → unchanged.
- **Merged tennis/soccer**: We send both sides and no `updatedSides` → frontend replaces both → unchanged.
- **DB / flush**: Existing flush logic (fullUpdates, awayOnlyUpdates, homeOnlyUpdates) and DB updates stay as-is. Only the **Redis broadcast payload** and **frontend apply logic** change.

---

## 1. Backend

### 1.1 Types (redis-cluster-broadcast + kalshi-price-update)

- **KalshiPriceBroadcastMessage** (and any shared KalshiPriceMessage):
  - Add optional: `updatedSides?: ('away' | 'home')[]`
  - When present: only the listed sides contain real data; the other side in the payload is ignored by the frontend.
  - When absent: full update, both sides are authoritative (current behavior).

### 1.2 Where messages are built (kalshi-price-update.service.ts)

- **publishPriceUpdates(updates)** (moneyline → Redis broadcast):
  - For each update, after computing `awayBuy/Sell`, `homeBuy/Sell`:
    - **Merged (tennis/soccer)**  
      `update.isAwayTeamTicker && update.isHomeTeamTicker` (and we have merged prices):  
      Build message with both sides. Do **not** set `updatedSides` (full update).
    - **Single-ticker tennis or soccer**  
      `sport` is tennis or soccer and only one of `isAwayTeamTicker` / `isHomeTeamTicker` is true:  
      - Set `updatedSides: ['away']` or `updatedSides: ['home']` accordingly.
      - Set only that side’s `kalshiBuyPrice` / `kalshiSellPrice` from the ticker’s YES prices.
      - For the other side, send a dummy object (e.g. 0, 0) so the type still has both `awayTeam` and `homeTeam`; frontend will ignore that side when `updatedSides` is present.
    - **All other cases** (single-ticker non-tennis/non-soccer, e.g. NBA):  
      No `updatedSides`; send both sides as today (YES/NO from one ticker). Frontend keeps full replace.

- **publishAllMarketUpdates** (if it is used for the same frontend feed):  
  Apply the same rule if it emits the same message shape; otherwise leave as-is if it’s only for the activity widget.

### 1.3 Games WebSocket / SSE

- They forward the same JSON they receive. No change needed except that the payload may now include `updatedSides`.

---

## 2. Frontend (GamesProvider – kalshi_price_update handler)

### 2.1 Apply logic

- Read `updatedSides` from the payload: `(data as any).updatedSides as ('away'|'home')[] | undefined`.
- **If `updatedSides` is present:**
  - **Away**: If `'away'` is in `updatedSides`, set  
    `kalshiBuyPrice` / `kalshiSellPrice` from `data.awayTeam` (and fallback to existing if needed).  
    If `'away'` is not in `updatedSides`, keep existing `awayTeam.kalshiBuyPrice` / `kalshiSellPrice`.
  - **Home**: If `'home'` is in `updatedSides`, set from `data.homeTeam`; otherwise keep existing.
  - Build `updatedGame` by merging only the updated side(s) into `existingGame` (same as today’s merge, but only for sides in `updatedSides`).
- **If `updatedSides` is absent (or not an array):**
  - Keep current behavior: apply both `awayTeam` and `homeTeam` from the payload (nullish coalesce with existing as today), so full replace for Kalshi fields.

### 2.2 Backward compatibility

- Old backend (no `updatedSides`): frontend never sees `updatedSides`, so it keeps full replace → no change.
- New backend + old frontend: new backend may send `updatedSides`; old frontend ignores it and still replaces both sides. So single-ticker tennis/soccer could still show a wrong side until the frontend is deployed. No new breakage.

---

## 3. Testing checklist

- **Tennis – single ticker (e.g. STA only):**  
  Backend sends `updatedSides: ['away']`, away = real STA prices, home = dummy.  
  Frontend: only away Kalshi prices change; home Kalshi prices unchanged.

- **Tennis – other ticker (UCH only):**  
  Backend sends `updatedSides: ['home']`, home = real UCH prices.  
  Frontend: only home Kalshi prices change; away unchanged.

- **Tennis – merged:**  
  Backend sends both sides, no `updatedSides`.  
  Frontend: both sides updated as today.

- **Soccer:**  
  Same as tennis (single-ticker → `updatedSides: ['away']` or `['home']`; merged → no `updatedSides`).

- **NBA (or other single-ticker sport):**  
  No `updatedSides`; both sides in payload.  
  Frontend: full replace, behavior unchanged.

- **Existing CLOB / game_update / initial load:**  
  No change; no `updatedSides` anywhere.

---

## 4. Files to touch (summary)

| Layer        | File(s) | Change |
|-------------|---------|--------|
| Backend     | `redis-cluster-broadcast.service.ts` | Add `updatedSides?: ('away' \| 'home')[]` to `KalshiPriceBroadcastMessage`. |
| Backend     | `kalshi-price-update.service.ts`     | In `publishPriceUpdates`, detect merged vs single-ticker tennis/soccer; set `updatedSides` and only real side for partial; keep full message for merged and non-tennis/soccer. |
| Frontend    | `GamesProvider.tsx`                  | In `kalshi_price_update` handler: if `updatedSides` present, merge only those sides; else keep current full replace. |
| (Optional)  | `games-websocket.service.ts`          | Only if the WS message type is typed; add `updatedSides` to the payload type so it’s forwarded as-is. |

---

## 5. Order of implementation

1. **Backend types**: Add `updatedSides` to the broadcast message type.
2. **Backend publish**: Implement partial vs full in `publishPriceUpdates` (tennis/soccer only).
3. **Frontend**: Implement merge-by-`updatedSides` in the `kalshi_price_update` handler.
4. **Manual test**: Tennis game, confirm one-ticker updates don’t swap; merged and NBA unchanged.

This keeps existing behavior for all current paths and only adds the partial-update behavior for tennis/soccer when the backend sends `updatedSides`.
