# Status Page Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul the `/status` admin page into a full ops dashboard — per-endpoint liveness probes, circuit breaker panel, admin action buttons with confirm dialogs, corrected cron intervals, and 60s auto-refresh.

**Architecture:** Client-side probing fires parallel GETs to all ~28 endpoints on load + every 60s. The existing `/api/status` (admin, detailed) and `/api/health` (public, circuit breakers) supply server-side data. No new worker endpoints — only fix stale `CRON_INTERVALS` and add 2 missing jobs.

**Tech Stack:** React 19, TanStack Query, shadcn/ui Dialog, Tailwind CSS v4, Cloudflare Worker (D1)

**Design doc:** `docs/plans/2026-02-28-status-page-overhaul-design.md`

---

### Task 1: Fix stale CRON_INTERVALS in worker

**Files:**
- Modify: `worker/src/api/status.ts:43-53`

**Step 1: Update the CRON_INTERVALS map**

Replace the existing map with corrected values and add missing jobs:

```typescript
const CRON_INTERVALS: Record<string, number> = {
  "sync-stablecoins": 900,
  "sync-stablecoin-charts": 900,
  "sync-blacklist": 1200,
  "sync-dex-liquidity": 1800,
  "sync-usds-status": 86400,
  "sync-bluechip": 86400,
  "sync-fx-rates": 900,
  "daily-digest": 86400,
  "snapshot-supply": 86400,
  "stability-index": 900,
  "snapshot-psi": 86400,
};
```

Changes:
- `sync-dex-liquidity`: 1200 → 1800 (runs every 30min on `10,40 * * * *`)
- `sync-usds-status`: 900 → 86400 (moved to daily `0 8 * * *`)
- `snapshot-supply`: 43200 → 86400 (runs daily at `0 8 * * *`)
- Add `stability-index`: 900 (piggybacked on `*/15 * * * *`)
- Add `snapshot-psi`: 86400 (runs daily at `0 8 * * *`)

**Step 2: Type-check the worker**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/api/status.ts
git commit -m "fix(worker): correct stale CRON_INTERVALS and add missing jobs"
```

---

### Task 2: Add HealthResponse and EndpointProbeResult types

**Files:**
- Modify: `src/lib/types.ts` (append after `StatusResponse`)

**Step 1: Add the new types**

Append after the `StatusResponse` interface (line ~513):

```typescript
// --- Health endpoint types ---

export interface CircuitRecord {
  state: "closed" | "half-open" | "open";
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "stale";
  timestamp: number;
  caches: Record<string, CacheStatus>;
  blacklist: { totalEvents: number; missingAmounts: number };
  circuits: Record<string, CircuitRecord>;
}

// --- Endpoint probe types ---

export interface EndpointProbeResult {
  path: string;
  status: number | null;      // null = timeout/network error
  latencyMs: number;
  error?: string;
}
```

**Step 2: Build to verify types compile**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(types): add HealthResponse, CircuitRecord, EndpointProbeResult"
```

---

### Task 3: Create useHealth hook

**Files:**
- Create: `src/hooks/use-health.ts`

**Step 1: Write the hook**

```typescript
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { HealthResponse } from "@/lib/types";

/**
 * Fetches /api/health (public endpoint, no auth).
 * Auto-refreshes every 60s for live ops monitoring.
 */
export function useHealth(): UseQueryResult<HealthResponse, Error> {
  return useQuery<HealthResponse, Error>({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/health`);
      if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
      return res.json() as Promise<HealthResponse>;
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/hooks/use-health.ts
git commit -m "feat(hooks): add useHealth hook for /api/health with 60s auto-refresh"
```

---

### Task 4: Update useStatus hook for auto-refresh

**Files:**
- Modify: `src/hooks/use-status.ts`

**Step 1: Change staleTime and add refetchInterval**

Replace the query options:

```typescript
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { StatusResponse } from "@/lib/types";

/**
 * Fetches /api/status with admin key auth.
 * Auto-refreshes every 60s for live ops monitoring.
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
      return res.json() as Promise<StatusResponse>;
    },
    enabled: !!adminKey,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 0,
  });
}
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/hooks/use-status.ts
git commit -m "feat(hooks): enable 60s auto-refresh on useStatus"
```

---

### Task 5: Build the endpoint probe hook

**Files:**
- Create: `src/hooks/use-endpoint-probes.ts`

**Step 1: Write the probe hook**

This hook fires parallel GETs to all endpoints and measures latency/status.

```typescript
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { API_BASE } from "@/lib/api";
import type { EndpointProbeResult } from "@/lib/types";

/** Endpoint definitions grouped by type */
export const ENDPOINT_GROUPS = {
  public: [
    "/api/stablecoins",
    "/api/stablecoin/1",
    "/api/stablecoin-charts",
    "/api/peg-summary",
    "/api/health",
    "/api/blacklist",
    "/api/depeg-events",
    "/api/usds-status",
    "/api/bluechip-ratings",
    "/api/dex-liquidity",
    "/api/dex-liquidity-history?stablecoin=1",
    "/api/supply-history?stablecoin=1",
    "/api/daily-digest",
    "/api/digest-archive",
    "/api/stability-index",
    "/api/report-cards",
  ],
  admin: [
    "/api/status",
    "/api/backfill-depegs",
    "/api/backfill-supply-history",
    "/api/backfill-cg-prices",
    "/api/audit-depeg-history",
    "/api/backfill-stability-index",
  ],
  inlineAdmin: [
    "/api/trigger-digest",
    "/api/reset-blacklist-sync",
    "/api/debug-sync-state",
  ],
} as const;

const ALL_ENDPOINTS = [
  ...ENDPOINT_GROUPS.public,
  ...ENDPOINT_GROUPS.admin,
  ...ENDPOINT_GROUPS.inlineAdmin,
];

const ADMIN_PATHS = new Set([
  ...ENDPOINT_GROUPS.admin,
  ...ENDPOINT_GROUPS.inlineAdmin,
]);

async function probeEndpoint(
  path: string,
  adminKey: string,
): Promise<EndpointProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = performance.now();

  try {
    const headers: Record<string, string> = {};
    if (ADMIN_PATHS.has(path)) {
      headers["X-Admin-Key"] = adminKey;
    }
    const res = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      headers,
    });
    const latencyMs = Math.round(performance.now() - start);
    return { path, status: res.status, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      path,
      status: null,
      latencyMs,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probes all API endpoints in parallel.
 * Auto-refreshes every 60s.
 */
export function useEndpointProbes(
  adminKey: string,
): UseQueryResult<EndpointProbeResult[], Error> {
  return useQuery<EndpointProbeResult[], Error>({
    queryKey: ["endpoint-probes", adminKey],
    queryFn: () => Promise.all(ALL_ENDPOINTS.map((p) => probeEndpoint(p, adminKey))),
    enabled: !!adminKey,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 0,
  });
}
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/hooks/use-endpoint-probes.ts
git commit -m "feat(hooks): add useEndpointProbes with parallel GET probing and 60s refresh"
```

---

### Task 6: Rewrite the status page client

**Files:**
- Modify: `src/app/status/client.tsx` (full rewrite)

This is the largest task. The new page adds these sections on top of the existing ones:
1. Header with countdown timer + manual refresh
2. Endpoint Health grid
3. Circuit Breaker table
4. Admin Actions panel with confirm dialogs

**Step 1: Write the full updated client**

Rewrite `src/app/status/client.tsx` with the following structure. The existing components (`StatusBanner`, `CronCard`, `DataQualityCards`, `CacheFreshnessTable`, `AdminKeyForm`) are preserved with minimal changes. New components are added above them.

The full file is large (~600 lines). Here is the structure — the implementer should write it as a single file:

**Preserved components (keep as-is from current file):**
- `STATUS_CONFIG` + `StatusBanner` — no changes
- `formatDuration`, `formatAge`, `formatInterval` — no changes
- `CronCard` — no changes
- `DataQualityCards` — no changes
- `CacheFreshnessTable` — no changes
- `AdminKeyForm` + `SESSION_KEY` — no changes
- `StatusClient` (default export, auth gate) — no changes

**New components to add:**

1. **`RefreshCountdown`** — Shows `⟳ 45s` countdown, auto-decrements every 1s, resets to 60 on data refresh. Takes `lastUpdated: number` (timestamp of last successful fetch). Shows a manual Refresh button that calls `refetch()` on all three queries.

2. **`EndpointHealthGrid`** — Takes `probes: EndpointProbeResult[]`, `caches: Record<string, CacheStatus>` from status data. Renders 3 sections (Public / Admin / Inline Admin). Each endpoint is a compact row:
   - Path (mono), status badge (green 2xx / red error / gray timeout), latency ms, cache age bar if available.
   - Sort healthy endpoints first, then errors.

3. **`CircuitBreakerTable`** — Takes `circuits: Record<string, CircuitRecord>`. Table with columns: Name, State (colored badge), Failures, Last Failure, Last Success. If empty, show "No circuit breakers registered".

4. **`AdminActionsPanel`** — Grid of action buttons. Each button opens a shadcn Dialog for confirmation. On confirm, fires GET with admin key. Shows inline loading state, then success/error response. For `debug-sync-state`, shows response in a collapsible `<pre>` block.

   Actions config array:
   ```typescript
   const ADMIN_ACTIONS = [
     { label: "Trigger Digest", path: "/api/trigger-digest", confirm: "Trigger daily digest? Bypasses 1h dedup window.", destructive: false },
     { label: "Reset Blacklist Sync", path: "/api/reset-blacklist-sync", confirm: "Reset blacklist sync? Rolls back EVM 50k blocks, Tron 7 days.", destructive: true },
     { label: "Debug Sync State", path: "/api/debug-sync-state", confirm: "Fetch sync state debug dump?", destructive: false },
     { label: "Backfill Depegs", path: "/api/backfill-depegs", confirm: "Run depeg backfill? This may take several minutes.", destructive: false },
     { label: "Backfill Supply", path: "/api/backfill-supply-history", confirm: "Backfill supply history snapshots?", destructive: false },
     { label: "Backfill CG Prices", path: "/api/backfill-cg-prices", confirm: "Backfill CoinGecko prices?", destructive: false },
     { label: "Backfill PSI", path: "/api/backfill-stability-index", confirm: "Backfill stability index history?", destructive: false },
     { label: "Audit Depegs", path: "/api/audit-depeg-history?dry-run=true", confirm: "Run depeg history audit (dry-run)?", destructive: false },
   ] as const;
   ```

5. **Updated `StatusDashboard`** — Wire up `useHealth()`, `useEndpointProbes(adminKey)` alongside existing `useStatus(adminKey)`. Render all sections in order:
   - Header with title + RefreshCountdown + sign out
   - StatusBanner
   - EndpointHealthGrid
   - CircuitBreakerTable
   - AdminActionsPanel
   - Cron Jobs
   - Data Quality
   - Cache Freshness

**Imports to add at top:**
```typescript
import { useHealth } from "@/hooks/use-health";
import { useEndpointProbes, ENDPOINT_GROUPS } from "@/hooks/use-endpoint-probes";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import type { EndpointProbeResult, CircuitRecord } from "@/lib/types";
import { API_BASE } from "@/lib/api";
```

**Step 2: Build to verify no type errors**

Run: `npm run build`
Expected: No errors (warnings about unused vars are OK to fix)

**Step 3: Manual visual test**

Run: `npm run dev`
Navigate to `http://localhost:3000/status` in the browser. Verify:
- Auth gate still works
- All sections render
- Endpoint probes fire and show results
- Circuit breaker table appears (may be empty if healthy)
- Admin action buttons open confirm dialogs
- Auto-refresh countdown ticks down
- Manual refresh button works

**Step 4: Commit**

```bash
git add src/app/status/client.tsx
git commit -m "feat(status): full ops dashboard — endpoint probes, circuit breakers, admin actions, auto-refresh"
```

---

### Task 7: Lint, type-check, and final verification

**Files:** None (verification only)

**Step 1: Run linter**

Run: `npm run lint`
Expected: No errors (fix any that appear)

**Step 2: Run frontend type-check**

Run: `npm run build`
Expected: Clean build

**Step 3: Run worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Final commit (if any lint fixes were needed)**

```bash
git add -A
git commit -m "chore: lint fixes for status page overhaul"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/worker-infrastructure.md` (update the `/api/status` description to mention CRON_INTERVALS now tracks 11 jobs)

**Step 1: Update the status endpoint description**

In `docs/worker-infrastructure.md`, find the `GET /api/status` section (~line 400-402) and update it to reflect that CRON_INTERVALS now tracks 11 jobs (was 9), including `stability-index` and `snapshot-psi`.

**Step 2: Commit**

```bash
git add docs/worker-infrastructure.md
git commit -m "docs(worker): update status endpoint docs to reflect 11 tracked cron jobs"
```
