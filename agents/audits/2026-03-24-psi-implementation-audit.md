# PSI Implementation Audit

Date: 2026-03-24

Scope: full Pharos Stability Index implementation review across methodology docs, worker compute, historical backfill, API shaping, frontend consumers, OG rendering, and tests.

## Executive Summary

The live PSI compute path is directionally solid: the formula is simple, the fail-closed depeg dependency change is correct, and the current sample cron is materially safer than the historical implementation. The main reliability weakness is not the formula itself, but the split between:

- live PSI computation
- historical PSI reconstruction/backfill
- API/UI presentation logic

Today, those paths do not share one canonical input model or one canonical display model. That creates three concrete problems:

1. The historical rebuild path can rewrite `stability_index` with scores that do not match current PSI methodology.
2. The PSI universe is defined in one place but populated through different asset sets in different paths.
3. The API/frontend layer has duplicated “display PSI” logic that already diverges in small but user-visible ways.

If the goal is to make PSI a flagship feature that is both accurate and trusted, remediation should start with historical correctness and canonicalization of shared PSI helpers before any formula expansion.

## What I Reviewed

- Docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/stability-index.md`, `docs/stability-index-timeline.md`
- Live compute: `worker/src/lib/stability-index.ts`, `worker/src/cron/stability-index.ts`, `worker/src/cron/snapshot-psi.ts`
- Historical rebuild: `worker/src/api/backfill-stability-index.ts`, `worker/src/lib/psi-recompute.ts`
- API: `worker/src/api/stability-index.ts`
- Frontend consumers: `src/app/stability-index/client.tsx`, `src/components/kpi-bar.tsx`, `src/components/psi-history-chart.tsx`
- Shared universe/version metadata: `shared/lib/psi-eligible.ts`, `shared/lib/shadow-stablecoins.ts`, `shared/lib/stability-index-version.ts`
- OG surface: `worker/src/lib/og-templates/stability-index-card.tsx`
- Relevant tests

## Findings

### 1. Critical: the backfill path is not methodology-faithful and can rewrite recent PSI history incorrectly

Files:

- [worker/src/api/backfill-stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-stability-index.ts#L44)
- [worker/src/lib/psi-recompute.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/psi-recompute.ts#L68)
- [worker/src/cron/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/stability-index.ts#L105)

Evidence:

- Backfill computes PSI with only `depegs`, `totalMcapUsd`, and `mcap7dChangePct` and never supplies `dewsStressBreadth` even for methodology `v3.0+`. See [worker/src/api/backfill-stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-stability-index.ts#L69).
- Backfill replays `peak_deviation_bps`, not live/replayed daily deviation. See [worker/src/lib/psi-recompute.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/psi-recompute.ts#L90).
- Backfill builds total market cap from all `supply_history` rows, not a canonical PSI-filtered universe. See [worker/src/api/backfill-stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-stability-index.ts#L56) and [worker/src/lib/psi-recompute.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/psi-recompute.ts#L59).

Why this matters:

- A rebuild of `stability_index` is currently not a faithful recomputation of the methodology documented in `docs/stability-index.md`.
- Post-`v3.0` rebuilt history will be biased upward in stressed periods because `stressBreadth` is silently omitted.
- Peak-deviation replay can bias older crisis windows downward versus the live semantics, because it uses event maxima instead of day-level current deviation.
- Total-market-cap denominator drift makes severity shares and trend inconsistent with the live path.

Impact on notable-event behavior:

- The major traumatic events will probably still show large drops, because severity and breadth dominate during those windows.
- Their exact depths, durations, and relative ranking are not trustworthy after a rebuild.
- Recent stressed periods after `v3.0` are especially vulnerable to appearing too calm because DEWS breadth is missing.

Recommendation:

- Treat `backfill-stability-index` as unsafe for methodology-sensitive historical truth until it is rebuilt around a canonical replay input model.
- The replay model should resolve, per day:
  - canonical PSI universe
  - per-coin market cap
  - per-coin daily deviation semantics
  - DEWS stress breadth where methodology version requires it
  - methodology-specific input adapters instead of one generic replay

### 2. Major: PSI universe definition is centralized, but the live and historical pipelines do not actually consume the same universe

Files:

- [shared/lib/psi-eligible.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/psi-eligible.ts#L4)
- [shared/lib/shadow-stablecoins.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/shadow-stablecoins.ts#L3)
- [worker/src/cron/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/stability-index.ts#L25)
- [worker/src/cron/sync-stablecoins/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/shared.ts#L3)

Evidence:

- PSI eligibility is defined as tracked + shadow assets. See [shared/lib/psi-eligible.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/psi-eligible.ts#L4).
- Shadow assets explicitly exist for historical continuity. See [shared/lib/shadow-stablecoins.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/shadow-stablecoins.ts#L3).
- Live PSI pulls from the stablecoins cache and filters that payload by eligible IDs. See [worker/src/cron/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/stability-index.ts#L25).
- The stablecoins cache is built from `ACTIVE_STABLECOINS`, not from the PSI eligible set. See [worker/src/cron/sync-stablecoins/shared.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-stablecoins/shared.ts#L3).

Why this matters:

- The “PSI universe” is conceptually singular but operationally split.
- Live PSI cannot rely on the same source path as the historical replay for shadow assets.
- That makes regression testing against historical crises harder because current computation and reconstructed history are not based on the same population-building logic.

Impact on notable-event behavior:

- Near-term live PSI is probably unaffected because the shadow assets are historical only.
- Historical continuity around UST and IRON depends on separate replay/backfill behavior rather than one unified system, which increases the chance of drift when methodology evolves.

Recommendation:

- Introduce one canonical `PsiUniverseSnapshot` builder shared by live compute and historical replay.
- Make “universe membership” explicit in stored `input_snapshot` metadata so historical rows can be audited later.

### 3. Major: the API/history assembly and page logic produce duplicate-today and incorrect “days in band / vs yesterday” behavior

Files:

- [worker/src/api/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stability-index.ts#L94)
- [worker/src/api/backfill-stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-stability-index.ts#L46)
- [src/app/stability-index/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/client.tsx#L580)
- [src/components/kpi-bar.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/kpi-bar.tsx#L395)

Evidence:

- The API always prepends today’s running average when samples exist. See [worker/src/api/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stability-index.ts#L94).
- The backfill path rebuilds through `endDay = todayMidnight`, so `stability_index` can already contain a row for today. See [worker/src/api/backfill-stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/backfill-stability-index.ts#L46).
- The dedicated page counts consecutive history rows matching the current band and then adds one more for “today”, without skipping a prepended today row. See [src/app/stability-index/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/client.tsx#L580).
- `delta vs yesterday` on that page uses `history[0]`, which after prepending is today’s running average, not yesterday. See [src/app/stability-index/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/client.tsx#L694).
- The KPI bar already has a separate implementation that explicitly skips today. See [src/components/kpi-bar.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/kpi-bar.tsx#L400).

Why this matters:

- Two PSI surfaces already disagree on the same derived metrics.
- Admin backfills can worsen the inconsistency by materializing a real daily row for today in `stability_index`.
- This is not a score-computation bug, but it is a trust bug: users can see different “days in band” logic depending on where they look.

Impact on notable-event behavior:

- No impact on stored PSI score.
- Moderate impact on the interpretation layer around PSI history and regime persistence.

Recommendation:

- Never store a daily snapshot row for today in the rebuild path.
- Centralize “append today”, “yesterday comparator”, “band streak”, and display-score logic into one shared selector used by API, frontend, digest, and OG.

### 4. Major: the OG PSI card has reversed score polarity

File:

- [worker/src/lib/og-templates/stability-index-card.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/og-templates/stability-index-card.tsx#L24)

Evidence:

- The thermometer logic treats `0` as best and `100` as worst. See [worker/src/lib/og-templates/stability-index-card.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/og-templates/stability-index-card.tsx#L24).
- Delta coloring also assumes higher PSI is worse. See [worker/src/lib/og-templates/stability-index-card.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/og-templates/stability-index-card.tsx#L37).
- The actual PSI implementation and public docs use higher = healthier.

Why this matters:

- Shared images can visually communicate the opposite of the product’s core model.
- This is especially risky because PSI is positioned as a defining product feature.

Impact on notable-event behavior:

- No score impact.
- High presentation/trust impact for social sharing and metadata consumers.

Recommendation:

- Fix OG polarity immediately after the historical-replay cleanup.
- Add a snapshot test for a known score like `92` and assert that it renders in the healthy end of the scale.

### 5. Moderate: the current API contract and tests are too weak around PSI’s most failure-prone areas

Files:

- [worker/src/api/__tests__/stability-index.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/stability-index.test.ts#L9)
- [worker/src/api/__tests__/backfill-stability-index.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-stability-index.test.ts#L7)

Evidence:

- The API contract test uses non-canonical bands (`"Stable"`) and obsolete component keys (`pricePeg`, `supplyMomentum`). See [worker/src/api/__tests__/stability-index.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/stability-index.test.ts#L9).
- The backfill test mocks `computeStabilityIndex`, so it cannot catch real regressions in methodology-specific replay inputs. See [worker/src/api/__tests__/backfill-stability-index.test.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/backfill-stability-index.test.ts#L7).

Why this matters:

- The PSI-specific tests are green, but they do not strongly protect the parts most likely to drift:
  - backfill/live parity
  - stress-breadth inclusion by methodology version
  - duplicate-today behavior
  - canonical band/component contract
  - notable-event calibration

Recommendation:

- Add golden scenario tests for:
  - Tether scare
  - IRON Finance
  - UST collapse
  - SVB weekend
- Assert score bands or bounded ranges, not exact fragile decimals for every case.
- Add one parity suite that compares live-style daily replay vs backfill-style replay under controlled fixtures.

### 6. Moderate: PSI presentation logic is duplicated across API, digest, KPI bar, and page client

Files:

- [worker/src/api/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stability-index.ts#L72)
- [worker/src/cron/daily-digest.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/daily-digest.ts#L526)
- [src/components/kpi-bar.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/kpi-bar.tsx#L358)
- [src/app/stability-index/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/stability-index/client.tsx#L691)

Evidence:

- Each surface independently derives:
  - displayed score (`avg24h ?? score`)
  - displayed band
  - 24h deltas
  - streak logic
  - “today vs history” interpretation

Why this matters:

- PSI’s meaning is centralized, but PSI’s presentation semantics are not.
- This will keep creating small inconsistencies whenever history shape or methodology metadata changes.

Recommendation:

- Add a shared runtime-neutral PSI selector module, for example under `shared/lib/psi-view-model.ts`, with helpers for:
  - `getDisplayedPsi`
  - `appendTodayRunningAverage`
  - `getPsiStreak`
  - `getPsiDeltas`
  - `normalizePsiHistory`

### 7. Low: `detail=true` history does not fully honor the “per-day component breakdowns” promise for today’s appended point

File:

- [worker/src/api/stability-index.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stability-index.ts#L105)

Evidence:

- Historical rows include `components` in detail mode.
- The prepended today-running-average history point does not.

Why this matters:

- Minor contract mismatch.
- The frontend tolerates it, but the API behavior is not as clean as the docs suggest.

Recommendation:

- Either include computed averaged components for the prepended today point in detail mode, or explicitly document today’s appended point as summary-only.

## Opportunities To Improve PSI Using Existing Data

These are worthwhile only after canonicalization and backfill correctness are fixed.

### A. Add PSI confidence / coverage metadata

Use existing data to expose:

- `depegInputStatus`
- `dewsInputStatus`
- `replayPriceFallbackCount`
- `eligibleUniverseCount`
- `coveredUniverseCount`
- `shadowCoverageCount`

This would help users trust the score without changing the score itself.

### B. Add a “stress concentration” decomposition

Use existing contributor and market-cap data to expose:

- top-1 contributor share of severity
- top-3 contributor share of severity
- long-tail breadth share

This would distinguish “one giant wobble” from “broad ecosystem fracture”.

### C. Add a “flight-to-quality” PSI companion metric

Using existing supply-history and stablecoin market-cap data, compute whether inflows are concentrating into USDT/USDC while PSI deteriorates. This would be valuable context during crises without contaminating the PSI core score.

### D. Add recovery analytics

Using existing history:

- trough depth
- days to recover one band
- days to recover back above STEADY

This strengthens PSI as an intelligence product, not just a score.

## Impact Assessment For Likely Remediation Changes

### Fixing backfill to include `stressBreadth`

Expected score impact:

- Calm periods: near zero
- Moderate stress periods after `v3.0`: lower PSI by roughly `0–5` points depending on breadth
- Major crises: still dominated by severity/breadth, so the event shape remains sharp

Conclusion:

- Safe and desirable. It improves fidelity without flattening notable events.

### Fixing backfill universe filtering

Expected score impact:

- Depends on how much non-PSI supply currently leaks into the denominator
- Historical crisis windows around shadow assets likely become more internally consistent
- Current live PSI likely unchanged

Conclusion:

- Safe and desirable. It should improve consistency more than it changes narrative behavior.

### Aligning historical replay from `peak_deviation_bps` to day-level replayed deviation

Expected score impact:

- Some historical crisis troughs may become less deep or shorter-lived
- UST/IRON/SVB would still remain major drops, but certain windows could look less dramatic

Conclusion:

- This is the one remediation that could visibly soften notable-event charts.
- Do not flip this blindly. Benchmark event windows first and preserve the product requirement that traumatic market events remain obvious.
- If necessary, keep:
  - operational PSI as the canonical series
  - event-local minima / crisis annotations as separate historical context

### Fixing duplicate-today/UI derivation bugs

Expected score impact:

- None

Conclusion:

- High trust win, no methodology risk.

### Fixing OG polarity

Expected score impact:

- None

Conclusion:

- High communication-value cleanup, no methodology risk.

## Recommended Remediation Sequence

1. Canonicalize the historical replay contract.
2. Fix backfill to honor methodology version semantics, especially `v3.0+`.
3. Unify PSI universe building across live and replay paths.
4. Remove “today” duplication from rebuild/API/view-model logic.
5. Extract shared PSI selector helpers for API, digest, OG, and frontend.
6. Add scenario-based regression tests around notable events and crisis troughs.
7. Only then consider expanding PSI with new companion analytics.

## Suggested Test Additions

- Backfill parity test for `v3.0+` including `stressBreadth`
- Backfill test proving today is not written into `stability_index`
- API test proving `detail=true` history shape is stable with/without today samples
- Frontend selector test for streak and delta semantics
- OG snapshot test for score polarity
- Golden notable-event fixtures with band/range expectations

## Verification Performed

Ran:

```bash
npm test -- worker/src/lib/__tests__/stability-index.test.ts worker/src/cron/__tests__/stability-index.test.ts worker/src/cron/__tests__/snapshot-psi.test.ts worker/src/api/__tests__/stability-index.test.ts worker/src/api/__tests__/backfill-stability-index.test.ts
```

Result: 5 test files passed, 74 tests passed.

## Bottom Line

PSI’s live core is good enough to build on. The priority is not inventing a new formula; it is making the historical and presentation layers as rigorous as the current live compute path. Once that is done, PSI can safely expand into richer regime analytics without losing the sharp crisis signatures that make it valuable.
