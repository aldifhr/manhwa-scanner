# Manhwa Scanner - Architecture Documentation

## 📐 System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          EXTERNAL TRIGGERS                               │
├─────────────────────────────────────────────────────────────────────────┤
│  Vercel Cron (10min)  │  Discord Interactions  │  QStash Webhooks      │
└──────────┬────────────┴────────────┬───────────┴───────────┬────────────┘
           │                         │                        │
           ▼                         ▼                        ▼
┌──────────────────┐      ┌──────────────────┐    ┌──────────────────┐
│   /api/cron      │      │ /api/interactive │    │/api/qstash-worker│
│  (Cron Handler)  │      │ (Discord Cmds)   │    │ (Async Worker)   │
└────────┬─────────┘      └────────┬─────────┘    └────────┬─────────┘
         │                         │                        │
         │                         │                        │
         ▼                         ▼                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         CORE BUSINESS LOGIC                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      CRON RUNTIME                                 │  │
│  │  (lib/cronRuntime.ts)                                            │  │
│  │                                                                   │  │
│  │  1. Load Whitelist & Guild Channels                             │  │
│  │  2. Validate Discord Channels (cached)                          │  │
│  │  3. Orchestrate Scraping                                        │  │
│  │  4. Match & Filter Updates                                      │  │
│  │  5. Dispatch Notifications                                      │  │
│  │  6. Update Metrics & Logs                                       │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────��─────┐  │
│  │                   SCRAPING ORCHESTRATOR                          │  │
│  │  (lib/scrapers/orchestrator.ts)                                 │  │
│  │                                                                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │  │
│  │  │   Ikiru     │  │  Shinigami  │  │ Shinigami   │            │  │
│  │  │   Provider  │  │   Project   │  │   Mirror    │            │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘            │  │
│  │         │                │                │                     │  │
│  │         └────────────────┴────────────────┘                     │  │
│  │                          │                                       │  │
│  │                          ▼                                       │  │
│  │              ┌───────────────────────┐                          │  │
│  │              │  Metadata Enrichment  │                          │  │
│  │              │  (covers, ratings)    │                          │  │
│  │              └───────────────────────┘                          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                   DISPATCH SYSTEM                                │  │
│  │  (lib/services/dispatch.ts)                                     │  │
│  │                                                                   │  │
│  │  1. Prepare Queue (Deduplication)                               │  │
│  │     ├─ Same chapter check (Redis SENT/PENDING)                 │  │
│  │     ├─ Cross-source duplicate check                            │  │
│  │     └─ Prefer newer source                                     │  │
│  │                                                                   │  │
│  │  2. Claim Chapters (Atomic Redis Lua)                          │  │
│  │     └─ PENDING state with TTL                                  │  │
│  │                                                                   │  │
│  │  3. Enrich Metadata (if missing)                               │  │
│  │     └─ Fetch from cache or scrape                              │  │
│  │                                                                   │  │
│  │  4. Send to Discord                                            │  │
│  │     ├─ Direct dispatch (legacy)                                │  │
│  │     └─ QStash queue (async, with retry)                        │  │
│  │                                                                   │  │
│  │  5. Mark as SENT (Redis)                                       │  │
│  │     └─ Update history with timestamp                           │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    REDIS (Upstash)                               │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  DISPATCH HISTORY (Hash)                                │   │  │
│  │  │  Key: dispatch:history                                  │   │  │
│  │  │  Fields: {chapterKey} → {status, timestamp, source}    │   │  │
│  │  │  TTL: 24 hours                                          │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  WHITELIST (Hash)                                       │   │  │
│  │  │  Key: whitelist:v2                                      │   │  │
│  │  │  Fields: {titleKey} → {title, sources, channels}       │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  METADATA CACHE (Hash)                                  │   │  │
│  │  │  Key: manga:meta:{titleKey}                            │   │  │
│  │  │  Fields: cover, rating, status, description            │   │  │
│  │  │  TTL: 24 hours                                          │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  RECENT CHAPTERS (Sorted Set)                          │   │  │
│  │  │  Key: recent:chapters                                   │   │  │
│  │  │  Score: timestamp                                       │   │  │
│  │  │  Max: 100 items                                         │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  CHANNEL VALIDATION CACHE (Hash)                       │   │  │
│  │  │  Key: channels:validation                               │   │  │
│  │  │  Fields: {channelId} → {valid, expiresAt}             │   │  │
│  │  │  TTL: 6 hours                                           │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  SOURCE HEALTH (Hash)                                   │   │  │
│  │  │  Key: source:health                                     │   │  │
│  │  │  Fields: {source} → {errorCount, lastError, status}    │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────┐   │  │
│  │  │  QSTASH QUEUE (Set)                                     │   │  │
│  │  │  Key: qstash:pending                                    │   │  │
│  │  │  Members: {messageId}                                   │   │  │
│  │  │  Purpose: Track pending QStash messages                │   │  │
│  │  └─────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                                   │
├─────────────────────────────────────────────────────────────────────────┤
���                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │   Discord    │  │    QStash    │  │   Upstash    │                 │
│  │     API      │  │  (Upstash)   │  │    Redis     │                 │
│  │              │  │              │  │              │                 │
│  │  - Send      │  │  - Async     │  │  - State     │                 │
│  │    Embeds    │  │    Queue     │  │  - Cache     │                 │
│  │  - Validate  │  │  - Retry 3x  │  │  - Locks     │                 │
│  │    Channels  │  │  - Signature │  │  - Scripts   │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Data Flow

### **1. Cron Execution Flow**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CRON TRIGGER (Every 10 min)                       │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Load Inputs   │
                    │  - Whitelist   │
                    │  - Channels    │
                    └────────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │   Validate     │
                    │   Channels     │
                    │  (cached 6h)   │
                    └────────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Scrape All    │
                    │   Sources      │
                    │  (parallel)    │
                    └────────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Match Against │
                    │   Whitelist    │
                    └────────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │   Dispatch     │
                    │  (dedupe +     │
                    │   send)        │
                    └────────┬───────┘
                             │
                             ▼
                    ┌────────────────┐
                    │  Update Logs   │
                    │  & Metrics     │
                    └────────────────┘
```

### **2. Dispatch Flow (Detailed)**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      MATCHED CHAPTERS (from scraping)                    │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │ Build Chapter Meta │
                    │  - Unique key      │
                    │  - Duplicate key   │
                    │  - Source priority │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Fetch Redis State  │
                    │  - SENT status     │
                    │  - PENDING status  │
                    │  - Duplicate flags │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Filter Claimable  │
                    │  - Skip SENT       │
                    │  - Skip PENDING    │
                    │  - Skip duplicates │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Select Preferred   │
                    │  - Newer source    │
                    │  - Better metadata │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Claim (Atomic)    │
                    │  - Set PENDING     │
                    │  - TTL 10 min      │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Enrich Metadata    │
                    │  - From cache      │
                    │  - Or scrape       │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Get Subscribers   │
                    │  - Per manga       │
                    │  - Build mentions  │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   Send Discord     │
                    │  - Direct (legacy) │
                    │  - QStash (async)  │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   Mark as SENT     │
                    │  - Update Redis    │
                    │  - Add to recent   │
                    └────────────────────┘
```

### **3. QStash Async Flow**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         DISPATCH CHAPTERS                                │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
                    ┌────────────────────┐
                    │  Publish to QStash │
                    │  - Batch 100 items │
                    │  - Add to pending  │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │   QStash Queue     │
                    │  - Retry 3x        │
                    │  - Exponential     │
                    │    backoff         │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ /api/qstash-worker │
                    │  - Verify sig      │
                    │  - Process task    │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Send to Discord   │
                    │  - With buttons    │
                    │  - With mentions   │
                    └─────────┬──────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │  Update Redis      │
                    │  - Mark SENT       │
                    │  - Remove pending  │
                    └────────────────────┘
```

---

## 🏗️ Module Structure

### **Core Modules**

```
lib/
├── api/                    # HTTP endpoint handlers
│   ├── cron.ts            # Cron trigger handler
│   ├── interactive.ts     # Discord interaction handler
│   └── qstash-worker.ts   # QStash webhook handler
│
├── services/              # Business logic services
│   ├── dispatch.ts        # Core dispatch logic
│   ├── dispatch/
│   │   ├── deduplication.ts  # Deduplication system
│   │   ├── meta.ts           # Chapter metadata builder
│   │   └── history.ts        # History management
│   ├── qstash.ts          # QStash integration
│   ├── storage.ts         # Redis operations
│   ├── channelValidation.ts  # Discord channel validation
│   ├── notifications.ts   # User subscriptions
│   └── source-health.ts   # Circuit breaker
│
├── scrapers/              # Data fetching
│   ├── orchestrator.ts    # Scraping coordinator
│   ├── ikiru.ts           # Ikiru scraper
│   ├── secondary.ts       # Shinigami scrapers
│   └── shared.ts          # Common utilities
│
├── providers/             # Provider pattern
│   ├── base.ts            # Provider interface
│   ├── registry.ts        # Provider registry
│   ├── ikiru.ts           # Ikiru provider
│   └── shinigami.ts       # Shinigami provider
│
├── commands/              # Discord slash commands
│   ├── add.ts             # /add command
│   ├── remove.ts          # /remove command
│   └── sync.ts            # /sync command
│
├── utils/                 # Shared utilities
│   ├── scraping.ts        # Scraping utilities (NEW!)
│   ├── type-guards.ts     # Type guards
│   └── bounded-map.ts     # LRU cache
│
├── config/                # Configuration
│   ├── defaults.ts        # Config management (NEW!)
│   ├── env.ts             # Environment variables
│   └── deadlines.ts       # Timeout management
│
├── constants/             # Constants
│   └── redis.ts           # Redis key constants
│
├── cronRuntime.ts         # Cron orchestration
├── discord.ts             # Discord API client
├── redis.ts               # Redis client & utilities
├── redisScripts.ts        # Lua scripts
├── domain.ts              # Domain logic
├── types.ts               # TypeScript types
└── logger.ts              # Structured logging
```

---

## 🔐 Security

### **Authentication & Authorization**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SECURITY LAYERS                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. CRON ENDPOINT                                                       │
│     ├─ CRON_SECRET verification                                        │
│     ├─ Rate limiting (144 runs/day max)                                │
│     └─ IP whitelist (Vercel Cron IPs)                                  │
│                                                                          │
│  2. DISCORD INTERACTIONS                                                │
│     ├─ Ed25519 signature verification                                  │
│     ├─ Timestamp validation (5 min window)                             │
│     └─ Guild/user permission checks                                    │
│                                                                          │
│  3. QSTASH WEBHOOKS                                                     │
│     ├─ JWT signature verification                                      │
│     ├─ Signing key rotation support                                    │
│     └─ Replay attack prevention                                        │
│                                                                          │
│  4. DASHBOARD                                                           │
│     ├─ Password authentication                                         │
│     ├─ Session tokens (httpOnly cookies)                               │
│     ├─ Login throttling (5 attempts/15min)                             │
│     └─ CSRF protection                                                 │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Performance Characteristics

### **Cron Execution**

| Phase | Duration | Notes |
|-------|----------|-------|
| Load Inputs | ~700ms | Redis fetch (whitelist + channels) |
| Channel Validation | ~200ms | Cached (6h TTL), parallel (8 concurrent) |
| Scraping | ~6-8s | Parallel (3 sources), adaptive concurrency |
| Matching | ~1ms | In-memory filter |
| Dispatch | ~200-600ms | QStash: 200ms, Direct: 600ms |
| **Total** | **~8-10s** | Within Vercel 10s limit |

### **Dispatch Performance**

| Metric | Value | Notes |
|--------|-------|-------|
| Deduplication | ~50ms | Redis pipeline (Lua scripts) |
| Metadata Enrichment | ~100-200ms | Cached (24h TTL) |
| Discord Send | ~300-500ms | Per channel, rate limited |
| QStash Publish | ~50ms | Async, non-blocking |
| **Throughput** | ~50 chapters/run | Limited by scraping |

### **Redis Operations**

| Operation | Latency | Notes |
|-----------|---------|-------|
| HGET/HSET | ~10-20ms | Upstash (US East) |
| Pipeline (10 ops) | ~30-50ms | Batched |
| Lua Script | ~20-40ms | Atomic execution |
| ZADD (sorted set) | ~15-25ms | Recent chapters |

---

## 🔄 State Machine

### **Chapter Dispatch State**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      CHAPTER LIFECYCLE                                   │
└─────────────────────────────────────────────────────────────────────────┘

    NEW
     │
     │ Scraped from source
     ▼
  MATCHED
     │
     │ Whitelist filter
     ▼
  CLAIMABLE ──────────┐
     │                │ Already SENT/PENDING
     │                │ or duplicate
     │                ▼
     │             SKIPPED
     │
     │ Atomic claim
     ▼
  PENDING ────────────┐
     │                │ TTL expires (10min)
     │                │ or worker fails
     │                ▼
     │             STALE ──> Retry
     │
     │ Send success
     ▼
   SENT
     │
     │ TTL expires (24h)
     ▼
  EXPIRED
```

---

## 🚀 Deployment

### **Vercel Configuration**

```yaml
# vercel.json
{
  "crons": [
    {
      "path": "/api/cron?action=update",
      "schedule": "*/10 * * * *"  # Every 10 minutes
    }
  ],
  "functions": {
    "api/cron.ts": {
      "maxDuration": 10  # 10 seconds
    },
    "api/qstash-worker.ts": {
      "maxDuration": 30  # 30 seconds
    }
  }
}
```

### **Environment Variables**

```bash
# Required
DISCORD_BOT_TOKEN=...
DISCORD_PUBLIC_KEY=...
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
CRON_SECRET=...

# QStash (Optional)
QSTASH_ENABLED=true
QSTASH_TOKEN=...
QSTASH_WORKER_URL=...
QSTASH_CURRENT_SIGNING_KEY=...
QSTASH_NEXT_SIGNING_KEY=...

# Configuration (Optional, with defaults)
SCRAPE_TIMEOUT_MS=8000
SCRAPE_CONCURRENCY=8
CHAPTER_TTL_SEC=86400
CHAPTER_PENDING_TTL_SEC=600
```

---

## 📈 Monitoring

### **Observability Stack**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OBSERVABILITY                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. STRUCTURED LOGGING (Pino)                                          │
│     ├─ Request correlation IDs                                         │
│     ├─ Contextual metadata                                             │
│     └─ Log levels (trace, debug, info, warn, error)                   │
│                                                                          │
│  2. METRICS                                                             │
│     ├─ Cron execution duration                                         │
│     ├─ Chapters processed                                              │
│     ├─ Source response times                                           │
│     ├─ Error rates                                                     │
│     └─ Cache hit rates                                                 │
│                                                                          │
│  3. HEALTH CHECKS                                                       │
│     ├─ Source health tracking                                          │
│     ├─ Circuit breaker status                                          │
│     └─ Redis connectivity                                              │
│                                                                          │
│  4. DASHBOARD                                                           │
│     ├─ Recent chapters                                                 │
│     ├─ Cron logs (last 50 runs)                                       │
│     ├─ Source health status                                            │
│     └─ Whitelist management                                            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Key Design Decisions

### **1. Why QStash?**
- **Problem:** Vercel functions have 10s timeout, Discord sends can take 5-10s
- **Solution:** Async queue with automatic retries
- **Benefit:** 60% faster cron execution, better reliability

### **2. Why Redis Lua Scripts?**
- **Problem:** Race conditions in concurrent dispatch
- **Solution:** Atomic operations on Redis server
- **Benefit:** Zero race conditions, consistent state

### **3. Why Provider Pattern?**
- **Problem:** Multiple manga sources with different APIs
- **Solution:** Unified interface, pluggable providers
- **Benefit:** Easy to add new sources, testable

### **4. Why Cross-Source Deduplication?**
- **Problem:** Same chapter from multiple sources
- **Solution:** Normalize titles, check duplicates
- **Benefit:** No duplicate notifications

### **5. Why Channel Validation Cache?**
- **Problem:** Discord API rate limits
- **Solution:** Cache validity for 6 hours
- **Benefit:** 95% cache hit rate, faster execution

---

## 📚 Further Reading

- [Redis Best Practices](./docs/redis-patterns.md)
- [Deduplication Algorithm](./docs/deduplication.md)
- [QStash Integration Guide](./docs/qstash-setup.md)
- [Testing Strategy](./docs/testing.md)
- [Performance Tuning](./docs/performance.md)

---

**Last Updated:** 2026-04-23  
**Version:** 1.0.0  
**Maintainer:** Manhwa Scanner Team
