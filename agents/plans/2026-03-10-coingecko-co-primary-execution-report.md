# CoinGecko Co-Primary — Execution Report & Phase C Handover

## Execution Summary

**Branch:** `feat/coingecko-co-primary`
**Base:** `8e02b4d7` (main at start)
**Date:** 2026-03-10
**Scope:** Phases A (Discovery + Observability) and B (Shadow Mode) — 12 tasks across 3 chunks

### Final Verification

| Gate | Result |
|------|--------|
| Migration applies | ✅ `0059_discovery_candidates.sql` |
| Worker type-check | ✅ `cd worker && npx tsc --noEmit` |
| Frontend build | ✅ `npm run build` (234 pages) |
| Tests | ✅ 1437/1437 (150 files) |
| Lint | ✅ 0 errors (1 pre-existing warning) |

### Commits (discovery/observability only)

```
eaa70e53 feat(shadow): add shadow CG-primary comparison alongside existing pipeline
0ea0177a docs: add coverage discovery to pipeline, API, status, and infra docs
64f82cba feat(observability): store PriceSourceHealth in stablecoins cron metadata
f331c233 feat(status): add price source health card to admin status page
74509ed3 feat(status): add discovery candidates card to admin status page
d2b09e49 feat(status): include discovery candidates + price source health in status response
7fd18a4f fix(test): add discovery-candidates to admin probe paths snapshot
59aa7941 fix(test): add discovery-scan to status test cron mock
c0674b13 feat(discovery): add DL residuals discovery (Source A) in syncStablecoins
e35a8c70 feat(discovery): register discovery-scan on daily cron slot
d4808633 feat(discovery): add discovery-candidates API endpoints
f02b9575 feat(discovery): add discovery scan cron with CG category fetch
43079341 feat(discovery): add CG_DISCOVERY circuit source + discovery/observability types
c6ab27b6 feat(discovery): add discovery_candidates D1 migration
```

Note: The branch also contains 2 unrelated compare-feature commits (`2b184575`, `6e334ac5`) that were picked up during a subagent worktree incident. They'll merge cleanly since they're already on main.

---

## What Was Built

### Phase A — Discovery + Observability

#### D1 Schema

`worker/migrations/0059_discovery_candidates.sql` — new table:

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| gecko_id | TEXT | Partial unique index |
| llama_id | INTEGER | Partial unique index |
| name | TEXT NOT NULL | |
| symbol | TEXT NOT NULL | |
| market_cap | REAL | |
| source | TEXT NOT NULL | CHECK: defillama, coingecko, both |
| first_seen | INTEGER NOT NULL | Unix seconds |
| last_seen | INTEGER NOT NULL | Unix seconds |
| dismissed | INTEGER DEFAULT 0 | |
| dismissed_at | INTEGER | |
| dismissed_mcap | REAL | Mcap at time of dismissal |

Three partial unique indexes prevent duplicates while allowing NULLs.

#### Discovery Pipeline

**Source A — DL Residuals** (`worker/src/cron/sync-stablecoins.ts:449-468`)
- Runs inside `syncStablecoins()`, before the ID remapping loop
- Filters `llamaData.peggedAssets` against `REGISTRY_BY_LLAMA_ID`
- Upserts untracked assets with circulating > $5M
- Zero extra API calls — piggybacks on existing DL stablecoins fetch

**Source B — CG Category** (`worker/src/cron/discovery-scan.ts`)
- Daily cron (`discovery-scan`, `0 8 * * *`)
- `GET /coins/markets?category=stablecoins&vs_currency=usd&per_page=250`
- Own circuit breaker: `CG_DISCOVERY` (independent from `CG_PRICES`)
- Filters against `TRACKED_STABLECOINS` geckoIds, minimum $5M mcap

**Candidate lifecycle:**
- Source merging: if a coin appears in both DL and CG, source becomes `"both"`
- Undismiss: if mcap crosses 10× the dismissed_mcap value, candidate resurfaces
- Cleanup: dismissed candidates hard-deleted after 90 days

#### Discovery API

| Endpoint | Method | Auth | Response |
|----------|--------|------|----------|
| `/api/discovery-candidates` | GET | admin | `{ candidates: DiscoveryCandidate[], total }` |
| `/api/discovery-candidates/:id/dismiss` | POST | admin | `{ ok: true }` or 404 |

Query params: `status` (active/dismissed/all), `limit` (max 200), `offset`.

Registered in `ENDPOINT_DEFINITIONS` (probeGroup: admin) and `worker/src/router.ts`. Dynamic dismiss route validated via `DISCOVERY_DISMISS_PATH_PATTERN` in `getAllowedEndpointMethods()`.

#### Observability — PriceSourceHealth

**Computed in** `syncStablecoins()` (`worker/src/cron/sync-stablecoins.ts:733-766`) from:
- `dualPriceStats` → `sourceDistribution.["defillama+coingecko"]`, confidence tiers
- `enrichStats` → pass1/1b (contract), pass2 (cached), pass3 (CG direct), passCmc, pass4 (DEX)

**Stored in** cron metadata (JSON-serialized via `buildSyncMetadata()`).

**Surfaced in** `/api/status` by extracting from `raw.crons["sync-stablecoins"].lastRun.metadata.priceSourceHealth` — no extra DB query.

#### Frontend — Status Page Cards

**`DiscoveryCandidatesCard`** (`src/components/status/discovery-candidates.tsx`)
- Renders after Admin Actions section
- Shows symbol, name, source badge (CG/DL/Both), market cap, days seen
- Dismiss button calls POST with admin Bearer token
- Client-side optimistic hide after dismiss

**`PriceSourceHealthCard`** (`src/components/status/price-source-health.tsx`)
- Renders after Circuit Breakers section
- Confidence distribution: High / Single / Low / Missing — colored severity tiles
- Source breakdown: CG+DL, CG-only, DL, Contract, CMC, DEX, Cached
- Collapsible divergences list (top 10 by bps)
- Collapsible shadow pipeline metrics (Phase B, see below)

### Phase B — Shadow Mode

**`computeShadowComparison()`** (`worker/src/cron/enrich-prices.ts:801-840`)
- Pure function: takes oldPrices map (DL-sourced) and newCgPrices map (CG-sourced)
- Returns: `{ totalCompared, meanDivergenceBps, p95DivergenceBps, maxDivergenceBps, coverageLost, coverageGained, cgAvailable }`
- 4 tests in `enrich-prices.test.ts`

**Integration** (`worker/src/cron/sync-stablecoins.ts:514-543`)
- Runs AFTER `fetchDualPrimaryPrices` returns but BEFORE dual-primary results overwrite `asset.price`
- Extracts CG prices from `dualPriceResults.get(asset.id).cgPrice` — no extra API call
- Old prices = raw DL list endpoint prices (still in `asset.price` at this point)
- Result stored in cron metadata as `shadowComparison`

**Frontend** — collapsible "Shadow Pipeline" section in `PriceSourceHealthCard`:
- Mean / P95 / Max divergence in bps
- Coverage delta: +gained / -lost
- CG availability flag

---

## Types Added

All in `shared/types/index.ts`:

```typescript
interface DiscoveryCandidate { id, geckoId, llamaId, name, symbol, marketCap, source, firstSeen, lastSeen, daysSeen, dismissed }
interface DiscoveryCandidatesResponse { candidates, total }
interface PriceSourceHealth { sourceDistribution, confidenceDistribution, divergences[], totalAssets, lastSync }
interface ShadowComparisonResult { totalCompared, meanDivergenceBps, p95DivergenceBps, maxDivergenceBps, coverageLost, coverageGained, cgAvailable }

// StatusResponse extended with:
priceSourceHealth: PriceSourceHealth | null;
discoveryCandidates: DiscoveryCandidate[] | null;
shadowComparison: ShadowComparisonResult | null;
```

`ShadowComparisonResult` is also defined in `worker/src/cron/enrich-prices.ts` (worker-internal copy, same shape).

---

## Phase C Handover — Pipeline Switch

> **GATE:** Do not start until shadow mode metrics pass for 7 consecutive days. Check the `/status` admin page → Shadow Pipeline section, or query the API: `GET /api/status` → `shadowComparison`.

### Success Criteria (from design doc)

| Metric | Threshold |
|--------|-----------|
| Mean divergence | < 25 bps |
| P95 divergence | < 100 bps |
| Max divergence | < 500 bps |
| Coverage lost | ≤ 5 assets |
| CG available | true on all 7 days |

### Scope

Phase C rewrites the price pipeline to make CoinGecko primary. It should be written as its own implementation plan (`agents/plans/2026-03-XX-coingecko-pipeline-switch.md`).

#### 1. Rewrite `fetchDualPrimaryPrices` → `fetchPrimaryPrices`

**Current behavior** (`worker/src/cron/enrich-prices.ts:200-350`):
- Fetches from both DL coins API and CG `/simple/price` in parallel
- Cross-validates: if both agree within 50bps → "high" confidence
- Single-source fallback if one circuit is open
- Returns `Map<string, DualPriceResult>` with both prices + confidence

**New behavior:**
- CG becomes the primary price source
- DL stablecoins API price (already available from the list endpoint in `asset.price`) serves as cross-validation
- Rename function and return type to reflect single-primary-with-validation model
- Keep confidence tiers but redefine: "high" = CG+DL agree, "single-source" = CG only, "low" = DL only

**Key constraint:** The CG `/simple/price` call is already happening (that's how `DualPriceResult.cgPrice` gets populated). The rewrite doesn't add new API calls — it changes which price is authoritative.

#### 2. Collapse `enrichMissingPrices` from 6 passes to 2 phases

**Current passes** (`worker/src/cron/enrich-prices.ts:422-790`):
- Pass 1: Contract address → DL coins API (`defillama-contract`)
- Pass 1b: Multi-chain contract fallback
- Pass 2: DL coins API by geckoId (`cached` — effectively CG prices proxied through DL)
- Pass 3: CG direct `/simple/price` for remaining
- Pass CMC: CoinMarketCap API
- Pass 4: DexScreener

**New phases:**
- Phase 1 prices (CG primary) now cover what passes 2+3 did → remove those passes
- Keep: contract-address enrichment (pass 1/1b), CMC fallback, DexScreener fallback
- Net effect: 6 passes → 4 (or rename to Phase 1a/1b/2/3)

#### 3. Add `priceSource` tagging

Every enrichment path should tag `asset.priceSource` with a machine-readable string so the observability layer can track source distribution accurately. The current tagging is partial.

#### 4. Update `supplemental-assets.ts`

**Current:** `worker/src/cron/sync-stablecoins/supplemental-assets.ts` fetches its own prices from DL coins API for gold/silver/fiat CG tokens.

**New:** Accept Phase 1 prices (CG primary) from the caller instead of making separate API calls. This eliminates redundant CG fetches.

#### 5. Remove `fetchCoinGeckoMarketData()`

This function fetches CG market data (market_cap) separately. After Phase C, this data comes from the Phase 1 CG batch call. Merge into the primary fetch.

#### 6. Update interfaces

- Rename `DualPriceResult` → `PrimaryPriceResult` (or similar)
- Rename `DualPriceStats` → `PriceValidationStats`
- Update `EnrichmentStats` — remove pass2/pass3 counters
- Update `PriceSourceHealth.sourceDistribution` keys if source categories change

#### 7. Update all tests

- `worker/src/cron/__tests__/enrich-prices.test.ts` — update for new function signatures
- `worker/src/cron/__tests__/sync-stablecoins.test.ts` (if it exists) — update mocks
- Shadow comparison tests remain valid (pure function, no pipeline dependency)

#### 8. Update documentation

- `docs/data-pipeline.md` — rewrite price enrichment section
- `docs/api-reference.md` — update PriceSourceHealth field descriptions if keys change

#### 9. Cleanup

- Narrow `DL_COINS` circuit breaker semantics — it currently guards both DL coins API price fetches AND contract-address lookups. After removing pass 2, consider whether the circuit breaker should be split.
- Remove shadow comparison code (or keep it permanently as a health monitor)

### Files to Modify

| File | Change |
|------|--------|
| `worker/src/cron/enrich-prices.ts` | Major rewrite: fetchPrimaryPrices, collapse enrichMissingPrices |
| `worker/src/cron/sync-stablecoins.ts` | Update call sites, remove shadow block (or keep), update metadata |
| `worker/src/cron/sync-stablecoins/supplemental-assets.ts` | Accept prices from caller |
| `worker/src/cron/__tests__/enrich-prices.test.ts` | Update for new signatures |
| `shared/types/index.ts` | Rename DualPriceResult/Stats types if exposed |
| `docs/data-pipeline.md` | Rewrite price enrichment section |
| `docs/api-reference.md` | Update PriceSourceHealth description |

### Risks

1. **Coverage regression** — CG may not cover all coins DL does. Shadow metrics will reveal this. The contract-address passes (1/1b) and CMC/DEX fallbacks remain as safety nets.
2. **Rate limiting** — CG `/simple/price` already runs in the dual-primary flow. Phase C doesn't add calls, but verify batch sizes stay within CG rate limits after removing pass 2 (which was a DL call that indirectly fetched CG prices).
3. **Price staleness** — DL list endpoint prices update on the DL cron cycle. CG `/simple/price` is real-time. After switching primary, ensure the cross-validation threshold (currently 50bps) accounts for this timing difference.
4. **Supplemental assets** — Gold/silver tokens use DL coins API for non-USD-pegged price conversion. Ensure the CG batch call includes these geckoIds or keep a narrow DL fallback for commodity tokens.

### Prerequisite Audit

Before writing the Phase C plan, audit DL stablecoins API price coverage:
- Add temporary logging to `syncStablecoins()` or hit the API directly
- Count: how many of our 156 tracked coins get a price from the DL list endpoint?
- If coverage < 80%, Phase 1 needs a Phase 1b fallback (DL coins API for assets without CG coverage)
- The shadow metrics (`shadowComparison.coverageLost`) already measure this — check after 7 days of data

---

## Documentation Updated

These docs were updated as part of Task 11:
- `docs/data-flow-map.md` — coverage discovery row
- `docs/data-pipeline.md` — Coverage Discovery section
- `docs/api-reference.md` — discovery endpoints
- `docs/status-dashboard.md` — two new status cards
- `docs/worker-infrastructure.md` — discovery-scan cron entry, job count 21→22
