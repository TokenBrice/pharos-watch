# Depeg Tracker + DEWS Audit

Date: 2026-04-08

Scope: live depeg detection, pending confirmation, DEWS scoring/persistence, peg summary and stress-signal APIs, and the primary `/depeg` frontend surfaces.

## Executive Summary

The implementation is materially better than a typical dashboard pipeline: the live detector has real guardrails, the DEX corroboration path is not naive, the DEWS job exposes degradation metadata instead of silently lying, and the test surface around the core worker flows is substantial.

The main weaknesses are concentrated in the pending-confirmation lane and in trust-policy drift across adjacent layers:

- The confirmation stage can promote a pending event even when corroborating sources point to the opposite side of the peg.
- Pending rows are effectively write-once snapshots, so worsening or direction-flipping candidates are not refreshed while they sit in `depeg_pending`.
- DEWS divergence currently trusts fresh `dex_prices` rows without applying the stronger liquidity gates already used elsewhere in the depeg stack.
- A few docs/comments have drifted away from the live contract, which makes the system harder to operate safely.

## What I Reviewed

- Live detection and helper layer:
  [worker/src/cron/detect-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts),
  [worker/src/cron/confirm-pending-depegs.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts),
  [worker/src/lib/depeg-helpers.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/depeg-helpers.ts),
  [worker/src/lib/native-peg-quotes.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/native-peg-quotes.ts)
- DEWS:
  [worker/src/lib/dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/dews.ts),
  [worker/src/cron/compute-dews.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts),
  [worker/src/cron/dews/source-state.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts),
  [worker/src/cron/dews/scoring.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/scoring.ts),
  [worker/src/cron/dews/persistence.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/persistence.ts)
- Read surfaces:
  [worker/src/api/depeg-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/depeg-events.ts),
  [worker/src/api/peg-summary.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/peg-summary.ts),
  [worker/src/api/stress-signals.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/stress-signals.ts),
  [worker/src/lib/peg-analytics.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/peg-analytics.ts)
- Frontend:
  [src/app/depeg/client.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/client.tsx),
  [src/app/depeg/page.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx),
  [src/components/depeg-tracker-table.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/depeg-tracker-table.tsx),
  [src/components/depeg-history.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/depeg-history.tsx),
  [src/components/depeg-feed.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/depeg-feed.tsx),
  [src/components/dews-summary.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/dews-summary.tsx),
  [src/components/dews-detail.tsx](/Users/ahirice/Documents/git/stablecoin-dashboard/src/components/dews-detail.tsx),
  [src/hooks/use-depeg-events.ts](/Users/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-depeg-events.ts)
- Relevant docs:
  [docs/depeg-detection.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/depeg-detection.md),
  [docs/dews.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md),
  [docs/architecture.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/architecture.md),
  [docs/testing.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/testing.md),
  [docs/worker-and-api-limits.md](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md)

## Ranked Findings

### 1. High: `confirmPendingDepegs()` ignores direction when evaluating corroborating sources

Evidence:

- Native-quote confirmation only tracks absolute deviation, not side of peg:
  [worker/src/cron/confirm-pending-depegs.ts:147](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L147),
  [worker/src/cron/confirm-pending-depegs.ts:148](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L148),
  [worker/src/cron/confirm-pending-depegs.ts:149](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L149),
  [worker/src/cron/confirm-pending-depegs.ts:150](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L150),
  [worker/src/cron/confirm-pending-depegs.ts:199](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L199),
  [worker/src/cron/confirm-pending-depegs.ts:200](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L200)
- CoinGecko / DefiLlama, DEX, CEX, and pool checks all use `Math.abs(...) >= secondaryBar` with no same-direction requirement:
  [worker/src/cron/confirm-pending-depegs.ts:233](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L233),
  [worker/src/cron/confirm-pending-depegs.ts:234](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L234),
  [worker/src/cron/confirm-pending-depegs.ts:252](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L252),
  [worker/src/cron/confirm-pending-depegs.ts:255](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L255),
  [worker/src/cron/confirm-pending-depegs.ts:267](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L267),
  [worker/src/cron/confirm-pending-depegs.ts:268](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L268),
  [worker/src/cron/confirm-pending-depegs.ts:281](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L281),
  [worker/src/cron/confirm-pending-depegs.ts:282](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L282)
- Promotion then preserves the original pending direction verbatim:
  [worker/src/cron/confirm-pending-depegs.ts:305](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L305),
  [worker/src/cron/confirm-pending-depegs.ts:306](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L306),
  [worker/src/cron/confirm-pending-depegs.ts:325](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L325)

Impact:

- A pending `above` event can be promoted by secondaries that actually show `below`, and vice versa.
- This is most dangerous on direction flips, thin/non-USD pegs, and any case where the primary signal is ambiguous enough to route through `depeg_pending`.
- It weakens the most safety-critical stage of the pipeline: the place where the code claims to add independent confirmation.

Recommendation:

- Normalize every secondary source through one shared helper that returns `{ bps, absBps, direction }`.
- Require corroboration direction to match `row.direction`.
- Treat opposite-direction secondary signals as contradiction, not confirmation.
- Add explicit tests for opposite-side native quotes, DEX medians, pool challengers, and CEX prices.

### 2. High: pending rows are write-once snapshots, so the queue can preserve stale severity and stale direction

Evidence:

- Detection inserts one row and never updates it:
  [worker/src/cron/detect-depegs.ts:553](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L553),
  [worker/src/cron/detect-depegs.ts:561](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L561),
  [worker/src/cron/detect-depegs.ts:565](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L565)
- Promotion falls back to the original `first_seen_*` snapshot whenever no authoritative current primary exists:
  [worker/src/cron/confirm-pending-depegs.ts:316](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L316),
  [worker/src/cron/confirm-pending-depegs.ts:317](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L317),
  [worker/src/cron/confirm-pending-depegs.ts:318](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L318),
  [worker/src/cron/confirm-pending-depegs.ts:319](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L319),
  [worker/src/cron/confirm-pending-depegs.ts:326](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L326),
  [worker/src/cron/confirm-pending-depegs.ts:327](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L327),
  [worker/src/cron/confirm-pending-depegs.ts:349](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L349)

Impact:

- If a pending move worsens before confirmation, the eventual live event can understate `peakDeviationBps` and `peakPrice`.
- If the market flips direction while the row is pending, the queue has no state transition; it depends on delete/reinsert timing elsewhere, which is brittle.
- This compounds Finding 1 because a stale direction can later be confirmed by an opposite-side corroborator.

Recommendation:

- Replace `DO NOTHING` with an upsert that tracks `last_seen_at`, `last_seen_bps`, `peak_seen_bps`, and direction transitions.
- Preserve the earliest timestamp for the same directional incident, but keep the worst magnitude and most recent observed price.
- Add idempotent tests for “pending worsens”, “pending softens”, and “pending flips direction before confirmation”.

### 3. Medium: DEWS divergence trusts fresh DEX rows without applying the stronger liquidity gates already used by the depeg stack

Evidence:

- The DEX observation storage floor is only `$50k`:
  [worker/src/lib/constants.ts:36](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/constants.ts#L36),
  [worker/src/lib/constants.ts:37](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/constants.ts#L37)
- DEWS only filters `dex_prices` by freshness:
  [worker/src/cron/dews/source-state.ts:85](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts#L85),
  [worker/src/cron/dews/source-state.ts:88](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts#L88),
  [worker/src/cron/dews/source-state.ts:92](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts#L92),
  [worker/src/cron/dews/source-state.ts:93](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts#L93)
- That raw value flows straight into the `diverg` signal:
  [worker/src/cron/dews/scoring.ts:98](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/scoring.ts#L98),
  [worker/src/cron/dews/scoring.ts:99](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/scoring.ts#L99),
  [worker/src/cron/dews/scoring.ts:134](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/scoring.ts#L134)

Impact:

- DEWS can raise WATCH/ALERT/WARNING from thin-pool noise that the live depeg detector deliberately refuses to trust.
- This makes DEWS less reliable exactly where it is supposed to be “early warning” rather than “early false positive”.
- The inconsistency is hard for operators to reason about because the same `dex_prices` table has different trust semantics depending on which consumer reads it.

Recommendation:

- Carry `source_total_tvl` into the DEWS source state and gate the divergence signal on at least the UI floor, and likely the depeg floor for high-severity outputs.
- Alternatively, expose a second DEWS-only “thin-liquidity divergence” sub-signal explicitly labeled as low confidence rather than mixing it into the main divergence path.

### 4. Medium: native-quote recovery can close an event while writing a still-depegged `recovery_price`

Evidence:

- When the direct native quote shows recovery but the primary USD price still looks depegged, the code closes the event and stores `recovery_price = price` from the contradictory primary sample:
  [worker/src/cron/detect-depegs.ts:499](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L499),
  [worker/src/cron/detect-depegs.ts:500](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L500),
  [worker/src/cron/detect-depegs.ts:501](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L501),
  [worker/src/cron/detect-depegs.ts:502](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L502),
  [worker/src/cron/detect-depegs.ts:503](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L503)

Impact:

- Stored history can show an event “recovering” at a price that still violates the threshold.
- Any UI, audit tool, or later methodology work that treats `recovery_price` as a trustworthy terminal observation will inherit that contradiction.
- This is not just cosmetic; it reduces confidence in the event table as a historical ledger.

Recommendation:

- When native-quote vetoes the primary move, either:
  store a native-implied recovery price compatible with `peg_reference`,
  or store `NULL` and add a recovery provenance flag.
- Add a regression test that asserts the bound `recovery_price` when native quotes close an open event.

### 5. Medium-Low: trust policy is duplicated across depeg detection, confirmation, DEWS, and UI copy

Evidence:

- Live detection uses directional signal objects plus protocol corroboration:
  [worker/src/cron/detect-depegs.ts:43](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L43),
  [worker/src/cron/detect-depegs.ts:73](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L73),
  [worker/src/cron/detect-depegs.ts:463](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/detect-depegs.ts#L463)
- Confirmation reimplements threshold logic separately and drifts:
  [worker/src/cron/confirm-pending-depegs.ts:197](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L197),
  [worker/src/cron/confirm-pending-depegs.ts:248](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L248),
  [worker/src/cron/confirm-pending-depegs.ts:276](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/confirm-pending-depegs.ts#L276)
- DEWS has its own DEX trust read-path:
  [worker/src/cron/dews/source-state.ts:85](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/dews/source-state.ts#L85)
- Public copy has already drifted from the live contract:
  [src/app/depeg/page.tsx:31](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx#L31),
  [src/app/depeg/page.tsx:35](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx#L35)

Impact:

- The bugs above are not isolated mistakes; they are symptoms of policy duplication.
- Each new feature risks re-encoding thresholds, freshness rules, and direction semantics slightly differently.
- That makes the system harder to extend with confidence.

Recommendation:

- Introduce a shared “peg signal evaluation” module that all consumers use for:
  direction derivation,
  threshold crossing,
  secondary confirmation eligibility,
  recovery eligibility,
  source trust tiering.
- Keep API serialization and UI copy thin wrappers around those shared contracts.

### 6. Low: docs/comments have drifted enough that they are no longer fully trustworthy for operators

Evidence:

- Public FAQ says Peg Score is null below 30 days, but the actual implementation uses 7 days:
  [src/app/depeg/page.tsx:31](/Users/ahirice/Documents/git/stablecoin-dashboard/src/app/depeg/page.tsx#L31),
  [shared/lib/peg-score.ts:109](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/peg-score.ts#L109),
  [shared/lib/peg-score.ts:111](/Users/ahirice/Documents/git/stablecoin-dashboard/shared/lib/peg-score.ts#L111)
- DEWS worker comments still claim a 15-minute cadence, while the verified doc says `10,40 * * * *`:
  [worker/src/cron/compute-dews.ts:5](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts#L5),
  [worker/src/cron/compute-dews.ts:25](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/compute-dews.ts#L25),
  [docs/dews.md:153](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md#L153),
  [docs/dews.md:155](/Users/ahirice/Documents/git/stablecoin-dashboard/docs/dews.md#L155)

Impact:

- This is low direct runtime risk, but it is real operational risk.
- In a methodology-heavy product, stale explanatory copy causes bad debugging decisions and erodes user trust faster than silent internal drift.

Recommendation:

- Treat depeg/DEWS copy like an API contract: update it in the same change set as behavior.
- Add a lightweight doc-sync check for the highest-risk surfaced facts:
  Peg Score minimum history,
  DEWS cadence,
  depeg confirmation sources.

## Healthy Areas

- The live detector has meaningful guardrails:
  direct native-peg vetoes, DEX protocol corroboration, pool challenger vetoes, and explicit orphan handling are all good design choices.
- The DEWS job reports degraded runs and malformed persisted inputs instead of silently publishing over bad upstream state.
- The test surface on the core worker flows is good enough that targeted bugfixes here should be low risk once implemented.

## Validation Run

- `npm test -- worker/src/cron/__tests__/detect-depegs.test.ts worker/src/cron/__tests__/confirm-pending-depegs.test.ts worker/src/cron/__tests__/compute-dews.test.ts worker/src/api/__tests__/depeg-events.test.ts worker/src/api/__tests__/peg-summary.test.ts worker/src/api/__tests__/stress-signals.test.ts src/hooks/__tests__/use-depeg-events.test.tsx src/components/__tests__/dews-summary.test.ts src/__tests__/depeg-tracker-sort.test.ts`
  Result: 9 files, 87 tests passed
- `npm run typecheck`
  Result: passed
- `cd worker && npx tsc --noEmit`
  Result: passed
- `npm run lint`
  Result: failed on an unrelated pre-existing warning in [worker/src/cron/blacklist/__tests__/balance-providers.test.ts:3](/Users/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/blacklist/__tests__/balance-providers.test.ts#L3)

## Recommended Fix Order

1. Fix direction-aware confirmation in `confirmPendingDepegs()`.
2. Replace pending-row `DO NOTHING` with an update-aware incident model.
3. Align DEWS divergence trust with the rest of the depeg pipeline.
4. Repair native-quote recovery persistence.
5. Centralize peg/depeg trust evaluation and sync the surfaced docs/comments.
