# sync-dex-liquidity Value Guard Remediation Plan

Date: 2026-04-16

## Scope

Investigation and remediation plan only. No production code, D1 data, migrations, or runtime configuration have been changed.

## Assumptions

- The production error under investigation is:
  `Error: [dex-liquidity] value coverage guard tripped: currentGlobalTvl=7159006645, previousGlobalTvl=12703104619, minExpectedGlobalTvl=7621862771`.
- `sync-dex-liquidity` should continue to protect the public dataset from real coverage collapses.
- A degraded source run should not be allowed to poison the next run's guard baseline.
- Preserving the last source-complete dataset is preferable to publishing capless secondary-source liquidity.

## Evidence

Production D1 read-only checks showed:

- 2026-04-16 06:40 UTC: `sync-dex-liquidity` was `ok`, `dlProtocolsAvailable=true`, `currentGlobalTvl=7.025B`, `protocolCapReductions.reducedTvlUsd=4.300B`.
- 2026-04-16 07:10 UTC: `sync-dex-liquidity` was `degraded`, `dlProtocolsAvailable=false`, `failedSources=["defillama-protocols","balancer-api"]`, `fallbackMode=["dl-protocols-unavailable","balancer-api-partial"]`, `currentGlobalTvl=12.703B`, and `protocolCapReductions.reducedTvlUsd=0`.
- 2026-04-16 07:40 UTC: `sync-dex-liquidity` errored with `currentGlobalTvl=7.159B`, comparing against the persisted 07:10 `__global__` row at `12.703B`.
- DefiLlama Yields and Protocols both returned HTTP 200 during manual checks at 2026-04-16 07:54 UTC, and the D1 circuit state had `defillama-protocols.lastSuccessAt=2026-04-16 07:40:08 UTC`.
- The current failed-run TVL, `7.159B`, is in the normal recent range: prior source-complete runs were `6.79B` to `7.12B`.
- `dex_pool_staging` currently contains several extreme CoinGecko Onchain rows, including TVL values above `1e18`, but current scoring filters and protocol caps keep most of these from published rows during source-complete runs.

## Root Cause

This incident is not a real liquidity collapse. It is a guard-baseline poisoning bug.

The 07:10 degraded run lost DeFiLlama Protocols, which means `protocolTvlCaps` was empty. Without protocol caps, secondary discovery TVL was not reduced, and the run persisted an inflated `dex_liquidity.__global__` value of `12.703B`.

The next run recovered DeFiLlama Protocols and recomputed a normal global TVL of `7.159B`. The value guard then compared that healthy value against the inflated degraded baseline and threw because `7.159B < 12.703B * 0.6`.

Contributing design issues:

- The hard value guard reads the previous baseline from `dex_liquidity.__global__` without checking whether that row came from a source-complete run.
- `degraded` runs with critical source failures can still persist public liquidity rows and the global sentinel.
- There is no high-side guard or publish gate for capless runs, so an inflated degraded run can update the baseline even though a later healthy run correctly returns to normal.

## Success Criteria

- A healthy source-complete run after a capless degraded run does not fail the value guard when it returns to the prior normal range.
- A genuine source-complete global TVL collapse still trips the hard value guard.
- A run with `dlProtocolsAvailable=false` does not overwrite the public liquidity dataset with uncapped secondary-source TVL.
- Cron metadata explains which value baseline was used and why a persisted baseline was ignored.
- The fix is covered by focused Vitest cases and worker type-checks.

## Remediation Plan

### 1. Add Guard-Eligible Baseline Selection

Modify `worker/src/cron/dex-liquidity/orchestrator-metadata.ts`.

Add a small helper that reads recent `cron_runs` metadata for `sync-dex-liquidity` and finds the most recent guard-eligible baseline:

- `status IN ('ok', 'degraded')`
- metadata exists and parses
- `sourceCoverage.dlYieldsAvailable === true`
- `sourceCoverage.dlProtocolsAvailable === true`
- `sourceCoverage.sourceDegradedFamilies` does not contain `defillama-yields` or `defillama-protocols`
- `sourceCoverage.currentGlobalTvl` is finite and positive

Use that eligible metadata baseline for the value guard when the latest persisted `dex_liquidity.__global__` row corresponds to a source-incomplete run. In this incident, that would select the 06:40 UTC `7.025B` baseline instead of the 07:10 UTC `12.703B` baseline.

Keep the existing `dex_liquidity.__global__` fallback for old databases or missing metadata.

### 2. Avoid Hard-Failing On Known-Poisoned Table Baselines

When the latest persisted baseline is detected as source-incomplete:

- do not let the persisted `__global__` row drive `hardValueGuard`
- compare against the most recent guard-eligible metadata baseline if available
- if no eligible baseline exists, degrade with explicit metadata instead of inventing a strict threshold from an untrusted row

Apply the same trust decision to the major-asset guard. If the top-10 table baseline comes from a source-incomplete run, treat the major-coverage guard as telemetry/degraded only, not as a hard throw.

### 3. Prevent Future Capless Baseline Poisoning

Add a publish decision before `persistDexLiquidityScoreState()` writes rows.

Recommended initial rule:

- if `criticalSourceFailures` includes `defillama-protocols`, skip persistence of `dex_liquidity`, `dex_prices`, challenger snapshots, depth stability, and freshness sentinel
- return a `degraded` cron result with metadata such as `persistenceSkippedReason: "defillama-protocols-unavailable"`
- still record analysis metadata in the cron result so the status page explains the outage

This keeps the last source-complete liquidity dataset live while DeFiLlama Protocols is unavailable, instead of publishing uncapped secondary-source TVL.

Do not skip persistence for optional direct API failures such as Balancer partial outages when DeFiLlama Yields and Protocols are healthy.

### 4. Add Metadata Fields

Extend `DexLiquidityCronMetadataSchema` in `worker/src/lib/schemas.ts` and the metadata builder to preserve:

- `sourceCoverage.dlYieldsAvailable`
- `sourceCoverage.dlProtocolsAvailable`
- `sourceCoverage.currentGlobalTvl`
- `sourceCoverage.previousGlobalTvl`
- `sourceCoverage.minExpectedGlobalTvl`
- `sourceCoverage.valueBaselineSource`
- `sourceCoverage.valueBaselineGlobalTvl`
- `sourceCoverage.ignoredPersistedGlobalTvl`
- `persistence.skipped`
- `persistence.skippedReason`

The current schema omits several of these fields even though metadata already emits them, so parsing through the schema loses useful baseline-quality context.

### 5. Tests

Add focused tests rather than broad fixture rewrites.

In `worker/src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts`:

- latest persisted `__global__ = 12.703B`, latest cron metadata is source-incomplete, prior source-complete metadata is `7.025B`, current run is `7.159B`: expect `hardValueGuard=false`, value baseline source points to the prior source-complete cron metadata
- source-complete previous baseline `10B`, current run `5B`: expect `hardValueGuard=true`
- no parseable metadata: preserves existing fallback behavior against `dex_liquidity.__global__`

In `worker/src/cron/__tests__/sync-dex-liquidity.test.ts`:

- `dlProtocolsAvailable=false` returns `degraded` and does not call `persistScores`, `computeDexPrices`, or `writeFreshnessSentinel`-dependent paths
- optional direct API failures still persist when DeFiLlama Yields and Protocols are healthy

### 6. Operational Recovery After Code Fix

After the code fix is deployed, the next source-complete `10,40 * * * *` run should compare against the last guard-eligible metadata baseline and overwrite the inflated 07:10 dataset with a normal source-complete snapshot.

If immediate recovery is needed before waiting for the next scheduled run, prepare a separate operator-approved D1 runbook. Do not do ad hoc D1 writes as part of the implementation PR.

## Validation Commands

Run at minimum:

```bash
cd worker && npx vitest --run src/cron/dex-liquidity/__tests__/orchestrator-metadata.test.ts src/cron/__tests__/sync-dex-liquidity.test.ts
cd worker && npx tsc --noEmit
npm run lint
```

Before pushing a production fix:

```bash
npm run test:merge-gate
```

## Documentation Updates

Update `docs/dex-liquidity.md` because this changes run semantics:

- degraded runs with missing DeFiLlama Protocols preserve the last source-complete public dataset
- guard metadata now distinguishes persisted table baseline from guard-eligible value baseline
- value-guard trips should be interpreted as source-complete drops, not capless recovery from a degraded run

No methodology version bump should be needed if scoring formulas and published row semantics remain the same apart from preserving the last source-complete snapshot during critical source outages.

## Deferred Follow-Up

The current staging table includes extreme CoinGecko Onchain TVL rows. Existing retained-pool filters and protocol caps reduce their production impact during source-complete runs, but a separate data-quality hardening pass should add source-level sanity checks for staged rows so obviously impossible TVL values are rejected before staging or merge.

Keep that follow-up separate from the guard-baseline fix unless implementation evidence shows it is required to stop this specific incident.
