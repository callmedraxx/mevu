# Solana USDC Deposit Webhook & Kalshi Balance SSE Trace

Trace of the flow from Alchemy Solana webhook → DB update → SSE to frontend for Kalshi USDC balance.

---

## 1. Alchemy Solana Webhook (Entry Point)

**Endpoint:** `POST /api/webhooks/alchemy-solana`

**Source:** Alchemy Address Activity webhook (configured in Alchemy Dashboard for Solana). Fires when any monitored Solana address has token/NFT activity.

**Flow:**
1. Request hits `src/routes/webhooks.ts` (router.post('/alchemy-solana'))
2. Raw body captured for signature verification (middleware in `src/index.ts`)
3. Signature verified via `verifySolanaWebhookSignature`
4. **Log added:** `[ALCHEMY_SOLANA_WEBHOOK] Received Solana address activity` (webhookId, network, activityCount)
5. Response 200 sent immediately (async processing)
6. `processSolanaWebhook(req.body)` called

---

## 2. Process Solana Webhook

**File:** `src/services/alchemy/alchemy-solana-webhook.service.ts`

**Flow:**
1. Extract `event.activity` and `event.network`
2. Filter: only `SOLANA_MAINNET` (or network containing "SOLANA")
3. **Log added:** `[ALCHEMY_SOLANA_WEBHOOK] Processing Solana USDC activity` (activityCount, network)
4. Load `solanaToUser` map: `users.solana_wallet_address` → `privy_user_id`
5. For each activity:
   - Skip if value ≤ 0
   - Skip if not USDC (asset, rawContract.address, or category=token)
   - Parse amount from `rawContract.rawValue` or value×1e6

**Incoming (deposit):** `toAddress` matches user Solana wallet
- `addToKalshiUsdcBalance(privyUserId, amountHuman)` → updates `users.kalshi_usdc_balance`
- `publishKalshiPositionUpdate(privyUserId, { type: 'balance_update', amount, source: 'solana_deposit' })`
- **Log:** `Solana USDC deposit detected and credited` (privyUserId, toAddress, amount, txHash)

**Outgoing (withdrawal):** `fromAddress` matches user Solana wallet
- `subtractFromKalshiUsdcBalance(privyUserId, amountHuman)`
- `publishKalshiPositionUpdate(privyUserId, { type: 'balance_update', amount: '-X', source: 'solana_withdrawal' })`
- **Log:** `Solana USDC withdrawal detected and debited` (privyUserId, fromAddress, amount, txHash)

---

## 3. Redis Broadcast (Cluster Bridge)

**File:** `src/services/redis-cluster-broadcast.service.ts`

**Channel:** `kalshi:user`

**Flow:**
1. `publishKalshiPositionUpdate(privyUserId, position)` publishes to Redis:
   - `{ type: 'kalshi_position_update', privyUserId, position }`
2. All workers subscribed to `KALSHI_USER_CHANNEL` receive the message
3. `subscribeToKalshiUserBroadcast(callback)` registers callbacks that are invoked when Redis delivers the message

**Purpose:** In cluster mode, the webhook may hit Worker A while the user's SSE connection is on Worker B. Redis pub/sub ensures Worker B receives the update and can push to the SSE client.

---

## 4. Kalshi Balance SSE Stream

**Endpoint:** `GET /api/kalshi-trading/balance/stream?privyUserId=...`

**File:** `src/routes/kalshi-trading.ts`

**Flow:**
1. Validate privyUserId, fetch user, resolve Solana address
2. Set SSE headers (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive)
3. Send initial snapshot: `{ type: 'snapshot', balance: kalshiUsdcBalance }`
4. Subscribe to `subscribeToKalshiUserBroadcast`
5. On `kalshi_position_update` with `position.type === 'balance_update'`:
   - Fetch fresh user from DB (balance was just updated)
   - Write `{ type: 'balance_update', balance: newBalance }` to SSE stream
6. Heartbeat every 30s: `: heartbeat\n\n`
7. On `req.close`: unsubscribe, clear heartbeat, end response

---

## 5. Frontend Usage

**SSE URL:** `/api/kalshi-trading/balance/stream?privyUserId={did:privy:...}`

**Events:**
- `snapshot` – initial balance when stream opens
- `balance_update` – new balance after deposit, withdrawal, or trade

**Header / Mobile Header:** The frontend subscribes to this SSE and updates the displayed Kalshi USDC balance when `balance_update` is received.

---

## 6. Other Publishers of balance_update

Besides Alchemy Solana webhook, `publishKalshiPositionUpdate` with `balance_update` is called from:
- **Kalshi trades** – `kalshi-trading.service.ts` (syncBalanceAfterTrade fallback, post-trade)
- **Kalshi redemption** – `kalshi-redemption.service.ts`
- **Onramp webhook** – `onramp-webhook.service.ts` (MoonPay/onramp completion)

---

## Log Summary

| Log Message | Location | When |
|-------------|----------|------|
| `[ALCHEMY_SOLANA_WEBHOOK] Received Solana address activity` | webhooks.ts | Webhook POST received |
| `[ALCHEMY_SOLANA_WEBHOOK] Processing Solana USDC activity` | alchemy-solana-webhook.service.ts | Starting to process activity |
| `Solana USDC deposit detected and credited` | alchemy-solana-webhook.service.ts | Incoming USDC matched to user |
| `Solana USDC withdrawal detected and debited` | alchemy-solana-webhook.service.ts | Outgoing USDC matched to user |
