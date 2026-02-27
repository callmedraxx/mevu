# CLOB WebSocket Disconnection Investigation

## Symptom

- CLOB shards disconnect with code **1006** (Abnormal Closure)
- Happens across multiple shards even with 500 assets per connection
- Frontend stops receiving token updates until reconnect
- Reconnects work but cause temporary data gaps

## Root Cause: Wrong Heartbeat Protocol

**Polymarket's CLOB WebSocket requires application-level text heartbeats, not WebSocket protocol pings.**

From [Polymarket docs](https://docs.polymarket.com/developers/CLOB/websocket/wss-overview):

> **Market and User Channels**: Send `PING` every 10 seconds. The server responds with `PONG`.
>
> **Connection drops after about 10 seconds**: You're not sending heartbeats. Send `PING` every 10 seconds for market/user channels.

### What we were doing wrong

| Current (wrong) | Required |
|-----------------|----------|
| `ws.ping()` — WebSocket protocol-level ping (binary control frame) | `ws.send('PING')` — Text message over the wire |
| Server may ignore protocol pings | Server expects text "PING" and replies with text "PONG" |

The Polymarket server does **not** recognize `ws.ping()` as a valid heartbeat. It expects a **text message** containing the string `"PING"`. Without this, the server closes the connection after ~10–15 seconds with code 1006.

### Why sharding didn't fix it

Sharding (500 assets per connection) addresses the **500-instrument limit** per connection. It does **not** address the heartbeat requirement. Each of the 25 connections (1 primary + 24 shards) must send text `"PING"` every 10 seconds. We were sending `ws.ping()` on all of them, so all were being closed by the server.

## Fix

Change heartbeat from `ws.ping()` to `ws.send('PING')` for:

1. **Primary connection** — in `ping()` method
2. **All shards** — in the shard's `pingInterval` callback

## Other Considerations

1. **Message volume**: 500 subscriptions × 24 shards = 12,000 assets. Each asset can generate price_change, book updates, etc. High message volume could contribute to instability, but the primary cause is the heartbeat.

2. **replaceSubscriptions**: When `replaceSubscriptions()` is called (e.g. during game refresh), it triggers `forceReconnect()` which closes all connections and reopens. The close-then-open strategy avoids duplicate connections. Ensure we're not calling this too frequently.

3. **Reconnect backoff**: Shards use 3s base delay. Exponential backoff (3s, 6s, 12s, 24s) applies only when disconnects happen rapidly (<10s uptime). If the connection was stable (>10s) before close, the next reconnect uses the short 3s delay — since disconnects minutes/hours apart are independent events, not rapid failures. The max-reconnect limit (5 attempts) applies only to rapid failures; stable disconnects always retry. After 5 rapid failures, we wait 60s then retry (fresh start).

---

## Ongoing: 1006 Disconnects After Minutes (Feb 2026)

Even with correct heartbeats, individual shards still close with **1006** after several minutes (3–8+ min). This is **not** from our code.

### Evidence

1. **Code 1006 = Abnormal closure** — Connection closed without a proper close frame. Our intentional closes use `1000` (normal closure).
2. **Individual shards close one at a time** — When we call `forceReconnect`, we close *all* shards at once and log "Closed CLOB shard connections". The 1006 disconnects are single shards closing independently.
3. **Crypto market switch does NOT trigger CLOB reconnection** — `registerToken` (orderbook) and `registerTokens` (price) only update local routing maps. They do not call `replaceSubscriptions` or `forceReconnect`. `replaceSubscriptions` is only called from `subscribeToAllGames`, which runs on games refresh (crypto hourly, sports, live games). When it runs, it only triggers `forceReconnect` if the asset list actually changed; otherwise it returns early.

4. **Confirmed correlation (Feb 2026)**: Disconnects occur when a user switches to a **new market that hasn't been visited before**. The shard that handles that market's tokens disconnects shortly after (within seconds). This is likely Polymarket's server reacting to new market activity (first visitor triggers server-side behavior) rather than our code. Diagnostic logging now records `recentlyRegisteredTokenOnShard: true` when the closed shard's assets include a token registered in the last 60 seconds. Stable uptime threshold for "fresh" disconnect: 10s.

### Likely causes (Polymarket / network)

- **Server-side load shedding** — Polymarket may close connections under load
- **Load balancer / proxy timeout** — Idle or long-lived connection limits
- **Connection limits per IP** — We use 25 connections (1 primary + 24 shards) for ~12k assets
- **Network blips** — Transient failures

### What we cannot prevent

We cannot prevent Polymarket (or intermediaries) from closing connections. The reconnect logic correctly recovers; it uses a short 3s delay when the connection was stable (>10s) before close, and exponential backoff only for rapid successive failures (<10s uptime).

### Diagnostic logging added

- **Shard close (1006)** — Logs `uptimeSec` and `uptimeMin` to correlate with user actions and timing
- **replaceSubscriptions** — Logs when it triggers `forceReconnect` vs returns early (no change)
