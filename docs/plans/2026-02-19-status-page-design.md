# Status Page Design — Admin Ops Dashboard

**Date:** 2026-02-19
**Audience:** Admin-only (not in main nav, accessible at `/status`)
**Refresh:** Manual (no auto-poll)

## Overview

An admin status page that surfaces cron health, cache freshness, and data quality metrics in one view. Lets the operator quickly spot pipeline issues without inspecting Cloudflare logs.

## Architecture: Single `/api/status` Endpoint

One rich endpoint powers the entire page. Replaces the existing `/api/health` for status page purposes (health endpoint remains for external uptime checks).

## 1. `cron_runs` D1 Table

New migration:

```sql
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,       -- 'ok' | 'error'
  error TEXT,
  item_count INTEGER,
  metadata TEXT               -- optional JSON
);
CREATE INDEX idx_cron_runs_job_started ON cron_runs(job, started_at DESC);
```

**Retention:** 7 days. Pruned on each insert (`DELETE WHERE started_at < now - 604800`).

**Logging helper** (`worker/src/lib/db.ts`):

```typescript
interface CronResult {
  itemCount?: number;
  metadata?: string;
}

async function logCronRun(
  db: D1Database,
  job: string,
  fn: () => Promise<CronResult | void>
): Promise<void> {
  const start = Date.now();
  try {
    const result = await fn();
    await db.prepare(
      'INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?,?,?,?,?,?)'
    ).bind(job, Math.floor(start/1000), Date.now()-start, 'ok',
      result?.itemCount ?? null, result?.metadata ?? null).run();
  } catch (e) {
    await db.prepare(
      'INSERT INTO cron_runs (job, started_at, duration_ms, status, error) VALUES (?,?,?,?,?)'
    ).bind(job, Math.floor(start/1000), Date.now()-start, 'error', String(e)).run();
    throw e;
  }
  // Prune old rows
  await db.prepare('DELETE FROM cron_runs WHERE started_at < ?')
    .bind(Math.floor(Date.now()/1000) - 604800).run();
}
```

Each cron job is wrapped: `await logCronRun(db, 'sync-stablecoins', () => syncStablecoins(db))`.

## 2. `/api/status` Endpoint

**Response shape:**

```typescript
interface StatusResponse {
  timestamp: number;
  overallStatus: 'healthy' | 'degraded' | 'stale';

  caches: Record<string, {
    ageSeconds: number | null;
    maxAge: number;
    healthy: boolean;
  }>;

  crons: Record<string, {
    lastRun: {
      startedAt: number;
      durationMs: number;
      status: string;
      error?: string;
      itemCount?: number;
    } | null;
    recentRuns: Array<{
      startedAt: number;
      durationMs: number;
      status: string;
      error?: string;
    }>;
    expectedIntervalSec: number;
    healthy: boolean;
  }>;

  dataQuality: {
    totalStablecoins: number;
    missingPrices: number;
    blacklistMissingAmounts: number;
    blacklistTotal: number;
    onchainSupplyDivergences: number;
    activeDepegs: number;
    staleOnchainSupply: number;
  };
}
```

**Caches tracked:**

| Key | Max age (sec) | Source cron |
|-----|--------------|-------------|
| `stablecoins` | 600 | sync-stablecoins (5min) |
| `stablecoin-charts` | 600 | sync-stablecoin-charts (5min) |
| `usds-status` | 86400 | sync-usds-status (15min, 20h skip) |
| `bluechip-ratings` | 43200 | sync-bluechip (15min, 6h skip) |
| `fx-rates` | 7200 | sync-fx-rates (2h) |

**Crons tracked (9 jobs):**

| Job | Expected interval |
|-----|------------------|
| sync-stablecoins | 300s (5min) |
| sync-stablecoin-charts | 300s (5min) |
| sync-blacklist | 900s (15min) |
| sync-dex-liquidity | 600s (10min) |
| sync-onchain-supply | 1800s (30min) |
| sync-usds-status | 900s (15min) |
| sync-bluechip | 900s (15min) |
| sync-fx-rates | 7200s (2h) |
| detect-depegs | 300s (5min, inline) |

`recentRuns`: last 10 per job.

**Healthy logic per cron:** last run status is `ok` AND `started_at` is within 2× expected interval.

**Overall status:**
- `stale`: any cache >2× max age OR any cron last run is `error`
- `degraded`: any cache >1.5× max age
- `healthy`: everything within bounds

**Data quality queries:**
- `missingPrices`: parse `stablecoins` cache JSON, count items with null/0 price
- `blacklistMissingAmounts` + `blacklistTotal`: `SELECT COUNT(*), SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) FROM blacklist_events`
- `onchainSupplyDivergences`: compare `onchain_supply` vs stablecoins cache, count >5% divergence
- `activeDepegs`: `SELECT COUNT(*) FROM depeg_events WHERE ended_at IS NULL`
- `staleOnchainSupply`: `SELECT COUNT(DISTINCT stablecoin_id) FROM onchain_supply WHERE updated_at < now - 7200`

**Cache-Control:** `no-store` (like existing health endpoint).

**Auth:** Admin-key protected via `X-Admin-Key` header (same as `backfill-depegs`).

## 3. Frontend — `/status` Page

**Route:** `src/app/status/page.tsx` + `src/app/status/client.tsx`
**Not in main nav** — accessed directly at `pharos.watch/status`.

### Layout (top to bottom):

#### Overall Status Banner
- Full-width colored bar: green/amber/red
- Shows "Healthy" / "Degraded" / "Stale" + timestamp

#### Cron Jobs Grid
- 2-column card grid (desktop), 1-column (mobile)
- One card per cron job:
  - Job name + expected interval label
  - Last run: relative timestamp, duration, status badge (green/red)
  - Error message (collapsible) if last run failed
  - Row of 10 dots (green/red) showing recent run history — visual pattern spotting
  - Card border color indicates health

#### Data Quality Cards
- Row of stat cards:
  - **Missing Prices** (amber >0, red >5)
  - **Blacklist Gaps** (missing / total)
  - **On-chain Divergences**
  - **Active Depegs**
  - **Stale On-chain Supply**

#### Cache Freshness Table
- Columns: cache key, age (human-readable), max age, status dot
- Sorted by staleness (most stale first)

### Components
- Reuse existing shadcn `Card`, `Badge`, `Table` primitives
- New: `StatusBanner`, `CronCard`, `DataQualityCards`, `CacheFreshnessTable`
- Hook: `useStatus()` — `useApiQuery<StatusResponse>('/api/status')` with no refetchInterval

### Admin Key
- Page reads admin key from an env var or URL param (`?key=...`) and passes it as `X-Admin-Key` header in the fetch.

## 4. Files Changed

### Worker (new/modified):
- `worker/migrations/0014_cron_runs.sql` — new migration
- `worker/src/lib/db.ts` — add `logCronRun()` helper
- `worker/src/api/status.ts` — new endpoint
- `worker/src/router.ts` — add `/api/status` route
- `worker/src/index.ts` — wrap each cron call with `logCronRun()`
- `worker/src/cron/*.ts` — each cron returns `CronResult` (optional, for item counts)

### Frontend (new):
- `src/app/status/page.tsx` — server component (metadata)
- `src/app/status/client.tsx` — client component (main page)
- `src/components/status-banner.tsx`
- `src/components/cron-card.tsx`
- `src/components/data-quality-cards.tsx`
- `src/components/cache-freshness-table.tsx`
- `src/hooks/use-status.ts` — TanStack Query hook
