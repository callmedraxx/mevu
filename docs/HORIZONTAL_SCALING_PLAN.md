# Horizontal Scaling Plan

This document outlines how to scale the MEVU API horizontally (multiple app instances behind a load balancer).

## Current Architecture (Single Instance)

```
                    ┌─────────────────────────────────────────┐
                    │              app (1 container)           │
                    │  ┌─────────┐ ┌─────────┐ ┌────────────┐ │
                    │  │ Sports  │ │  CLOB   │ │ HTTP x3    │ │
                    │  │ Worker  │ │ Worker  │ │ (API+WS)   │ │
                    │  └────┬────┘ └────┬────┘ └─────┬──────┘ │
                    └──────┼───────────┼────────────┼────────┘
                           │           │            │
                    ┌──────┴───────────┴────────────┴────────┐
                    │              Redis (pub/sub + cache)   │
                    └──────────────────┬───────────────────┘
                    ┌───────────────────┴───────────────────┐
                    │        PgBouncer → PostgreSQL          │
                    └────────────────────────────────────────┘
```

## Key Constraints

### 1. Background Workers (Sports, CLOB)
- **Must run exactly once** across the entire deployment
- Sports: polls live games, teams, scores; writes to Redis/DB
- CLOB: WebSocket to CLOB for price updates; publishes to Redis
- **Solution:** Separate services OR leader election

### 2. WebSockets
- Clients connect to a specific HTTP worker
- Redis pub/sub already delivers updates to **all workers in the same instance**
- With multiple instances: need Redis pub/sub to deliver to **all instances**
- **Current:** Redis cluster broadcast exists; each instance subscribes
- **Requirement:** Sticky sessions OR ensure Redis pub/sub reaches every instance (it does—all connect to same Redis)

### 3. In-Memory State
- Request coalescing (games/frontend): per-process; with multiple instances, each instance has its own
- Redis games cache: shared across instances ✓
- Frontend games cache: per-instance; Redis invalidation broadcast already clears all
- **Recommendation:** Use Redis-based coalescing for hot endpoints (games/frontend) so all instances share one fetch

### 4. Database Connections
- Per instance: 5 processes × 25 connections = 125 to PgBouncer
- PgBouncer: max_client_conn=10000, default_pool_size=100, max_db_connections=140
- **With 3 app instances:** 3 × 125 = 375 client connections; need max_db_connections ≥ 140 (pool_mode=transaction shares well)
- **Action:** Increase PgBouncer `max_client_conn` and Postgres `max_connections` if scaling beyond a few instances

### 5. Redis
- Single Redis: fine for moderate scale
- Each instance: ~5 Redis connections (games cache, cluster broadcast pub/sub)
- **Scale:** Redis can handle 10k+ connections; add Redis Cluster/Sentinel for HA

---

## Scaling Strategies

### Strategy A: Split HTTP from Background (Recommended)

Run **two app modes** in separate containers:

| Service        | Replicas | Role                                      |
|----------------|----------|-------------------------------------------|
| `app-http`     | N (e.g. 3–5) | HTTP API + WebSockets, no background work |
| `app-workers`  | 1        | Sports + CLOB workers only                |

**app-http** (scalable):
- `WORKER_TYPE=http` only; no sports/CLOB
- Serves API, WebSockets
- Reads from Redis cache (written by app-workers)
- Subscribes to Redis pub/sub for real-time updates

**app-workers** (single instance):
- `WORKER_TYPE=sports` and `WORKER_TYPE=clob`
- Polls external APIs, writes to Redis/DB
- Publishes to Redis for HTTP instances

**Code changes:**
1. Add env `APP_MODE=http|workers|all` (default `all` for backward compatibility)
2. When `APP_MODE=http`: only start HTTP workers, skip sports/CLOB
3. When `APP_MODE=workers`: only start sports + CLOB, no HTTP server
4. When `APP_MODE=all`: current behavior (single container)

**docker-compose scaling:**
```yaml
services:
  app-http:
    build: .
    environment:
      - APP_MODE=http
      - WORKER_COUNT=4  # 4 HTTP workers per container
    deploy:
      replicas: 3       # 3 containers = 12 HTTP workers total
    # ...

  app-workers:
    build: .
    environment:
      - APP_MODE=workers
      - WORKER_COUNT=3  # 1 sports + 1 CLOB + 1 spare
    deploy:
      replicas: 1       # Exactly 1
    # ...
```

---

### Strategy B: All-in-One with Replicas + Leader Election

Keep single app image, scale replicas, use **leader election** so only one instance runs background workers.

- Use Redis `SET NX` or similar for leader lock
- Leader: runs sports + CLOB + HTTP
- Followers: HTTP only
- On leader failure: new leader acquired, starts background workers

**Pros:** Single image, simpler deploy
**Cons:** More complex, leader failover delay

---

### Strategy C: Separate Background Service

Extract sports + CLOB into a **standalone background service** (different repo or container).

- Background service: polls APIs, writes Redis/DB, publishes to Redis
- API service: HTTP + WebSockets only, horizontally scalable
- Clean separation, each service scales independently

---

## Implementation Checklist (Strategy A)

### Phase 1: Code Changes
- [ ] Add `APP_MODE` env var and branch startup logic in `index.ts`
- [ ] When `APP_MODE=http`: skip sports/CLOB fork, only run HTTP workers
- [ ] When `APP_MODE=workers`: skip HTTP server, only run sports + CLOB
- [ ] Ensure Redis URL and DB URL are identical for all instances

### Phase 2: Docker / Orchestration
- [ ] Create `app-http` and `app-workers` services (or use same image with different env)
- [ ] Use same Dockerfile, different `command` or `APP_MODE`
- [ ] Load balancer in front of `app-http` (nginx, HAProxy, or cloud LB)
- [ ] Optional: sticky sessions for WebSocket affinity (not strictly required—Redis pub/sub works across instances)

### Phase 3: Infrastructure
- [ ] PgBouncer: verify `max_client_conn` and `max_db_connections` for N instances
- [ ] Postgres: `max_connections` ≥ PgBouncer `max_db_connections`
- [ ] Redis: consider Redis Sentinel or Cluster for HA
- [ ] Nginx/load balancer: tune `worker_connections`, `keepalive`

### Phase 4: Optional Optimizations
- [ ] Redis-based request coalescing for games/frontend (cross-instance)
- [ ] Add more HTTP workers per container (`WORKER_COUNT=7` → 5 HTTP)
- [ ] Consider read replicas for Postgres for heavy read endpoints

---

## Example: Docker Compose with 3 HTTP Instances

```yaml
services:
  app-http:
    build: .
    image: mevu-app
    environment:
      - APP_MODE=http
      - WORKER_COUNT=5   # 5 HTTP workers per container
      - NODE_ENV=production
      - DATABASE_URL=postgresql://user:password@pgbouncer:6432/mevu
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 3
    depends_on:
      - pgbouncer
      - redis

  app-workers:
    build: .
    image: mevu-app
    environment:
      - APP_MODE=workers
      - WORKER_COUNT=3
      - NODE_ENV=production
      - DATABASE_URL=postgresql://user:password@pgbouncer:6432/mevu
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 1
    depends_on:
      - pgbouncer
      - redis

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - app-http
```

---

## Load Balancer Configuration (Nginx)

- **WebSocket support:** `Upgrade` and `Connection` headers
- **Health checks:** `/health` or `/api/health`
- **Upstream:** round-robin or least_conn across `app-http` instances

```nginx
upstream api {
    least_conn;
    server app-http-1:3000;
    server app-http-2:3000;
    server app-http-3:3000;
}

server {
    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;  # For WebSocket
    }
}
```

---

## Summary

| Component       | Current              | Horizontal scaling                    |
|----------------|----------------------|----------------------------------------|
| HTTP workers   | 3 (1 container)      | 3 × N containers (e.g. 9–15 total)     |
| Background     | 1 sports, 1 CLOB     | 1 container (or leader-elected)        |
| Redis          | 1                    | 1 (or cluster for HA)                  |
| Postgres       | 1 + PgBouncer        | Same; tune connection limits           |
| Load balancer  | None (direct)        | Nginx / HAProxy / cloud LB             |

**Recommended path:** Strategy A (split HTTP from workers) with `APP_MODE` for minimal code change and clear separation of concerns.

---

## Multi-Droplet Deployment (e.g. DigitalOcean)

With **3+ separate droplets**, each running Docker, PostgreSQL and Redis must be **shared** — all app droplets connect to the **same** database and Redis. You cannot run a separate DB on each droplet; that would create 3 independent systems with no shared data.

### Architecture: Shared Data Layer

```
                         ┌─────────────────────┐
                         │   Load Balancer     │
                         │   (nginx or DO LB)  │
                         └──────────┬──────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
              ▼                     ▼                     ▼
    ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
    │   Droplet 1     │   │   Droplet 2     │   │   Droplet 3     │
    │   Docker        │   │   Docker        │   │   Docker        │
    │   app-http x1   │   │   app-http x1   │   │   app-http x1   │
    └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │   Droplet 4 (or Managed)  │
                    │   PostgreSQL             │
                    │   PgBouncer               │
                    │   Redis                   │
                    │   app-workers (optional)  │
                    └──────────────────────────┘
```

### Option 1: Dedicated Data Droplet

| Droplet | Role | Docker |
|---------|------|--------|
| **Droplet 1** | app-http only | `APP_MODE=http` |
| **Droplet 2** | app-http only | `APP_MODE=http` |
| **Droplet 3** | app-http only | `APP_MODE=http` |
| **Droplet 4** | Postgres + PgBouncer + Redis + app-workers | Full stack (DB, cache, background workers) |

- **App droplets:** Run only `app-http` containers. `DATABASE_URL` and `REDIS_URL` point to Droplet 4’s **private IP** (e.g. `postgresql://user:pass@10.0.0.4:6432/mevu`).
- **Data droplet:** Runs postgres, pgbouncer, redis, app-workers. Exposes PgBouncer (6432) and Redis (6379) on a private network.
- **Load balancer:** DO Load Balancer or a 5th droplet with nginx, forwarding to Droplets 1–3.

### Option 2: Managed Database + Redis

| Droplet | Role |
|---------|------|
| **Droplet 1** | app-http |
| **Droplet 2** | app-http |
| **Droplet 3** | app-http |
| **Droplet 4** | app-workers (or run on Droplet 1) |
| **DO Managed Postgres** | Database (connection string from DO) |
| **DO Managed Redis** | Cache + pub/sub |

- No DB/Redis on your droplets.
- All app droplets use the same managed DB and Redis connection strings.
- Simpler ops, backups, and failover handled by DO.

### Connection Strings for App Droplets

Each app droplet needs the **same** URLs, pointing to the shared layer:

```env
# On Droplet 1, 2, 3 (app-http)
APP_MODE=http
DATABASE_URL=postgresql://user:password@<pgbouncer-ip>:6432/mevu
REDIS_URL=redis://<redis-ip>:6379
```

- `<pgbouncer-ip>`: Private IP of the droplet running PgBouncer, or DO Managed DB host.
- `<redis-ip>`: Private IP of the droplet running Redis, or DO Managed Redis host.

### Docker on Each App Droplet

Each app droplet runs a reduced compose with only the app:

```yaml
# docker-compose.yml on Droplet 1, 2, 3
services:
  app:
    image: mevu-app:latest
    environment:
      - APP_MODE=http
      - WORKER_COUNT=5
      - DATABASE_URL=postgresql://user:pass@10.0.0.4:6432/mevu
      - REDIS_URL=redis://10.0.0.4:6379
    ports:
      - "3000:3000"
```

No postgres, redis, or pgbouncer on these droplets.

### Docker on the Data Droplet (Option 1)

Runs the full stack, but with `APP_MODE=workers` so it only does background work:

```yaml
# docker-compose.yml on Droplet 4
services:
  postgres:
    # ... (your existing postgres config)

  pgbouncer:
    # ... (ensure listen on 0.0.0.0 or private interface for other droplets)

  redis:
    # ... (ensure bind to private IP or 0.0.0.0 for other droplets)

  app-workers:
    image: mevu-app:latest
    environment:
      - APP_MODE=workers
      - DATABASE_URL=postgresql://user:pass@pgbouncer:6432/mevu
      - REDIS_URL=redis://redis:6379
```

### DigitalOcean Private Network

1. Enable **VPC / Private Networking** for all droplets.
2. Use **private IPs** for `DATABASE_URL` and `REDIS_URL` (e.g. `10.0.0.x`).
3. Firewall: allow 6432 and 6379 only from the app droplet private IPs.

### PgBouncer and Postgres Tuning

With 3 app droplets × 5 workers × 25 connections ≈ 375 client connections:

- `pgbouncer.ini`: `max_client_conn = 5000` (or higher)
- Postgres: `max_connections >= 150`
- PgBouncer `pool_mode = transaction` so 100 DB connections can serve many more clients.

### Summary: What Runs Where

| Component | Where it runs | Shared? |
|-----------|---------------|---------|
| **PostgreSQL** | 1 droplet (or Managed) | Yes — single source of truth |
| **PgBouncer** | Same droplet as Postgres | Yes |
| **Redis** | 1 droplet (or Managed) | Yes — shared cache and pub/sub |
| **app-http** | 3+ droplets | No — each runs its own containers |
| **app-workers** | 1 droplet (can be data droplet) | No — only one instance |
| **Load balancer** | DO LB or dedicated droplet | Distributes to app droplets |
