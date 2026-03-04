# Status Reliability Hardening - Specification and Implementation Plan

Date: 2026-03-04  
Status: Implemented in this changeset

## 1) Problem Statement

The status page repeatedly diverged from observed API endpoint health. Operators saw `degraded` while endpoint probes were green. Root causes:

1. Cron runs marked `degraded` (fallback mode) were treated as availability failures.
2. Data-quality conditions used sticky absolute triggers (`blacklistMissingAmounts > 0`) with weak recovery semantics.
3. Overall status lacked explicit causes, confidence, and transition history.
4. No discrepancy signal existed between status synthesis and independent endpoint probes.

## 2) Reliability Contract (SLI-Aligned)

Status layers:

1. `availabilityStatus`
   - Driven by cache freshness + cron execution health.
   - Availability-impacting cron states: `error`, stale/missing runs, and `skipped_locked` without fresh `ok`.
   - Non-impacting warning cron state: `degraded`.
2. `dataQualityStatus`
   - Driven by missing price ratio, blacklist gap ratio/recentness, on-chain stale/divergence ratios.
3. `overallStatus`
   - Effective status from hysteresis state machine over the raw worst-of availability/data-quality signal.

Canonical status levels:

1. `healthy`: no SLI breach; warning channel may still exist.
2. `degraded`: sustained partial impairment or elevated risk.
3. `stale`: severe impairment or stale core data.

## 3) Thresholds and Cause Model

### 3.1 Availability (raw)

`stale`:

1. `worstCacheRatio > 2`, or
2. any cron `error`, or
3. `unhealthyCrons >= 3`

`degraded`:

1. `worstCacheRatio > 1.5`, or
2. `unhealthyCrons > 0`

Warning-only channel:

1. Fresh cron runs with `status = degraded` are counted as warning (`summary.degradedCrons`) but do not reduce availability health by themselves.

### 3.2 Data Quality (raw)

`stale`:

1. `missingPriceRatio > 0.4`
2. `blacklistMissingRatio >= 0.02`
3. `blacklistRecentMissingAmounts >= 25` in last 24h
4. `staleOnchainSupply >= 10`
5. `onchainSupplyDivergences >= 25`
6. `onchainStaleRatio >= 0.25`
7. `onchainDivergenceRatio >= 0.25`

`degraded`:

1. `missingPriceRatio > 0.15`
2. `blacklistRecentMissingAmounts > 0` in last 24h
3. `blacklistMissingRatio >= 0.005`
4. `onchainStaleRatio >= 0.1`
5. `onchainDivergenceRatio >= 0.1`

## 4) State Machine and Hysteresis

Raw status is computed each evaluation. Effective status is persisted in `status_state`.

Escalation:

1. `healthy -> degraded`: requires `raw=degraded` for 2 consecutive evaluations.
2. `healthy -> stale`: immediate when `raw=stale`.
3. `degraded -> stale`: requires `raw=stale` for 2 consecutive evaluations.

Recovery:

1. `degraded -> healthy`: requires `raw=healthy` for 3 consecutive evaluations and minimum dwell time.
2. `stale -> degraded`: requires `raw=degraded` for 2 consecutive evaluations and stale minimum dwell time.
3. `stale -> healthy`: requires `raw=healthy` for 3 consecutive evaluations and stale minimum dwell time.

Self-healing behavior:

1. Recovery requires sustained healthy raw checks; no manual action needed.

## 5) Transition Timeline and Auditability

Every effective status change writes an append-only record in `status_transitions` with:

1. from/to status
2. raw status at transition time
3. transition reason
4. confidence
5. structured causes
6. timestamp

This provides incident chronology and recurrence visibility.

## 6) Discrepancy Detection

Independent synthetic probes run in cron (`status-self-check`) against critical public endpoints.

Probe status:

1. `healthy`: 100% pass and low tail latency.
2. `degraded`: partial pass or elevated latency.
3. `stale`: broad failures.

Divergence:

1. Compare effective status (state machine) with latest probe status.
2. If severity delta >= 1 and probe data is fresh, mark divergence in response.
3. Persist discrepancy streak state and alert on sustained divergence.

## 7) Staleness of Status System Itself

Status response includes:

1. `staleness.ageSeconds` from last status evaluation.
2. `staleness.maxAgeSec` expected freshness window.
3. `staleness.isStale` flag.

UI additionally warns if client-side refresh data is older than expected polling interval.

## 8) API Contracts

### 8.1 `GET /api/status` (admin)

Now returns:

1. raw/effective status context
2. structured causes
3. confidence score
4. state-machine counters/dwell info
5. staleness signal
6. latest probe summary
7. discrepancy signal
8. recent transition timeline

### 8.2 `GET /api/status-history` (admin)

Machine-readable transition/probe history for tooling and incident analysis.

## 9) Coverage and Representation

Status endpoint registry is expanded to include missing user-critical API flows in probe groups where applicable, reducing false negatives from unmonitored routes.

## 10) Verification Requirements

Required checks:

1. Unit tests for:
   - warning-only cron degraded state
   - hysteresis transition gating
   - blacklist historical-vs-recent behavior
   - transition persistence
   - discrepancy evaluation
2. Full repo validation:
   - `npm run build`
   - `npm run lint`
   - `cd worker && npx tsc --noEmit`
   - `npm test`
