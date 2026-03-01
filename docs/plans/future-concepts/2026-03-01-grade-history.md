# Safety Score Grade History — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Record an event every time a stablecoin's overall Safety Score letter grade changes, then display a grade timeline on each stablecoin detail page.

**Architecture:** A daily cron (piggybacking on the `0 8 * * *` slot) computes all report cards using extracted shared logic, compares each coin's current grade to its last known grade in D1, and inserts a row into `grade_history` when the letter changes. A new API endpoint serves history per coin. A frontend timeline component renders it on the detail page.

**Tech Stack:** D1 (SQLite), Cloudflare Workers cron, TanStack Query, React, Tailwind, shadcn/ui

---

## Task 1: D1 Migration — `grade_history` Table

**Files:**
- Create: `worker/migrations/0031_grade_history.sql`

**Step 1: Write the migration**

```sql
-- Grade history: one row per overall letter-grade change
CREATE TABLE grade_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stablecoin_id TEXT NOT NULL,
  grade TEXT NOT NULL,
  score REAL,
  prev_grade TEXT,
  prev_score REAL,
  methodology_version TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX idx_grade_hist_coin ON grade_history(stablecoin_id, recorded_at DESC);
CREATE INDEX idx_grade_hist_date ON grade_history(recorded_at DESC);
```

Column notes:
- `grade` / `prev_grade`: Letter grade strings (`"A+"`, `"B-"`, `"NR"`, etc.). `prev_grade` is NULL for the initial seed row.
- `score` / `prev_score`: Numeric 0–100 score. NULL when grade is `"NR"`.
- `methodology_version`: e.g. `"5.4"`. Records which version produced this grade, so methodology bumps are attributable.
- `recorded_at`: Unix seconds (UTC midnight of snapshot day).

**Step 2: Verify migration applies locally**

Run:
```bash
cd worker && npx wrangler d1 migrations apply pharos-db --local
```

Expected: Migration 0031 applied successfully.

**Step 3: Commit**

```bash
git add worker/migrations/0031_grade_history.sql
git commit -m "feat(db): add grade_history table for safety score tracking"
```

---

## Task 2: Extract Card Computation to Shared Module

The report card computation currently lives entirely inside the API handler (`worker/src/api/report-cards.ts`). We need it callable from both the API and the new cron. Extract the data-fetching + computation into a shared module.

**Files:**
- Create: `worker/src/lib/compute-cards.ts`
- Modify: `worker/src/api/report-cards.ts` (replace inline logic with import)
- Test: `worker/src/lib/__tests__/compute-cards.test.ts`

### Step 1: Write tests for the extraction

Create `worker/src/lib/__tests__/compute-cards.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeCard, topologicalOrder } from "../compute-cards";
import { TRACKED_STABLECOINS } from "../../../../src/lib/stablecoins";

describe("topologicalOrder", () => {
  it("returns all input coins", () => {
    const subset = TRACKED_STABLECOINS.slice(0, 5);
    const sorted = topologicalOrder(subset);
    expect(sorted).toHaveLength(subset.length);
    for (const m of subset) {
      expect(sorted.find((s) => s.id === m.id)).toBeDefined();
    }
  });

  it("places upstream coins before their dependents", () => {
    // Find a coin with dependencies (e.g. DAI depends on USDC)
    const sorted = topologicalOrder([...TRACKED_STABLECOINS]);
    const indexById = new Map(sorted.map((m, i) => [m.id, i]));
    // If coin X depends on coin Y, Y must come before X
    for (const meta of sorted) {
      const deps = meta.reserves?.composition?.filter((s) => s.id) ?? [];
      for (const dep of deps) {
        if (dep.id && indexById.has(dep.id)) {
          expect(indexById.get(dep.id)!).toBeLessThan(indexById.get(meta.id)!);
        }
      }
    }
  });
});

describe("computeCard", () => {
  it("returns a valid ReportCard shape", () => {
    const meta = TRACKED_STABLECOINS.find((s) => s.symbol === "USDC")!;
    const card = computeCard(
      meta,
      new Map(),        // empty peg data
      {},               // empty dex liquidity
      {},               // empty bluechip
      new Map(),        // empty upstream scores
    );
    expect(card.id).toBe(meta.id);
    expect(card.symbol).toBe("USDC");
    expect(card.dimensions).toHaveProperty("pegStability");
    expect(card.dimensions).toHaveProperty("liquidity");
    expect(card.dimensions).toHaveProperty("resilience");
    expect(card.dimensions).toHaveProperty("decentralization");
    expect(card.dimensions).toHaveProperty("dependencyRisk");
    expect(typeof card.overallGrade).toBe("string");
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
```bash
npm test -- worker/src/lib/__tests__/compute-cards.test.ts
```

Expected: FAIL — `../compute-cards` module not found.

### Step 3: Create the shared module

Create `worker/src/lib/compute-cards.ts`. This extracts three things from `worker/src/api/report-cards.ts`:
1. `isBlacklistable()` helper (lines 48–51)
2. `computeCard()` function (lines 273–330)
3. `topologicalOrder()` function (lines 336–354)

```typescript
import { computePegScore } from "../../../src/lib/peg-score";
import { deriveDependencies } from "../../../src/lib/reserve-templates";
import {
  scorePegStability,
  scoreLiquidity,
  scoreResilience,
  scoreDecentralization,
  scoreDependencyRisk,
  computeOverallGrade,
  resolveResilienceFactors,
  resolveGovernanceQuality,
} from "../../../src/lib/report-cards";
import type {
  StablecoinMeta,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  PegSummaryCoin,
  DimensionKey,
  GovernanceType,
  GovernanceQuality,
  RawDimensionInputs,
} from "../../../src/lib/types";

// ---------------------------------------------------------------------------
// Blacklistability helper
// ---------------------------------------------------------------------------

export function isBlacklistable(meta: StablecoinMeta): boolean | "possible" {
  if (meta.canBeBlacklisted !== undefined) return meta.canBeBlacklisted;
  return meta.flags.governance === "centralized";
}

// ---------------------------------------------------------------------------
// Per-coin card computation
// ---------------------------------------------------------------------------

export function computeCard(
  meta: StablecoinMeta,
  pegDataById: Map<string, PegSummaryCoin>,
  dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">>,
  bluechipMap: Record<string, BluechipRating>,
  overallScores: Map<string, number>,
): ReportCard {
  const peg = pegDataById.get(meta.id);
  const liq = dexLiqMap[meta.id];
  const rating = bluechipMap[meta.id];

  const canBeBlacklisted = isBlacklistable(meta);
  const resilienceFactors = resolveResilienceFactors(meta);

  const dimensions: Record<DimensionKey, ReturnType<typeof scorePegStability>> = {
    pegStability: scorePegStability(peg, meta),
    liquidity: scoreLiquidity(liq),
    resilience: scoreResilience(meta, canBeBlacklisted),
    decentralization: scoreDecentralization(meta.flags.governance as GovernanceType, meta),
    dependencyRisk: scoreDependencyRisk(meta, overallScores),
  };

  const navToken = !!meta.flags.navToken;
  const overall = computeOverallGrade(dimensions, { navToken });

  const rawInputs: RawDimensionInputs = {
    pegScore: peg?.pegScore ?? null,
    activeDepeg: peg?.activeDepeg ?? false,
    depegEventCount: peg?.eventCount ?? 0,
    lastEventAt: peg?.lastEventAt ?? null,
    liquidityScore: liq?.liquidityScore ?? null,
    concentrationHhi: liq?.concentrationHhi ?? null,
    bluechipGrade: rating?.grade ?? null,
    canBeBlacklisted,
    chainTier: resilienceFactors.chainTier,
    deploymentModel: resilienceFactors.deploymentModel,
    collateralQuality: resilienceFactors.collateralQuality,
    custodyModel: resilienceFactors.custodyModel,
    governanceTier: meta.flags.governance as GovernanceType,
    governanceQuality: resolveGovernanceQuality(meta.flags.governance as GovernanceType, meta),
    dependencies: deriveDependencies(meta),
    navToken,
  };

  return {
    id: meta.id,
    name: meta.name,
    symbol: meta.symbol,
    overallGrade: overall.grade,
    overallScore: overall.score,
    dimensions,
    ratedDimensions: overall.ratedDimensions,
    rawInputs,
    ...(() => { const d = deriveDependencies(meta); return d.length > 0 ? { dependencies: d } : {}; })(),
    isDefunct: false,
  };
}

// ---------------------------------------------------------------------------
// Topological sort — ensures every coin is scored after all its upstreams
// ---------------------------------------------------------------------------

export function topologicalOrder(metas: StablecoinMeta[]): StablecoinMeta[] {
  const metaMap = new Map(metas.map(m => [m.id, m]));
  const visited = new Set<string>();
  const result: StablecoinMeta[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const meta = metaMap.get(id);
    if (!meta) return;
    for (const dep of deriveDependencies(meta)) {
      if (metaMap.has(dep.id)) visit(dep.id);
    }
    result.push(meta);
  }

  for (const meta of metas) visit(meta.id);
  return result;
}
```

### Step 4: Run tests to verify they pass

Run:
```bash
npm test -- worker/src/lib/__tests__/compute-cards.test.ts
```

Expected: All tests PASS.

### Step 5: Update the API handler to use the shared module

Modify `worker/src/api/report-cards.ts`:

1. **Replace local imports** — remove the scorer/grade imports that are now re-exported through the shared module. Add import of `computeCard`, `topologicalOrder`, `isBlacklistable` from `"../lib/compute-cards"`.

2. **Delete** the three local functions:
   - `isBlacklistable()` (lines 48–51)
   - `computeCard()` (lines 273–330)
   - `topologicalOrder()` (lines 336–354)

3. The handler body (`handleReportCards`, lines 65–267) stays exactly the same — it still calls `computeCard()` and `topologicalOrder()`, just imported from the new location.

After changes, the import block should look like:

```typescript
import { getCache } from "../lib/db";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { CACHE_PROFILES } from "../lib/constants";
import { computePegScore } from "../../../src/lib/peg-score";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { sumPegBuckets } from "../../../src/lib/supply";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { deriveDependencies } from "../../../src/lib/reserve-templates";
import { DEAD_STABLECOINS } from "../../../src/lib/dead-stablecoins";
import {
  METHODOLOGY_VERSION,
  DIMENSION_WEIGHTS,
  PEG_MULTIPLIER_EXPONENT,
  GRADE_THRESHOLDS,
} from "../../../src/lib/report-cards";
import { computeCard, topologicalOrder } from "../lib/compute-cards";
import type {
  StablecoinData,
  StablecoinMeta,
  DepegEvent,
  DexLiquidityData,
  BluechipRating,
  ReportCard,
  ReportCardsResponse,
  PegSummaryCoin,
  DimensionKey,
  GovernanceType,
  GovernanceQuality,
  RawDimensionInputs,
  ChainTier,
  DeploymentModel,
  CollateralQuality,
  CustodyModel,
} from "../../../src/lib/types";
```

Note: Some type imports (`DimensionKey`, `GovernanceType`, `GovernanceQuality`, `RawDimensionInputs`, `ChainTier`, `DeploymentModel`, `CollateralQuality`, `CustodyModel`) may no longer be needed in this file since they're only used inside `computeCard`. Clean them up if the type-checker confirms they're unused.

### Step 6: Verify everything still works

Run:
```bash
npm run build && npm run lint && npm test
```

Also:
```bash
cd worker && npx tsc --noEmit
```

Expected: All pass with no regressions.

### Step 7: Commit

```bash
git add worker/src/lib/compute-cards.ts worker/src/lib/__tests__/compute-cards.test.ts worker/src/api/report-cards.ts
git commit -m "refactor: extract computeCard + topologicalOrder to shared module"
```

---

## Task 3: Cron Job — `snapshot-grades.ts`

Records grade changes by computing all report cards and diffing against the last known grade per coin.

**Files:**
- Create: `worker/src/cron/snapshot-grades.ts`
- Modify: `worker/src/index.ts` (add to `0 8 * * *` slot)

### Step 1: Write the cron job

Create `worker/src/cron/snapshot-grades.ts`:

```typescript
import { getCache, batchExecute } from "../lib/db";
import type { CronResult } from "../lib/db";
import { type DepegRow, rowToDepegEvent } from "../lib/depeg-helpers";
import { computePegScore } from "../../../src/lib/peg-score";
import { derivePegRates, getPegReference } from "../../../src/lib/peg-rates";
import { sumPegBuckets } from "../../../src/lib/supply";
import { TRACKED_STABLECOINS } from "../../../src/lib/stablecoins";
import { METHODOLOGY_VERSION } from "../../../src/lib/report-cards";
import { computeCard, topologicalOrder } from "../lib/compute-cards";
import type {
  StablecoinData,
  DepegEvent,
  DexLiquidityData,
  BluechipRating,
  PegSummaryCoin,
  ReportCardGrade,
} from "../../../src/lib/types";

// ---------------------------------------------------------------------------
// DexLiquidityRow mirrors the shape used in report-cards API handler
// ---------------------------------------------------------------------------

interface DexLiquidityRow {
  stablecoin_id: string;
  liquidity_score: number | null;
  concentration_hhi: number | null;
  pool_count: number;
  chain_count: number;
}

interface LastGradeRow {
  stablecoin_id: string;
  grade: string;
}

// ---------------------------------------------------------------------------
// Main cron
// ---------------------------------------------------------------------------

export async function snapshotGrades(db: D1Database): Promise<CronResult> {
  // 1. Load data (same sources as report-cards API handler)
  const [stablecoinsCached, bluechipCached, dexLiqResult] = await Promise.all([
    getCache(db, "stablecoins"),
    getCache(db, "bluechip-ratings"),
    db.prepare("SELECT stablecoin_id, liquidity_score, concentration_hhi, pool_count, chain_count FROM dex_liquidity").all<DexLiquidityRow>(),
  ]);

  if (!stablecoinsCached) {
    console.warn("[snapshot-grades] No stablecoins cache, skipping");
    return { itemCount: 0 };
  }

  // Cache freshness check (same threshold as snapshot-supply)
  const cacheAge = Math.floor(Date.now() / 1000) - stablecoinsCached.updatedAt;
  if (cacheAge > 1200) {
    console.warn(`[snapshot-grades] Cache is ${cacheAge}s old (>1200s), skipping`);
    return { itemCount: 0 };
  }

  let peggedAssets: StablecoinData[];
  let fxFallbackRates: Record<string, number> | undefined;
  try {
    const parsed = JSON.parse(stablecoinsCached.value) as {
      peggedAssets: StablecoinData[];
      fxFallbackRates?: Record<string, number>;
    };
    peggedAssets = parsed.peggedAssets;
    fxFallbackRates = parsed.fxFallbackRates;
  } catch {
    console.error("[snapshot-grades] Failed to parse stablecoins cache");
    return { itemCount: 0 };
  }

  // Build dex liquidity map
  const dexLiqMap: Record<string, Pick<DexLiquidityData, "liquidityScore" | "concentrationHhi" | "poolCount" | "chainCount">> = {};
  for (const row of dexLiqResult.results ?? []) {
    dexLiqMap[row.stablecoin_id] = {
      liquidityScore: row.liquidity_score,
      concentrationHhi: row.concentration_hhi,
      poolCount: row.pool_count,
      chainCount: row.chain_count,
    };
  }

  let bluechipMap: Record<string, BluechipRating> = {};
  if (bluechipCached) {
    try { bluechipMap = JSON.parse(bluechipCached.value); } catch { /* empty fallback */ }
  }

  // Load depeg events (4-year window)
  const fourYearsAgoSec = Math.floor(Date.now() / 1000) - Math.ceil(4 * 365.25 * 86400);
  const eventsResult = await db.prepare("SELECT * FROM depeg_events WHERE started_at > ? ORDER BY started_at DESC")
    .bind(fourYearsAgoSec)
    .all<DepegRow>();

  const allEvents = (eventsResult.results ?? []).map(rowToDepegEvent);
  const eventsByCoins = new Map<string, DepegEvent[]>();
  for (const e of allEvents) {
    const list = eventsByCoins.get(e.stablecoinId) ?? [];
    list.push(e);
    eventsByCoins.set(e.stablecoinId, list);
  }

  // Build peg data (same as report-cards handler lines 129–180)
  const metaById = new Map(TRACKED_STABLECOINS.map((s) => [s.id, s]));
  const priceById = new Map(peggedAssets.map((a) => [a.id, a]));
  const { rates: pegRates } = derivePegRates(peggedAssets, metaById, fxFallbackRates);
  const now = Math.floor(Date.now() / 1000);
  const fourYearsAgo = now - 4 * 365.25 * 86400;

  const pegDataById = new Map<string, PegSummaryCoin>();
  for (const meta of TRACKED_STABLECOINS) {
    if (meta.flags.navToken) continue;

    const asset = priceById.get(meta.id);
    const events = eventsByCoins.get(meta.id) ?? [];

    let currentBps: number | null = null;
    if (asset?.price != null && typeof asset.price === "number" && !isNaN(asset.price)) {
      const supply = asset.circulating ? sumPegBuckets(asset.circulating) : 0;
      if (supply >= 1_000_000) {
        const pegRef = getPegReference(asset.pegType, pegRates, meta.commodityOunces);
        if (pegRef > 0) {
          currentBps = Math.round(((asset.price / pegRef) - 1) * 10000);
        }
      }
    }

    const trackingStart = events.length > 0
      ? Math.min(Math.min(...events.map((e) => e.startedAt)), fourYearsAgo)
      : fourYearsAgo;
    const scoreResult = computePegScore(events, trackingStart, now);

    pegDataById.set(meta.id, {
      id: meta.id,
      symbol: meta.symbol,
      name: meta.name,
      pegType: asset?.pegType ?? "",
      pegCurrency: meta.flags.pegCurrency,
      governance: meta.flags.governance,
      currentDeviationBps: currentBps,
      pegScore: scoreResult.pegScore,
      pegPct: scoreResult.pegPct,
      severityScore: scoreResult.severityScore,
      spreadPenalty: scoreResult.spreadPenalty,
      eventCount: scoreResult.eventCount,
      worstDeviationBps: scoreResult.worstDeviationBps,
      activeDepeg: scoreResult.activeDepeg,
      lastEventAt: scoreResult.lastEventAt,
      trackingSpanDays: scoreResult.trackingSpanDays,
    });
  }

  // 2. Compute all cards (topological order for dependency scoring)
  const sortedMetas = topologicalOrder([...TRACKED_STABLECOINS]);
  const overallScores = new Map<string, number>();
  const currentGrades = new Map<string, { grade: ReportCardGrade; score: number | null }>();

  for (const meta of sortedMetas) {
    const card = computeCard(meta, pegDataById, dexLiqMap, bluechipMap, overallScores);
    currentGrades.set(card.id, { grade: card.overallGrade, score: card.overallScore });
    if (card.overallScore !== null) {
      overallScores.set(card.id, card.overallScore);
    }
  }

  // 3. Load last known grades
  const lastGradesResult = await db.prepare(`
    SELECT g.stablecoin_id, g.grade
    FROM grade_history g
    INNER JOIN (
      SELECT stablecoin_id, MAX(recorded_at) AS max_at
      FROM grade_history
      GROUP BY stablecoin_id
    ) latest ON g.stablecoin_id = latest.stablecoin_id AND g.recorded_at = latest.max_at
  `).all<LastGradeRow>();

  const lastGrades = new Map<string, string>();
  for (const row of lastGradesResult.results ?? []) {
    lastGrades.set(row.stablecoin_id, row.grade);
  }

  // 4. Diff and insert changes
  const snapshotDate = Math.floor(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000
  );

  const stmts: D1PreparedStatement[] = [];

  for (const [coinId, current] of currentGrades) {
    const prev = lastGrades.get(coinId);

    if (prev === undefined) {
      // First record — seed with current grade (prev_grade = NULL)
      stmts.push(
        db.prepare(
          "INSERT INTO grade_history (stablecoin_id, grade, score, prev_grade, prev_score, methodology_version, recorded_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
        ).bind(coinId, current.grade, current.score, METHODOLOGY_VERSION, snapshotDate)
      );
    } else if (prev !== current.grade) {
      // Grade changed — record the transition
      // Fetch previous score for the record
      const prevRow = await db.prepare(
        "SELECT score FROM grade_history WHERE stablecoin_id = ? ORDER BY recorded_at DESC LIMIT 1"
      ).bind(coinId).first<{ score: number | null }>();

      stmts.push(
        db.prepare(
          "INSERT INTO grade_history (stablecoin_id, grade, score, prev_grade, prev_score, methodology_version, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(coinId, current.grade, current.score, prev, prevRow?.score ?? null, METHODOLOGY_VERSION, snapshotDate)
      );
    }
    // else: grade unchanged, do nothing
  }

  if (stmts.length > 0) {
    await batchExecute(db, stmts);
  }

  const seedCount = [...currentGrades.keys()].filter((id) => !lastGrades.has(id)).length;
  const changeCount = stmts.length - seedCount;

  console.log(`[snapshot-grades] ${seedCount} seeded, ${changeCount} grade changes recorded for ${new Date(snapshotDate * 1000).toISOString().slice(0, 10)}`);
  return { itemCount: stmts.length, metadata: `seeded=${seedCount} changed=${changeCount}` };
}
```

### Step 2: Register in the daily cron slot

Modify `worker/src/index.ts`:

1. Add import at the top (after line 10, near other cron imports):

```typescript
import { snapshotGrades } from "./cron/snapshot-grades";
```

2. Add to the `"0 8 * * *"` case block (after the `snapshot-supply` line, around line 231):

```typescript
ctx.waitUntil(logCronRun(db, "snapshot-grades", () => snapshotGrades(db)));
```

Place it after `snapshot-supply` — it has no ordering dependency on other jobs in this slot.

### Step 3: Type-check and lint

Run:
```bash
cd worker && npx tsc --noEmit
```

Then:
```bash
npm run lint
```

Expected: No errors.

### Step 4: Commit

```bash
git add worker/src/cron/snapshot-grades.ts worker/src/index.ts
git commit -m "feat(cron): add daily grade history snapshot to 0 8 * * * slot"
```

---

## Task 4: API Endpoint — `GET /api/grade-history`

**Files:**
- Create: `worker/src/api/grade-history.ts`
- Modify: `worker/src/router.ts` (add route)

### Step 1: Write the handler

Create `worker/src/api/grade-history.ts`:

```typescript
import { withErrorHandler, addFreshnessHeaders } from "../lib/api-utils";
import { buildPaginatedQuery } from "../lib/db";
import { CACHE_PROFILES } from "../lib/constants";

interface GradeHistoryRow {
  id: number;
  stablecoin_id: string;
  grade: string;
  score: number | null;
  prev_grade: string | null;
  prev_score: number | null;
  methodology_version: string;
  recorded_at: number;
}

export const handleGradeHistory = withErrorHandler("grade-history", async (db: D1Database, url: URL): Promise<Response> => {
  const params = url.searchParams;
  const stablecoin = params.get("stablecoin");
  const limit = Math.min(Math.max(parseInt(params.get("limit") ?? "") || 100, 1), 1000);
  const offset = Math.max(parseInt(params.get("offset") ?? "0", 10) || 0, 0);

  const conditions: string[] = [];
  const filterBindings: (string | number)[] = [];

  if (stablecoin) {
    conditions.push("stablecoin_id = ?");
    filterBindings.push(stablecoin);
  }

  const { where, limitClause, offsetClause, paginationBindings } = buildPaginatedQuery({
    conditions, limit, offset,
  });

  const sql = `SELECT * FROM grade_history${where} ORDER BY recorded_at DESC${limitClause}${offsetClause}`;
  const [countBatch, dataBatch] = await db.batch([
    db.prepare(`SELECT COUNT(*) as total FROM grade_history${where}`).bind(...filterBindings),
    db.prepare(sql).bind(...filterBindings, ...paginationBindings),
  ]);

  const total = ((countBatch.results ?? []) as { total: number }[])[0]?.total ?? 0;
  const events = ((dataBatch.results ?? []) as GradeHistoryRow[]).map((row) => ({
    id: row.id,
    stablecoinId: row.stablecoin_id,
    grade: row.grade,
    score: row.score,
    prevGrade: row.prev_grade,
    prevScore: row.prev_score,
    methodologyVersion: row.methodology_version,
    recordedAt: row.recorded_at,
  }));

  const latestTs = events.length > 0 ? events[0].recordedAt : Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({ events, total }), {
    headers: addFreshnessHeaders({
      "Content-Type": "application/json",
      "Cache-Control": CACHE_PROFILES.slow,
    }, latestTs, 3600),
  });
});
```

Cache profile is `slow` (1h edge, 5min browser) since data changes at most once per day.

### Step 2: Add route

Modify `worker/src/router.ts`:

1. Add import at the top:

```typescript
import { handleGradeHistory } from "./api/grade-history";
```

2. Add route (before the `/api/report-cards` block, around line 120):

```typescript
if (path === "/api/grade-history") {
  return handleGradeHistory(db, url);
}
```

### Step 3: Type-check

Run:
```bash
cd worker && npx tsc --noEmit
```

Expected: No errors.

### Step 4: Commit

```bash
git add worker/src/api/grade-history.ts worker/src/router.ts
git commit -m "feat(api): add GET /api/grade-history endpoint"
```

---

## Task 5: Frontend Type + Hook

**Files:**
- Modify: `src/lib/types.ts` (add `GradeChangeEvent` type)
- Create: `src/hooks/use-grade-history.ts`

### Step 1: Add the type

Add to `src/lib/types.ts` (after the `ReportCardsResponse` interface, around line 470):

```typescript
export interface GradeChangeEvent {
  id: number;
  stablecoinId: string;
  grade: ReportCardGrade;
  score: number | null;
  prevGrade: ReportCardGrade | null;
  prevScore: number | null;
  methodologyVersion: string;
  recordedAt: number;
}
```

### Step 2: Create the hook

Create `src/hooks/use-grade-history.ts`:

```typescript
"use client";

import type { GradeChangeEvent } from "@/lib/types";
import { useApiQuery, CRON_24H } from "./use-api-query";

interface GradeHistoryResponse {
  events: GradeChangeEvent[];
  total: number;
}

export function useGradeHistory(stablecoinId: string) {
  const params = `?stablecoin=${encodeURIComponent(stablecoinId)}`;
  return useApiQuery<GradeHistoryResponse>(
    ["grade-history", stablecoinId],
    `/api/grade-history${params}`,
    CRON_24H,
  );
}
```

Uses `CRON_24H` since data changes at most daily. staleTime = 24h, refetchInterval = 48h.

### Step 3: Type-check

Run:
```bash
npm run build
```

Expected: Build succeeds.

### Step 4: Commit

```bash
git add src/lib/types.ts src/hooks/use-grade-history.ts
git commit -m "feat(ui): add GradeChangeEvent type and useGradeHistory hook"
```

---

## Task 6: Frontend Component — Grade Timeline

**Files:**
- Create: `src/components/grade-timeline.tsx`
- Modify: `src/app/stablecoin/[id]/client.tsx` (integrate into detail page)

### Step 1: Create the timeline component

Create `src/components/grade-timeline.tsx`:

```typescript
"use client";

import { useGradeHistory } from "@/hooks/use-grade-history";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_CARD_GRADE_COLORS } from "@/lib/report-cards";
import type { GradeChangeEvent, ReportCardGrade } from "@/lib/types";

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
  });
}

function GradeTransition({ event }: { event: GradeChangeEvent }) {
  const isUpgrade = event.prevGrade && event.score !== null && event.prevScore !== null && event.score > event.prevScore;
  const isDowngrade = event.prevGrade && event.score !== null && event.prevScore !== null && event.score < event.prevScore;

  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{formatDate(event.recordedAt)}</span>
      <Badge className={REPORT_CARD_GRADE_COLORS[event.grade as ReportCardGrade] ?? REPORT_CARD_GRADE_COLORS.NR}>
        {event.grade}
      </Badge>
      {event.prevGrade && (
        <span className="text-xs text-muted-foreground">
          {isUpgrade ? "upgraded" : isDowngrade ? "downgraded" : "changed"} from{" "}
          <Badge variant="outline" className="text-[10px] px-1 py-0">
            {event.prevGrade}
          </Badge>
        </span>
      )}
      {!event.prevGrade && (
        <span className="text-xs text-muted-foreground">initial grade</span>
      )}
    </div>
  );
}

export function GradeTimeline({ stablecoinId }: { stablecoinId: string }) {
  const { data, isLoading } = useGradeHistory(stablecoinId);

  if (isLoading) {
    return <Skeleton className="h-24" />;
  }

  const events = data?.events;
  if (!events || events.length === 0) {
    return null; // No history yet — hide the section entirely
  }

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-1">
        <CardTitle as="h2" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Grade History
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {events.map((event) => (
            <GradeTransition key={event.id} event={event} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

Design notes:
- Returns `null` when no history exists (graceful degradation before first cron run).
- Each entry shows: date, new grade badge (colored), transition text.
- Sorted newest-first (API returns `ORDER BY recorded_at DESC`).

### Step 2: Integrate into the detail page

Modify `src/app/stablecoin/[id]/client.tsx`:

1. Add import (near other component imports):

```typescript
import { GradeTimeline } from "@/components/grade-timeline";
```

2. Add the component **inside** the `report-card` section, right after `<ReportCardDetail>` (around line 392):

```typescript
<section id="report-card">
  {reportCard && <ReportCardDetail card={reportCard} />}
  <GradeTimeline stablecoinId={id} />
</section>
```

The timeline sits below the current report card. It renders nothing if there's no history yet (returns null).

3. No changes needed to `DETAIL_SECTIONS` — the grade timeline lives within the existing "Safety Score" section.

### Step 3: Build and verify

Run:
```bash
npm run build
```

Expected: Build succeeds with no type errors.

### Step 4: Commit

```bash
git add src/components/grade-timeline.tsx src/app/stablecoin/[id]/client.tsx
git commit -m "feat(ui): add grade timeline component to stablecoin detail page"
```

---

## Task 7: Documentation Updates

**Files:**
- Modify: `docs/report-cards.md` (add grade history section)
- Modify: `docs/api-reference.md` (add endpoint docs)
- Modify: `docs/architecture.md` (update file tree if needed)

### Step 1: Update `docs/report-cards.md`

Add a new section after the existing "API" section (around line 243):

```markdown
### Grade History

The system records an event each time a stablecoin's **overall letter grade** changes (e.g. B+ → A-). Grade snapshots run daily at 08:00 UTC as part of the `0 8 * * *` cron slot.

**Table:** `grade_history`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `INTEGER PK` | Auto-increment |
| `stablecoin_id` | `TEXT` | DefiLlama ID |
| `grade` | `TEXT` | New letter grade |
| `score` | `REAL` | New numeric score (0–100) |
| `prev_grade` | `TEXT` | Previous letter grade (NULL for seed) |
| `prev_score` | `REAL` | Previous numeric score |
| `methodology_version` | `TEXT` | e.g. "5.4" |
| `recorded_at` | `INTEGER` | UTC midnight epoch seconds |

**First run behavior:** On the first cron execution (or when a new coin is added to tracking), a seed row is inserted with `prev_grade = NULL`. Subsequent runs only insert rows when the letter grade differs from the last recorded grade.

**Methodology bumps:** When methodology version changes (e.g. 5.4 → 5.5), many coins may shift grades simultaneously. All changes are recorded with the new version, making mass shifts attributable.
```

Also add to the "Frontend" / "Key Files" section:

```markdown
| `src/components/grade-timeline.tsx` | Grade history timeline on detail page |
| `src/hooks/use-grade-history.ts` | TanStack Query hook for grade history |
| `worker/src/cron/snapshot-grades.ts` | Daily grade change detection cron |
| `worker/src/api/grade-history.ts` | Grade history API endpoint |
| `worker/src/lib/compute-cards.ts` | Shared card computation (used by API + cron) |
```

### Step 2: Update `docs/api-reference.md`

Add a new endpoint section (in alphabetical position or after report-cards):

```markdown
### `GET /api/grade-history`

Grade change events for stablecoins. Returns events sorted by `recorded_at` descending.

Cache: slow (`s-maxage=3600, max-age=300`).

**Query parameters**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stablecoin` | `string` | — | Filter by DefiLlama stablecoin ID |
| `limit` | `number` | `100` | Max rows (1–1000) |
| `offset` | `number` | `0` | Pagination offset |

**Response**

```json
{
  "events": [GradeChangeEvent],
  "total": 42
}
```

**`GradeChangeEvent`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-increment DB ID |
| `stablecoinId` | `string` | DefiLlama stablecoin ID |
| `grade` | `string` | New letter grade (A+ through F, or NR) |
| `score` | `number \| null` | New numeric score (0–100) |
| `prevGrade` | `string \| null` | Previous letter grade (null for initial seed) |
| `prevScore` | `number \| null` | Previous numeric score |
| `methodologyVersion` | `string` | Methodology version that produced this grade |
| `recordedAt` | `number` | Unix seconds (UTC midnight of snapshot day) |
```

### Step 3: Update `docs/architecture.md`

Add the new files to the relevant sections of the file tree:

- `worker/src/cron/snapshot-grades.ts` under cron jobs
- `worker/src/api/grade-history.ts` under API handlers
- `worker/src/lib/compute-cards.ts` under shared libs

### Step 4: Commit

```bash
git add docs/report-cards.md docs/api-reference.md docs/architecture.md
git commit -m "docs: add grade history endpoint, cron, and table documentation"
```

---

## Task 8: Final Verification

### Step 1: Full build + type-check + lint + test

```bash
npm run build && npm run lint && npm test
```

```bash
cd worker && npx tsc --noEmit
```

Expected: All pass.

### Step 2: Local worker smoke test

```bash
cd worker && npx wrangler d1 migrations apply pharos-db --local && npx wrangler dev
```

In another terminal:
```bash
curl http://localhost:8787/api/grade-history | jq .
```

Expected: `{ "events": [], "total": 0 }` (no data yet — the cron hasn't run).

### Step 3: Commit (if any final fixes)

```bash
git add -A
git commit -m "chore: final verification fixes for grade history feature"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | D1 migration | `worker/migrations/0031_grade_history.sql` |
| 2 | Extract computation | `worker/src/lib/compute-cards.ts`, modify `worker/src/api/report-cards.ts` |
| 3 | Cron job | `worker/src/cron/snapshot-grades.ts`, modify `worker/src/index.ts` |
| 4 | API endpoint | `worker/src/api/grade-history.ts`, modify `worker/src/router.ts` |
| 5 | Type + hook | `src/lib/types.ts`, `src/hooks/use-grade-history.ts` |
| 6 | Frontend component | `src/components/grade-timeline.tsx`, modify `src/app/stablecoin/[id]/client.tsx` |
| 7 | Documentation | `docs/report-cards.md`, `docs/api-reference.md`, `docs/architecture.md` |
| 8 | Final verification | Build, lint, test, smoke test |

**Dependency order:** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8

All tasks are sequential — each builds on the previous one.
