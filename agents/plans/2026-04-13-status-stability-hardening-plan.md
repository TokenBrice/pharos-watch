# Status Stability Hardening Plan

Date: 2026-04-13

## Goal

Eliminate the remaining false-positive degradation cycles in Pharos status reporting by (1) raising the `missingPriceRatio` degraded threshold from 0.15 to 0.18 so the normal ~15% operating point no longer flaps at the boundary, plus adding an info-severity `missing_prices_elevated` cause for early-warning observability in the 15-18% band, (2) suppressing two persistent info-severity causes (`watch_unhealthy_crons_present` and `onchain_monitor_low_sample`) that fire forever without a real issue, and (3) reconciling the semantic divergence between `/api/health` (public, unsmoothed, no data-quality signals) and `/api/public-status-history` (admin-state machine, includes data-quality flaps) so the public `/status/` page hero and the uptime bar/transition timeline tell a single, coherent story.

## Background and root-cause summary

The April 6 remediation plan (`2026-04-06-health-status-remediation-plan.md`) and the April 11 fixes (`ffefafdf` / `77d2580d`) already addressed the dominant pre-Apr-11 failure mode: a single `sync-stablecoins` DL parse failure instant-escalating the public status to `stale` via `raw-stale-immediate-escalation`. The April 11 fixes added `availabilityImpactingConsecutiveCronErrors` so a single transient critical-cron error now only escalates to `degraded`, and added a 3-retry loop for DL parse failures.

Those fixes worked. Prod data confirms that after Apr 11 09:20 CEST there has not been a single `raw-stale-immediate-escalation` event from a transient cron error. But a second failure mode remains.

### Evidence (collected 2026-04-13 from `stablecoin-db` prod D1)

Transitions in the last 21 days:

| reason | count |
|---|---|
| raw-stale-immediate-escalation | 47 (all pre-Apr-11 fix) |
| raw-healthy-recovery-from-stale | 43 |
| raw-healthy-recovery-threshold | 24 |
| raw-degraded-consecutive-threshold | 20 |
| raw-degraded-recovery-from-stale | 13 |
| raw-stale-consecutive-threshold | 9 |

Post-Apr-11 fix (last ~38 hours of data), the only degrade→recover pattern is:

| at | reason | primary cause |
|---|---|---|
| 2026-04-12 12:39:53 → 13:39:53 | degraded for 60 min | `missing_prices_degraded (15.14% > 15.00%)` |
| 2026-04-12 16:25:09 → 2026-04-13 00:10:08 | degraded for 7h 45min | `missing_prices_degraded (15.14% > 15.00%)` |
| 2026-04-13 01:40:12 → 02:25:10 | degraded for 45 min | `missing_prices_degraded (15.14% > 15.00%)` |

Every single post-fix healthy→degraded transition is driven solely by the same cause: `missing_prices_degraded` at 15.14%. The metric value `missingPriceRatio = 0.1513647642679901` appears identically across every one of those transitions. There are no `cron_error_runs` causes and no other warning-severity causes in the post-fix window.

The system is spending approximately **25% of wall-clock time in `degraded`** (~9.5 hours out of 38) not because anything is actually broken but because the missing-price ratio is hovering just above the 15.00% degraded threshold with no hysteresis band.

Canonical tracked count: **194 stablecoins** (`shared/data/stablecoins/canonical-order.json`). 15% of 194 = 29.1. Thirty coins missing prices ≈ 15.46%; twenty-nine ≈ 14.95%. The system literally flips degraded/healthy based on whether exactly one coin's price comes back or not during a given run.

Two additional info-severity causes fire in every status evaluation (post-fix and pre-fix alike):

- `watch_unhealthy_crons_present: 1 watch-tier cron job(s) unavailable/stale` — driven by `yield-coverage-audit`, which has **zero rows in `cron_runs`** despite its `0 6 1 * *` trigger being registered in `worker/wrangler.toml` since commit `b77b01710` on 2026-03-26. The Apr 1 06:00 UTC trigger should have fired but did not (or fired and failed to log). This is a perpetual info false positive.
- `onchain_monitor_low_sample: only 2 recently refreshed coin(s)` — `onchain_supply` table contains exactly 2 rows (KAU + KAG), because only `sync-kinesis-supply` writes to it. The ratio-threshold 10 will never be reached with the current writer set, so this cause fires forever and adds nothing.

Neither info cause affects `availabilityStatus` or `dataQualityStatus`, so they do not drive degradations by themselves. But they permanently occupy two slots in every causes array, inflate the diagnostic issue count, and mask legitimate issues. Fixing them is a net observability improvement.

### UI divergence

`/api/health` (used by `PublicStatusHero` via the `useHealth` hook) returns `overallStatus = maxPublicStatus(cacheImpactStatus, mintBurnImpactStatus, circuitImpactStatus, blacklistQueryError ? "degraded" : "healthy")`. It does **not** include missing-price ratio, cron health, reserve coverage, or any other data-quality signal.

`/api/public-status-history` (used by `UptimeBar` and `PublicTransitionTimeline` via the `usePublicStatusHistory` hook) returns the state-machine-smoothed `currentStatus` and the full list of `status_transitions` rows. Those transitions include every `missing_prices_degraded` flap, even though `/api/health` would never reflect that.

Net result: on a typical day the hero says "Public surface steady / healthy" while the uptime bar below shows amber days and the transition timeline shows 2-6 entries for the previous 24h. Users see inconsistent signals on the same page.

This is the primary sense in which `/status/` over-reports: the transition timeline surfaces admin-level data-quality blips that have no impact on the `/api/health`-backed public read path.

### Ancillary observations (not root causes, noted for context)

- `sync-stablecoins` takes 212s-480s per run (average ~249s post-fix vs ~221s pre-fix) and hit the 480s hard timeout twice post-fix (Apr 11 17:16 and 20:00 UTC). This is a chronic slowness issue independent of the status-reporting problem. It is not the cause of current degradations (the state machine correctly smooths those single errors now) but it creates capacity pressure on the 15-minute critical lane and should be tracked as a separate followup. Explicitly out of scope for this plan.
- `sync-dex-liquidity` has a value-coverage guard that tripped multiple times on Apr 11-12 (`currentGlobalTvl=7055074706 < minExpectedGlobalTvl=7108189773`). `sync-dex-liquidity` is a `watch`-tier cron so its errors do not drive availability status, but the recurring guard trips may indicate either a real market event or a bug in TVL aggregation. Also out of scope.

## Success criteria

- No `missing_prices_degraded` state transition fires when the missing-price ratio is between 0.15 and 0.18 (the new elevated band). `raw-degraded-consecutive-threshold` transitions whose primary cause is `missing_prices_degraded` drop to **zero** in the first 7 days after rollout, down from 3+/day pre-fix.
- Total `status_transitions` rows per day (all causes, all reasons) drops to **≤ 2/day** in the first 7 days after rollout, down from 6+/day pre-fix.
- `/api/status.causes.availability` does not contain `watch_unhealthy_crons_present` when the only watch-tier cron with no history is `yield-coverage-audit` (bootstrap suppression). All other watch-tier crons with real history continue to report unhealthy when they are.
- `/api/status.causes.dataQuality` does not contain `onchain_monitor_low_sample` when the on-chain monitor is at the structural floor (tracked coins < 3). Tracked counts in [3, 9] still emit the info cause.
- `/api/health.status` and `/api/public-status-history.currentStatus` return identical values for the same timestamp. The `/status/` public page hero badge matches the uptime bar's rightmost segment color.
- `/api/public-status-history.transitions` only contains rows whose `causes` include at least one public-impacting code. Missing-price-only transitions are filtered out.
- `summary.transitionsLast24h` is present in `/api/status` and is ≤ 2 under normal operation.
- All existing tests in `worker/src/api/__tests__/status.test.ts`, `worker/src/lib/__tests__/status-reliability.test.ts`, `worker/src/lib/status/__tests__/cron-health.test.ts`, and frontend `src/lib/__tests__/status-dashboard-model.test.ts` either still pass unchanged or are updated in-place with a commit message referencing this plan. Brand-new test files in Workstreams 1, 2, 3, 4, 5 pass. `npm run test:merge-gate` passes cleanly before merge.

## Explicit non-goals

- No investigation of `sync-stablecoins` runtime performance. The slowness is real but orthogonal to the status-flapping issue this plan targets; it should be its own planning cycle.
- No change to the `availability` lane derivation logic (`deriveAvailabilityStatus`). The Apr 6 + Apr 11 remediations already handle that lane correctly.
- No change to the `reserve-composition` lane logic. It is already ratio-based with sensible thresholds.
- No schema migration. `status_state` stays as-is.
- No state-based hysteresis bands or per-lane status tracking. Round 1 review rejected that approach because of cross-lane coupling risk (see the Round 1 notes below). This plan fixes the flapping by raising the threshold instead.
- No broader redesign of the public `/status/` page layout or copy. The `getImpactedPublicSurfaces` logic is intentionally preserved.
- No fix for the root cause of the 29-30 persistently-missing-price coins in this plan. Workstream 6 produces a research artifact identifying those coins; a follow-up plan will triage them.
- No fix for the scheduled-event dispatch that caused `yield-coverage-audit` to miss its Apr 1 window. Workstream 2 paper-covers the resulting cron-health false positive; the May 1 verification in Workstream 7 decides whether a real fix is urgent.

## Design decisions

### 1. Raise the `missingPriceRatio` threshold (no hysteresis state)

Prod evidence: `missingPriceRatio` is flapping at ~14.95% ↔ ~15.14%, straddling the `ratioDegraded = 0.15` boundary. Normal operating point is roughly 29-30 coins missing out of ~194 tracked, which is ≈ 15% by design.

Two options considered for the fix:

- **State-based hysteresis bands** (enter 15%, exit 12%): rejected during Round 1 review because the exit threshold (12%) is below the normal operating point (14.95%), which would lock the system into permanent degraded once any unrelated lane briefly pushed the global status to degraded. See the Round 1 findings below for the full trace.
- **Raise the threshold** (enter 18% degraded, 45% stale): accepted. Stateless, no cross-lane coupling, simple to test, and the prod normal point (14.95%) is comfortably below the new 18% degraded edge.

Math with 194 tracked:

- 15.00% = 29.1 coins (old boundary)
- 15.14% = 29.4 coins (observed degraded sample)
- 18.00% = 34.9 coins (new degraded edge)
- 35 coins missing = 18.04% → degraded
- 34 coins missing = 17.53% → healthy

Operators still get an early-warning signal for missing-price drift via a new **info-severity** cause `missing_prices_elevated` that fires in the 15%-18% band without affecting `dataQualityStatus`. This is consistent with how `onchain_monitor_low_sample` currently works: a diagnostic that shows up in the causes array for observability without driving the status label.

### 2. Leave blacklist and cache thresholds unchanged

`blacklistMissingRatio` (degraded 1%, stale 2%) and `cacheFreshnessRatio` (degraded 8x, stale 12x) are not observed flapping in prod. Prod `/api/health` snapshot:

- `blacklist.missingAmounts = 0`
- All cache `healthy: true` with ratios well below 8.0x

Changing thresholds that are not misbehaving is YAGNI. If flapping appears later, the fix pattern from this plan can be re-applied.

### 3. No hysteresis state machine changes

The April 6 remediation already implemented the global status hysteresis correctly (`escalateToDegraded = 2`, `recoverToHealthy = 3`, dwell). Combined with the April 11 consecutive-cron-error counter, the state machine is doing its job. The problem this plan targets is purely the signal-level threshold configuration, not the hysteresis engine.

### 4. `yield-coverage-audit` — short-term suppression, verification-gated

The wiring inspection (`worker/src/handlers/scheduled.ts:37 → monthly-yield-audit.ts → runLeasedCron("yield-coverage-audit", ...)`) looks correct. The trigger string `"0 6 1 * *"` is in `worker/wrangler.toml:49` and was added in commit `b77b01710` on 2026-03-26 (before the Apr 1 window). But the job has zero rows in `cron_runs`, meaning either the scheduled event dispatch failed, the lease/fence wrapper threw before the cron logger ran, or the runner body raised an error silently before recording.

Short-term (this plan): stop the false-positive `watch_unhealthy_crons_present` info cause by treating a watch-tier cron with zero runs as bootstrap-healthy — parallel to the `reserveComposition.bootstrap` pattern in `evaluation-state.ts:33-34`.

Safety-gated rollout: Workstream 8 explicitly schedules a verification check on 2026-05-01 (the next monthly trigger) confirming that a row exists in `cron_runs` after 06:00 UTC. If not, the bootstrap guard is silently hiding a real failure, and the follow-up investigation (instrument the scheduled-event handoff) becomes urgent instead of tracking. The Workstream 3 bootstrap guard is intentionally a paper cover; the plan commits to replacing it with a real fix if May 1 fails to produce a row.

### 5. `onchain_monitor_low_sample` — suppress when design-intentional

Currently only `sync-kinesis-supply` writes to `onchain_supply`, which permanently caps tracked coins at 2. The ratio-based divergence threshold requires ≥ 10 tracked coins. So this cause will fire forever at severity `info` until either (a) more on-chain writers are added or (b) the threshold is lowered.

Neither (a) nor (b) is the right move inside this plan — option (a) is a feature expansion out of scope, and option (b) would surface noisy divergence ratios. The right move is to suppress the info cause entirely when `onchainSupplyMonitoring === "unavailable"` or when the tracked count is less than the threshold **and** the monitor has simply never been populated beyond that. Tracked coins ≥ 3 but < 10 should still surface the cause as "limited coverage" so a human can notice.

### 6. Align `/api/health` and state-machine semantics for the public UI

The cleanest fix has two parts:

**Part A — transition filtering.** `handlePublicStatusHistory` filters the state-machine's `status_transitions` rows down to only those whose causes include at least one public-facing impact. Public-facing impact means any cause whose code is one of: `cache_ratio_*`, `cache_freshness_query_failed`, `cache_warning`, `fx_source_stale`, `fx_source_degraded`, `fx_cached_fallback`, `mint_burn_public_*`, `mint_burn_health_query_failed`, `open_circuit_groups`, `circuit_query_failed`, `cron_error_runs` (critical severity only), `multiple_unhealthy_crons`, `unhealthy_crons_present`, or `db_unhealthy`. Explicitly excluded: `missing_prices_*`, `blacklist_gaps_*`, `reserve_sync_*`, `onchain_*`, `watch_*`, and any `info`-severity cause.

**Part B — public `currentStatus` source.** `handlePublicStatusHistory` computes its `currentStatus` field from `assessPublicHealth(db, now)` (the same function `/api/health` uses) rather than `status_state.current_status` (the admin hysteresis-smoothed global). This guarantees the hero badge and the uptime bar top-segment always agree. The tradeoff is that the public `currentStatus` is unsmoothed, but `/api/health` is already unsmoothed and the transition history gives temporal context, so the uptime bar still tells a coherent story.

Missing-price ratio flaps (now much rarer under the raised threshold) remain visible on the admin `/status/` (which uses the full `StatusResponse` via `/api/status`) but do not leak into the public transition log.

### 7. Keep the existing `/api/status` response shape

No contract changes to `/api/status`. Admin dashboards, integration tests, and the status-self-check cron probing path all stay working unchanged. All the new logic lives inside the derivation helpers and the `handlePublicStatusHistory` handler.

## File structure

### New files

- `shared/lib/status-public-impact.ts` — the shared public-impact helper used by Workstream 4.
- `worker/src/api/__tests__/public-status-history.test.ts` — new test file for Workstream 4 (only if the file does not already exist; if it does, extend it).
- `agents/research/2026-04-13-missing-price-coins-audit.md` — research artifact from Workstream 6 step 4.

### Modified files

Shared:

- `shared/lib/status-thresholds.ts` — raise `STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded` (0.15 → 0.18) and `ratioStale` (0.40 → 0.45). Add `ratioElevated: 0.15`. No other constants changed.
- `shared/types/status.ts` — extend `CronStatus` with optional `bootstrap?: boolean` (Workstream 2) and `StatusResponse["summary"]` with `transitionsLast24h: number` (Workstream 5).

Worker:

- `worker/src/lib/status/evaluation-causes.ts` — add the `missing_prices_elevated` info branch (Workstream 1). No changes to `deriveDataQualityStatus` logic beyond picking up the raised constants.
- `worker/src/lib/status/cron-health.ts` — add the watch-tier bootstrap guard (Workstream 2).
- `worker/src/lib/status/onchain-data-quality.ts` — add the structural floor guard (Workstream 3).
- `worker/src/api/public-status-history.ts` — import the public-impact helper, call `assessPublicHealth`, filter transitions, use `assessPublicHealth.overallStatus` for `currentStatus` (Workstream 4).
- `worker/src/lib/status-evaluation.ts` — add `transitionsLast24h` count query and include it in the summary (Workstream 5).

Docs:

- `docs/status-dashboard.md` — raised thresholds, elevated band, public-impact filter semantics.
- `docs/api-reference.md` — updated `/api/public-status-history` description.

Tests (see Workstream-specific steps for full code):

- `worker/src/api/__tests__/status.test.ts` — raised thresholds + elevated cause tests, onchain suppression tests.
- `worker/src/lib/status/__tests__/cron-health.test.ts` — bootstrap guard tests.
- `worker/src/api/__tests__/public-status-history.test.ts` — new file for transition filter + current-status alignment tests.

## Implementation workstreams

### Workstream 1: Raise `missingPriceRatio` thresholds and add `missing_prices_elevated` early-warning cause

**Files:**
- `shared/lib/status-thresholds.ts`
- `worker/src/lib/status/evaluation-causes.ts`
- `worker/src/api/__tests__/status.test.ts`

**Step 1: Write the failing tests.**

Add a describe block to `worker/src/api/__tests__/status.test.ts`:

```typescript
describe("missingPriceRatio raised thresholds", () => {
  it("stays healthy at 34 missing out of 194 (17.53% — just below 18%)", async () => {
    const db = buildFakeStatusDb({
      totalStablecoins: 194,
      missingPrices: 34,
      currentStatus: "healthy",
    });
    const response = await handleStatus(db, /* trustedAdmin */ true);
    const body = await response.json();
    expect(body.dataQualityStatus).toBe("healthy");
    expect(body.causes.dataQuality.map((c: any) => c.code)).not.toContain("missing_prices_degraded");
  });

  it("degrades at 36 missing out of 194 (18.56% — above 18%)", async () => {
    const db = buildFakeStatusDb({
      totalStablecoins: 194,
      missingPrices: 36,
      currentStatus: "healthy",
    });
    const response = await handleStatus(db, true);
    const body = await response.json();
    expect(body.dataQualityStatus).toBe("degraded");
    const cause = body.causes.dataQuality.find((c: any) => c.code === "missing_prices_degraded");
    expect(cause).toBeDefined();
    expect(cause.threshold).toBe(0.18);
  });

  it("stays healthy at 30 missing out of 194 (15.46% — in the elevated band)", async () => {
    const db = buildFakeStatusDb({
      totalStablecoins: 194,
      missingPrices: 30,
      currentStatus: "healthy",
    });
    const response = await handleStatus(db, true);
    const body = await response.json();
    expect(body.dataQualityStatus).toBe("healthy");
    // Elevated info cause surfaces for observability without affecting status
    const elevated = body.causes.dataQuality.find((c: any) => c.code === "missing_prices_elevated");
    expect(elevated).toBeDefined();
    expect(elevated.severity).toBe("info");
  });

  it("does not emit missing_prices_elevated when ratio is below 15%", async () => {
    const db = buildFakeStatusDb({
      totalStablecoins: 194,
      missingPrices: 20,
      currentStatus: "healthy",
    });
    const response = await handleStatus(db, true);
    const body = await response.json();
    const elevated = body.causes.dataQuality.find((c: any) => c.code === "missing_prices_elevated");
    expect(elevated).toBeUndefined();
  });

  it("goes stale at 90 missing out of 194 (46.39% — above the new 45% stale bar)", async () => {
    const db = buildFakeStatusDb({
      totalStablecoins: 194,
      missingPrices: 90,
      currentStatus: "healthy",
    });
    const response = await handleStatus(db, true);
    const body = await response.json();
    expect(body.dataQualityStatus).toBe("stale");
  });
});
```

If a helper named `buildFakeStatusDb` does not already exist in the test file, create a small fixture-builder at the top of the test file that composes the existing D1 mock patterns. Reuse the existing mocking style (`{ match, rows, first }` entries) — do not introduce a new mocking framework.

**Step 2: Run the new tests and confirm they fail.**

```bash
npm test -- worker/src/api/__tests__/status.test.ts -t "raised thresholds"
```

Expected: failures — the thresholds still say 0.15 and 0.40, and the elevated cause does not exist.

**Step 3: Bump the thresholds in `shared/lib/status-thresholds.ts`.**

```typescript
// --- Missing price thresholds ---
// Raised 2026-04-13 to eliminate boundary flap at 15%. Prior values 0.15/0.40
// were too tight for the current ~194-stablecoin tracked set: the normal
// operating point hovers at ~15% (~29-30 persistently missing-price coins),
// which produced 2-3 visible healthy↔degraded transitions per day driven
// entirely by coin-counting noise. New values 0.18/0.45 give ≈ 6 coins of
// slack above normal; the elevated band 0.15-0.18 is surfaced as an
// info-severity cause for observability without driving status.
export const STATUS_MISSING_PRICE_THRESHOLDS = {
  ratioElevated: 0.15,
  ratioDegraded: 0.18,
  ratioStale: 0.45,
} as const;
```

No other threshold constants change in this workstream. Blacklist, reserve composition, cache ratio, and on-chain thresholds remain as they are.

**Step 4: Add the `missing_prices_elevated` cause emission in `buildDataQualityCauses`.**

Modify `worker/src/lib/status/evaluation-causes.ts`:

```typescript
if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioStale) {
  pushCause(dataQualityCauses, {
    code: "missing_prices_stale",
    layer: "data-quality",
    severity: "critical",
    message:
      `Missing price ratio is stale (${formatRatio(input.missingPriceRatio)} > ` +
      `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioStale)}).`,
    metric: "missingPriceRatio",
    value: input.missingPriceRatio,
    threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioStale,
  });
} else if (input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded) {
  pushCause(dataQualityCauses, {
    code: "missing_prices_degraded",
    layer: "data-quality",
    severity: "warning",
    message:
      `Missing price ratio is degraded (${formatRatio(input.missingPriceRatio)} > ` +
      `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded)}).`,
    metric: "missingPriceRatio",
    value: input.missingPriceRatio,
    threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded,
  });
} else if (input.missingPriceRatio >= STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated) {
  pushCause(dataQualityCauses, {
    code: "missing_prices_elevated",
    layer: "data-quality",
    severity: "info",
    message:
      `Missing price ratio is elevated (${formatRatio(input.missingPriceRatio)} ≥ ` +
      `${formatRatio(STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated)}); not degrading status but worth watching.`,
    metric: "missingPriceRatio",
    value: input.missingPriceRatio,
    threshold: STATUS_MISSING_PRICE_THRESHOLDS.ratioElevated,
  });
}
```

Note: the elevated branch uses `>=` (not `>`) so the exact 15% boundary goes to elevated, not to healthy. The degraded and stale branches keep their `>` semantics.

**Step 5: Update `deriveDataQualityStatus` in `evaluation-state.ts` — nothing to do.**

The derivation function compares `input.missingPriceRatio > STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded` already. Bumping the constant in Step 3 is sufficient; no code changes needed here. Read the function to confirm it imports the same constants and does not hard-code `0.15`.

**Step 6: Confirm no other module hard-codes `0.15` or `0.40` from the thresholds.**

Use the Grep tool (not bash) to search the repo. The search needs two patterns against `worker/src` and `shared/`:

```
pattern: 0\.15
path:    /Users/ahirice/Documents/git/stablecoin-dashboard/worker/src
```

and

```
pattern: 0\.4[^0-9]
path:    /Users/ahirice/Documents/git/stablecoin-dashboard/shared
```

Also repeat for `shared/lib` and `shared/types`.

Expected matches: only the canonical constants in `shared/lib/status-thresholds.ts` (and possibly test fixture files under `__tests__/`). Any other hit means a hard-coded boundary exists in production code and must be replaced with `STATUS_MISSING_PRICE_THRESHOLDS.ratioDegraded` / `.ratioStale` imports. Test fixtures with explicit numeric expectations are allowed; just make sure they still assert the new threshold values.

**Step 7: Run the new tests and confirm they pass.**

```bash
npm test -- worker/src/api/__tests__/status.test.ts -t "raised thresholds"
```

Expected: all five pass.

**Step 8: Run the whole status test suite to check for regressions.**

```bash
npm test -- worker/src/api/__tests__/status.test.ts
```

Expected: all tests pass. Any existing test that was implicitly relying on a 0.15 degraded boundary (e.g., "30 missing → degraded") must be updated to reflect the new behavior. In those cases, explicitly state the intent in the test name: either "historical guard — 15% no longer degraded" or "raised threshold — 36 missing degrades". Do not suppress the old test silently.

**Step 9: Commit.**

```bash
git add shared/lib/status-thresholds.ts worker/src/lib/status/evaluation-causes.ts \
  worker/src/api/__tests__/status.test.ts
git commit -m "$(cat <<'EOF'
fix(status): raise missingPriceRatio thresholds, add elevated info band

The 15% ratioDegraded boundary flapped in prod because the normal
operating point with 194 tracked coins and ~29-30 persistently missing
prices is ≈ 14.95%-15.15%. Every counting-noise crossing produced a
visible healthy↔degraded transition (3+ per day). Raise ratioDegraded
to 0.18 (35 coins) and ratioStale to 0.45 to give ~6 coins of slack
above normal.

Add a new info-severity missing_prices_elevated cause for the 0.15-0.18
band so operators still see early-warning drift without the cause
affecting dataQualityStatus.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Workstream 2: Watch-tier cron bootstrap guard

A watch-tier cron that has never produced a single `cron_runs` row is in bootstrap mode, not unhealthy. Match the existing `reserveComposition.bootstrap` pattern.

**Files:**
- `worker/src/lib/status/cron-health.ts`
- Tests: `worker/src/lib/status/__tests__/cron-health.test.ts` (extend)

**Step 1: Add the failing test.**

Add to the existing cron-health test file:

```typescript
describe("watch-tier bootstrap guard", () => {
  it("does not count a never-ran watch-tier cron as unhealthy", async () => {
    const db = buildFakeCronHealthDb({
      runsByJob: {
        // yield-coverage-audit missing entirely (no rows)
        "sync-stablecoins": [{ started_at: now - 60, status: "ok", duration_ms: 3000 }],
        "sync-fx-rates": [{ started_at: now - 60, status: "ok", duration_ms: 3000 }],
        // ... etc for all other jobs
      },
    });

    const snapshot = await loadCronHealth(db, now);
    expect(snapshot.watchUnhealthyCrons).toBe(0);
    expect(snapshot.crons["yield-coverage-audit"].bootstrap).toBe(true);
    expect(snapshot.crons["yield-coverage-audit"].healthy).toBe(true);
  });

  it("still counts a critical-tier cron with no runs as unhealthy", async () => {
    const db = buildFakeCronHealthDb({
      runsByJob: {
        // sync-stablecoins missing entirely — critical, must still be flagged
      },
    });

    const snapshot = await loadCronHealth(db, now);
    expect(snapshot.availabilityImpactingUnhealthyCrons).toBeGreaterThan(0);
  });
});
```

**Step 2: Run, confirm failure.**

```bash
npm test -- worker/src/lib/status/__tests__/cron-health.test.ts -t "bootstrap"
```

Expected: failures because current logic treats any cron without recent runs as unhealthy regardless of history or tier.

**Step 3: Add `bootstrap` to the `CronStatus` shape and update `loadCronHealth`.**

Edit `shared/types/status.ts` to include an optional `bootstrap?: boolean` on `CronStatus`:

```typescript
export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
  telemetryUnknown: boolean;
  inFlight: CronInFlight | null;
  bootstrap?: boolean;
}
```

Edit `worker/src/lib/status/cron-health.ts`:

```typescript
for (const [job, interval] of Object.entries(CRON_INTERVALS)) {
  const runs = cronByJob.get(job) ?? [];
  const lastRun = runs.length > 0 ? runs[0] : null;
  const inFlight = cronProgressByJob.get(job);
  const telemetryUnknown = cronHistoryQueryFailed;
  const inFlightFresh = inFlight != null && now - inFlight.updatedAt <= Math.max(300, interval);
  const isFresh = lastRun != null && now - lastRun.startedAt <= interval * 2;
  const hasFreshOk = runs.some((run) => run.status === "ok" && now - run.startedAt <= interval * 2);
  const availabilityHealthyFromLastRun =
    isFresh &&
    lastRun != null &&
    (lastRun.status === "ok" ||
      lastRun.status === "degraded" ||
      (lastRun.status === "skipped_locked" && hasFreshOk));
  const statusImpact = getCronStatusImpact(job);

  // Bootstrap = never ran at all. For watch-tier crons (especially monthly
  // ones), a fresh install or a just-registered trigger legitimately has no
  // history yet; treating it as unhealthy produces a permanent false positive.
  // Critical-tier crons are still considered unhealthy when they've never run,
  // because the system cannot claim healthy operation without them.
  const bootstrap = runs.length === 0;
  const watchBootstrap = bootstrap && statusImpact === "watch";
  const healthy = telemetryUnknown
    ? true
    : inFlightFresh || availabilityHealthyFromLastRun || watchBootstrap;
  const availabilityUnhealthy = !telemetryUnknown && !healthy;

  if (availabilityUnhealthy) {
    unhealthyCrons++;
    if (statusImpact === "critical") {
      availabilityImpactingUnhealthyCrons++;
    } else {
      watchUnhealthyCrons++;
    }
  }

  // ... rest unchanged ...

  crons[job] = {
    lastRun,
    recentRuns: runs,
    expectedIntervalSec: interval,
    healthy,
    telemetryUnknown,
    inFlight: /* ... */,
    ...(watchBootstrap ? { bootstrap: true } : {}),
  };
}
```

**Step 4: Run and confirm passes.**

```bash
npm test -- worker/src/lib/status/__tests__/cron-health.test.ts -t "bootstrap"
```

Expected: pass.

**Step 5: Run the whole status suite.**

```bash
npm test -- worker/src/api/__tests__/status.test.ts \
  worker/src/lib/status/__tests__/cron-health.test.ts
```

Expected: all pass.

**Step 6: Commit.**

```bash
git add shared/types/status.ts worker/src/lib/status/cron-health.ts \
  worker/src/lib/status/__tests__/cron-health.test.ts
git commit -m "$(cat <<'EOF'
fix(status/cron-health): treat never-ran watch-tier crons as bootstrap

A watch-tier cron with zero historical cron_runs rows is in bootstrap
mode and does not count toward watchUnhealthyCrons. This mirrors the
existing reserveComposition bootstrap semantics and eliminates the
permanent watch_unhealthy_crons_present info cause driven by
yield-coverage-audit (which has a monthly trigger that has not yet
produced a successful run).

Critical-tier crons with zero runs still count as unhealthy because
the system cannot credibly claim availability without them.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Workstream 3: Suppress `onchain_monitor_low_sample` by design

The info cause should only fire when the on-chain monitor is partially operational (3-9 coins tracked). When the monitor is structurally at 0-2 coins because only one writer exists, firing the cause adds nothing — it's a configuration statement, not a problem.

**Files:**
- `worker/src/lib/status/onchain-data-quality.ts`
- Tests: `worker/src/api/__tests__/status.test.ts`

**Step 1: Read the existing cause builder.**

Read `worker/src/lib/status/onchain-data-quality.ts` to find where `onchain_monitor_low_sample` is pushed onto the causes array.

**Step 2: Add the failing test.**

```typescript
it("does not emit onchain_monitor_low_sample when monitor is structurally unavailable", async () => {
  const db = buildFakeStatusDb({
    onchainSupplyTrackedCoins: 2, // Kinesis KAU + KAG only
    onchainSupplyMonitoring: "active", // still reports as active — has rows
  });

  const response = await handleStatus(db, true);
  const body = await response.json();
  const hasCause = body.causes.dataQuality.some((c: any) => c.code === "onchain_monitor_low_sample");
  expect(hasCause).toBe(false);
});

it("still emits onchain_monitor_low_sample when tracked coins are in the partial range", async () => {
  const db = buildFakeStatusDb({
    onchainSupplyTrackedCoins: 6, // between the structural floor (3) and the threshold (10)
    onchainSupplyMonitoring: "active",
  });

  const response = await handleStatus(db, true);
  const body = await response.json();
  const hasCause = body.causes.dataQuality.some((c: any) => c.code === "onchain_monitor_low_sample");
  expect(hasCause).toBe(true);
});
```

**Step 3: Run, confirm failure.**

**Step 4: Update the onchain data-quality assessment.**

In the onchain assessment builder:

```typescript
// Suppression floor: when only the structural tracked set (≤ 2 coins) is
// populated, the "low sample" info cause adds no signal. It's a design
// statement, not a health issue. Emit the info cause only when the tracked
// count is in the legitimate partial-coverage band.
const STRUCTURAL_ONCHAIN_FLOOR = 3;
if (
  trackedCoins >= STRUCTURAL_ONCHAIN_FLOOR &&
  !hasRepresentativeOnchainRatioSample(trackedCoins)
) {
  causes.push({
    code: "onchain_monitor_low_sample",
    layer: "data-quality",
    severity: "info",
    message: `On-chain monitor has only ${trackedCoins} recently refreshed coin(s); ratio-based stale/degraded thresholds stay inactive until ${STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins} coins are live.`,
    metric: "onchainSupplyTrackedCoins",
    value: trackedCoins,
    threshold: STATUS_ONCHAIN_THRESHOLDS.ratioMinTrackedCoins,
  });
}
```

**Step 5: Run, confirm pass.**

**Step 6: Commit.**

```bash
git add worker/src/lib/status/onchain-data-quality.ts worker/src/api/__tests__/status.test.ts
git commit -m "$(cat <<'EOF'
fix(status/onchain): suppress low-sample info cause at structural floor

When the on-chain monitor has 0-2 tracked coins (current prod state:
KAU + KAG from sync-kinesis-supply only), the low-sample info cause
fires permanently and adds no actionable signal. Emit the cause only
when tracked coins are in the legitimate partial-coverage band (3-9).

Once additional on-chain supply writers land, the band will activate
naturally and diagnostics resume.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Workstream 4: Public transition filter and current-status alignment

The public `/status/` page should filter out admin-only status transitions driven by data-quality causes with no public-facing impact, and should source its "current public status" from the same function `/api/health` uses so the hero badge and the uptime bar/transition timeline always agree.

**Files:**
- `shared/lib/status-public-impact.ts` — new small shared helper
- `worker/src/api/public-status-history.ts`
- Tests: new `worker/src/api/__tests__/public-status-history.test.ts`

**Step 1: Write the failing tests.**

Create `worker/src/api/__tests__/public-status-history.test.ts`. Reuse whatever D1 mocking helper exists at the top of `worker/src/api/__tests__/status.test.ts` — import it or copy the pattern, do not introduce a new mocking framework:

```typescript
import { describe, it, expect, vi } from "vitest";
import { handlePublicStatusHistory } from "../public-status-history";

const now = 1776_000_000;

function buildFakeDb(params: {
  transitions: Array<{
    id: number;
    at: number;
    from: "healthy" | "degraded" | "stale" | null;
    to: "healthy" | "degraded" | "stale";
    reason: string;
    causes: Array<{ code: string; severity: "critical" | "warning" | "info"; layer: "availability" | "data-quality"; message: string }>;
  }>;
  /** Status returned by assessPublicHealth (drives the public currentStatus). */
  publicHealthStatus: "healthy" | "degraded" | "stale";
  /** Status persisted in status_state.current_status (admin hysteresis-smoothed).
   *  Defaults to `publicHealthStatus` if omitted. Set explicitly to test the
   *  case where admin state diverges from public health. */
  adminStateStatus?: "healthy" | "degraded" | "stale";
  lastChangedAt?: number;
}) {
  // Compose the same D1Database shape the real handler reads:
  //
  //   1. status_state SELECT (via getStatusStateSnapshot) → a single row with:
  //         current_status = params.adminStateStatus ?? params.publicHealthStatus,
  //         last_changed_at = params.lastChangedAt ?? (now - 86400),
  //         plus the other counter/confidence columns.
  //   2. status_transitions SELECT (via listRecentStatusTransitions) → the
  //         params.transitions list mapped to row shape with causes_json encoded.
  //   3. The tables assessPublicHealth queries:
  //        - cache row SELECTs → return stub rows that produce the target
  //          cacheImpactStatus when passed through getOverallCacheImpactStatus.
  //          (Set updated_at far in the past to produce 'stale', near in the
  //          past to produce 'healthy', etc.)
  //        - mint_burn_* aggregates → return rows consistent with the target status.
  //        - circuit_states → return 0 open circuits for healthy, 3+ for degraded.
  //        - blacklist_events → return a count consistent with the target.
  //
  // The existing D1 mock helper in worker/src/api/__tests__/status.test.ts
  // already has patterns for every one of these queries. Import or copy that
  // helper and extend it to take `publicHealthStatus` and `adminStateStatus`
  // as independent knobs instead of the single `currentStatus` the existing
  // helper uses. Do NOT introduce a new mocking framework.
}

describe("public-status-history transition filter", () => {
  it("omits transitions whose only cause is missing_prices_degraded", async () => {
    const db = buildFakeDb({
      publicHealthStatus: "healthy",
      transitions: [
        {
          id: 1,
          at: now - 3600,
          from: "healthy",
          to: "degraded",
          reason: "raw-degraded-consecutive-threshold",
          causes: [
            {
              code: "missing_prices_degraded",
              severity: "warning",
              layer: "data-quality",
              message: "Missing price ratio is degraded (18.56% > 18.00%).",
            },
          ],
        },
      ],
    });

    const response = await handlePublicStatusHistory(
      db,
      false,
      new Request("https://test/api/public-status-history?window=24h"),
    );
    const body = await response.json();
    expect(body.transitions).toHaveLength(0);
    expect(body.currentStatus).toBe("healthy");
  });

  it("retains transitions with cache_ratio_stale", async () => {
    const db = buildFakeDb({
      publicHealthStatus: "stale",
      transitions: [
        {
          id: 1,
          at: now - 3600,
          from: "healthy",
          to: "stale",
          reason: "raw-stale-immediate-escalation",
          causes: [
            {
              code: "cache_ratio_stale",
              severity: "critical",
              layer: "availability",
              message: "Cache freshness exceeded stale threshold.",
            },
          ],
        },
      ],
    });

    const response = await handlePublicStatusHistory(
      db,
      false,
      new Request("https://test/api/public-status-history"),
    );
    const body = await response.json();
    expect(body.transitions).toHaveLength(1);
    expect(body.transitions[0].to).toBe("stale");
    expect(body.currentStatus).toBe("stale");
  });

  it("retains transitions whose cause set mixes public and admin codes", async () => {
    const db = buildFakeDb({
      publicHealthStatus: "degraded",
      transitions: [
        {
          id: 1,
          at: now - 3600,
          from: "healthy",
          to: "degraded",
          reason: "raw-degraded-consecutive-threshold",
          causes: [
            {
              code: "missing_prices_degraded",
              severity: "warning",
              layer: "data-quality",
              message: "Missing price ratio is degraded (18.5% > 18%).",
            },
            {
              code: "cache_ratio_degraded",
              severity: "warning",
              layer: "availability",
              message: "Cache freshness exceeded degraded threshold.",
            },
          ],
        },
      ],
    });

    const response = await handlePublicStatusHistory(
      db,
      false,
      new Request("https://test/api/public-status-history"),
    );
    const body = await response.json();
    expect(body.transitions).toHaveLength(1);
  });

  it("sources currentStatus from assessPublicHealth even when admin state is degraded", async () => {
    // Admin state says 'degraded' (because data quality has missing_prices_degraded
    // held under hysteresis), but the public health assessment says 'healthy'
    // because /api/health does not include data-quality signals. The public
    // history endpoint must report the public view.
    const db = buildFakeDb({
      publicHealthStatus: "healthy",
      adminStateStatus: "degraded", // ← the independent knob on the fixture
      transitions: [],
    });

    const response = await handlePublicStatusHistory(
      db,
      false,
      new Request("https://test/api/public-status-history"),
    );
    const body = await response.json();
    expect(body.currentStatus).toBe("healthy");
  });
});
```

**Step 2: Run, confirm failure.**

```bash
npm test -- worker/src/api/__tests__/public-status-history.test.ts
```

Expected: all four tests fail because the filter and the public-status source change have not been implemented.

**Step 3: Create the shared public-impact helper.**

Create `shared/lib/status-public-impact.ts`:

```typescript
import type { StatusCause } from "../types/status";

/**
 * Cause codes that correspond to things a public /status/ page viewer will
 * actually notice in the user-facing product. Admin-only data-quality
 * concerns (missing prices, blacklist ratio drift, reserve coverage,
 * on-chain monitor) are intentionally excluded.
 */
const PUBLIC_IMPACT_CODES: ReadonlySet<string> = new Set([
  "cache_ratio_stale",
  "cache_ratio_degraded",
  "cache_freshness_query_failed",
  "cache_warning",
  "fx_source_stale",
  "fx_source_degraded",
  "fx_cached_fallback",
  "mint_burn_public_stale",
  "mint_burn_public_degraded",
  "mint_burn_health_query_failed",
  "open_circuit_groups",
  "circuit_query_failed",
  "cron_error_runs",
  "multiple_unhealthy_crons",
  "unhealthy_crons_present",
  "db_unhealthy",
]);

export function causeIsPublicImpacting(cause: StatusCause): boolean {
  if (cause.severity === "info") return false;
  return PUBLIC_IMPACT_CODES.has(cause.code);
}

export function transitionHasPublicImpact(causes: StatusCause[]): boolean {
  return causes.some(causeIsPublicImpacting);
}
```

Note: this lives in `shared/lib/` (not `worker/src/lib/`) so it can be unit-tested outside the worker runtime and imported from anywhere.

**Step 4: Update `handlePublicStatusHistory`.**

Rewrite `worker/src/api/public-status-history.ts`:

```typescript
import {
  parseEnumParam,
  parseQueryParams,
  withErrorHandler,
  jsonResponse,
} from "../lib/api-utils";
import {
  getStatusStateSnapshot,
  listRecentStatusTransitions,
} from "../lib/status-reliability";
import { assessPublicHealth } from "../lib/public-health-assessment";
import { transitionHasPublicImpact } from "@shared/lib/status-public-impact";
import {
  PUBLIC_STATUS_HISTORY_WINDOWS,
  type PublicStatusHistoryResponse,
  type PublicStatusHistoryWindow,
  type PublicStatusTransition,
  type StatusTransition,
} from "@shared/types/status";

const MAX_LIMIT = 200;
const DEFAULT_WINDOW: PublicStatusHistoryWindow = "30d";
const WINDOW_TO_SECONDS: Record<PublicStatusHistoryWindow, number> = {
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
};
const VALID_WINDOWS = new Set<PublicStatusHistoryWindow>(PUBLIC_STATUS_HISTORY_WINDOWS);

function toPublicTransition(t: StatusTransition): PublicStatusTransition {
  return {
    id: t.id,
    from: t.from,
    to: t.to,
    transitionType: t.transitionType,
    reason: t.reason,
    at: t.at,
  };
}

export const handlePublicStatusHistory = withErrorHandler(
  "public-status-history",
  async (db: D1Database, _trustedAdmin?: boolean, request?: Request): Promise<Response> => {
    const now = Math.floor(Date.now() / 1000);
    const url = new URL(request?.url ?? "https://pharos.watch/api/public-status-history");
    const parsed = parseQueryParams(url.searchParams, {
      limit: { type: "int", default: 50, min: 1, max: MAX_LIMIT, rangePolicy: "reject" },
    });
    if (parsed instanceof Response) return parsed;
    const window = parseEnumParam(url.searchParams.get("window"), VALID_WINDOWS, "window", DEFAULT_WINDOW);
    if (window instanceof Response) return window;

    const from = now - WINDOW_TO_SECONDS[window];

    // Fetch all three inputs in parallel:
    //   1. the hysteresis state (for lastChangedAt only — NOT for currentStatus)
    //   2. the full transition list in the window
    //   3. the public health assessment (same source /api/health uses)
    //
    // assessPublicHealth does a fair amount of DB work; the 60s response
    // cache on this endpoint absorbs the cost.
    const [{ state }, allTransitions, publicHealth] = await Promise.all([
      getStatusStateSnapshot(db, now),
      listRecentStatusTransitions(db, parsed.limit, { from }),
      assessPublicHealth(db, now, { logPrefix: "public-status-history" }),
    ]);

    // Filter transitions to only those with at least one public-facing cause.
    const filteredTransitions = allTransitions.filter((t) => transitionHasPublicImpact(t.causes));

    // Public currentStatus comes from assessPublicHealth — NOT from the
    // state machine's hysteresis-smoothed admin status. This keeps the
    // public hero (/api/health) and this endpoint in sync. The admin
    // /status/ page continues to use /api/status for its smoothed view.
    const publicCurrentStatus = publicHealth.overallStatus;

    const body: PublicStatusHistoryResponse = {
      timestamp: now,
      currentStatus: publicCurrentStatus,
      lastChangedAt: state?.lastChangedAt ?? null,
      transitions: filteredTransitions.map(toPublicTransition),
    };

    return jsonResponse(body, { "Cache-Control": "public, max-age=60" });
  },
);
```

Key changes from the existing implementation:

- Import and call `assessPublicHealth` in the parallel fetch block.
- Compute `publicCurrentStatus = publicHealth.overallStatus` instead of `state?.currentStatus`.
- Filter `allTransitions` through `transitionHasPublicImpact` before mapping to public shape.
- Keep `lastChangedAt` sourced from `state` (it's still the "when did the admin state machine last flip" timestamp; the UI uses it only as a duration-since label, and having it reflect admin state is acceptable since the admin state is usually a strict superset of public state).

**Step 5: Run, confirm the tests pass.**

```bash
npm test -- worker/src/api/__tests__/public-status-history.test.ts
```

Expected: all four pass.

**Step 6: Run adjacent suites.**

```bash
npm test -- worker/src/api/__tests__/status.test.ts
npm test -- worker/src/lib/__tests__/status-reliability.test.ts
```

Expected: unaffected, still pass.

**Step 7: Commit.**

```bash
git add shared/lib/status-public-impact.ts worker/src/api/public-status-history.ts \
  worker/src/api/__tests__/public-status-history.test.ts
git commit -m "$(cat <<'EOF'
fix(status): public history filters admin-only causes + aligns currentStatus

/api/public-status-history now (1) filters status_transitions rows to
those whose causes include at least one public-facing code (cache
ratio, FX source, mint/burn, circuit breakers, critical cron errors,
db_unhealthy) and (2) sources its currentStatus from
assessPublicHealth — the same function /api/health uses — instead of
the hysteresis-smoothed admin global in status_state.

This eliminates the UI divergence on /status/ where the hero said
"Public surface steady" while the uptime bar and transition timeline
showed missing-price-driven degraded periods. Admin /status/ continues
to use /api/status for the full state machine view.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Workstream 5: Flap-rate diagnostics (defensive)

Add a lightweight flap-rate counter to the `handleStatus` response so operators can spot a new flapping lane the next time a threshold drifts. This is the long-term preventative layer.

**Files:**
- `worker/src/lib/status/cron-health.ts` or a new `worker/src/lib/status/flap-detection.ts`
- `worker/src/api/status.ts`
- `shared/types/status.ts` — add `summary.transitionsLast24h`
- Tests: `worker/src/api/__tests__/status.test.ts`

**Step 1: Add the failing test.**

Add to `worker/src/api/__tests__/status.test.ts`:

```typescript
describe("summary.transitionsLast24h", () => {
  it("reports the count of transitions in the last 24h", async () => {
    const nowSec = 1_776_000_000;
    // Extend buildFakeStatusDb (or the existing D1 mock helper) to accept a
    // `recentTransitionsCount` param that seeds the response for:
    //   SELECT COUNT(*) AS cnt FROM status_transitions WHERE scope = ? AND created_at >= ?
    // The helper should return { cnt: params.recentTransitionsCount } from that match.
    const db = buildFakeStatusDb({
      recentTransitionsCount: 4,
      nowSec,
    });

    const response = await handleStatus(db, /* trustedAdmin */ true);
    const body = await response.json();
    expect(body.summary.transitionsLast24h).toBe(4);
  });

  it("reports 0 when the count query fails gracefully", async () => {
    const db = buildFakeStatusDb({
      recentTransitionsCount: "throw", // special sentinel: helper throws on the count query
    });

    const response = await handleStatus(db, true);
    const body = await response.json();
    // A failed count query is observability-only; the response still succeeds
    // with transitionsLast24h = 0.
    expect(body.summary.transitionsLast24h).toBe(0);
  });
});
```

The `buildFakeStatusDb` helper must be extended to understand `recentTransitionsCount` (either as a number or the sentinel `"throw"`). The existing D1 mock pattern in `status.test.ts` already handles query-match → row/first responses; adding a new match entry for the COUNT SQL is straightforward.

**Step 2: Run, confirm failure.**

**Step 3: Add the counter.**

In `computeRawStatus`, issue an extra query (small, indexed) for the count:

```typescript
let transitionsLast24h = 0;
try {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM status_transitions
       WHERE scope = ? AND created_at >= ?`,
    )
    .bind("global", now - 86400)
    .first<{ cnt: number }>();
  transitionsLast24h = row?.cnt ?? 0;
} catch (err) {
  console.warn("[status] transitions count query failed:", err);
}
```

Add to `RawStatusComputation.summary` and `StatusResponse.summary`:

```typescript
summary: {
  // ... existing fields
  transitionsLast24h,
},
```

**Step 4: Run, confirm pass.**

**Step 5: Commit.**

```bash
git add worker/src/lib/status-evaluation.ts shared/types/status.ts \
  worker/src/api/__tests__/status.test.ts
git commit -m "$(cat <<'EOF'
feat(status): surface transitionsLast24h in the status summary

A quick-glance counter on /api/status so flap rates are visible without
spelunking status_transitions. Admin dashboards can use it to detect
new flapping lanes as thresholds drift.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Workstream 6: Docs and missing-price root-cause audit

**Files:**
- `docs/status-dashboard.md`
- `docs/api-reference.md`
- `agents/research/2026-04-13-missing-price-coins-audit.md` (new artifact — research note, not product docs)

The weekly changelog for 2026-04-13 to 2026-04-19 is generated by the `changelog-collect` skill during the normal weekly cycle and is NOT written by hand in this plan. The worker deploy does not gate on the changelog entry.

**Step 1: Update `docs/status-dashboard.md` to describe the new thresholds and the public-impact filter.**

Add (or update) sections documenting:

- `missingPriceRatio` thresholds: 15% → info `missing_prices_elevated` (advisory only), 18% → warning `missing_prices_degraded`, 45% → critical `missing_prices_stale`.
- The public transition filter: which cause codes propagate to `/api/public-status-history` and which are admin-only.
- The fact that `/api/public-status-history.currentStatus` is sourced from `assessPublicHealth` (matching `/api/health`), not from `status_state.current_status`.

Example subsection:

```markdown
## Missing-price thresholds

The status evaluation classifies the share of tracked stablecoins currently
missing a price into three bands:

| Band | Enter | Cause code | Severity | Drives `dataQualityStatus`? |
|---|---|---|---|---|
| elevated | 15% | `missing_prices_elevated` | info | no — advisory only |
| degraded | 18% | `missing_prices_degraded` | warning | yes → `degraded` |
| stale    | 45% | `missing_prices_stale`    | critical | yes → `stale`    |

The elevated band exists for operator observability: it surfaces
price-enrichment drift before it crosses the hard threshold without
producing a visible status transition.

## Public vs admin status sources

- `/api/health` returns the unsmoothed public-facing status computed from
  cache freshness, mint/burn sync, circuit breakers, and the blacklist
  query path. It does **not** include data-quality signals such as
  `missingPriceRatio`, `blacklistMissingRatio`, or on-chain monitoring.
- `/api/public-status-history` returns transitions filtered by
  public-facing impact and reports the same `currentStatus` as `/api/health`.
  The hero badge on `/status/` and the uptime bar/transition timeline
  are guaranteed to agree.
- `/api/status` (admin only) returns the full state machine: every cause,
  every transition, the hysteresis state, the smoothed global status.
```

**Step 2: Update `docs/api-reference.md`.**

In the `/api/public-status-history` section, document the filter semantics and the `currentStatus` source. In the `/api/status` section, note that the admin endpoint continues to return the unfiltered full causes array.

**Step 3: Commit docs updates.**

```bash
git add docs/status-dashboard.md docs/api-reference.md
git commit -m "docs(status): raised missing-price thresholds and public filter"
```

**Step 4: Run the missing-price root-cause audit (investigation task, no code change).**

Open a wrangler query session and extract the list of stablecoins currently missing prices in the cache:

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --command \
  "SELECT value FROM cache WHERE key = 'stablecoins'" --json > /tmp/stablecoins-cache.json
```

Then parse and extract the missing list:

```bash
python3 <<'PY'
import json, sys
raw = json.load(open('/tmp/stablecoins-cache.json'))
value = raw[0]['results'][0]['value']
payload = json.loads(value)
assets = payload.get('peggedAssets', [])
total = len(assets)
missing = [(a.get('id', '?'), a.get('symbol', '?'), a.get('pegType', '?')) for a in assets if not a.get('price')]
print(f'Total tracked: {total}')
print(f'Missing price count: {len(missing)}')
print(f'Ratio: {len(missing)/total:.4f}')
print('Missing list:')
for row in missing:
    print(f'  {row[0]:<40} {row[1]:<12} {row[2]}')
PY
```

Write the output (the missing-coin list and a categorization: pre-launch, broken source, no live source, etc.) to `agents/research/2026-04-13-missing-price-coins-audit.md`. This note becomes the input for a follow-up plan that root-causes and fixes the persistently-missing coins.

```bash
git add agents/research/2026-04-13-missing-price-coins-audit.md
git commit -m "research: audit of stablecoins currently missing prices"
```

### Workstream 7: Verification and rollout

**Step 1: Run the full local gate.**

```bash
npm run lint
npm test
cd worker && npx tsc --noEmit && cd ..
npm run test:merge-gate
```

Expected: all green. Because this plan touches `worker/src`, `shared/lib`, and `shared/types`, both the worker deploy gate and the Pages gate should activate. A red gate here means there's a cross-file inconsistency — fix locally, do not bypass.

**Step 2: Manual smoke on the admin status endpoint.**

After deploy, hit `/api/status` with a trusted admin token and verify:

- `dataQualityStatus` is `healthy` (the normal operating point should now be below the 18% raised threshold).
- `causes.dataQuality` does NOT contain `onchain_monitor_low_sample` (suppressed by Workstream 3 at the structural floor).
- `causes.dataQuality` may contain `missing_prices_elevated` with `severity: "info"` if the ratio is in the 15-18% band — that is expected and does not drive status.
- `causes.availability` does NOT contain `watch_unhealthy_crons_present` (the Workstream 2 bootstrap guard should suppress the `yield-coverage-audit` zero-run case).
- `summary.transitionsLast24h` is present and is ≤ 2 per day (down from the 6+ prior to the fix).

**Step 3: Manual smoke on the public status endpoint.**

Hit `/api/health` and `/api/public-status-history`:

- `/api/health.status` is `healthy` (assuming the baseline scenario).
- `/api/public-status-history.currentStatus` equals `/api/health.status`.
- Recent transitions in the public response do NOT include rows whose only cause is `missing_prices_degraded`.
- The `PublicStatusHero` on `https://pharos.watch/status/` shows "Public surface steady" AND the uptime bar shows no amber segments for the last 24h.

**Step 4: Observe prod for 48 hours.**

Check `status_transitions` for the 48-hour window after deploy:

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --command \
  "SELECT datetime(created_at, 'unixepoch') AS at, reason, \
          json_extract(causes_json, '\$[0].code') AS primary_cause \
     FROM status_transitions \
    WHERE created_at >= strftime('%s', 'now', '-2 day') \
    ORDER BY created_at DESC"
```

Expected: zero transitions whose primary cause is `missing_prices_degraded`, and total transitions per day ≤ 2 (down from 6+).

**Step 5: Schedule the May 1 `yield-coverage-audit` verification.**

The Workstream 2 bootstrap guard suppresses the info cause produced by `yield-coverage-audit` having zero `cron_runs` rows. The April 1 monthly trigger (`0 6 1 * *`) should have produced a row and did not. The next firing is 2026-05-01 06:00 UTC.

On 2026-05-01 around 08:00 UTC, run the following check:

```bash
cd worker
npx wrangler d1 execute stablecoin-db --remote --command \
  "SELECT datetime(started_at, 'unixepoch') AS at, status, substr(error, 1, 120) AS err \
     FROM cron_runs \
    WHERE job = 'yield-coverage-audit' \
    ORDER BY started_at DESC LIMIT 5"
```

**If the query returns at least one row for 2026-05-01:** The bootstrap guard was correctly paper-covering a not-yet-fired trigger. File away the result. No follow-up needed.

**If the query still returns zero rows:** The scheduled-event dispatch for `0 6 1 * *` is broken (either in Cloudflare Workers triggers, in `handleScheduledEvent`, or in `runMonthlyYieldAuditSlot`). Escalate this to a dedicated follow-up plan with these initial steps:

1. Check Cloudflare Workers triggers in the dashboard — is the monthly trigger listed and recently invoked?
2. Add a temporary always-write log at the top of `runScheduledSlotWithFence` that inserts a row into a diagnostic table (or just writes `console.log`) on every scheduled event, labeled with the cron string.
3. Redeploy and wait for the next monthly fire.
4. If still no row: the issue is in the Cloudflare scheduled-event dispatch itself, not in worker code. File a platform issue.

Schedule the verification as a calendar reminder on the user's system; do not block rollout of this plan waiting for May 1.

**Step 6: Commit.**

No code commit in this workstream — it's verification and observability. Note any findings in `agents/research/2026-04-13-missing-price-coins-audit.md` alongside the Workstream 6 artifact.

## Test plan summary

New tests (all in `worker/src/api/__tests__/` or `worker/src/lib/status/__tests__/`):

1. **Raised missing-price thresholds and elevated info cause (Workstream 1)** — 5 cases:
   - 34 missing → healthy
   - 36 missing → degraded
   - 30 missing → healthy + `missing_prices_elevated` info cause
   - 20 missing → healthy + no elevated cause
   - 90 missing → stale
2. **Watch-tier cron bootstrap guard (Workstream 2)** — 2 cases:
   - `yield-coverage-audit` zero runs, watch-tier → `watchUnhealthyCrons = 0`, `bootstrap = true`
   - `sync-stablecoins` zero runs, critical-tier → `availabilityImpactingUnhealthyCrons >= 1`
3. **Onchain low-sample suppression floor (Workstream 3)** — 2 cases:
   - tracked = 2 → no `onchain_monitor_low_sample` cause
   - tracked = 6 → `onchain_monitor_low_sample` cause still fires
4. **Public transition filter and current-status alignment (Workstream 4)** — 4 cases:
   - missing-prices-only transition → filtered out
   - cache-ratio-stale transition → retained
   - mixed public + admin causes → retained
   - admin state = degraded + public health = healthy → `currentStatus = healthy`
5. **Transitions last 24h counter (Workstream 5)** — 1 case.

Existing tests that must still pass unchanged:

- `worker/src/lib/__tests__/status-reliability.test.ts`
- `worker/src/api/__tests__/status.test.ts` (the pre-existing body, not the new raised-threshold block)
- `worker/src/lib/status/__tests__/cron-health.test.ts` (extended by Workstream 2)
- `src/lib/__tests__/status-dashboard-model.test.ts`
- `src/app/admin/__tests__/client.test.tsx`
- `src/components/__tests__/data-quality-cards.test.tsx`

Existing tests that must be UPDATED to reflect new thresholds (Workstream 1 may break these):

- Any test that used `missingPrices: 30` as a degraded fixture → update to use `missingPrices: 36` with a comment referencing this plan.
- Any test that asserted `cause.threshold === 0.15` → update to `0.18` with a rename to `missing_prices_degraded_18pct` if the test name was pinned.
- Any test that used `missingPrices: 78` (the old stale point at 40%) → update to `missingPrices: 90`.

During execution of Workstream 1 step 8, if any such test fails, update the fixture value AND the name/comment in the same commit. Do not broadly rewrite tests — only touch the ones that surface as failures.

Regression guard fixtures:

- `missingPrices = 29 / 194 = 14.95%` → healthy, no `missing_prices_*` cause.
- `missingPrices = 30 / 194 = 15.46%` → healthy, `missing_prices_elevated` info cause only.
- `missingPrices = 34 / 194 = 17.53%` → healthy, `missing_prices_elevated` info cause only.
- `missingPrices = 36 / 194 = 18.56%` → degraded, `missing_prices_degraded` warning cause with threshold=0.18.
- `missingPrices = 90 / 194 = 46.39%` → stale, `missing_prices_stale` critical cause with threshold=0.45.
- `yield-coverage-audit` never-ran + all other crons healthy → `watchUnhealthyCrons = 0`, no info cause.
- `sync-stablecoins` never-ran + all other crons healthy → `availabilityImpactingUnhealthyCrons ≥ 1`.
- `onchain` tracked = 2 → no `onchain_monitor_low_sample` cause.
- `onchain` tracked = 6 → `onchain_monitor_low_sample` cause still fires.
- Public history with only `missing_prices_degraded` transitions in the window → empty transition list, `currentStatus = healthy` (from `assessPublicHealth`).

## Verification commands

```bash
# Before starting any work — confirm a clean baseline
npm run lint
npm test
cd worker && npx tsc --noEmit && cd ..

# Iterating inside the plan
npm test -- worker/src/api/__tests__/status.test.ts
npm test -- worker/src/lib/status/__tests__/cron-health.test.ts
npm test -- worker/src/api/__tests__/public-status-history.test.ts

# Before committing each workstream
npm run lint
cd worker && npx tsc --noEmit && cd ..

# Before pushing (must pass the full merge gate)
npm run test:merge-gate
```

## Execution order

1. Workstream 1 (raised thresholds + elevated cause) — highest-impact, fixes the primary flapping issue.
2. Workstream 2 (watch-tier bootstrap) — quick win, eliminates one persistent info cause.
3. Workstream 3 (onchain low-sample suppression) — quick win, eliminates the other.
4. Workstream 4 (public transition filter + current-status alignment) — fixes the hero↔timeline divergence. Depends on Workstream 1 being in place because the filter's test fixtures reference the new threshold values.
5. Workstream 5 (transitions-last-24h counter) — purely additive observability.
6. Workstream 6 (docs + missing-price audit research note) — last before merge.
7. Workstream 7 (verification + rollout) — after merge, including the May 1 `yield-coverage-audit` check.

## Follow-up items (not part of this plan)

These were observed during investigation and should be tracked separately:

1. **`sync-stablecoins` runtime performance.** Average 249s per run with 480s timeouts on Apr 11 17:16 and 20:00 UTC. The current hysteresis fix smooths the status impact but the underlying capacity pressure remains. Needs profiling of the `pricing.ts` / `enrich-prices-*` passes and possibly splitting the stage.
2. **`yield-coverage-audit` never-fired trigger.** The `0 6 1 * *` trigger was registered Mar 26 but the Apr 1 06:00 UTC monthly window produced no `cron_runs` row. Either the scheduled event did not dispatch (Cloudflare-side issue) or the lease wrapper failed before the cron logger ran. Needs a one-time verification that the May 1 trigger writes a row; if not, add a dedicated failing test and instrument the scheduled-event path to write an always-row on slot entry.
3. **`sync-dex-liquidity` value-coverage guard trips.** Multiple errors on Apr 11-12 with `currentGlobalTvl ≈ 7.05B < minExpectedGlobalTvl = 7.11B`. The guard uses 60% of previous global TVL, and previous is still 11.85B. Either a real 40% TVL drop went undetected for a while (in which case raise a product-side flag) or the guard formula has a stale anchor. Needs investigation.
4. **`onchain_supply` writers expansion.** Only `sync-kinesis-supply` writes to `onchain_supply` (KAU + KAG, 2 rows). The monitoring design assumes ≥ 10 tracked coins for the ratio-based stale/degraded logic. Either add more RPC-backed writers or formally decommission the ratio-based path.
5. **`/api/health` does not include missing-price warnings for operators.** Separate UX question: should operators get a warning-level signal in `/api/health` when the missing-price ratio is approaching the band? Or is that admin-only by design? This plan preserves admin-only; raise if the product wants otherwise.

## Validation loop

### Round 1 review

**Medium issues found:**

1. **Cross-lane coupling in hysteresis bias creates a hard lock-in.** The initial draft used the global `currentStatus` from `status_state` as a hysteresis bias signal: when the global is degraded, all lanes use their lower "exit" thresholds. But the observed normal operating point for `missingPriceRatio` is ~14.95% (≈ 29-30 coins missing out of ~194 tracked). The proposed exit band of 12% is *below the normal operating point*. So a brief availability hiccup (one critical cron error) would push the global to degraded, which would then force the missing-price lane into exit-threshold hold mode (12%), which the real signal (14.95%) is always above. The system would be permanently held at degraded until the 30-minute `STATUS_SYSTEM_FRESHNESS_SEC` fallback wiped the state, at which point the cycle could restart. Catastrophic.

2. **`publicCurrentStatus` derivation in the public transition filter referenced `state.currentStatus`.** That's the admin hysteresis-smoothed global status, which diverges from what `/api/health` reports. Using it would re-introduce the very UI divergence the workstream was meant to eliminate. The correct source for the public current status is `assessPublicHealth(db, now)` — the same function `/api/health` calls — so the hero and the uptime bar/transition timeline converge on one public-facing definition.

3. **Workstream 3's watch-tier bootstrap guard masks real breakage of the April 1 `yield-coverage-audit` slot.** The plan suppressed the persistent `watch_unhealthy_crons_present` info cause by treating a never-ran watch-tier cron as bootstrap healthy. But the April 1 monthly window has already passed without producing a `cron_runs` row, which means the Cloudflare scheduled-event dispatch or the lease/fence wrapper failed silently. Bootstrap is the wrong label — it's "first run missed". The plan needed an explicit verification step for the May 1 slot, and a follow-up to instrument the scheduled-event handoff so a silent miss becomes loud.

4. **Workstream 2 (cause-message alignment) was coupled to the hysteresis-bias approach.** If the hysteresis approach is removed in favor of a simple threshold raise (see fix #1 below), Workstream 2 is redundant — the cause messages already report the single active threshold. Leaving the workstream in would produce code that never runs its conditional branches, plus tests that no longer reflect the shipped behavior.

5. **The plan did not describe an operational fallback for raising the threshold.** If a real missing-price regression ever lands (say the enrichment pipeline starts dropping 40+ coins silently), the raised threshold would delay detection without providing any early-warning signal. The right shape is: raise the hard `ratioDegraded` threshold that actually degrades status, and simultaneously add an advisory `missing_prices_elevated` info cause in the 15-18% band so operators still see the early-warning drift.

**Changes made:**

- **Rewrote Workstream 1 to raise the raw thresholds** instead of adding state-based hysteresis bias. New values: `ratioDegraded: 0.15 → 0.18`, `ratioStale: 0.40 → 0.45`. This eliminates the cross-lane coupling risk entirely because each raw evaluation is stateless. The blacklist and cache thresholds are left unchanged because prod evidence shows they are not flapping and touching them would be YAGNI.
- **Added an `missing_prices_elevated` info-severity cause** that fires when `ratioDegraded_prev (0.15) ≤ missingPriceRatio ≤ ratioDegraded_new (0.18)`. This is the early-warning band and does not affect `dataQualityStatus`.
- **Deleted Workstream 2** in its entirety. Cause messages stay on the single active threshold because there is no longer a hysteresis band to align them against.
- **Rewrote Workstream 5** to source `publicCurrentStatus` from `assessPublicHealth(db, now)` (matching `/api/health`) instead of `state.currentStatus`. Also removed the need to extend `getStatusStateSnapshot` to return causes — the transition filter reads `causes` directly from the already-parsed `listRecentStatusTransitions` result.
- **Added a dedicated verification task** in Workstream 7 step 5 to check that the 2026-05-01 `yield-coverage-audit` trigger produces a row in `cron_runs`. If it does not, the Workstream 2 bootstrap guard is hiding a real failure and follow-up item #2 becomes urgent instead of tracking.
- **Added a Workstream 6 step 4 root-cause investigation task** (not a code change) to list the specific 29-30 stablecoins that currently have no price in the cache, via a wrangler D1 query against the `stablecoins` cache row. Output goes to `agents/research/2026-04-13-missing-price-coins-audit.md` for the follow-up prioritization.
- **Tightened the threshold math in Workstream 1's tests.** With `ratioDegraded = 0.18` and 194 tracked, the crossover is at 35 coins (0.1804). Tests now use 34 coins (0.1753 → healthy) and 36 coins (0.1856 → degraded). 35 is intentionally avoided because it lands right at the boundary and would make the test fragile.

### Round 2 review

**Medium issues found in the Round 1-revised draft:**

1. **Goal section still referenced "hysteresis bands"** even though Workstream 1 was rewritten to use raised thresholds instead. An implementer reading the Goal would expect bands and be confused when Workstream 1 has no banded-comparison code. Fixed: Goal rewritten to describe the threshold raise + `missing_prices_elevated` info cause.
2. **Explicit non-goals still said "this plan uses the global `currentStatus` as the hysteresis bias signal"** — the exact approach that Round 1 rejected. Fixed: non-goals now say "no state-based hysteresis bands or per-lane status tracking" and reference the Round 1 rejection rationale.
3. **Success criteria #1 referenced "within ±2 percentage points ... for a single sample"** — that's hysteresis-band language that does not match the raised-threshold approach actually in Workstream 1. Fixed: all six success-criteria bullets rewritten to reference the specific numeric thresholds (0.15, 0.18, 0.45), the new `missing_prices_elevated` cause, and the `transitionsLast24h ≤ 2/day` target.
4. **Round 1 review notes referenced "Workstream 8"** for the yield-coverage-audit verification and "Workstream 7" for the missing-price audit — but the plan was renumbered so verification is Workstream 7 step 5 and the missing-price audit is Workstream 6 step 4. Fixed: notes updated with correct pointers.
5. **Workstream 4's test 4 ("admin state = degraded + public health = healthy") was ambiguous** — the test inline-commented "Override status_state mock to say current_status='degraded'" without showing how, and `buildFakeDb` had no `adminStateStatus` parameter. An implementer would either skip the test or invent an ad-hoc override. Fixed: `buildFakeDb` now has an explicit `adminStateStatus?` parameter documented in its JSDoc, and the test uses it directly.

**Minor issues also fixed:**

- **Workstream 1 step 6 was formatted as a bash code block** containing only comments saying "use the Grep tool". Rewritten as an explicit Grep pattern + path list so the step is actionable as-is.
- **Workstream 5's failing test referenced `nowSec` without a binding** and used a `recentTransitions` param that doesn't match how the helper composes D1 mocks. Rewritten with a declared `nowSec` constant, a `recentTransitionsCount` param, an explicit instruction to extend `buildFakeStatusDb`, and a second test case for the count-query-failure fallback path.

**Changes made:**

- Goal, Explicit non-goals, and Success criteria sections fully rewritten to reflect the raised-threshold + public-filter approach. No remaining references to hysteresis bands or per-lane state bias.
- Round 1 "Changes made" notes renumbered to point at the correct workstream IDs (Workstream 7 step 5 for the May 1 verification, Workstream 6 step 4 for the missing-price audit).
- `buildFakeDb` helper in Workstream 4 gets an explicit `adminStateStatus` parameter with a JSDoc comment.
- Workstream 1 step 6 rewritten with concrete Grep patterns and paths.
- Workstream 5 test rewritten with proper binding, extended fixture contract, and a second case for failure fallback.

### Round 3 review

**Medium issues found:**

- none.

**Remaining notes (not medium issues, filed for implementer context):**

- `buildFakeStatusDb` and `buildFakeCronHealthDb` are referenced in Workstreams 1, 2, 3, 5 as if they already exist. In practice, the existing test file `worker/src/api/__tests__/status.test.ts` uses a `{ match, rows, first }` D1 mock pattern rather than a single helper builder. Workstreams that reference these builders should check first and either (a) import the existing D1 mock helper and pass the same `{ match, rows, first }` entries, or (b) write a local helper that wraps the existing pattern. Either way, do not introduce a new mocking framework. This is an implementation detail and was flagged in each workstream's notes already.
- Workstream 4 calls `assessPublicHealth` from `handlePublicStatusHistory`, adding several D1 reads per call. The endpoint already has a 60s response cache (`Cache-Control: public, max-age=60`), so the effective cost is roughly 1 full assessment per minute per unique caller. That's a small additional load on D1 but comfortably within budget.
- The 2026-05-01 verification in Workstream 7 step 5 is time-gated: the check can only run on or after 2026-05-01 06:00 UTC. Until then, the Workstream 2 bootstrap guard functions as intended for the `yield-coverage-audit` case. An implementer executing this plan should set a calendar reminder rather than trying to run the check immediately.

**Final assessment:**

- Medium-issue count: **0**.
- The plan is ready for implementation.
