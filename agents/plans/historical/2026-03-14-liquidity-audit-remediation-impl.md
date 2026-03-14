# Liquidity Audit Remediation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remediate all findings from the DEX liquidity feature audit (2 critical, 6 high, 10 medium, 8 low) across circuit breakers, scoring, discovery, schema, frontend, and tests.

**Architecture:** Single feature branch `fix/liquidity-audit-remediation`. Worker-side changes harden the fetch/scoring/discovery pipeline. Frontend changes add error boundaries and guards. New tests verify circuit breaker and cascading failure behavior.

**Tech Stack:** TypeScript, Cloudflare Workers (D1), Next.js 16, React 19, Vitest, Zod

**Spec:** `agents/plans/2026-03-14-liquidity-audit-remediation.md`

---

## File Map

**Create:**
- `worker/migrations/0068_dex_prices_index.sql` — new index
- `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts` — new test file

**Modify:**
- `worker/src/lib/constants.ts:143` — add CURVE_LIQUIDITY_API circuit source
- `worker/src/cron/dex-liquidity/constants.ts:84` — add timeout constant + confidence function
- `worker/src/cron/dex-liquidity/fetch-primary.ts:141-154` — circuit breaker wrap + subgraph timeouts
- `worker/src/cron/dex-liquidity/scoring.ts:487-499` — confidence-weighted median
- `worker/src/cron/dex-liquidity/staging-merge.ts:213` — documentation comment
- `worker/src/cron/dex-discovery/types.ts:49` — clock skew clamp
- `worker/src/cron/dex-discovery/crawl-sources.ts:63-65` — chain resolution warnings
- `worker/src/cron/dex-discovery/orchestrator.ts:261-273` — per-source pool metrics + unresolved chains
- `shared/types/market.ts:200-217` — Zod bounds
- `src/app/stablecoin/[id]/client.tsx:208-210` — error boundary
- `src/app/liquidity/client.tsx:173,182` — global key guard + aria-label
- `src/components/liquidity-stats.tsx:62,125` — globalData guards
- `worker/src/api/dex-liquidity.ts:90-98,146` — normalizeTopPools fix + metadata log
- `worker/src/lib/report-cards-snapshot.ts:65-69` — staleness check
- `worker/src/cron/sync-redemption-backstops.ts:36-37` — staleness check
- `worker/src/cron/dex-liquidity/orchestrator.ts:25-28` — documentation comments
- `worker/src/cron/dex-liquidity/scoring.ts:280,388` — documentation comments
- `worker/src/cron/dex-discovery/orchestrator.ts:177` — documentation comment
- `worker/src/api/dex-liquidity.ts:100` — documentation comment
- `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts` — extend with new tests
- `worker/src/cron/__tests__/sync-dex-liquidity.test.ts` — extend with cascading tests
- `docs/dex-liquidity.md` — score formula documentation
- `docs/data-pipeline.md` — circuit breaker list update

---

## Chunk 1: Foundation (Migration + Circuit Breaker + Timeouts)

### Task 1: Create branch and migration

**Files:**
- Create: `worker/migrations/0068_dex_prices_index.sql`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b fix/liquidity-audit-remediation main
```

- [ ] **Step 2: Create migration file**

```sql
-- worker/migrations/0068_dex_prices_index.sql
CREATE INDEX IF NOT EXISTS idx_dex_prices_updated ON dex_prices(updated_at DESC);
```

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/0068_dex_prices_index.sql
git commit -m "feat(L5): add dex_prices updated_at index"
```

---

### Task 2: Add CURVE_LIQUIDITY_API circuit source

**Files:**
- Modify: `worker/src/lib/constants.ts:143`

- [ ] **Step 1: Add circuit source constant**

In `worker/src/lib/constants.ts`, add `CURVE_LIQUIDITY_API` to `CIRCUIT_SOURCE` right after the `CURVE_ONCHAIN` entry (line 143):

```typescript
  CURVE_ONCHAIN: "curve-onchain",
  CURVE_LIQUIDITY_API: "curve-liquidity-api",
```

- [ ] **Step 2: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success (no errors)

- [ ] **Step 3: Commit**

```bash
git add worker/src/lib/constants.ts
git commit -m "feat(C1): add CURVE_LIQUIDITY_API circuit breaker source"
```

---

### Task 3: Wrap Curve fetch with circuit breaker

**Files:**
- Modify: `worker/src/cron/dex-liquidity/fetch-primary.ts:141-154`

- [ ] **Step 1: Wrap the Curve fetch block**

In `worker/src/cron/dex-liquidity/fetch-primary.ts`, replace the Curve fetch block (lines 141-152) with:

```typescript
  // Now safe to start Curve batch — DL connections are released (max 4 concurrent)
  let curveResponses: (Response | null)[];
  let curveCircuitSkipped = false;
  const curveCircuitAllowed = await shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API);

  if (curveCircuitAllowed) {
    curveResponses = await Promise.all(
      CURVE_CHAINS.map((chain) =>
        fetchWithRetry(`${CURVE_API_BASE}/${chain}`, { headers: { "User-Agent": USER_AGENT }, signal }),
      ),
    );
    const curveSuccess = curveResponses.some((r) => r?.ok);
    await recordOutcome(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API, curveSuccess);
  } else {
    console.warn("[dex-liquidity] Curve liquidity API circuit open — skipping Curve pool data");
    curveResponses = CURVE_CHAINS.map(() => null);
    curveCircuitSkipped = true;
  }

  // Only abort if BOTH DL sources AND Curve all failed (truly catastrophic)
  if (!dlYieldsAvailable && curveResponses.every((r) => !r?.ok)) {
    console.error("[dex-liquidity] All pool data sources failed — aborting");
    return null;
  }
```

Note: the old code was `const curveResponses = await Promise.all(...)`. The new code uses `let` and wraps with the circuit breaker check. `shouldAttemptFetch` and `recordOutcome` are already imported at line 5.

- [ ] **Step 2: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/dex-liquidity/fetch-primary.ts
git commit -m "feat(C1): wrap Curve liquidity fetch with circuit breaker"
```

---

### Task 4: Add subgraph per-chain timeouts

**Files:**
- Modify: `worker/src/cron/dex-liquidity/constants.ts:84`
- Modify: `worker/src/cron/dex-liquidity/fetch-primary.ts:316-322,420+`

- [ ] **Step 1: Add timeout constant**

At the end of `worker/src/cron/dex-liquidity/constants.ts` (after line 84), add:

```typescript

/** Per-chain timeout for subgraph queries (UniV3, Aerodrome) */
export const SUBGRAPH_PER_CHAIN_TIMEOUT_MS = 15_000;
```

- [ ] **Step 2: Add per-chain timeout to fetchUniV3Data**

In `worker/src/cron/dex-liquidity/fetch-primary.ts`, add the import for the new constant. Find the existing import block from `"./constants"` (line 20-23) and add `SUBGRAPH_PER_CHAIN_TIMEOUT_MS` to it.

Then inside `fetchUniV3Data()`, in the `for` loop over chains (line 332), add a per-chain timeout signal right after the loop statement:

```typescript
  for (const [chain, subgraphId] of Object.entries(UNIV3_SUBGRAPHS)) {
    const perChainTimeout = AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, perChainTimeout])
      : perChainTimeout;
    const subgraphUrl = `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`;
    const { entityCount, observationCount, observations, shouldLogIndex } = await fetchSubgraphEntities<UniV3SubgraphPool>({
      subgraphUrl,
      sourceLabel: "Uni V3 subgraph",
      chain,
      buildQuery: () => UNIV3_POOL_QUERY,
      signal: combinedSignal,
```

Replace the `signal,` line in the `fetchSubgraphEntities` call with `signal: combinedSignal,`.

- [ ] **Step 3: Add per-chain timeout to fetchAerodromeData**

Apply the same pattern in `fetchAerodromeData()`. Find the `for` loop over `AERODROME_SUBGRAPHS` entries and add:

```typescript
    const perChainTimeout = AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, perChainTimeout])
      : perChainTimeout;
```

Then pass `signal: combinedSignal` instead of `signal` to `fetchSubgraphEntities`.

- [ ] **Step 4: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/constants.ts worker/src/cron/dex-liquidity/fetch-primary.ts
git commit -m "feat(H2): add 15s per-chain subgraph timeouts"
```

---

## Chunk 2: Scoring & Discovery Hardening

### Task 5: Add DEX price confidence weighting

**Files:**
- Modify: `worker/src/cron/dex-liquidity/constants.ts`
- Modify: `worker/src/cron/dex-liquidity/scoring.ts:487-499`

- [ ] **Step 1: Add confidence function to constants.ts**

At the end of `worker/src/cron/dex-liquidity/constants.ts`, add:

```typescript

/**
 * Confidence weight for DEX price observations by protocol.
 * Scales TVL weight in the TVL-weighted median to down-weight
 * less reliable sources.
 */
export function dexPriceConfidenceForProtocol(protocol: string): number {
  if (protocol === "curve" || protocol === "uniswap-v3" || protocol === "aerodrome") return 1.0;
  if (
    protocol.startsWith("staged-cg_onchain") ||
    protocol.startsWith("geckoterminal") ||
    protocol.startsWith("coingecko")
  ) return 0.85;
  if (
    protocol.startsWith("dexscreener") ||
    protocol.startsWith("cg-ticker") ||
    protocol.startsWith("staged-dexscreener") ||
    protocol.startsWith("staged-cg_tickers")
  ) return 0.55;
  return 0.3;
}
```

- [ ] **Step 2: Apply confidence weighting in computeDexPrices**

In `worker/src/cron/dex-liquidity/scoring.ts`, add import for `dexPriceConfidenceForProtocol` from `"./constants"`.

Then in `computeDexPrices()`, after `if (observations.length === 0) continue;` (line 484) and before the sort (line 488), add:

```typescript
    // H1: Scale TVL weights by source confidence before computing median
    const adjustedObs = observations.map((o) => ({
      ...o,
      tvl: o.tvl * dexPriceConfidenceForProtocol(o.protocol),
    }));
```

Then change the median computation to use `adjustedObs`:

```typescript
    // TVL-weighted median: sort by price, walk until cumulative TVL crosses 50%
    adjustedObs.sort((a, b) => a.price - b.price);
    const totalTvl = adjustedObs.reduce((s, o) => s + o.tvl, 0);
    const halfTvl = totalTvl / 2;
    let cumTvl = 0;
    let medianPrice = adjustedObs[0].price;
    for (const obs of adjustedObs) {
      cumTvl += obs.tvl;
      if (cumTvl >= halfTvl) {
        medianPrice = obs.price;
        break;
      }
    }
```

The `topSources` extraction (line 509) continues to use the raw `observations` (not `adjustedObs`) so the API shows actual TVL:

```typescript
    // Top 5 sources by TVL for transparency (spread to avoid mutating price-sorted array)
    const topSources = [...observations]
      .sort((a, b) => b.tvl - a.tvl)
      .slice(0, 5)
      .map((o) => ({ protocol: o.protocol, chain: o.chain, price: o.price, tvl: o.tvl }));
```

This line must remain using `observations`, not `adjustedObs`.

- [ ] **Step 3: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/dex-liquidity/constants.ts worker/src/cron/dex-liquidity/scoring.ts
git commit -m "feat(H1): confidence-weight DEX price median by source tier"
```

---

### Task 6: Clock skew clamp in stagedPoolConfidence

**Files:**
- Modify: `worker/src/cron/dex-discovery/types.ts:49`

- [ ] **Step 1: Add clamp**

In `worker/src/cron/dex-discovery/types.ts`, modify `stagedPoolConfidence()` (line 49):

```typescript
export function stagedPoolConfidence(ageHours: number): number {
  ageHours = Math.max(0, ageHours);
  if (ageHours > 24) return 0;
  return Math.max(0.5, 1 - ageHours / 48);
}
```

- [ ] **Step 2: Run existing tests**

```bash
npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
```

Expected: all existing tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/dex-discovery/types.ts
git commit -m "fix(M2): clamp negative age in stagedPoolConfidence for clock skew"
```

---

### Task 7: Chain resolution warnings in discovery crawl

**Files:**
- Modify: `worker/src/cron/dex-discovery/crawl-sources.ts:63-65`
- Modify: `worker/src/cron/dex-discovery/orchestrator.ts:216-273`

- [ ] **Step 1: Update CrawlResult type and collect unresolved chains**

In `worker/src/cron/dex-discovery/crawl-sources.ts`, update the `CrawlResult` interface (line 20) to include unresolved chains:

```typescript
export interface CrawlResult {
  pools: StagedPool[];
  priceObs: Array<{
    stablecoinId: string;
    price: number;
    tvl: number;
    chain: string;
    protocol: string;
  }>;
  unresolvedChains: string[];
}
```

In `crawlCoin()` after `const cgQueriedChains = new Set<string>();` (line 44), add:

```typescript
  const unresolvedChains: string[] = [];
```

In the CG onchain stage, where `if (!cgNetwork) continue;` appears (line 65), replace with:

```typescript
      if (!cgNetwork) {
        console.warn(`[dex-discovery] Chain "${chain}" not in CG registry for ${stablecoinId}, skipping`);
        unresolvedChains.push(chain);
        continue;
      }
```

At the end of `crawlCoin()`, return the `unresolvedChains` array alongside the existing return values. Find all `return { pools, priceObs };` statements and change them to `return { pools, priceObs, unresolvedChains };`. There are multiple early returns (e.g., line 61 for `timeExceeded()`) — all must include `unresolvedChains`.

- [ ] **Step 2: Aggregate unresolved chains + per-source pool counts in orchestrator**

In `worker/src/cron/dex-discovery/orchestrator.ts`, declare the new aggregation variables **before** the `try` block (after `const failedCoinErrors: Record<string, string> = {};` at line 137 and before `try {` at line 140), so they remain in scope for both the success and error return paths:

```typescript
  const allUnresolvedChains = new Set<string>();
  const poolsBySource: Record<string, number> = {};
```

In the crawl loop, after `poolsDiscovered += result.pools.length;` (line 225), add:

```typescript
        for (const chain of result.unresolvedChains) {
          allUnresolvedChains.add(chain);
        }
        for (const pool of result.pools) {
          poolsBySource[pool.source] = (poolsBySource[pool.source] ?? 0) + 1;
        }
```

In the return metadata JSON (line 264), add the new fields:

```typescript
      metadata: JSON.stringify({
        coinsCrawled,
        poolsDiscovered,
        tierBreakdown,
        budgetExhausted,
        runSeq,
        failedCoins,
        failedCoinErrors: Object.keys(failedCoinErrors).length > 0 ? failedCoinErrors : undefined,
        unresolvedChains: allUnresolvedChains.size > 0 ? [...allUnresolvedChains] : undefined,
        poolsBySource: Object.keys(poolsBySource).length > 0 ? poolsBySource : undefined,
      }),
```

Also add the same fields to the error return metadata block (around line 280).

- [ ] **Step 3: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/dex-discovery/crawl-sources.ts worker/src/cron/dex-discovery/orchestrator.ts
git commit -m "feat(H3,M4): chain resolution warnings + per-source pool count metrics"
```

---

### Task 8: Orderbook fingerprint dedup documentation comment

**Files:**
- Modify: `worker/src/cron/dex-liquidity/staging-merge.ts:213`

- [ ] **Step 1: Add comment**

In `worker/src/cron/dex-liquidity/staging-merge.ts`, add a comment above the dedup check block (before line 213):

```typescript
    // Dedup check — skip pool metrics merge for known pools.
    // Note: Orderbook pools (poolId starting with "orderbook:") naturally skip
    // fingerprint dedup because they lack token addresses (fingerprint returns null
    // from buildPoolFingerprint when normalized.length < 2). They are only deduped
    // by exact poolId match.
    const addressKnown = knownPoolAddrs.has(stagedPool.poolId);
```

Replace the existing comment `// Dedup check — skip pool metrics merge for known pools` (line 213) with the expanded version.

- [ ] **Step 2: Commit**

```bash
git add worker/src/cron/dex-liquidity/staging-merge.ts
git commit -m "docs(H4): document orderbook pool fingerprint dedup behavior"
```

---

## Chunk 3: Schema, Frontend & API Fixes

### Task 9: Tighten Zod schema bounds

**Files:**
- Modify: `shared/types/market.ts:200-217`

- [ ] **Step 1: Add min/max bounds to Zod schemas**

In `shared/types/market.ts`, replace the following fields in `DexLiquidityDataSchema` (around lines 200-217):

```typescript
  liquidityScore: z.number().min(0).max(100).nullable(),
```
(was `z.number().nullable()`)

```typescript
  concentrationHhi: z.number().min(0).max(1).nullable(),
```
(was `z.number().nullable()`)

```typescript
  avgPoolStress: z.number().min(0).max(100).nullable(),
```
(was `z.number().nullable()`)

```typescript
  durabilityScore: z.number().min(0).max(100).nullable(),
```
(was `z.number().nullable()`)

```typescript
  coverageConfidence: z.number().min(0).max(1),
```
(was `z.number()`)

- [ ] **Step 2: Full build + type-check**

```bash
npm run build
```

Expected: success (the scoring pipeline already clamps these ranges)

- [ ] **Step 3: Commit**

```bash
git add shared/types/market.ts
git commit -m "feat(H5): tighten Zod bounds on liquidity score fields"
```

---

### Task 10: DexLiquidityCard error boundary

**Files:**
- Modify: `src/app/stablecoin/[id]/client.tsx:1-3,208-210`

- [ ] **Step 1: Add import and wrap DexLiquidityCard**

In `src/app/stablecoin/[id]/client.tsx`, add the import after the existing imports (around line 12):

```typescript
import { SectionErrorBoundary } from "@/components/section-error-boundary";
```

Then wrap the DexLiquidityCard (lines 208-210):

```tsx
      <section id="liquidity">
        <SectionErrorBoundary name="liquidity">
          <DexLiquidityCard stablecoinId={viewModel.id} />
        </SectionErrorBoundary>
      </section>
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: success

- [ ] **Step 3: Commit**

```bash
git add src/app/stablecoin/[id]/client.tsx
git commit -m "feat(H6): wrap DexLiquidityCard with SectionErrorBoundary"
```

---

### Task 11: DEX_GLOBAL_KEY guard + aria-label

**Files:**
- Modify: `src/app/liquidity/client.tsx:173,182`
- Modify: `src/components/liquidity-stats.tsx:62,125`

- [ ] **Step 1: Add global key guard in client.tsx**

In `src/app/liquidity/client.tsx`, find the section that renders the stats and leaderboard (around line 173):

```tsx
      {summaryStats && liquidityMap && (
        <LiquidityStats stats={summaryStats} liquidityMap={liquidityMap} />
      )}
```

This is already guarded by `liquidityMap` being truthy. The `DEX_GLOBAL_KEY` guard needs to be in `liquidity-stats.tsx` where the aggregate bars are rendered.

- [ ] **Step 2: Add aria-label to ToggleGroup**

In `src/app/liquidity/client.tsx`, find the `<ToggleGroup>` element (line 182) and add the aria-label:

```tsx
            <ToggleGroup
              type="single"
              value={pegFilter}
              onValueChange={(v) => v && setPegFilter(v as PegCurrency | "all")}
              className="flex gap-1"
              aria-label="Filter by peg currency"
            >
```

- [ ] **Step 3: Add early-return guards in liquidity-stats.tsx**

In `src/components/liquidity-stats.tsx`, update `ChainAggregateBar` (line 62):

```typescript
function ChainAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const chainTotals = useMemo(() => {
    const totals: Record<string, number> = globalData?.chainTvl ? { ...globalData.chainTvl } : {};
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [globalData]);
```

Change from using `data` in the useMemo dependency to `globalData`. Extract `globalData` before the `useMemo` call. The current code already accesses `data[DEX_GLOBAL_KEY]` inside useMemo — refactor to extract it outside so the dependency is cleaner.

Similarly in `ProtocolAggregateBar` (line 125):

```typescript
function ProtocolAggregateBar({ data }: { data: Record<string, DexLiquidityData> }) {
  const globalData = data[DEX_GLOBAL_KEY];
  const { displayEntries, colorMap, total } = useMemo(() => {
    return buildProtocolBreakdown(globalData?.protocolTvl ?? {});
  }, [globalData]);
```

Both components already return `null` when `total === 0`, which handles the missing global data case gracefully.

- [ ] **Step 4: Verify build**

```bash
npm run build
```

Expected: success

- [ ] **Step 5: Commit**

```bash
git add src/app/liquidity/client.tsx src/components/liquidity-stats.tsx
git commit -m "feat(M8,M9): guard DEX_GLOBAL_KEY access + add aria-label to peg filter"
```

---

### Task 12: normalizeTopPools source fix + metadata parse log

**Files:**
- Modify: `worker/src/api/dex-liquidity.ts:90-98,146`

- [ ] **Step 1: Fix normalizeTopPools**

In `worker/src/api/dex-liquidity.ts`, replace the `normalizeTopPools` function (lines 90-98):

```typescript
function normalizeTopPools(json: string | null): DexLiquidityPoolResponse[] {
  const parsed = safeParse<DexLiquidityPoolResponse[]>(json, []);
  return parsed.map((pool) => {
    const normalizedSource = normalizePoolSource(pool.source);
    if (normalizedSource != null) {
      return { ...pool, source: normalizedSource };
    }
    console.info("[dex-liquidity] Unknown pool source:", pool.source);
    const { source: _, ...rest } = pool;
    return rest as DexLiquidityPoolResponse;
  });
}
```

- [ ] **Step 2: Add metadata parse failure logging**

In the `buildDexLiquidityWarning` function, find the empty catch block (line 146):

```typescript
    } catch {
      // Ignore malformed metadata and fall back to generic warning text.
    }
```

Replace with:

```typescript
    } catch (err) {
      console.info("[dex-liquidity] Malformed cron metadata:", err instanceof Error ? err.message : String(err));
    }
```

- [ ] **Step 3: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 4: Commit**

```bash
git add worker/src/api/dex-liquidity.ts
git commit -m "fix(M6,L6): clean normalizeTopPools source handling + log metadata parse failures"
```

---

### Task 13: Liquidity staleness check in consumers

**Files:**
- Modify: `worker/src/lib/report-cards-snapshot.ts:65-69`
- Modify: `worker/src/cron/sync-redemption-backstops.ts:36-37`

- [ ] **Step 1: Add staleness check in report-cards-snapshot**

In `worker/src/lib/report-cards-snapshot.ts`, after the `Promise.all` block (line 65-70) that loads `dexLiqMap`, add a staleness check:

```typescript
  const [stablecoinsCached, bluechipCached, dexLiqMap, redemptionBackstopMap] = await Promise.all([
    loadStablecoinsCache(db, { mode: "strict", allowLegacyArray: false }),
    getCache(db, "bluechip-ratings"),
    loadDexLiquidityMap(db),
    loadRedemptionBackstopMap(db),
  ]);

  // M10: Check liquidity data staleness (separate query — loadDexLiquidityMap doesn't include updated_at)
  let liquidityStale = false;
  try {
    const staleness = await db.prepare("SELECT MAX(updated_at) as max_ts FROM dex_liquidity").first<{ max_ts: number | null }>();
    const maxTs = staleness?.max_ts;
    if (maxTs != null) {
      const ageSec = Math.floor(Date.now() / 1000) - maxTs;
      if (ageSec > 3600) {
        console.warn(`[report-cards] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } catch {
    // Non-blocking — staleness check is observability only
  }
```

Then include `liquidityStale` in the `ReportCardsSnapshot` interface and return. In `worker/src/lib/report-cards-snapshot.ts`, add `liquidityStale: boolean` to the `ReportCardsSnapshot` interface (after the `updatedAt: number;` field):

```typescript
export interface ReportCardsSnapshot {
  cards: ReportCard[];
  methodology: { /* existing fields */ };
  dependencyGraph: { edges: { from: string; to: string }[] };
  updatedAt: number;
  liquidityStale: boolean;
}
```

Then include `liquidityStale` in the return object of `buildReportCardsSnapshot`. The `handleReportCards` API handler serializes the entire snapshot — the new field will appear in the response metadata automatically.

- [ ] **Step 2: Add staleness check in sync-redemption-backstops**

In `worker/src/cron/sync-redemption-backstops.ts`, after `const dexLiquidityMap = await loadDexLiquidityMap(db);` (line 36), add:

```typescript
  // M10: Check liquidity data staleness
  let liquidityStale = false;
  try {
    const staleness = await db.prepare("SELECT MAX(updated_at) as max_ts FROM dex_liquidity").first<{ max_ts: number | null }>();
    const maxTs = staleness?.max_ts;
    if (maxTs != null) {
      const ageSec = now - maxTs;
      if (ageSec > 3600) {
        console.warn(`[sync-redemption-backstops] Liquidity data is stale (age: ${ageSec}s)`);
        liquidityStale = true;
      }
    }
  } catch {
    // Non-blocking
  }
```

Then include `liquidityStale` in the cron result metadata. In the return statement (line 96-109), add `liquidityStale` to the JSON.stringify object:

```typescript
    metadata: JSON.stringify({
      synced: snapshots.length,
      failed: failedIds.length,
      configured: configuredIds.length,
      dynamic: dynamicCount,
      estimated: estimatedCount,
      static: staticCount,
      liquidityStale,
      ...(failedIds.length > 0 ? { failedIds } : {}),
      ...(missingFromCache.length > 0 ? { missingFromCache } : {}),
    }),
```

- [ ] **Step 3: Verify worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 4: Commit**

```bash
git add worker/src/lib/report-cards-snapshot.ts worker/src/cron/sync-redemption-backstops.ts
git commit -m "feat(M10): add liquidity staleness checks in report-cards and redemption-backstops"
```

---

## Chunk 4: Documentation Comments & Docs Updates

### Task 14: Add documentation comments to codebase

**Files:**
- Modify: `worker/src/cron/dex-liquidity/orchestrator.ts`
- Modify: `worker/src/cron/dex-liquidity/scoring.ts`
- Modify: `worker/src/cron/dex-discovery/orchestrator.ts`
- Modify: `worker/src/api/dex-liquidity.ts`

- [ ] **Step 1: M1 — Coverage guard bootstrap comment**

In `worker/src/cron/dex-liquidity/orchestrator.ts`, find the coverage guard section. Look for the check that compares current coverage count to previous coverage. Add a comment above it:

```typescript
  // M1: First-run bootstrap — when previousCoverage is 0, the minimum threshold
  // is max(1, floor(0 * 0.6)) = 1, so the guard permits any result with at
  // least 1 scored coin. This avoids false alarms on initial deployment.
```

- [ ] **Step 2: M3 — Protocol TVL cap comment**

In `worker/src/cron/dex-liquidity/scoring.ts`, find the global protocol TVL cap block (around line 388). Add a comment above it:

```typescript
  // M3: Global protocol-level TVL cap: when reducing excess, chain TVLs are
  // distributed proportionally rather than attributed to the chain with the
  // most excess. This is a trade-off — exact chain attribution would require
  // per-pool chain data which is not available in the global aggregate.
```

- [ ] **Step 3: M5 — Discovery deadline comment**

In `worker/src/cron/dex-discovery/orchestrator.ts`, find the deadline constant (line 177: `const deadlineMs = Date.now() + 13 * 60_000;`). Add a comment above:

```typescript
    // M5: Deadline is checked at coin boundaries only (not mid-crawl), which is
    // acceptable with a 13-min budget — individual coin crawls take 5-30s, so
    // overshoot is bounded. Mid-crawl checks would add complexity for negligible
    // benefit and risk leaving a coin in a partial-crawl state.
    const deadlineMs = Date.now() + 13 * 60_000;
```

- [ ] **Step 4: M7 — Trend baseline tolerance comment**

In `worker/src/api/dex-liquidity.ts`, find the `selectTrendBaseline` function (around line 100). Add a comment near the tolerance parameter:

```typescript
// M7: Wide tolerance windows (24h for 24h baseline, 48h for 7d baseline) handle
// missed cron runs gracefully. The dex-liquidity cron runs every 30 min, but if
// several runs are missed, we still find a usable baseline within the tolerance.
```

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/dex-liquidity/orchestrator.ts worker/src/cron/dex-liquidity/scoring.ts worker/src/cron/dex-discovery/orchestrator.ts worker/src/api/dex-liquidity.ts
git commit -m "docs(M1,M3,M5,M7): add design rationale comments to coverage guard, TVL cap, deadline, and trend tolerance"
```

---

### Task 15: Update docs/dex-liquidity.md with score formulas

**Files:**
- Modify: `docs/dex-liquidity.md`

- [ ] **Step 1: Read current doc**

Read `docs/dex-liquidity.md` to find where score formulas are documented.

- [ ] **Step 2: Add formula documentation**

Add or update the score formulas section with:

```markdown
### Pool Quality Component

`poolQuality = (qualityAdjustedTvl / effectiveTvl) × 100`

### Durability Score

Sub-component weights:
- **35%** TVL stability (coefficient of variation over 7d snapshots)
- **25%** Volume consistency (coefficient of variation over 7d snapshots)
- **25%** Maturity (oldest pool age, capped at 365 days)
- **15%** Organic fraction (`sqrt(organicFraction)` curve — diminishing returns past 50%)

The organic fraction uses a sqrt curve: `organicComponent = sqrt(organicFraction) × 100`.
This means 25% organic → 50 score, 50% organic → 71 score, 100% organic → 100 score.
```

- [ ] **Step 3: Commit**

```bash
git add docs/dex-liquidity.md
git commit -m "docs(L2): document poolQuality formula and durability sub-component weights"
```

---

### Task 16: Update docs/data-pipeline.md with circuit breaker

**Files:**
- Modify: `docs/data-pipeline.md`

- [ ] **Step 1: Read current doc and add circuit breaker entry**

Find the circuit breaker source list in `docs/data-pipeline.md` and add `curve-liquidity-api` to the list.

- [ ] **Step 2: Commit**

```bash
git add docs/data-pipeline.md
git commit -m "docs(C1): add curve-liquidity-api to circuit breaker source list"
```

---

## Chunk 5: Tests

### Task 17: fetch-primary.ts circuit breaker tests

**Files:**
- Create: `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURVE_CHAINS } from "../constants";

// Mock circuit breaker module
vi.mock("../../../lib/circuit-breaker", () => ({
  shouldAttemptFetch: vi.fn(async () => true),
  recordOutcome: vi.fn(async () => {}),
}));

// Mock fetch-retry
vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(async () => new Response("{}", { status: 200 })),
}));

// Mock db-cache
vi.mock("../../../lib/db-cache", () => ({
  setCache: vi.fn(async () => {}),
  getCache: vi.fn(async () => null),
}));

// Mock yield cache builder
vi.mock("../../yield-sync/cache", () => ({
  buildDlStablecoinPoolsCache: vi.fn(() => ({})),
}));

// Mock CG onchain
vi.mock("../../../lib/coingecko-onchain", () => ({
  fetchCgTokensBatch: vi.fn(async () => []),
  onchainRateLimit: vi.fn(async () => {}),
  CG_CHAIN_MAP: {},
}));

import { shouldAttemptFetch, recordOutcome } from "../../../lib/circuit-breaker";
import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchDataSources } from "../fetch-primary";

function createMockDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({ success: true, meta: {} }),
      }),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} }),
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function mockDlYieldsSuccess() {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("yields.llama.fi")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (urlStr.includes("api.llama.fi/protocols")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (urlStr.includes("api.curve.finance")) {
      return new Response(JSON.stringify({ data: { poolData: [] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

function mockDlYieldsFail() {
  vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (urlStr.includes("yields.llama.fi")) {
      return new Response("error", { status: 500 });
    }
    if (urlStr.includes("api.llama.fi/protocols")) {
      return new Response("error", { status: 500 });
    }
    if (urlStr.includes("api.curve.finance")) {
      return new Response(JSON.stringify({ data: { poolData: [] } }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("fetchDataSources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
    mockDlYieldsSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips Curve when circuit breaker is open", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    // Curve calls should not have been made
    const curveCalls = vi.mocked(fetchWithRetry).mock.calls.filter(
      (call) => String(call[0]).includes("api.curve.finance"),
    );
    expect(curveCalls).toHaveLength(0);
  });

  it("records success when at least 1 Curve chain succeeds", async () => {
    mockDlYieldsSuccess();
    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      true,
    );
  });

  it("records failure when all Curve chains fail", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull(); // DL is still up
    expect(vi.mocked(recordOutcome)).toHaveBeenCalledWith(
      expect.anything(),
      "curve-liquidity-api",
      false,
    );
  });

  it("returns DL-only data when Curve fails", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("yields.llama.fi")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      if (urlStr.includes("api.llama.fi/protocols")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (urlStr.includes("api.curve.finance")) {
        return new Response("error", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });

  it("returns null when both DL and Curve fail (catastrophic)", async () => {
    vi.mocked(fetchWithRetry).mockImplementation(async () => {
      return new Response("error", { status: 500 });
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).toBeNull();
  });

  it("returns DL-only data when circuit breaker is open and DL succeeds", async () => {
    vi.mocked(shouldAttemptFetch).mockImplementation(async (_db, source) => {
      if (source === "curve-liquidity-api") return false;
      return true;
    });

    const result = await fetchDataSources(null, createMockDb());
    expect(result).not.toBeNull();
    expect(result!.dlYieldsAvailable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the new tests**

```bash
npm test -- --run worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts
git commit -m "test(C2): add fetch-primary circuit breaker tests"
```

---

### Task 18: Extend staging-merge tests

**Files:**
- Modify: `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`

- [ ] **Step 1: Add clock skew test to stagedPoolConfidence**

In the existing `describe("stagedPoolConfidence")` block, add:

```typescript
  it("clamps negative age to 0 (clock skew protection)", () => {
    expect(stagedPoolConfidence(-5)).toBe(1);
  });
```

- [ ] **Step 2: Add orderbook fingerprint test**

In the existing `describe("mergeStagedPools")` block, add:

```typescript
  it("orderbook pools skip fingerprint dedup (null tokens)", async () => {
    const now = 1710000000;
    const mockDb = createMockDb([{
      pool_id: "orderbook:binance:usdt-tether",
      stablecoin_id: "usdt-tether",
      source: "cg_tickers",
      chain: "cex",
      protocol: "cg-ticker-binance",
      symbol: "USDT/USD",
      tvl_usd: 500000,
      volume_24h: 1000000,
      fee_tier: null,
      balance_ratio: null,
      is_stable: 0,
      base_token: null,
      quote_token: null,
      quote_symbol: "USD",
      price_usd: 1.0001,
      locked_liq_pct: null,
      discovered_at: now - 86400 * 5,
      refreshed_at: now,
    }]);
    const metrics = new Map();
    // Fingerprint for this pool would be null (no tokens), so it should NOT be
    // skipped by fingerprint dedup — only exact poolId match matters
    const knownPoolAddrs = new Set<string>();

    const result = await mergeStagedPools(mockDb, metrics as never, knownPoolAddrs, now);

    expect(result.mergedCount).toBe(1);
    expect(result.skippedByFingerprintCount).toBe(0);
  });
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
```

Expected: all tests pass (including new ones)

- [ ] **Step 4: Commit**

```bash
git add worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts
git commit -m "test(C2): add clock skew and orderbook fingerprint dedup tests"
```

---

### Task 19: Extend cascading failure tests

**Files:**
- Modify: `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

- [ ] **Step 1: Add DL+Curve catastrophic + DL down + Curve up tests**

In the existing `describe("syncDexLiquidity")` block, add (note: the existing test "throws on catastrophic source failure" covers the fetch layer; this tests the full orchestrator integration path):

```typescript
  it("throws catastrophic error when both DL and Curve fail (integration)", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce(null);
    await expect(syncDexLiquidity(db, "graph-key")).rejects.toThrow("catastrophic source failure");
  });

  it("returns degraded when DL fails but Curve succeeds", async () => {
    vi.mocked(fetchDataSources).mockResolvedValueOnce({
      pools: [],
      dexProjects: new Set<string>(),
      protocolTvlCaps: new Map<string, number>(),
      curveResponses: [new Response("{}", { status: 200 })],
      graphApiKey: "graph-key",
      dlYieldsAvailable: false,
      dlProtocolsAvailable: false,
    });

    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
    };
    expect(metadata.failedSources).toContain("defillama-yields");
  });
```

- [ ] **Step 2: Add all-secondary-sources-fail test (spec 6c item 3)**

The existing mock setup already mocks all secondary sources (UniV3, Aerodrome, staged, DexScreener, CG Tickers) to return empty results. The `fetchDataSources` mock returns `dlYieldsAvailable: true` with empty pools, so scoring runs on primary data only. The existing "returns ok when required source families succeed" test already validates this scenario. Add a variant that explicitly fails Aerodrome:

```typescript
  it("succeeds with failedSources when secondary sources fail", async () => {
    const { fetchAerodromeData } = await import("../dex-liquidity/fetch-primary");
    vi.mocked(fetchAerodromeData).mockRejectedValueOnce(new Error("subgraph timeout"));

    const result = await syncDexLiquidity(db, "graph-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      failedSources?: string[];
    };
    expect(metadata.failedSources).toContain("aerodrome-subgraph");
  });
```

- [ ] **Step 3: Add coverage guard test (spec 6c item 4)**

This test verifies that a hard coverage drop triggers the guard. The coverage guard in the orchestrator compares current scored coins against previous coverage. To test this, mock `computeStablecoinScores` to return very few results compared to what `persistScores` would expect:

```typescript
  it("throws when coverage guard detects catastrophic drop", async () => {
    const { computeStablecoinScores } = await import("../dex-liquidity/scoring");
    // Mock scoring to return only 2 coins, but persistScores checks against previous count
    vi.mocked(computeStablecoinScores).mockResolvedValueOnce({
      scores: new Map([["usdt-tether", {}], ["usdc-circle", {}]]) as never,
      globalAgg: {} as never,
    });

    // Mock the DB to return a previous coverage count of 20
    const mockDbWithCoverage = {
      ...db,
      prepare: (sql: string) => {
        if (sql.includes("COUNT(*)") && sql.includes("dex_liquidity")) {
          return {
            bind: () => ({
              first: async () => ({ cnt: 20 }),
            }),
            first: async () => ({ cnt: 20 }),
            all: async () => ({ results: [{ cnt: 20 }] }),
            run: async () => ({ success: true, meta: {} }),
          };
        }
        return db.prepare(sql);
      },
    } as unknown as D1Database;

    await expect(syncDexLiquidity(mockDbWithCoverage, "graph-key")).rejects.toThrow(/coverage/i);
  });
```

Note: If the coverage guard implementation doesn't use `COUNT(*)` directly or the mock structure needs adjustment, adapt the mock to match the actual guard query. The key assertion is that the function rejects when scored count drops far below previous coverage.

- [ ] **Step 4: Run tests**

```bash
npm test -- --run worker/src/cron/__tests__/sync-dex-liquidity.test.ts
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add worker/src/cron/__tests__/sync-dex-liquidity.test.ts
git commit -m "test(C2): add cascading failure and coverage guard tests"
```

---

## Chunk 6: Final Validation & Push

### Task 20: Full validation

- [ ] **Step 1: Full build + type-check**

```bash
npm run build
```

Expected: success

- [ ] **Step 2: Worker type-check**

```bash
cd worker && npx tsc --noEmit
```

Expected: success

- [ ] **Step 3: All tests**

```bash
npm test
```

Expected: all pass

- [ ] **Step 4: Lint**

```bash
npm run lint
```

Expected: no errors

- [ ] **Step 5: Commit any fixups and push**

```bash
git push -u origin fix/liquidity-audit-remediation
```
