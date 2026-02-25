# Pharos Stability Index — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a deterministic 0–100 stability index with named condition bands (BEDROCK → MELTDOWN), displayed on the homepage and referenced by the daily digest.

**Architecture:** Pure compute function in `worker/src/lib/`, daily cron at 07:55 UTC stores snapshots in D1, API endpoint serves latest + history, digest reads the score before calling Sonnet, frontend widget shows band + score + sparkline. Backfill endpoint replays formula over 4 years of depeg history.

**Tech Stack:** TypeScript, Cloudflare Workers + D1, TanStack Query, Recharts (sparkline), Tailwind CSS.

**Design doc:** `docs/plans/2026-02-25-stability-index-design.md`

---

### Task 1: Database Migration

**Files:**
- Create: `worker/migrations/0022_stability_index.sql`

**Step 1: Write the migration**

```sql
-- Pharos Stability Index: daily score snapshots
CREATE TABLE stability_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at INTEGER NOT NULL,
  score REAL NOT NULL,
  band TEXT NOT NULL,
  components TEXT NOT NULL,
  input_snapshot TEXT NOT NULL
);
CREATE INDEX idx_stability_index_computed_at ON stability_index(computed_at);
```

**Step 2: Apply migration locally**

Run: `cd worker && npx wrangler d1 migrations apply stablecoin-db --local`
Expected: Migration 0022 applied successfully

**Step 3: Commit**

```bash
git add worker/migrations/0022_stability_index.sql
git commit -m "feat(stability-index): add stability_index table migration"
```

---

### Task 2: Pure Compute Function + Band Definitions

**Files:**
- Create: `worker/src/lib/stability-index.ts`

**Step 1: Write the compute function**

```typescript
/**
 * Pharos Stability Index — pure compute function.
 * See docs/plans/2026-02-25-stability-index-design.md for algorithm details.
 */

export type ConditionBand = "BEDROCK" | "STEADY" | "TREMOR" | "FRACTURE" | "CRISIS" | "MELTDOWN";

export interface StabilityInput {
  depegs: { bps: number; mcapUsd: number }[];
  totalMcapUsd: number;
  freezeCount24h: number;
  mcap7dChangePct: number;
}

export interface StabilityResult {
  score: number;
  band: ConditionBand;
  components: {
    severity: number;
    breadth: number;
    freezes: number;
    trend: number;
  };
}

const K = 60;

export function computeStabilityIndex(input: StabilityInput): StabilityResult {
  const { depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct } = input;

  const severityRaw = depegs.reduce((sum, d) => {
    const share = totalMcapUsd > 0 ? d.mcapUsd / totalMcapUsd : 0;
    const amplifier = Math.log2(1 + d.mcapUsd / 1e9);
    return sum + (Math.abs(d.bps) / 100) * share * amplifier * K;
  }, 0);
  const severity = Math.min(60, severityRaw);

  const breadthRaw = depegs.reduce((sum, d) => {
    return sum + Math.sqrt(d.mcapUsd / 1e9) * 3;
  }, 0);
  const breadth = Math.min(15, breadthRaw);

  const freezes = Math.min(10, freezeCount24h * 2.5);

  const trend = Math.max(-5, Math.min(5, mcap7dChangePct));

  const raw = 100 - severity - breadth - freezes + trend;
  const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

  return {
    score,
    band: getConditionBand(score),
    components: {
      severity: Math.round(severity * 100) / 100,
      breadth: Math.round(breadth * 100) / 100,
      freezes: Math.round(freezes * 100) / 100,
      trend: Math.round(trend * 100) / 100,
    },
  };
}

export function getConditionBand(score: number): ConditionBand {
  if (score >= 90) return "BEDROCK";
  if (score >= 75) return "STEADY";
  if (score >= 60) return "TREMOR";
  if (score >= 40) return "FRACTURE";
  if (score >= 20) return "CRISIS";
  return "MELTDOWN";
}

/** Hex colors for each band — used by API consumers and frontend. */
export const BAND_COLORS: Record<ConditionBand, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/lib/stability-index.ts
git commit -m "feat(stability-index): pure compute function with band definitions"
```

---

### Task 3: Cron Job

**Files:**
- Create: `worker/src/cron/stability-index.ts`

The cron queries the same data sources the digest uses (stablecoins cache, depeg_events, blacklist_events) and calls the pure compute function.

**Step 1: Write the cron**

```typescript
import type { StablecoinData } from "../../../src/lib/types";
import { getCirculatingRaw, getPrevWeekRaw } from "../../../src/lib/supply";
import { TRACKED_IDS } from "../../../src/lib/stablecoins";
import { getCache } from "../lib/db";
import type { CronResult } from "../lib/db";
import { computeStabilityIndex } from "../lib/stability-index";

export async function computeAndStoreStabilityIndex(db: D1Database): Promise<CronResult> {
  const stablecoinsCache = await getCache(db, "stablecoins");
  if (!stablecoinsCache) {
    return { metadata: "skipped: no stablecoins cache" };
  }

  const parsed = JSON.parse(stablecoinsCache.value) as { peggedAssets: StablecoinData[] };
  const tracked = parsed.peggedAssets.filter((c) => TRACKED_IDS.has(c.id));

  let totalMcapUsd = 0;
  let totalPrevWeek = 0;
  const mcapById = new Map<string, number>();

  for (const coin of tracked) {
    const mcap = getCirculatingRaw(coin);
    totalMcapUsd += mcap;
    totalPrevWeek += getPrevWeekRaw(coin);
    mcapById.set(coin.id, mcap);
  }

  const mcap7dChangePct = totalPrevWeek > 0
    ? ((totalMcapUsd - totalPrevWeek) / totalPrevWeek) * 100
    : 0;

  // Active depegs
  const activeDepegs = await db
    .prepare("SELECT stablecoin_id, peak_deviation_bps FROM depeg_events WHERE ended_at IS NULL")
    .all<{ stablecoin_id: string; peak_deviation_bps: number }>();
  const depegs = (activeDepegs.results ?? []).map((r) => ({
    bps: r.peak_deviation_bps,
    mcapUsd: mcapById.get(r.stablecoin_id) ?? 0,
  }));

  // Freeze count in last 24h
  const cutoff = Math.floor(Date.now() / 1000) - 86400;
  const freezeRow = await db
    .prepare("SELECT COUNT(*) as cnt FROM blacklist_events WHERE timestamp > ?")
    .bind(cutoff)
    .first<{ cnt: number }>();
  const freezeCount24h = freezeRow?.cnt ?? 0;

  const result = computeStabilityIndex({ depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct });

  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(
      now,
      result.score,
      result.band,
      JSON.stringify(result.components),
      JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct }),
    )
    .run();

  console.log(`[stability-index] score=${result.score} band=${result.band}`);
  return { metadata: `score=${result.score} band=${result.band}` };
}
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/cron/stability-index.ts
git commit -m "feat(stability-index): daily cron job to compute and store score"
```

---

### Task 4: API Handler

**Files:**
- Create: `worker/src/api/stability-index.ts`

**Step 1: Write the handler**

```typescript
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";

export const handleStabilityIndex = withErrorHandler("stability-index", async (db: D1Database): Promise<Response> => {
  const current = await db
    .prepare("SELECT computed_at, score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 1")
    .first<{ computed_at: number; score: number; band: string; components: string }>();

  const historyRows = await db
    .prepare("SELECT computed_at, score, band FROM stability_index ORDER BY computed_at DESC LIMIT 91")
    .all<{ computed_at: number; score: number; band: string }>();

  // First row is "current", rest is history
  const history = (historyRows.results ?? [])
    .slice(1)
    .map((r) => ({ date: r.computed_at, score: r.score, band: r.band }));

  if (!current) {
    return new Response(JSON.stringify({ current: null, history: [] }), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_PROFILES.slow,
      },
    });
  }

  return new Response(JSON.stringify({
    current: {
      score: current.score,
      band: current.band,
      components: JSON.parse(current.components),
      computedAt: current.computed_at,
    },
    history,
  }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    }, current.computed_at, 86400),
  });
});
```

**Step 2: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add worker/src/api/stability-index.ts
git commit -m "feat(stability-index): API endpoint for latest score + history"
```

---

### Task 5: Wire Up Cron, Route, and Trigger

**Files:**
- Modify: `worker/wrangler.toml:10-13` (add cron trigger)
- Modify: `worker/src/index.ts:1-14` (add import) and `worker/src/index.ts:159-205` (add cron case)
- Modify: `worker/src/router.ts:1-18` (add import) and `worker/src/router.ts:90-92` (add route)

**Step 1: Add cron trigger to wrangler.toml**

Change the `crons` array in `worker/wrangler.toml:10-13` from:
```toml
crons = [
  "*/15 * * * *",
  "0 8 * * *",
]
```
to:
```toml
crons = [
  "*/15 * * * *",
  "55 7 * * *",
  "0 8 * * *",
]
```

**Step 2: Add import and cron case to index.ts**

Add import at `worker/src/index.ts` after line 10 (`import { generateDailyDigest } ...`):
```typescript
import { computeAndStoreStabilityIndex } from "./cron/stability-index";
```

Add new case in the switch statement at `worker/src/index.ts`, between the `*/15` case (line 182) and the `0 8` case (line 184):
```typescript
      case "55 7 * * *":
        ctx.waitUntil(logCronRun(db, "stability-index", () => computeAndStoreStabilityIndex(db)));
        break;
```

**Step 3: Add import and route to router.ts**

Add import at `worker/src/router.ts` after line 17 (`import { handleDigestArchive } ...`):
```typescript
import { handleStabilityIndex } from "./api/stability-index";
```

Add route at `worker/src/router.ts` after the digest-archive route (after line 92):
```typescript
  if (path === "/api/stability-index") {
    return handleStabilityIndex(db);
  }
```

**Step 4: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 5: Commit**

```bash
git add worker/wrangler.toml worker/src/index.ts worker/src/router.ts
git commit -m "feat(stability-index): wire up cron trigger, handler, and API route"
```

---

### Task 6: Digest Integration

**Files:**
- Modify: `worker/src/cron/daily-digest.ts:9-30` (system prompt)
- Modify: `worker/src/cron/daily-digest.ts:32-45` (DigestInputData interface)
- Modify: `worker/src/cron/daily-digest.ts:47-82` (buildUserPrompt function)
- Modify: `worker/src/cron/daily-digest.ts:125-210` (data collection section)

**Step 1: Add stability index fields to DigestInputData**

At `worker/src/cron/daily-digest.ts`, add to the `DigestInputData` interface (after the `biggestSupplyChange` field around line 44):
```typescript
  stabilityIndex: { score: number; band: string; components: { severity: number; breadth: number; freezes: number; trend: number } } | null;
  yesterdayIndex: { score: number; band: string } | null;
```

**Step 2: Query latest two stability index rows in the data collection section**

In `generateDailyDigest()`, after the freeze count query (around line 198), add:
```typescript
  // 4. Stability index (latest two for today + yesterday comparison)
  const indexRows = await db
    .prepare("SELECT score, band, components FROM stability_index ORDER BY computed_at DESC LIMIT 2")
    .all<{ score: number; band: string; components: string }>();
  const indexResults = indexRows.results ?? [];
  const stabilityIndex = indexResults[0]
    ? { score: indexResults[0].score, band: indexResults[0].band, components: JSON.parse(indexResults[0].components) }
    : null;
  const yesterdayIndex = indexResults[1]
    ? { score: indexResults[1].score, band: indexResults[1].band }
    : null;
```

Add both to the `inputData` object (around line 207):
```typescript
    stabilityIndex,
    yesterdayIndex,
```

**Step 3: Add stability index to buildUserPrompt**

In `buildUserPrompt()`, after the freeze count line (around line 61) and before the `biggestSupplyChange` block, add:
```typescript
  if (data.stabilityIndex) {
    const { score, band, components } = data.stabilityIndex;
    const trend = components.trend >= 0 ? `+${components.trend}` : `${components.trend}`;
    lines.push(
      `Pharos Stability Index: ${score} [${band}] (severity=${components.severity}, breadth=${components.breadth}, freezes=${components.freezes}, trend=${trend})`,
    );
    if (data.yesterdayIndex) {
      lines.push(`Yesterday: ${data.yesterdayIndex.score} [${data.yesterdayIndex.band}]`);
    }
  }
```

**Step 4: Update system prompt**

In the `SYSTEM_PROMPT` constant (lines 9-30), append before the JSON format instruction (`"You MUST respond with valid JSON..."`):
```
"Open with the Pharos Stability Index score and its condition band. " +
"Reference the band name naturally — 'Another day in BEDROCK' or 'We've slipped into TREMOR for the first time since March.' " +
"When the band changed from yesterday, lead with that transition — band shifts are the headline. " +
```

**Step 5: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

```bash
git add worker/src/cron/daily-digest.ts
git commit -m "feat(stability-index): integrate score and band into daily digest prompt"
```

---

### Task 7: Frontend Hook

**Files:**
- Create: `src/hooks/use-stability-index.ts`

**Step 1: Write the hook**

```typescript
"use client";

import { useApiQuery, CRON_24H } from "@/hooks/use-api-query";

interface StabilityIndexComponents {
  severity: number;
  breadth: number;
  freezes: number;
  trend: number;
}

interface StabilityIndexCurrent {
  score: number;
  band: string;
  components: StabilityIndexComponents;
  computedAt: number;
}

interface StabilityIndexHistoryPoint {
  date: number;
  score: number;
  band: string;
}

export interface StabilityIndexData {
  current: StabilityIndexCurrent | null;
  history: StabilityIndexHistoryPoint[];
}

export function useStabilityIndex() {
  return useApiQuery<StabilityIndexData>(
    ["stability-index"],
    "/api/stability-index",
    CRON_24H,
  );
}
```

**Step 2: Commit**

```bash
git add src/hooks/use-stability-index.ts
git commit -m "feat(stability-index): TanStack Query hook"
```

---

### Task 8: Frontend Component

**Files:**
- Create: `src/components/stability-index.tsx`

The widget shows: band name + score (color-coded), 30-day sparkline, delta from yesterday.

**Step 1: Write the component**

```typescript
"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";

const BAND_COLORS: Record<string, string> = {
  BEDROCK: "text-green-500",
  STEADY: "text-teal-500",
  TREMOR: "text-yellow-500",
  FRACTURE: "text-orange-500",
  CRISIS: "text-red-500",
  MELTDOWN: "text-red-800",
};

const BAND_BG: Record<string, string> = {
  BEDROCK: "bg-green-500",
  STEADY: "bg-teal-500",
  TREMOR: "bg-yellow-500",
  FRACTURE: "bg-orange-500",
  CRISIS: "bg-red-500",
  MELTDOWN: "bg-red-800",
};

const SPARKLINE_COLORS: Record<string, string> = {
  BEDROCK: "#22c55e",
  STEADY: "#14b8a6",
  TREMOR: "#eab308",
  FRACTURE: "#f97316",
  CRISIS: "#ef4444",
  MELTDOWN: "#991b1b",
};

export function StabilityIndex() {
  const { data, isLoading } = useStabilityIndex();

  if (!isLoading && (!data || !data.current)) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-4 py-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-32" />
      </div>
    );
  }

  const { score, band, computedAt } = data!.current!;
  const history = data!.history;

  // Delta from yesterday (first history point)
  const yesterday = history.length > 0 ? history[0] : null;
  const delta = yesterday ? Math.round((score - yesterday.score) * 10) / 10 : null;

  const colorClass = BAND_COLORS[band] ?? "text-foreground";
  const sparkColor = SPARKLINE_COLORS[band] ?? "#888";

  // Build sparkline points from history (oldest to newest) + current
  const sparkData = [...history].reverse().concat({ date: computedAt, score, band });

  return (
    <div className="flex items-center gap-4 py-3 animate-in fade-in duration-300">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Stability Index
        </span>
        <span className={`text-2xl font-bold tabular-nums ${colorClass}`}>
          {score.toFixed(1)}
        </span>
        <span className={`text-sm font-bold uppercase tracking-wide ${colorClass}`}>
          {band}
        </span>
      </div>
      {delta !== null && (
        <span className={`text-sm font-medium tabular-nums ${delta >= 0 ? "text-green-500" : "text-red-500"}`}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
        </span>
      )}
      {sparkData.length > 1 && (
        <Sparkline data={sparkData} color={sparkColor} />
      )}
    </div>
  );
}

function Sparkline({ data, color }: { data: { score: number; band: string }[]; color: string }) {
  const scores = data.map((d) => d.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const w = 120;
  const h = 28;
  const padding = 2;

  const points = scores
    .map((s, i) => {
      const x = padding + (i / (scores.length - 1)) * (w - 2 * padding);
      const y = h - padding - ((s - min) / range) * (h - 2 * padding);
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={w} height={h} className="shrink-0" aria-label="30-day stability index trend">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
```

**Step 2: Type-check and build**

Run: `npm run build`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/components/stability-index.tsx
git commit -m "feat(stability-index): homepage widget with sparkline and delta"
```

---

### Task 9: Homepage Integration

**Files:**
- Modify: `src/app/page.tsx:5` (add import)
- Modify: `src/app/page.tsx:39-41` (add component above digest)

**Step 1: Add import**

At `src/app/page.tsx`, add after line 5 (`import { DailyDigest } ...`):
```typescript
import { StabilityIndex } from "@/components/stability-index";
```

**Step 2: Add component above digest**

At `src/app/page.tsx`, change the digest wrapper (lines 39-41) from:
```tsx
      <div className="mb-6">
        <DailyDigest />
      </div>
```
to:
```tsx
      <div className="mb-6">
        <StabilityIndex />
        <DailyDigest />
      </div>
```

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(stability-index): add widget to homepage above digest"
```

---

### Task 10: Backfill Endpoint

**Files:**
- Create: `worker/src/api/backfill-stability-index.ts`
- Modify: `worker/src/router.ts` (add import + route)

This admin-only endpoint replays the stability index formula over historical depeg events and supply data. It iterates day by day, reconstructing the market state for each day using `depeg_events` (started_at/ended_at) and `supply_history` (per-coin mcap snapshots).

**Step 1: Write the backfill handler**

```typescript
import { withErrorHandler } from "../lib/api-utils";
import { computeStabilityIndex } from "../lib/stability-index";
import { batchExecute } from "../lib/db";

export const handleBackfillStabilityIndex = withErrorHandler(
  "backfill-stability-index",
  async (db: D1Database, adminKey?: string, request?: Request): Promise<Response> => {
    // Admin auth
    const provided = request?.headers.get("X-Admin-Key");
    if (!adminKey || provided !== adminKey) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;

    // Determine backfill window: find earliest depeg event
    const earliest = await db
      .prepare("SELECT MIN(started_at) as earliest FROM depeg_events")
      .first<{ earliest: number | null }>();

    if (!earliest?.earliest) {
      return new Response(JSON.stringify({ error: "No depeg events found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Start from earliest depeg event, iterate day by day
    const startDay = Math.floor(earliest.earliest / DAY) * DAY;
    const endDay = Math.floor(now / DAY) * DAY;

    // Load all depeg events into memory for fast lookup
    const allDepegs = await db
      .prepare("SELECT stablecoin_id, peak_deviation_bps, started_at, ended_at FROM depeg_events ORDER BY started_at")
      .all<{ stablecoin_id: string; peak_deviation_bps: number; started_at: number; ended_at: number | null }>();
    const depegEvents = allDepegs.results ?? [];

    // Load all supply snapshots for mcap lookup
    const allSupply = await db
      .prepare("SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history ORDER BY snapshot_date")
      .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();
    const supplyRows = allSupply.results ?? [];

    // Build supply lookup: for each coin, sorted snapshots
    const supplyByColn = new Map<string, { date: number; mcap: number }[]>();
    for (const r of supplyRows) {
      const list = supplyByColn.get(r.stablecoin_id) ?? [];
      list.push({ date: r.snapshot_date, mcap: r.circulating_usd });
      supplyByColn.set(r.stablecoin_id, list);
    }

    // Helper: find nearest supply snapshot for a coin on a given day
    function getMcapForDay(coinId: string, day: number): number {
      const snapshots = supplyByColn.get(coinId);
      if (!snapshots || snapshots.length === 0) return 0;
      let best = snapshots[0];
      for (const s of snapshots) {
        if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
        if (s.date > day) break;
      }
      // Only use if within 14 days
      return Math.abs(best.date - day) <= 14 * DAY ? best.mcap : 0;
    }

    // Clear existing backfill data
    await db.prepare("DELETE FROM stability_index").run();

    // Iterate day by day
    const stmts: D1PreparedStatement[] = [];
    let count = 0;

    for (let day = startDay; day <= endDay; day += DAY) {
      // Find active depegs on this day
      const activeDepegs = depegEvents.filter(
        (e) => e.started_at <= day && (e.ended_at === null ? day <= now : e.ended_at > day)
      );

      const depegs: { bps: number; mcapUsd: number }[] = [];
      let totalMcapUsd = 0;

      // Collect unique coin mcaps for total
      const coinMcaps = new Map<string, number>();
      for (const e of activeDepegs) {
        const mcap = getMcapForDay(e.stablecoin_id, day);
        depegs.push({ bps: e.peak_deviation_bps, mcapUsd: mcap });
        coinMcaps.set(e.stablecoin_id, mcap);
      }

      // Total mcap: sum all tracked coins' supply for this day
      for (const [, snapshots] of supplyByColn) {
        let best = snapshots[0];
        for (const s of snapshots) {
          if (Math.abs(s.date - day) < Math.abs(best.date - day)) best = s;
          if (s.date > day) break;
        }
        if (Math.abs(best.date - day) <= 14 * DAY) {
          totalMcapUsd += best.mcap;
        }
      }

      // 7-day trend
      const day7ago = day - 7 * DAY;
      let totalMcap7dAgo = 0;
      for (const [, snapshots] of supplyByColn) {
        let best = snapshots[0];
        for (const s of snapshots) {
          if (Math.abs(s.date - day7ago) < Math.abs(best.date - day7ago)) best = s;
          if (s.date > day7ago) break;
        }
        if (Math.abs(best.date - day7ago) <= 14 * DAY) {
          totalMcap7dAgo += best.mcap;
        }
      }
      const mcap7dChangePct = totalMcap7dAgo > 0
        ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
        : 0;

      // Freezes: zero for backfill (no deep historical data)
      const freezeCount24h = 0;

      const result = computeStabilityIndex({ depegs, totalMcapUsd, freezeCount24h, mcap7dChangePct });

      stmts.push(
        db.prepare(
          "INSERT INTO stability_index (computed_at, score, band, components, input_snapshot) VALUES (?, ?, ?, ?, ?)"
        ).bind(
          day,
          result.score,
          result.band,
          JSON.stringify(result.components),
          JSON.stringify({ depegCount: depegs.length, totalMcapUsd, freezeCount24h, mcap7dChangePct }),
        )
      );
      count++;
    }

    await batchExecute(db, stmts);

    return new Response(JSON.stringify({ ok: true, daysBackfilled: count }), {
      headers: { "Content-Type": "application/json" },
    });
  }
);
```

**Step 2: Add route in router.ts**

Add import at `worker/src/router.ts` after the stability-index import:
```typescript
import { handleBackfillStabilityIndex } from "./api/backfill-stability-index";
```

Add route after the `/api/stability-index` route:
```typescript
  if (path === "/api/backfill-stability-index") {
    return handleBackfillStabilityIndex(db, adminKey, request);
  }
```

**Step 3: Type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add worker/src/api/backfill-stability-index.ts worker/src/router.ts
git commit -m "feat(stability-index): admin backfill endpoint for historical data"
```

---

### Task 11: Full Build Verification

**Step 1: Worker type-check**

Run: `cd worker && npx tsc --noEmit`
Expected: No errors

**Step 2: Frontend build**

Run: `npm run build`
Expected: Build succeeds with no type errors

**Step 3: Apply migration to remote**

Run: `cd worker && npx wrangler d1 migrations apply stablecoin-db --remote`
Expected: Migration 0022 applied

**Step 4: Deploy worker**

Run: `cd worker && npx wrangler deploy`
Expected: Deployment succeeds, new cron trigger `55 7 * * *` registered

**Step 5: Trigger backfill**

Run: `curl -X GET "https://api.pharos.watch/api/backfill-stability-index" -H "X-Admin-Key: $ADMIN_KEY"`
Expected: `{"ok":true,"daysBackfilled":...}` (expect 1000+ days)

**Step 6: Verify API**

Run: `curl -s "https://api.pharos.watch/api/stability-index" | python3 -m json.tool | head -20`
Expected: JSON with `current` (score, band, components) and `history` array with backfilled data

**Step 7: Commit any remaining changes and push**

```bash
git push
```
