# Status Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an admin-only status page at `/status` that surfaces cron health, cache freshness, and data quality metrics in one view.

**Architecture:** Single `/api/status` worker endpoint (admin-key-protected) returns all diagnostic data. New `cron_runs` D1 table logs every cron execution. Frontend is a Next.js page with shadcn components — not in main nav, manual refresh only.

**Tech Stack:** Cloudflare Workers + D1, Next.js 16 static export, React 19, TanStack Query, shadcn/ui, Tailwind v4.

**Design doc:** `docs/plans/2026-02-19-status-page-design.md`

---

### Task 1: D1 Migration — `cron_runs` Table

**Files:**
- Create: `worker/migrations/0014_cron_runs.sql`

**Step 1: Write the migration**

```sql
-- worker/migrations/0014_cron_runs.sql
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  item_count INTEGER,
  metadata TEXT
);
CREATE INDEX idx_cron_runs_job_started ON cron_runs(job, started_at DESC);
```

**Step 2: Apply migration locally**

Run: `cd worker && npx wrangler d1 migrations apply pharos-db --local`
Expected: Migration 0014 applied successfully.

**Step 3: Commit**

```
feat: add cron_runs D1 migration for status page
```

---

### Task 2: `logCronRun()` Helper

**Files:**
- Modify: `worker/src/lib/db.ts` (append after existing exports, ~line 127)

**Step 1: Add the CronResult interface and logCronRun function**

Append to `worker/src/lib/db.ts`:

```typescript
// --- Cron run logging ---

export interface CronResult {
  itemCount?: number;
  metadata?: string;
}

/**
 * Wraps a cron job function with execution logging.
 * Logs start time, duration, status, and optional item count to cron_runs table.
 * Prunes rows older than 7 days after each insert.
 */
export async function logCronRun(
  db: D1Database,
  job: string,
  fn: () => Promise<CronResult | void>
): Promise<void> {
  const startMs = Date.now();
  const startSec = Math.floor(startMs / 1000);
  try {
    const result = await fn();
    await db
      .prepare(
        "INSERT INTO cron_runs (job, started_at, duration_ms, status, item_count, metadata) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        job,
        startSec,
        Date.now() - startMs,
        "ok",
        result?.itemCount ?? null,
        result?.metadata ?? null
      )
      .run();
  } catch (e) {
    await db
      .prepare(
        "INSERT INTO cron_runs (job, started_at, duration_ms, status, error) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(job, startSec, Date.now() - startMs, "error", String(e))
      .run();
    throw e;
  }
  // Prune rows older than 7 days
  await db
    .prepare("DELETE FROM cron_runs WHERE started_at < ?")
    .bind(Math.floor(Date.now() / 1000) - 604800)
    .run();
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 3: Commit**

```
feat: add logCronRun() helper for cron execution logging
```

---

### Task 3: Wrap Cron Jobs with `logCronRun()`

**Files:**
- Modify: `worker/src/index.ts` (lines 94-125, the `scheduled` handler)

**Step 1: Import logCronRun**

Add to imports at top of `worker/src/index.ts`:

```typescript
import { logCronRun } from "./lib/db";
```

**Step 2: Wrap each cron call**

Replace the `scheduled` handler body (lines 94-125) with:

```typescript
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const db = env.DB;
    const cron = event.cron;

    switch (cron) {
      case "*/5 * * * *":
        ctx.waitUntil(logCronRun(db, "sync-stablecoins", () => syncStablecoins(db)));
        ctx.waitUntil(logCronRun(db, "sync-stablecoin-charts", () => syncStablecoinCharts(db)));
        break;
      case "*/10 * * * *":
        ctx.waitUntil(logCronRun(db, "sync-dex-liquidity", () => syncDexLiquidity(db, env.GRAPH_API_KEY ?? null)));
        if (new Date(event.scheduledTime).getMinutes() % 30 === 0) {
          ctx.waitUntil(logCronRun(db, "sync-onchain-supply", () => syncOnchainSupply(db, env.TRONGRID_API_KEY ?? null)));
        }
        break;
      case "*/15 * * * *":
        ctx.waitUntil(
          logCronRun(db, "sync-blacklist", () =>
            syncBlacklist(db, env.ETHERSCAN_API_KEY ?? null, env.TRONGRID_API_KEY ?? null, env.DRPC_API_KEY ?? null)
          )
        );
        ctx.waitUntil(logCronRun(db, "sync-usds-status", () => syncUsdsStatus(db, env.ETHERSCAN_API_KEY ?? null)));
        ctx.waitUntil(logCronRun(db, "sync-bluechip", () => syncBluechip(db)));
        break;
      case "0 */2 * * *":
        ctx.waitUntil(logCronRun(db, "sync-fx-rates", () => syncFxRates(db)));
        break;
    }
  },
```

**Key difference from original:** Each cron is now wrapped in `logCronRun()`. The cron functions all return `Promise<void>`, which is compatible with `CronResult | void`.

**Note on `detect-depegs`:** This runs inline inside `syncStablecoins` (called at the end of that function). It does NOT need a separate `logCronRun` wrapper — its health is reflected in the sync-stablecoins run status. The status API will track it separately via the `depeg_events` table state.

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors. All cron functions return `Promise<void>` which satisfies `Promise<CronResult | void>`.

**Step 4: Commit**

```
feat: wrap all cron jobs with logCronRun() execution logging
```

---

### Task 4: `/api/status` Endpoint

**Files:**
- Create: `worker/src/api/status.ts`
- Modify: `worker/src/router.ts` (add route)
- Modify: `worker/src/index.ts` (skip edge cache for `/api/status`)

**Step 1: Create the status API handler**

Create `worker/src/api/status.ts`:

```typescript
import { getCache } from "../lib/db";
import { withErrorHandler } from "../lib/api-utils";

// --- Types ---

interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
}

interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
}

interface DataQuality {
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistTotal: number;
  onchainSupplyDivergences: number;
  activeDepegs: number;
  staleOnchainSupply: number;
}

interface StatusResponse {
  timestamp: number;
  overallStatus: "healthy" | "degraded" | "stale";
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  dataQuality: DataQuality;
}

// --- Config ---

const CACHE_THRESHOLDS: Record<string, number> = {
  stablecoins: 600,
  "stablecoin-charts": 600,
  "usds-status": 86400,
  "bluechip-ratings": 43200,
  "fx-rates": 7200,
};

const CRON_INTERVALS: Record<string, number> = {
  "sync-stablecoins": 300,
  "sync-stablecoin-charts": 300,
  "sync-blacklist": 900,
  "sync-dex-liquidity": 600,
  "sync-onchain-supply": 1800,
  "sync-usds-status": 900,
  "sync-bluechip": 900,
  "sync-fx-rates": 7200,
};

// --- Handler ---

export const handleStatus = withErrorHandler(
  "status",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    // Admin key auth
    const provided = request?.headers.get("X-Admin-Key");
    if (!adminKey || provided !== adminKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Math.floor(Date.now() / 1000);

    // 1. Cache freshness
    const caches: Record<string, CacheStatus> = {};
    let worstCacheRatio = 0;
    for (const [key, maxAge] of Object.entries(CACHE_THRESHOLDS)) {
      const cached = await getCache(db, key);
      const ageSeconds = cached ? now - cached.updatedAt : null;
      const ratio = ageSeconds != null ? ageSeconds / maxAge : Infinity;
      if (ratio > worstCacheRatio) worstCacheRatio = ratio;
      caches[key] = { ageSeconds, maxAge, healthy: ratio <= 1.5 };
    }

    // 2. Cron run history
    const crons: Record<string, CronStatus> = {};
    let anyCronError = false;
    for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
      const rows = await db
        .prepare(
          "SELECT started_at, duration_ms, status, error, item_count FROM cron_runs WHERE job = ? ORDER BY started_at DESC LIMIT 10"
        )
        .bind(job)
        .all<{
          started_at: number;
          duration_ms: number;
          status: string;
          error: string | null;
          item_count: number | null;
        }>();

      const runs: CronRun[] = (rows.results ?? []).map((r) => ({
        startedAt: r.started_at,
        durationMs: r.duration_ms,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
        ...(r.item_count != null ? { itemCount: r.item_count } : {}),
      }));

      const lastRun = runs.length > 0 ? runs[0] : null;
      const healthy =
        lastRun != null &&
        lastRun.status === "ok" &&
        now - lastRun.startedAt <= interval * 2;

      if (lastRun?.status === "error") anyCronError = true;

      crons[job] = {
        lastRun,
        recentRuns: runs,
        expectedIntervalSec: interval,
        healthy,
      };
    }

    // 3. Data quality
    const dataQuality = await getDataQuality(db, now);

    // 4. Overall status
    const overallStatus: StatusResponse["overallStatus"] =
      worstCacheRatio > 2 || anyCronError
        ? "stale"
        : worstCacheRatio > 1.5
          ? "degraded"
          : "healthy";

    const body: StatusResponse = {
      timestamp: now,
      overallStatus,
      caches,
      crons,
      dataQuality,
    };

    return new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  }
);

// --- Data quality queries ---

async function getDataQuality(db: D1Database, now: number): Promise<DataQuality> {
  // Missing prices: parse stablecoins cache
  let totalStablecoins = 0;
  let missingPrices = 0;
  try {
    const cached = await getCache(db, "stablecoins");
    if (cached) {
      const data = JSON.parse(cached.value);
      const assets = Array.isArray(data) ? data : data?.assets ?? [];
      totalStablecoins = assets.length;
      missingPrices = assets.filter(
        (a: { price?: number | null }) => a.price == null || a.price === 0
      ).length;
    }
  } catch {
    // cache parse failed
  }

  // Blacklist gaps
  let blacklistTotal = 0;
  let blacklistMissingAmounts = 0;
  try {
    const bl = await db
      .prepare(
        "SELECT COUNT(*) as total, SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) as missing FROM blacklist_events"
      )
      .first<{ total: number; missing: number }>();
    if (bl) {
      blacklistTotal = bl.total;
      blacklistMissingAmounts = bl.missing;
    }
  } catch {
    // query failed
  }

  // Active depegs
  let activeDepegs = 0;
  try {
    const dp = await db
      .prepare("SELECT COUNT(*) as cnt FROM depeg_events WHERE ended_at IS NULL")
      .first<{ cnt: number }>();
    if (dp) activeDepegs = dp.cnt;
  } catch {
    // query failed
  }

  // Stale on-chain supply (rows older than 2h)
  let staleOnchainSupply = 0;
  try {
    const stale = await db
      .prepare(
        "SELECT COUNT(DISTINCT stablecoin_id) as cnt FROM onchain_supply WHERE updated_at < ?"
      )
      .bind(now - 7200)
      .first<{ cnt: number }>();
    if (stale) staleOnchainSupply = stale.cnt;
  } catch {
    // query failed
  }

  // On-chain supply divergences (compare on-chain vs DefiLlama)
  let onchainSupplyDivergences = 0;
  try {
    const onchainRows = await db
      .prepare(
        "SELECT stablecoin_id, SUM(supply) as total_supply FROM onchain_supply WHERE updated_at > ? GROUP BY stablecoin_id"
      )
      .bind(now - 7200)
      .all<{ stablecoin_id: string; total_supply: number }>();

    if (onchainRows.results && onchainRows.results.length > 0) {
      const cached = await getCache(db, "stablecoins");
      if (cached) {
        const data = JSON.parse(cached.value);
        const assets: Array<{ id: string; price?: number; circulating?: Record<string, number> }> =
          Array.isArray(data) ? data : data?.assets ?? [];
        const assetMap = new Map(assets.map((a) => [a.id, a]));

        for (const row of onchainRows.results) {
          const asset = assetMap.get(row.stablecoin_id);
          if (!asset?.price || !asset.circulating) continue;
          // DefiLlama circulating values are in USD
          const llamaValues = Object.values(asset.circulating);
          const llamaTotal = llamaValues.reduce((s, v) => s + (v ?? 0), 0);
          const llamaSupply = llamaTotal / asset.price;
          if (llamaSupply > 0) {
            const divergence = Math.abs(row.total_supply - llamaSupply) / llamaSupply;
            if (divergence > 0.05) onchainSupplyDivergences++;
          }
        }
      }
    }
  } catch {
    // divergence check failed
  }

  return {
    totalStablecoins,
    missingPrices,
    blacklistMissingAmounts,
    blacklistTotal,
    onchainSupplyDivergences,
    activeDepegs,
    staleOnchainSupply,
  };
}
```

**Step 2: Add route in `worker/src/router.ts`**

Add import at top:

```typescript
import { handleStatus } from "./api/status";
```

Add route before the `return null` at the end (before line 73):

```typescript
  if (path === "/api/status") {
    return handleStatus(db, adminKey, request);
  }
```

**Step 3: Skip edge cache for `/api/status`**

In `worker/src/index.ts`, line 62, change:

```typescript
    const skipCache = url.pathname === "/api/health";
```

to:

```typescript
    const skipCache = url.pathname === "/api/health" || url.pathname === "/api/status";
```

Also add `X-Admin-Key` to the allowed CORS headers. In `worker/src/index.ts` line 25, change:

```typescript
    "Access-Control-Allow-Headers": "Content-Type",
```

to:

```typescript
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key",
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors.

**Step 5: Commit**

```
feat: add /api/status endpoint with cron history, cache freshness, and data quality
```

---

### Task 5: Frontend — `useStatus()` Hook and Types

**Files:**
- Create: `src/hooks/use-status.ts`
- Modify: `src/lib/types.ts` (add StatusResponse type)

**Step 1: Add StatusResponse type**

Append to `src/lib/types.ts`:

```typescript
// --- Status page types ---

export interface CacheStatus {
  ageSeconds: number | null;
  maxAge: number;
  healthy: boolean;
}

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: string;
  error?: string;
  itemCount?: number;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
}

export interface DataQuality {
  totalStablecoins: number;
  missingPrices: number;
  blacklistMissingAmounts: number;
  blacklistTotal: number;
  onchainSupplyDivergences: number;
  activeDepegs: number;
  staleOnchainSupply: number;
}

export interface StatusResponse {
  timestamp: number;
  overallStatus: "healthy" | "degraded" | "stale";
  caches: Record<string, CacheStatus>;
  crons: Record<string, CronStatus>;
  dataQuality: DataQuality;
}
```

**Step 2: Create the hook**

Create `src/hooks/use-status.ts`:

```typescript
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { StatusResponse } from "@/lib/types";

/**
 * Fetches /api/status with admin key auth.
 * No auto-refetch — manual refresh only (admin page).
 */
export function useStatus(adminKey: string): UseQueryResult<StatusResponse, Error> {
  return useQuery<StatusResponse, Error>({
    queryKey: ["status", adminKey],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/status`, {
        headers: { "X-Admin-Key": adminKey },
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error("Invalid admin key");
        throw new Error(`Failed to fetch status: ${res.status}`);
      }
      return res.json();
    },
    enabled: !!adminKey,
    staleTime: Infinity, // manual refresh only
    retry: 0,
  });
}
```

**Step 3: Type-check**

Run: `npm run build`
Expected: Build succeeds (no pages use the hook yet, but types must compile).

**Step 4: Commit**

```
feat: add StatusResponse types and useStatus() hook
```

---

### Task 6: Frontend — Status Page Shell + Banner

**Files:**
- Create: `src/app/status/page.tsx`
- Create: `src/app/status/client.tsx`

**Step 1: Create server component with metadata**

Create `src/app/status/page.tsx`:

```tsx
import type { Metadata } from "next";
import StatusClient from "./client";

export const metadata: Metadata = {
  title: "System Status — Pharos",
  description: "Admin status dashboard for Pharos data pipeline monitoring.",
  robots: { index: false, follow: false },
};

export default function StatusPage() {
  return <StatusClient />;
}
```

**Step 2: Create client component**

Create `src/app/status/client.tsx`. This is the main page component. It reads the admin key from the URL `?key=...` param and renders the status data.

```tsx
"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useStatus } from "@/hooks/use-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// --- Status Banner ---

const STATUS_CONFIG = {
  healthy: { label: "Healthy", bg: "bg-green-500/15", text: "text-green-700 dark:text-green-400", border: "border-green-500/30" },
  degraded: { label: "Degraded", bg: "bg-amber-500/15", text: "text-amber-700 dark:text-amber-400", border: "border-amber-500/30" },
  stale: { label: "Stale", bg: "bg-red-500/15", text: "text-red-700 dark:text-red-400", border: "border-red-500/30" },
} as const;

function StatusBanner({ status, timestamp }: { status: "healthy" | "degraded" | "stale"; timestamp: number }) {
  const config = STATUS_CONFIG[status];
  const time = new Date(timestamp * 1000).toLocaleString();
  return (
    <div className={`rounded-lg border p-4 ${config.bg} ${config.border}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`h-3 w-3 rounded-full ${status === "healthy" ? "bg-green-500" : status === "degraded" ? "bg-amber-500" : "bg-red-500"}`} />
          <span className={`text-lg font-semibold ${config.text}`}>{config.label}</span>
        </div>
        <span className="text-sm text-muted-foreground">Checked: {time}</span>
      </div>
    </div>
  );
}

// --- Cron Card ---

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatInterval(seconds: number): string {
  if (seconds < 3600) return `${seconds / 60}min`;
  return `${seconds / 3600}h`;
}

function CronCard({ job, cron }: { job: string; cron: { lastRun: { startedAt: number; durationMs: number; status: string; error?: string; itemCount?: number } | null; recentRuns: Array<{ startedAt: number; durationMs: number; status: string; error?: string }>; expectedIntervalSec: number; healthy: boolean } }) {
  const now = Math.floor(Date.now() / 1000);
  const borderColor = cron.healthy ? "border-green-500/30" : "border-red-500/30";

  return (
    <Card className={`border-2 ${borderColor}`}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono">{job}</CardTitle>
          <span className="text-xs text-muted-foreground">every {formatInterval(cron.expectedIntervalSec)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {cron.lastRun ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm">
              <Badge variant={cron.lastRun.status === "ok" ? "secondary" : "destructive"} className="text-xs">
                {cron.lastRun.status}
              </Badge>
              <span className="text-muted-foreground">{formatAge(now - cron.lastRun.startedAt)} ago</span>
              <span className="text-muted-foreground">({formatDuration(cron.lastRun.durationMs)})</span>
              {cron.lastRun.itemCount != null && (
                <span className="text-muted-foreground">{cron.lastRun.itemCount} items</span>
              )}
            </div>
            {cron.lastRun.error && (
              <details className="text-xs">
                <summary className="cursor-pointer text-red-600 dark:text-red-400">Error details</summary>
                <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted p-2 text-xs">{cron.lastRun.error}</pre>
              </details>
            )}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">No runs recorded</span>
        )}

        {/* Recent runs dot row */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">History:</span>
          {cron.recentRuns.map((run, i) => (
            <div
              key={i}
              className={`h-2.5 w-2.5 rounded-full ${run.status === "ok" ? "bg-green-500" : "bg-red-500"}`}
              title={`${run.status} — ${new Date(run.startedAt * 1000).toLocaleString()} (${formatDuration(run.durationMs)})`}
            />
          ))}
          {cron.recentRuns.length === 0 && <span className="text-xs text-muted-foreground">none</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// --- Data Quality Cards ---

function DataQualityCards({ dq }: { dq: { totalStablecoins: number; missingPrices: number; blacklistMissingAmounts: number; blacklistTotal: number; onchainSupplyDivergences: number; activeDepegs: number; staleOnchainSupply: number } }) {
  const cards = [
    {
      label: "Missing Prices",
      value: dq.missingPrices,
      detail: `/ ${dq.totalStablecoins} coins`,
      severity: dq.missingPrices > 5 ? "red" : dq.missingPrices > 0 ? "amber" : "green",
    },
    {
      label: "Blacklist Gaps",
      value: dq.blacklistMissingAmounts,
      detail: `/ ${dq.blacklistTotal.toLocaleString()} events`,
      severity: dq.blacklistMissingAmounts > 50 ? "red" : dq.blacklistMissingAmounts > 0 ? "amber" : "green",
    },
    {
      label: "On-chain Divergences",
      value: dq.onchainSupplyDivergences,
      detail: "coins >5% off",
      severity: dq.onchainSupplyDivergences > 3 ? "red" : dq.onchainSupplyDivergences > 0 ? "amber" : "green",
    },
    {
      label: "Active Depegs",
      value: dq.activeDepegs,
      detail: "open events",
      severity: dq.activeDepegs > 5 ? "red" : dq.activeDepegs > 0 ? "amber" : "green",
    },
    {
      label: "Stale On-chain",
      value: dq.staleOnchainSupply,
      detail: "coins >2h old",
      severity: dq.staleOnchainSupply > 5 ? "red" : dq.staleOnchainSupply > 0 ? "amber" : "green",
    },
  ];

  const severityColor = {
    green: "text-green-600 dark:text-green-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  };

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
        <Card key={c.label}>
          <CardContent className="pt-4">
            <div className="text-xs text-muted-foreground">{c.label}</div>
            <div className={`text-2xl font-bold ${severityColor[c.severity]}`}>{c.value}</div>
            <div className="text-xs text-muted-foreground">{c.detail}</div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// --- Cache Freshness Table ---

function CacheFreshnessTable({ caches }: { caches: Record<string, { ageSeconds: number | null; maxAge: number; healthy: boolean }> }) {
  const sorted = Object.entries(caches).sort(([, a], [, b]) => {
    const ratioA = a.ageSeconds != null ? a.ageSeconds / a.maxAge : Infinity;
    const ratioB = b.ageSeconds != null ? b.ageSeconds / b.maxAge : Infinity;
    return ratioB - ratioA;
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Cache Freshness</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 font-medium">Cache Key</th>
              <th className="pb-2 font-medium">Age</th>
              <th className="pb-2 font-medium">Max Age</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(([key, cache]) => (
              <tr key={key} className="border-b last:border-0">
                <td className="py-2 font-mono text-xs">{key}</td>
                <td className="py-2">{cache.ageSeconds != null ? formatAge(cache.ageSeconds) : "—"}</td>
                <td className="py-2">{formatAge(cache.maxAge)}</td>
                <td className="py-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${cache.healthy ? "bg-green-500" : "bg-red-500"}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Main Page ---

function StatusContent() {
  const searchParams = useSearchParams();
  const adminKey = searchParams.get("key") ?? "";
  const { data, isLoading, error } = useStatus(adminKey);

  if (!adminKey) {
    return (
      <div className="py-20 text-center">
        <h1 className="text-xl font-semibold">Pharos System Status</h1>
        <p className="mt-2 text-muted-foreground">Add <code className="rounded bg-muted px-1">?key=YOUR_ADMIN_KEY</code> to the URL.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="py-20 text-center">
        <div className="text-muted-foreground">Loading status...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-20 text-center">
        <div className="text-red-600 dark:text-red-400">{error.message}</div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Pharos System Status</h1>

      <StatusBanner status={data.overallStatus} timestamp={data.timestamp} />

      <section>
        <h2 className="mb-3 text-lg font-semibold">Cron Jobs</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(data.crons).map(([job, cron]) => (
            <CronCard key={job} job={job} cron={cron} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Data Quality</h2>
        <DataQualityCards dq={data.dataQuality} />
      </section>

      <CacheFreshnessTable caches={data.caches} />
    </div>
  );
}

export default function StatusClient() {
  return (
    <Suspense fallback={<div className="py-20 text-center text-muted-foreground">Loading...</div>}>
      <StatusContent />
    </Suspense>
  );
}
```

**Why Suspense?** `useSearchParams()` requires a Suspense boundary in Next.js 16 static exports.

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds, `/status` page is exported.

**Step 4: Commit**

```
feat: add /status admin page with cron health, data quality, and cache freshness
```

---

### Task 7: Verify End-to-End

**Step 1: Apply migration locally and start worker**

Run: `cd worker && npx wrangler d1 migrations apply pharos-db --local && npx wrangler dev`

**Step 2: Start frontend dev server**

Run: `npm run dev`

**Step 3: Manually test status page**

Open `http://localhost:3000/status?key=YOUR_LOCAL_ADMIN_KEY`.

Expected: Page loads, shows "No runs recorded" for all crons (no data yet), cache freshness shows ages, data quality cards show counts.

**Step 4: Trigger a cron locally**

Using `curl` or Wrangler, trigger a scheduled event. Then reload the status page.

Expected: Cron card updates with the run, dot row shows one green dot.

**Step 5: Type-check both**

Run: `npm run build && cd worker && npx tsc --noEmit`
Expected: Both pass.

**Step 6: Commit**

No code changes here — just verification. If fixes are needed, commit them as:

```
fix: address issues found during status page verification
```

---

### Task 8: Update Documentation

**Files:**
- Modify: `docs/architecture.md` (add `/api/status` to endpoint table, add `cron_runs` to table list)
- Modify: `src/app/about/page.tsx` (add status data source mention if appropriate — but since it's admin-only, this is optional)

**Step 1: Update architecture.md**

Add to the API Endpoints table:

```
| `GET /api/status` | Admin status dashboard (cron runs, cache freshness, data quality). Requires `X-Admin-Key` header |
```

Add to file tree under `src/app/`:

```
│   ├── status/                # Admin status dashboard (not in nav)
│   │   ├── page.tsx
│   │   └── client.tsx
```

Add `cron_runs` migration to the migrations count mention if present.

**Step 2: Commit**

```
docs: add /api/status endpoint and status page to architecture docs
```
