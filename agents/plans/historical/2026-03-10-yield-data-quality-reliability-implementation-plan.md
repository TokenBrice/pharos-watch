# Yield Data Quality & Reliability — Implementation Plan

**Date:** 2026-03-10
**Scope:** `/yield` page, yield detail surfaces, `sync-yield-data`, `fetch-tbill-rate`, yield cache/API contracts, yield history storage, and supporting docs/tests
**Based on:** End-to-end audit of the existing yield feature and cron pipeline completed on 2026-03-10

---

## Objective

Improve the `/yield` feature so the displayed APY, PYS, warning signals, and history are:

1. **More accurate** — metrics reflect the correct source series and benchmark state.
2. **More reliable** — degraded upstream inputs do not silently republish as authoritative fresh data.
3. **More explainable** — users and operators can see where the number came from, how fresh it is, and when fallback logic was used.

---

## Executive Build Order

Recommended execution order:

1. **Source-aware history foundation**
2. **Benchmark + upstream freshness provenance**
3. **Source arbitration and anomaly policy**
4. **Frontend freshness/provenance UX**
5. **Backfill, docs, and release hardening**

This order is deliberate:

- Phase 1 fixes the biggest data-integrity flaw first.
- Phase 2 prevents degraded upstream inputs from being misrepresented.
- Phase 3 changes selection policy only after the pipeline can explain its inputs.
- Phase 4 surfaces the new truth to users.
- Phase 5 cleans up historical continuity, observability, and docs before rollout.

---

## Core Decisions

These decisions should be treated as the working design unless implementation reveals a blocker.

### 1. History becomes source-aware

The current `yield_history` model stores one best row per coin per timestamp. That is not sufficient once the best source changes over time.

**Decision:** store **per-source history rows** keyed by `(stablecoin_id, source_key, recorded_at)` and persist `is_best` for that timestamp.

This gives us:

- same-source 7d/30d calculations
- source-switch detection
- alternate-source history if needed later
- auditable source selection over time

### 2. Rankings must carry provenance

The API should not expose only the output number. It should also expose enough metadata to explain how trustworthy that number is.

**Decision:** add a `provenance` envelope to ranking rows and to the top-level rankings response.

Minimum contents:

- source freshness / age
- source selection mode
- benchmark rate metadata
- safety snapshot status / coverage
- whether fallback values were used
- whether anomaly policy intervened

### 3. Benchmark cache must preserve last known good data

The current T-bill fetch path overwrites the cache with a hardcoded fallback on any fetch failure.

**Decision:** move to a structured benchmark cache that preserves:

- `rate`
- `recordDate`
- `fetchedAt`
- `source`
- `fallbackMode`
- `isFallback`

If FRED fails and a prior good value exists, keep the prior good value and mark it degraded. Only use the hardcoded fallback when no prior valid benchmark exists.

### 4. Best-source selection becomes confidence-aware

The current winner is simply the highest `currentApy`.

**Decision:** replace that with a ranked arbitration policy:

- first by source confidence / fidelity
- then by anomaly penalties
- then by current APY

This preserves upside while avoiding obvious false winners.

---

## Non-Goals

These are explicitly out of scope for this plan unless a later phase is expanded:

- Redesigning the PYS formula itself
- Adding new third-party vendors beyond the current source set
- Expanding the product into a generalized yield aggregator
- Reworking unrelated pages or report-card methodology outside their yield dependencies

---

## Phase 1: Source-Aware History Foundation

### Goal

Eliminate mixed-series contamination in `apy7d`, `apy30d`, PYS inputs, warning signals, and chart history.

### Deliverables

1. New source-aware history schema
2. Worker writes history per source, not only per current winner
3. Ranking metrics computed from the active source series only
4. Source-switch metadata captured for UI and API use

### Proposed Schema

Replace the existing single-series history shape with a new table or v2 migration:

```sql
CREATE TABLE yield_history_v2 (
  stablecoin_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  is_best INTEGER NOT NULL DEFAULT 0,
  symbol TEXT NOT NULL,
  yield_source TEXT NOT NULL,
  yield_type TEXT NOT NULL,
  data_source TEXT NOT NULL,
  apy REAL NOT NULL,
  apy_base REAL,
  apy_reward REAL,
  exchange_rate REAL,
  source_tvl_usd REAL,
  warning_signals TEXT,
  PRIMARY KEY (stablecoin_id, source_key, recorded_at)
);
```

Recommended indexes:

- `(stablecoin_id, source_key, recorded_at DESC)`
- `(stablecoin_id, recorded_at DESC, is_best)`
- `(recorded_at DESC)` if pruning cost becomes noticeable

### Implementation Tasks

1. Add a migration that creates `yield_history_v2`, copies legacy rows into it as `source_key = 'legacy-best'`, and renames tables.
2. Persist one history row for **every resolved source** in `sync-yield-data`, with `is_best = 1` only for the selected source at that timestamp.
3. Stop computing 7d/30d metrics from coin-level mixed history. Query history by `(stablecoin_id, source_key)`.
4. Add source-switch detection:
   if the current best `source_key` differs from the previously best source, persist a lightweight `selection_flags` marker in memory for API output and reset display semantics accordingly.
5. Update `yield-history` API to support:
   - default `mode=best`
   - optional `sourceKey=<key>` for a source-specific series
   - chart annotations for source switches when `mode=best`

### Recommended API Contract Additions

`GET /api/yield-history` should add:

- `sourceKey`
- `yieldSource`
- `yieldType`
- `dataSource`
- `isBest`
- `sourceSwitch` flag on rows where the selected best source changed

### Files

- `worker/migrations/*`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/cron/yield-sync/rankings.ts`
- `shared/types/index.ts`
- `src/hooks/use-yield-history.ts`
- `src/components/yield-history-chart.tsx`
- `docs/yield-intelligence.md`
- `docs/api-reference.md`

### Acceptance Criteria

- A coin that changes best source no longer mixes old-source samples into the new source's 7d/30d metrics.
- `yield-history` can return source-specific history for a given `sourceKey`.
- The chart can visually mark or break on source switches instead of implying a continuous single-source line.
- Existing consumers remain backward compatible when they do not request a specific `sourceKey`.

### Verification

- New worker tests for same-source trailing averages after a source switch
- New API tests for `mode=best` and `sourceKey=...`
- Frontend tests for source-switch marker rendering
- `cd worker && npx tsc --noEmit`
- `npm test`
- `npm run build`

---

## Phase 2: Benchmark and Upstream Freshness Provenance

### Goal

Stop degraded upstream inputs from looking like fresh truth.

### Deliverables

1. Structured benchmark cache
2. Structured DeFiLlama pool cache metadata
3. Rankings API freshness/provenance envelope
4. History endpoint freshness headers

### Implementation Tasks

#### 2A. Replace scalar benchmark cache with structured metadata

Create a new cache payload for the Treasury rate, for example:

```json
{
  "rate": 3.72,
  "recordDate": "2026-03-02",
  "fetchedAt": 1772505600,
  "source": "fred-dgs3mo",
  "isFallback": false,
  "fallbackMode": null
}
```

Behavior:

- on successful FRED fetch: overwrite with fresh structured payload
- on failed FRED fetch:
  - if prior good payload exists, retain it and mark degraded
  - if no prior valid payload exists, write the hardcoded fallback payload

#### 2B. Add age/status metadata to `dl-stablecoin-pools`

Instead of caching a bare array, cache a structured envelope:

```json
{
  "updatedAt": 1772505600,
  "source": "sync-dex-liquidity",
  "poolCount": 1234,
  "data": [...]
}
```

`sync-yield-data` should read this and propagate:

- cache age
- whether it used cached pools or direct fetch
- whether direct fetch failed

#### 2C. Add provenance to rankings

Add a top-level `provenance` object to `/api/yield-rankings` and a per-row `provenance` object.

Top-level:

- `yieldSnapshotUpdatedAt`
- `yieldSnapshotAgeSec`
- `benchmark`
- `safetySnapshot`
- `sourceInputs`

Per-row:

- `sourceKey`
- `sourceSelectedBy`
- `sourceObservedAt`
- `sourceAgeSec`
- `usedDefaultSafety`
- `selectionWarnings`
- `benchmarkRateUsed`
- `benchmarkRecordDate`

#### 2D. Fix history freshness

`yield-history` currently has no freshness metadata. Add headers based on the latest successful `sync-yield-data` run or latest matching history row.

Recommended:

- `X-Data-Age`
- stale `Warning` header when applicable

### Files

- `worker/src/cron/fetch-tbill-rate.ts`
- `worker/src/cron/yield-sync/sources.ts`
- `worker/src/cron/sync-yield-data.ts`
- `worker/src/api/cache-handlers.ts`
- `worker/src/api/yield-history.ts`
- `worker/src/lib/api-utils.ts`
- `shared/types/index.ts`
- `src/lib/api.ts`
- `src/hooks/use-yield-rankings.ts`
- `src/hooks/use-yield-history.ts`
- `docs/yield-intelligence.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`

### Acceptance Criteria

- A transient FRED failure no longer replaces a valid recent benchmark with the hardcoded fallback.
- Rankings can explain whether the benchmark is fresh, retained, or fallback.
- Rankings can explain whether DL pool inputs came from cached DEX sync data or direct fetch.
- History endpoint freshness can be surfaced by the frontend.

### Verification

- New `fetch-tbill-rate` tests for "retain last known good"
- New source-loading tests for structured DL pool cache parsing
- API contract tests for `_meta` / provenance presence
- `npm test`
- `npm run build`

---

## Phase 3: Confidence-Aware Source Arbitration

### Goal

Prevent obviously suspect sources from winning solely because they print the highest APY.

### Deliverables

1. Confidence scoring for resolved sources
2. Hard and soft anomaly penalties
3. Explicit best-source selection reason
4. Operator-visible counters for arbitration events

### Proposed Selection Model

Assign each resolved source a confidence tier:

- Tier A: on-chain deterministic
- Tier B: rate-derived deterministic
- Tier C: curated static DeFiLlama pool map
- Tier D: curated variant/wrapper map
- Tier E: deterministic auto-discovered allowlist match by address/symbol
- Tier F: symbol-fallback DeFiLlama match

Add penalties for:

- stale source input
- 0% APY when same-source history suggests otherwise
- large divergence vs. another high-confidence source
- tiny TVL relative to the coin's primary source
- reward-heavy spike without recent historical support

Selection order:

1. disqualify rows that fail hard rules
2. rank by confidence tier
3. apply anomaly penalties
4. choose highest remaining `currentApy`

### Hard Rules

Recommended initial hard rules:

- reject rows with invalid numeric data
- reject rows older than defined source-staleness threshold
- reject symbol-fallback rows when a deterministic source exists and the APY diverges materially
- reject low-TVL rows when they are the sole reason a coin appears above benchmark

### Soft Rules

Recommended soft penalties:

- penalize rows with `reward-heavy`
- penalize rows with `yield-spike`
- penalize rows when `currentApy` exceeds same-source 30d mean by a large multiple

### Implementation Tasks

1. Create a `scoreResolvedSource()` helper that returns:
   - confidence tier
   - penalties
   - keep/reject decision
   - selection reason
2. Apply the arbitration layer before `bestSourceKeyByCoin` is computed.
3. Persist arbitration output into row provenance.
4. Turn the current log-only cross-source divergence check into a policy input.
5. Add cron metadata counters:
   - `rowsRejected`
   - `rowsPenalized`
   - `divergenceFlags`
   - `sourceSwitches`

### Files

- `worker/src/cron/sync-yield-data.ts`
- `worker/src/cron/yield-sync/resolve.ts`
- `worker/src/cron/yield-helpers.ts`
- `worker/src/cron/yield-sync/types.ts`
- `shared/types/index.ts`
- `docs/yield-intelligence.md`

### Acceptance Criteria

- Best-source selection is no longer "highest current APY wins" in all cases.
- Divergent low-confidence rows cannot silently replace higher-confidence canonical rows.
- API consumers can see why a source was selected.

### Verification

- Tests for confidence tie-breaks
- Tests for divergence rejection
- Tests for fallback symbol matches not overtaking deterministic sources
- `npm test`
- `npm run build`

---

## Phase 4: Frontend Provenance, Freshness, and History UX

### Goal

Expose the new reliability model clearly on `/yield` and stablecoin detail pages.

### Deliverables

1. Rankings hook reads backend freshness metadata rather than only client fetch time
2. `/yield` page surfaces provenance and degraded-state context
3. History chart shows source switches and source labels
4. Detail page shows benchmark/source as-of context

### Implementation Tasks

#### 4A. Move yield hooks to meta-aware fetches

Use `apiFetchWithMeta` for:

- `useYieldRankings`
- `useYieldHistory`

Either add dedicated hooks or a shared `useApiQueryWithMeta` helper.

#### 4B. Fix the stale banner contract

The stale banner should consume:

- `_meta`
- `X-Data-Age`
- benchmark freshness
- degraded upstream warnings

It should not rely solely on TanStack `dataUpdatedAt` for cache-backed datasets.

#### 4C. Add a provenance summary block

On `/yield`, add a compact provenance rail with:

- benchmark as-of date
- yield snapshot age
- safety snapshot coverage
- source mode note such as "best source selected via confidence-aware arbitration"

#### 4D. Update leaderboard rows

Add:

- source freshness tooltip
- source selection reason
- source-switch badge where applicable
- explicit distinction between canonical/native source and alternate opportunity

#### 4E. Update history chart

Add:

- source switch markers
- optional segmented line rendering
- current source label
- benchmark as-of tooltip

#### 4F. Update detail page yield section

Add:

- benchmark record date
- source freshness
- selection confidence messaging when the source is auto-discovered or degraded

### Files

- `src/hooks/use-yield-rankings.ts`
- `src/hooks/use-yield-history.ts`
- `src/lib/api.ts`
- `src/components/stale-data-banner.tsx`
- `src/app/yield/client.tsx`
- `src/components/yield-leaderboard.tsx`
- `src/components/yield-history-chart.tsx`
- `src/components/yield-detail-section.tsx`
- `docs/yield-intelligence.md`
- `docs/methodology-page.md`

### Acceptance Criteria

- `/yield` shows backend freshness truth, not just frontend fetch recency.
- Users can tell when a benchmark is fallback, retained, or fresh.
- History charts no longer imply one continuous source when the source changed.
- Detail pages explain the current yield source and its freshness.

### Verification

- Component tests for provenance banners/tooltips
- Hook tests for meta-aware fetch parsing
- `npm test`
- `npm run build`

---

## Phase 5: Backfill, Hardening, Docs, and Release

### Goal

Make the migration safe to deploy and operationally useful.

### Deliverables

1. Backfill plan for legacy history
2. Status/admin observability updates
3. Documentation updates
4. Rollout and rollback procedure

### Backfill Strategy

Recommended approach:

1. Migrate legacy `yield_history` rows into `yield_history_v2` as:
   - `source_key = 'legacy-best'`
   - `is_best = 1`
2. Exclude legacy rows from same-source trailing metrics unless the current best source is also `legacy-best`.
3. Allow charts to display legacy history with a visible marker:
   `Legacy mixed-source history before <migration date>`.
4. Do **not** try to reconstruct historical per-source rows from old snapshots unless a separate recovery project is approved.

This is the least risky option and avoids inventing provenance that never existed.

### Status / Operator Updates

Update `/status` or cron metadata consumers to include:

- last successful yield sync
- last successful benchmark fetch
- safety coverage ratio used by yield sync
- count of arbitration rejections
- count of source switches
- count of coins using fallback benchmark or default safety

### Documentation Updates

Must update at the end of the relevant phases:

- `docs/yield-intelligence.md`
- `docs/api-reference.md`
- `docs/data-flow-map.md`
- `docs/worker-infrastructure.md` if cron/cache contract changes materially
- `docs/testing.md` if new fixture or test patterns are introduced
- `/methodology` page if public methodology language changes

### Rollout Plan

1. Ship schema migration
2. Deploy worker changes with dual-read compatibility
3. Let one full yield sync cycle populate new history
4. Verify status metrics and live API payloads
5. Deploy frontend provenance updates
6. Run a 24-hour observation period before declaring the feature re-baselined

### Rollback Plan

- If frontend issues appear: roll back frontend only, worker remains backward compatible
- If worker issues appear after schema migration:
  - stop using new fields
  - keep dual-read compatibility
  - restore old selection path behind a flag if needed
- Do not attempt destructive rollback of the new history schema in-place

### Verification

- `npm run lint`
- `cd worker && npx tsc --noEmit`
- `npm test`
- `npm run build`
- targeted smoke checks against:
  - `/api/yield-rankings`
  - `/api/yield-history?stablecoin=<id>&days=30`
  - `/yield`
  - one detail page with native yield
  - one detail page with rate-derived or price-derived yield

---

## Suggested Ticket Breakdown

If you want this executed in parallel worktrees, use the following split.

### Workstream A: Data model + worker

- Phase 1 schema and history writes
- Phase 2 benchmark cache/provenance
- Phase 3 arbitration policy

### Workstream B: API + shared contracts

- shared types
- cache/meta response shapes
- history endpoint enhancements

### Workstream C: Frontend

- meta-aware hooks
- stale/provenance UI
- chart/source-switch UX

### Workstream D: Docs + ops

- docs refresh
- status/admin observability
- rollout checklist

Recommended merge sequence:

1. A + B foundation
2. C UI consumption
3. D docs/ops

---

## Phase Gates

Do not move to the next phase until the prior gate is green.

### Gate 1

- source-aware history schema merged
- same-source metrics computed correctly
- build/test green

### Gate 2

- benchmark retains last known good
- provenance present in rankings API
- build/test green

### Gate 3

- confidence-aware source selection active
- divergence policy tested
- build/test green

### Gate 4

- frontend reads backend freshness/provenance
- source switches visible in history
- build/test green

### Gate 5

- docs updated
- rollout checklist executed
- live smoke checks pass

---

## Highest-Risk Areas

1. **History migration**
   Risk: breaking chart continuity or API assumptions.
   Mitigation: dual-read compatibility and explicit legacy marker.

2. **Selection-policy change**
   Risk: changing winners for many coins at once.
   Mitigation: ship provenance first, then arbitration, and log diff output during rollout.

3. **Frontend meta plumbing**
   Risk: stale banner or hooks regress other cache-backed pages if generalized too aggressively.
   Mitigation: keep yield-specific hook changes isolated unless a shared abstraction is clearly safe.

4. **Backfill expectations**
   Risk: attempting to infer provenance from legacy history.
   Mitigation: do not reconstruct what the old model never stored.

---

## Recommended First Sprint

If execution starts immediately, the first sprint should include only:

1. Phase 1 source-aware history migration and same-source metrics
2. Phase 2 benchmark cache retention
3. Minimal provenance fields needed to prove those changes worked

That produces the largest quality improvement with the least UI churn.
