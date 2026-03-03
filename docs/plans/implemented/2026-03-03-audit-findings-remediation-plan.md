# Audit Findings Remediation Plan (2026-03-03)

## 1. Objective

Document a complete remediation plan for the five issues found in the latest code audit, with concrete implementation steps, tests, rollout sequencing, and acceptance criteria.

## 2. Scope

In scope:

1. Mint/burn circuit-breaker health reporting mismatch.
2. Alchemy batch timestamp mapping bug (response-order assumption).
3. URL filter helper clearing `"1"` unexpectedly.
4. DEWS radar mobile tap behavior regression (no navigation).
5. Render-time state updates in leaderboard tables.

Out of scope:

1. Any versioning/changelog system work for Stability Index, Blacklist Tracker, Depeg/DEWS methodology versioning, and Liquidity methodology versioning.

## 3. Issue Matrix

| ID | Severity | Area | Files |
| --- | --- | --- | --- |
| A1 | High | Worker cron + circuit breaker | `worker/src/index.ts`, `worker/src/cron/sync-mint-burn.ts`, tests |
| A2 | High | Alchemy log/timestamp client | `worker/src/lib/alchemy-logs.ts`, tests |
| A3 | Medium | Frontend URL filters | `src/hooks/use-url-filters.ts`, page clients/tests |
| A4 | Medium | DEWS UI interaction | `src/components/dews-summary.tsx`, interaction tests |
| A5 | Low | React render lifecycle hygiene | `src/components/depeg-tracker-table.tsx`, `src/components/yield-leaderboard.tsx` |

## 4. Remediation Details

## 4.1 A1: Mint/Burn Circuit Breaker Records Success on Resolved Hard Failures

### Problem

`recordOutcome(..., true)` is currently driven by promise resolve/reject in scheduled handler. `syncMintBurn()` can return an error payload (for example: failed chain-head precheck) without throwing, so the job resolves and is recorded as healthy.

### Root Cause

Health propagation relies on thrown errors, but `syncMintBurn()` uses non-throwing error returns for provider-level failures.

### Fix Strategy

Make provider-level hard failures throw (reject), so circuit-breaker outcome remains aligned with actual provider health.

### Code Changes

1. In `worker/src/cron/sync-mint-burn.ts`:
1. Replace non-throwing early returns for hard failure conditions with thrown errors.
1. Specifically:
1. Missing `ALCHEMY_API_KEY` should throw.
1. Failing Ethereum chain-head precheck should throw.
1. Keep partial per-contract errors non-fatal (current behavior), because they still provide useful partial progress.

2. Optional hardening (recommended):
1. If `contractsProcessed === 0` and `apiErrors > 0`, throw after loop to mark the run unhealthy when no useful work was completed.

3. Keep current scheduler logic in `worker/src/index.ts` unchanged; it will now correctly treat these failures as rejected jobs and record `recordOutcome(..., false)`.

### Tests

1. Update `worker/src/cron/__tests__/sync-mint-burn.test.ts`:
1. Change "returns zero events and error when chain head fetch fails" to expect rejection.
1. Add case for missing API key expecting rejection.
1. Keep partial-failure isolation test to ensure mixed success still resolves.

2. Add/extend scheduler-level test (if available) to assert failed mint/burn run records unsuccessful outcome.

### Acceptance Criteria

1. Provider hard-failure paths reject promise.
2. Circuit breaker opens after repeated provider hard-failures.
3. Mixed-success runs still process healthy contracts.

## 4.2 A2: Alchemy Batch Timestamp Mapping Uses Array Position Instead of JSON-RPC ID

### Problem

`resolveBlockTimestamps()` maps `responses[j] -> batch[j]`, assuming server response order equals request order.

### Root Cause

JSON-RPC batch responses are not guaranteed to preserve request order.

### Fix Strategy

Map each response by `response.id` back to the original request index.

### Code Changes

1. In `worker/src/lib/alchemy-logs.ts`:
1. Parse batch response as array, validate each item.
1. For each response:
1. Read numeric `id`.
1. Validate `id` bounds (`0 <= id < batch.length`).
1. Map `batch[id]` to parsed timestamp.
1. Ignore malformed/out-of-range IDs safely.

2. Keep existing warning behavior for HTTP and fetch failures.

### Tests

Add/extend tests in `worker/src/lib/__tests__/alchemy-logs.test.ts`:

1. Shuffled response order still yields correct block->timestamp mapping.
2. Out-of-range IDs are ignored.
3. Duplicate IDs use last valid mapping or first valid mapping (choose and document deterministic behavior).
4. Non-array response body handling remains safe.

### Acceptance Criteria

1. Timestamp mapping is order-independent.
2. Existing tests pass plus new order-independence tests.

## 4.3 A3: URL Filter Hook Treats `"1"` as a Global Clear Sentinel

### Problem

`useUrlFilters()` currently deletes params when value is `"1"`, causing valid values like search query `"1"` to be dropped.

### Root Cause

A generic clear-sentinel list includes `"1"` even though not all params treat `"1"` as "default".

### Fix Strategy

Remove `"1"` from global clear logic; only clear on explicit empty/default values that are semantically global (`""`, `"all"`).

### Code Changes

1. In `src/hooks/use-url-filters.ts`:
1. Update `isClearValue()` to return true only for `""` and `"all"`.
1. Update inline docs in the same file to remove `"1"` from behavior contract.

2. Verify callsites:
1. `src/app/depeg/client.tsx`
1. `src/app/liquidity/client.tsx`
No changes required if they already pass expected values.

### Tests

1. Add unit test for hook utilities (or extract `isClearValue` to a pure helper and unit test it):
1. `"1"` should be preserved.
1. `""` and `"all"` should clear.

2. Add integration smoke for URL behavior:
1. Setting search to `"1"` keeps `?q=1`.
1. Reload reads `q=1` correctly.

### Acceptance Criteria

1. User can search `"1"` and keep that query in URL.
2. No unintended param deletions for numeric strings.

## 4.4 A4: DEWS Radar Mobile Tap No Longer Navigates

### Problem

On coarse pointers, tapping a DEWS dot toggles tooltip state only; navigation is never executed.

### Root Cause

`onClick` path for touch mode replaced navigation with tooltip toggling and omitted a path to push route.

### Fix Strategy

Use two-step touch interaction:

1. First tap: show tooltip.
2. Second tap on same dot: navigate to stablecoin detail.

This preserves context preview while restoring discoverable navigation.

### Code Changes

1. In `src/components/dews-summary.tsx` (`DEWSRadar` coin click handler):
1. Desktop/fine pointer: keep immediate navigation.
1. Coarse pointer:
1. If tapped coin is not currently selected, set `hoveredId`.
1. If tapped coin is already selected, call `onCoinClick(id)` and clear selection.

2. Optional UX polish:
1. Add small "Tap again to open" hint in tooltip for coarse pointers.

### Tests

1. Add component interaction test for coarse pointer mode:
1. First tap selects tooltip.
1. Second tap navigates.

2. Verify keyboard interaction remains unchanged.

### Acceptance Criteria

1. Mobile users can navigate from radar dots.
2. Tooltip interaction remains available.

## 4.5 A5: Render-Time `setState` in Leaderboard Components

### Problem

Two table components call `setState` during render when row count changes.

### Root Cause

Pagination reset logic is implemented inline in render phase (`if (prevCount !== count) setState(...)`), which is not render-pure.

### Fix Strategy

Move pagination reset to `useEffect` keyed by data-length changes.

### Code Changes

1. In `src/components/depeg-tracker-table.tsx`:
1. Remove render-phase `prevRowCount` state block.
1. Add `useEffect(() => setPage(0), [rows.length]);`.

2. In `src/components/yield-leaderboard.tsx`:
1. Remove render-phase `prevCount` state block.
1. Add `useEffect(() => setPage(0), [rankings.length]);`.

### Tests

1. Add/adjust component tests:
1. Pagination resets to first page when filtered dataset size changes.
1. No render-loop behavior.

2. Lint check should no longer report these `set-state-in-render` patterns for these components.

### Acceptance Criteria

1. No render-phase state updates in these files.
2. Pagination reset behavior is preserved.

## 5. Validation Plan

After implementing all five fixes:

1. `npm run lint`
2. `npm test`
3. `cd worker && npx tsc --noEmit`
4. `npm run build`
5. Targeted regression checks:
1. Mint/burn hard-failure path toggles circuit-breaker failure outcome.
2. Alchemy shuffled batch response test passes.
3. `?q=1` remains in depeg/liquidity filters.
4. Mobile DEWS radar double-tap navigation works.
5. Pagination still resets correctly after filtering.

## 6. Rollout Plan

Recommended PR sequence:

1. PR-1: A2 (timestamp mapping) + tests.
2. PR-2: A1 (circuit-breaker health propagation) + tests.
3. PR-3: A3 + A5 (frontend behavior + lifecycle hygiene) + tests.
4. PR-4: A4 (mobile DEWS interaction) + tests + quick UX QA.

Reasoning:

1. Worker correctness fixes first (high severity, backend reliability).
2. Frontend quality fixes after backend signal correctness is locked.
3. Interaction-only change last for focused QA.

## 7. Risk Notes

1. A1:
1. Throwing where code previously returned may increase observed cron failures immediately. This is desired because it reflects real provider health.

2. A2:
1. Low-risk change if ID bounds are validated and malformed entries are ignored.

3. A3:
1. If any existing flow relied on `"1"` to clear, that flow must explicitly pass `""` or `"all"` instead.

4. A4:
1. Touch behavior must be tested on real device/emulation to ensure second-tap navigation works consistently.

5. A5:
1. Ensure `useEffect` reset does not interfere with server-side hydration behavior.

## 8. Definition of Done

All items below must be true:

1. All five fixes are merged.
2. New tests for each issue are merged and passing.
3. No regressions in `npm run lint`, `npm test`, worker typecheck, and build.
4. Manual QA confirms:
1. Mint/burn provider hard-failure affects circuit breaker.
1. DEWS mobile dot navigation works.
1. `q=1` query persistence works.
5. Audit findings A1-A5 are marked resolved.
