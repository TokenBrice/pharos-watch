# Liquidity Audit Remediation — Implementation Spec

**Date:** 2026-03-14
**Branch:** `fix/liquidity-audit-remediation`
**Source:** `agents/research/2026-03-14-liquidity-feature-audit.md`
**Strategy:** Single feature branch, all changes, one PR

---

## Section 1: Circuit Breakers & Timeout Hardening (C1, H2)

### 1a. Curve Liquidity API Circuit Breaker

**Files:** `worker/src/lib/constants.ts`, `worker/src/cron/dex-liquidity/fetch-primary.ts`

**Note:** `CIRCUIT_SOURCE.CURVE_ONCHAIN` ("curve-onchain") already exists and protects the Curve on-chain *price* fetches in `enrich-prices.ts` (the pricing consensus pipeline). The new breaker is for the liquidity pipeline's Curve *pool data* fetch — a separate integration with different endpoints and failure modes. Named `CURVE_LIQUIDITY_API` to make the distinction explicit.

**Changes:**
1. Add `CURVE_LIQUIDITY_API: "curve-liquidity-api"` to `CIRCUIT_SOURCE` in `constants.ts`
2. In `fetch-primary.ts`, wrap the 4-chain Curve fetch block:
   - Before the `Promise.all(CURVE_CHAINS.map(...))`, call `shouldAttemptFetch(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API)`
   - If circuit is open, skip Curve entirely — set `curveResponses = CURVE_CHAINS.map(() => null)` so the existing catastrophic-failure check (`curveResponses.every(r => !r?.ok)`) evaluates correctly per-entry rather than vacuously on an empty array
   - After the fetch completes (or fails), call `recordOutcome(db, CIRCUIT_SOURCE.CURVE_LIQUIDITY_API, success)`
   - Success = at least 1 chain returned valid data
3. Add `"curve-liquidity-api"` to the circuit breaker source list in `docs/data-pipeline.md`
4. Subgraph endpoints (UniV3, Aerodrome) do NOT get circuit breakers — the per-chain timeouts in Section 1b are sufficient since these sources are already non-fatal (wrapped in try/catch). Adding breakers for each chain × subgraph combination would be over-engineering.

### 1b. Subgraph Per-Source Timeouts

**Files:** `worker/src/cron/dex-liquidity/fetch-primary.ts`, `worker/src/cron/dex-liquidity/constants.ts`

**Changes:**
1. Add `SUBGRAPH_PER_CHAIN_TIMEOUT_MS = 15_000` constant in `worker/src/cron/dex-liquidity/constants.ts`
2. For `fetchUniV3Data()`: create a per-chain `AbortSignal.timeout(SUBGRAPH_PER_CHAIN_TIMEOUT_MS)` combined with the parent `signal` via `AbortSignal.any([signal, perChainTimeout])`
3. For `fetchAerodromeData()`: same pattern, 15s timeout
4. These functions are already wrapped in non-fatal try/catch — the timeout just ensures they don't hang indefinitely

---

## Section 2: DEX Price Median Confidence Weighting (H1)

**Files:** `worker/src/cron/dex-liquidity/scoring.ts`, `worker/src/cron/dex-liquidity/constants.ts`

**Context:** `DexPriceObs` (defined in `types.ts:125`) has fields: `price`, `tvl`, `chain`, `protocol`. There is no `source` field. The `protocol` field contains values like `"curve"`, `"uniswap-v3"`, `"aerodrome"`, `"geckoterminal-aggregate"`, `"coingecko-aggregate"`, `"dexscreener-{dexId}"`, `"cg-ticker-{exchangeId}"`, `"staged-{source}-{dexId}"`.

**Changes:**
1. Add a `dexPriceConfidenceForProtocol(protocol: string): number` function in `constants.ts` that uses prefix matching on the `protocol` field:
   - `protocol === "curve"` or `protocol === "uniswap-v3"` or `protocol === "aerodrome"` → `1.0` (primary on-chain)
   - `protocol.startsWith("staged-cg_onchain")` or `protocol.startsWith("geckoterminal")` or `protocol.startsWith("coingecko")` → `0.85` (staged discovery)
   - `protocol.startsWith("dexscreener")` or `protocol.startsWith("cg-ticker")` or `protocol.startsWith("staged-dexscreener")` or `protocol.startsWith("staged-cg_tickers")` → `0.55` (fallback)
   - Default → `0.3` (unknown source, conservative)
2. In `computeDexPrices()` in `scoring.ts`, before computing the TVL-weighted median (line 488), scale each observation's TVL:
   ```
   const adjustedObs = observations.map(o => ({
     ...o,
     tvl: o.tvl * dexPriceConfidenceForProtocol(o.protocol),
   }));
   ```
   Then use `adjustedObs` for the median computation instead of raw `observations`.
3. The median algorithm itself is unchanged; only the input TVL weights are scaled.
4. The `topSources` display (line 509) continues to use the raw `observations` (not adjusted) so the API shows actual TVL, not adjusted TVL.

---

## Section 3: Discovery Cron Hardening (H3, H4, M4)

### 3a. Chain Resolution Warnings (H3)

**Files:** `worker/src/cron/dex-discovery/crawl-sources.ts`, `worker/src/cron/dex-discovery/orchestrator.ts`

**Changes:**
1. In `crawlCoin()` in `crawl-sources.ts`, when building targets per chain, if a chain is not resolved in any provider map (`CG_CHAIN_MAP`, `GT_CHAIN_MAP`, `CHAIN_REGISTRY`), log:
   `console.warn("[dex-discovery] Chain \"X\" not in registry for Y, skipping")`
2. Collect unresolved chains per coin and return them alongside pools/priceObs
3. In `orchestrator.ts`, aggregate unresolved chains across all coins into cron metadata under `unresolvedChains: string[]` (deduplicated)

### 3b. Orderbook Pool ID & Fingerprint Dedup (H4)

**Files:** `worker/src/cron/dex-liquidity/staging-merge.ts`

**Context:** The current orderbook pool ID format `orderbook:${exchangeId}:${stablecoinId}` is actually correct for the discovery pipeline — it preserves per-coin uniqueness within the `knownPoolIds` set shared across coins during a crawl run. Changing it to `orderbook:${exchangeId}` would cause the second stablecoin crawled to skip a shared exchange entirely (since `knownPoolIds` is shared across coins).

The actual issue (H4) is about fingerprint dedup in the scoring cron's staged-pool merge. Verification shows that `buildPoolFingerprint()` in `pool-helpers.ts:181` already returns `null` when token addresses are empty (line 191: `if (normalized.length < 2) return null`). Since orderbook pools have `baseToken = null` and `quoteToken = null`, their fingerprint is `null`, so they naturally skip fingerprint dedup and are only deduped by exact `poolId` match.

**Changes:**
1. **No pool ID format change** — current format is correct
2. Add a code comment in `staging-merge.ts` at the dedup check block (around line 213) documenting that orderbook pools (`poolId` starting with `orderbook:`) naturally skip fingerprint dedup because they lack token addresses (fingerprint returns `null`), and are deduped by exact `poolId` match only

### 3c. Per-Source Pool Count Metrics (M4)

**Files:** `worker/src/cron/dex-discovery/orchestrator.ts`

**Changes:**
1. In `orchestrator.ts`, track `poolsBySource: Record<string, number>` accumulating pool counts keyed by source (`cg_onchain`, `gecko_terminal`, `dexscreener`, `cg_tickers`)
2. Include `poolsBySource` in the cron result metadata JSON
3. The `crawlCoin()` return already includes pools with `source` field — just count them per source after each coin's crawl

---

## Section 4: Schema Validation & Frontend Robustness (H5, H6, M8, M9)

### 4a. Zod Bounds (H5)

**Files:** `shared/types/market.ts`

**Changes:**
1. Tighten Zod schemas:
   - `liquidityScore: z.number().min(0).max(100).nullable()`
   - `concentrationHhi: z.number().min(0).max(1).nullable()`
   - `durabilityScore: z.number().min(0).max(100).nullable()`
   - `avgPoolStress: z.number().min(0).max(100).nullable()`
   - `coverageConfidence: z.number().min(0).max(1)`
2. Verify these constraints don't conflict with existing data (the scoring pipeline already clamps these ranges via `Math.min`/`Math.max`)

### 4b. DexLiquidityCard Error Boundary (H6)

**Files:** `src/app/stablecoin/[id]/client.tsx`

**Context:** `DexLiquidityCard` is dynamically imported and rendered at line 208 in `src/app/stablecoin/[id]/client.tsx`. The existing `SectionErrorBoundary` component at `src/components/section-error-boundary.tsx` is already used in `homepage-client.tsx` and `depeg/client.tsx`.

**Changes:**
1. Import `SectionErrorBoundary` in `src/app/stablecoin/[id]/client.tsx`
2. Wrap the `<DexLiquidityCard>` at line 208 with `<SectionErrorBoundary name="liquidity">`:
   ```tsx
   <section id="liquidity">
     <SectionErrorBoundary name="liquidity">
       <DexLiquidityCard stablecoinId={viewModel.id} />
     </SectionErrorBoundary>
   </section>
   ```
3. The existing `SectionErrorBoundary` already renders a styled fallback — no custom fallback needed

### 4c. `DEX_GLOBAL_KEY` Guard (M8)

**Files:** `src/app/liquidity/client.tsx`, `src/components/liquidity-stats.tsx`

**Changes:**
1. In `client.tsx`, after accessing `liquidityMap[DEX_GLOBAL_KEY]`, add explicit guard. When missing, summary stats section shows a "Global liquidity data unavailable" info message
2. In `liquidity-stats.tsx`, guard `globalData` access in `ChainAggregateBar` and `ProtocolAggregateBar`. Return `null` when global data is missing.

### 4d. Aria-Label on Peg Filter (M9)

**Files:** `src/app/liquidity/client.tsx`

**Changes:**
1. Add `aria-label="Filter by peg currency"` to the `<ToggleGroup>` element

---

## Section 5: Medium & Low Fixes

### 5a. Clock Skew Clamp (M2)

**Files:** `worker/src/cron/dex-discovery/types.ts`

**Changes:**
1. In `stagedPoolConfidence()` at line 49, add `ageHours = Math.max(0, ageHours)` as the first line of the function body. This ensures negative ages (from clock skew where `refreshedAt` is in the future) are clamped to 0 rather than producing undefined confidence values. Protects all callers, not just `staging-merge.ts`.

### 5b. Documentation Comments (M1, M3, M5, M7)

**Files:** `worker/src/cron/dex-liquidity/orchestrator.ts`, `worker/src/cron/dex-liquidity/scoring.ts`, `worker/src/cron/dex-discovery/orchestrator.ts`, `worker/src/api/dex-liquidity.ts`

**Changes:**
1. M1: Add comment at coverage guard bootstrap explaining first-run allows empty results by design
2. M3: Add comment at protocol TVL cap reduction explaining proportional distribution trade-off
3. M5: Add comment at discovery deadline check explaining coin-boundary-only check is acceptable with 13-min budget
4. M7: Add comment at trend baseline tolerance constants explaining wide tolerance handles missed cron runs

### 5c. `normalizeTopPools()` Source Fix (M6)

**Files:** `worker/src/api/dex-liquidity.ts`

**Context:** The current code sets `source: undefined` which JSON.stringify omits — so the serialized JSON output is already correct. The fix is for type-level correctness and to add observability for unknown sources.

**Changes:**
1. When source normalization fails, omit the `source` key via destructuring: `const { source: _, ...rest } = pool; return rest;`
2. Add a `console.info("[dex-liquidity] Unknown pool source:", pool.source)` log so misconfigured sources can be diagnosed

### 5d. Liquidity Staleness Check in Consumers (M10)

**Files:** `worker/src/lib/report-cards-snapshot.ts`, `worker/src/cron/sync-redemption-backstops.ts`

**Note:** `loadDexLiquidityMap()` does not include `updated_at` in its query. Do NOT modify the shared helper's interface. Instead, issue a separate one-liner query in each consumer:
```ts
const { max_ts } = await db.prepare("SELECT MAX(updated_at) as max_ts FROM dex_liquidity").first<{ max_ts: number | null }>() ?? { max_ts: null };
```

**Changes:**
1. After loading `dexLiquidityMap`, query `max(updated_at)` via the separate query above
2. If older than 3600s (60 min, 2x cron interval), log warning:
   `console.warn("[report-cards] Liquidity data is stale (age: Xs)")`
3. Include `liquidityStale: boolean` in compute metadata (report cards already have metadata; redemption backstops add to cron metadata)
4. No score changes — observability only

### 5e. Score Formulas Documentation (L2)

**Files:** `docs/dex-liquidity.md`

**Changes:**
1. Add exact `poolQuality` component formula: `(qualityAdjustedTvl / effectiveTvl) x 100`
2. Document durability sub-component weights: 35% TVL stability, 25% volume consistency, 25% maturity, 15% organic fraction
3. Document the organic fraction sqrt curve

### 5f. `dex_prices` Index (L5)

**Files:** New migration file `worker/migrations/0068_dex_prices_index.sql`

**Changes:**
1. `CREATE INDEX IF NOT EXISTS idx_dex_prices_updated ON dex_prices(updated_at DESC);`

### 5g. Log Cron Metadata Parse Failures (L6)

**Files:** `worker/src/api/dex-liquidity.ts`

**Changes:**
1. In `buildDexLiquidityWarning()` catch block, add:
   `console.info("[dex-liquidity] Malformed cron metadata:", err instanceof Error ? err.message : String(err))`

---

## Section 6: Critical-Path Tests (C2)

### 6a. `fetch-primary.ts` Tests

**New file:** `worker/src/cron/dex-liquidity/__tests__/fetch-primary.test.ts`

**Test cases:**
1. Curve circuit breaker open → skips Curve, no Curve API calls made
2. Curve circuit breaker closed, all 4 chains succeed → records success outcome
3. Curve circuit breaker closed, all 4 chains fail → records failure outcome, returns empty Curve data
4. DL yields succeeds + Curve fails → returns DL-only data (non-null result)
5. DL yields fails + Curve fails → returns null (catastrophic)
6. Subgraph per-chain timeout: mock one chain hanging → other chains still return, failed source recorded
7. Circuit breaker open + DL yields succeeds → returns DL-only data (Curve skipped cleanly)

**Mocking strategy:** `vi.spyOn(globalThis, "fetch")` for HTTP calls, mock D1 via inline `createMockDb` pattern (existing in `staging-merge.test.ts:5` and `sync-dex-liquidity.test.ts:34`)

### 6b. `staging-merge.ts` Tests

**Extend existing file:** `worker/src/cron/dex-liquidity/__tests__/staging-merge.test.ts`

The existing file tests `stagedPoolConfidence` and `stagedPoolMaturityDays`. Add new test cases for the merge logic:

**New test cases:**
1. Empty staging table → returns empty merge result
2. Staged pool 0h old → confidence 1.0, full TVL applied
3. Staged pool 12h old → confidence 0.75, TVL scaled
4. Staged pool 24h old → confidence 0.5 (boundary)
5. Staged pool >24h old → excluded from merge
6. Clock skew: `refreshedAt` in future → clamped to confidence 1.0 (after M2 fix)
7. Fingerprint dedup: staged pool already in primary set → skipped (count in `stagedPoolsSkippedByFingerprint`)
8. Orderbook pool ID (`orderbook:binance:usdt-tether`) → fingerprint returns null (empty tokens), deduped by exact pool_id match only

### 6c. Cascading Failure Tests

**Extend:** `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`

**New test cases:**
1. DL down + Curve down → throws catastrophic error
2. DL down + Curve up → degraded status, Curve-only data persisted
3. All secondary sources (UniV3, Aero, staged, DS, CG Tickers) fail → primary-only scoring succeeds with `failedSources` in metadata
4. Coverage guard: mock previous coverage = 20, current = 5 → throws hard coverage guard

---

## Execution Order

1. Section 5f (migration) — must be applied first as it's a schema change
2. Section 1 (circuit breakers & timeouts) — foundational reliability
3. Section 2 (confidence weighting) — scoring correctness
4. Section 3 (discovery hardening) — discovery reliability
5. Section 4 (schema & frontend) — type safety and UX
6. Section 5 (remaining fixes) — cleanup
7. Section 6 (tests) — verification of all above

## Validation

- `npm run build` — full build + type-check
- `cd worker && npx tsc --noEmit` — worker type-check
- `npm test` — all tests pass including new ones
- `npm run lint` — no lint errors

## Not Changed (Documented as Intentional)

- **L1**: Orderbook quality multiplier 0.6x — documented, reasonable
- **L3**: `discovery_candidates` table — used by separate discovery-scan cron
- **L4**: `raw_json` field — reserved for debugging
- **L7**: Summary stats double-iteration — 156 items, negligible
- **L8**: `methodologyVersion` not in UI — not a reliability concern
- **M1**: Bootstrap guard — comment only (design section 5b)
- **M3**: Protocol TVL cap — comment only (design section 5b)
- **M5**: Deadline check — comment only (design section 5b)
