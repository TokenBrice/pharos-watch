# 2026-03-22 GeckoTerminal Follow-Up Implementation Plan

> Execution plan for the GeckoTerminal follow-up investigation in [../research/2026-03-22-geckoterminal-followup-investigation.md](../research/2026-03-22-geckoterminal-followup-investigation.md).
> Scope covers the remaining `geckoterminal-probe` reliability problem after the breaker-accounting fix, including both the immediate hardening pass and the authenticated on-chain fallback path.

## Objective

Make the `geckoterminal-probe` path reliable enough that:

- transient Worker-edge `429` responses do not reopen the breaker for another 30 minutes on a 2-request probe
- operators can diagnose GT probe behavior from persisted cron metadata instead of relying on Wrangler tail
- production can prefer the higher-confidence authenticated CoinGecko `/onchain` pool surface when available, while preserving current fallback behavior for uncovered paths
- docs and tests stay aligned with the resulting runtime contract

## Scope

This plan covers all necessary implementation work for the GT follow-up:

1. probe resilience hardening on the current public GT pool path
2. GT probe observability in `sync-stablecoins` metadata
3. authenticated CoinGecko `/onchain` pool preference where supported
4. fallback retention for GT-only or CG-uncovered cases
5. docs, tests, rollout validation, and live post-deploy monitoring

## Confirmed Operating Facts

These are the planning assumptions locked from the investigation and should be treated as the baseline:

- the live GT probe currently targets only `2` assets: `yusd-aegis` and `gyd-gyroscope`
- the `2026-03-22 11:30 UTC` probe failure came from real `429` responses on both requests
- the same public GT pool URLs currently return `200` from this machine, so the mismatch looks Worker-edge/provider-path specific
- the probe is not contending with other GT-heavy jobs in the same quarter-hourly slot
- the current probe uses `0` retries and `5_000 ms` timeout per request
- existing stored DEX data is not a clean live replacement for the probe
- the Worker already has a normalized `COINGECKO_API_KEY` path and existing `/onchain` helpers in `worker/src/lib/coingecko-onchain.ts`

## Design Decisions

### D1. Implement the work in two ordered phases, not one broad swap

Phase 1 should harden the existing public GT probe and add observability.
Phase 2 should add authenticated CoinGecko `/onchain` preference.

Reasoning:

- Phase 1 directly fixes the known fragility with minimal semantic change.
- Phase 2 is architecturally desirable, but it broadens the transport contract and should land only after the probe is observable enough to compare behaviors.

### D2. Preserve the effective source contract unless the source-selection semantics actually change

The GT probe exists to add an independent pool-level cross-check to CG-only assets.

Planned contract:

- if CoinGecko `/onchain` is used only as a transport path to retrieve equivalent pool-level data, keep the probe output source labeled as `geckoterminal`
- if the implementation starts using CoinGecko-only coverage semantics or materially different selection logic, treat that as a methodology change and update versioning/timeline docs

Default assumption for implementation:

- keep the source label unchanged unless the behavior clearly stops being a GT-equivalent pool probe

### D3. Do not replace the live probe with stored D1-backed DEX data in this pass

Current stored alternatives are either stale (`yusd-aegis`) or are the exact conflicting DEX signal the probe is supposed to arbitrate (`gyd-gyroscope`).

That reuse path can be reconsidered later, but it is not the right fix for the currently observed failure mode.

### D4. Improve operator visibility before depending on further production observation

Persisting GT probe stats into `sync-stablecoins` metadata is part of the remediation, not an optional extra.

Without that, future GT regressions still require live Wrangler tail sessions to distinguish:

- coverage miss
- zero eligible candidates
- low-TVL skip
- transport/rate-limit failure

## Constraints

- Keep changes root-cause driven and avoid widening pricing semantics beyond the GT follow-up scope.
- Preserve current quarter-hourly sequencing and do not introduce new shared-slot connection spikes.
- Do not add D1 schema changes unless absolutely necessary. The expected plan should fit in existing cron metadata surfaces.
- Update the relevant pricing docs for any runtime-behavior change.
- If Phase 2 changes methodology semantics rather than only transport mechanics, also update methodology version/timeline surfaces.

## Non-Goals

- No redesign of the broader DEX price bridge.
- No attempt to force `gyd-gyroscope` to trust the existing Balancer price row in this workstream.
- No new GT-specific admin controls or manual breaker-reset tooling.
- No generalized provider-throttling framework beyond what the GT probe path needs.

## Implementation Order

```text
Phase 0  Lock acceptance criteria and characterize current GT probe behavior in tests
Phase 1  Harden the public GT probe and persist GT probe metadata
Phase 2  Prefer authenticated CoinGecko /onchain pools where available, retain GT fallback
Phase 3  Update docs and methodology/version surfaces as required
Phase 4  Validate locally, deploy, and monitor the next eligible quarter-hourly runs
```

This order keeps the smallest, highest-confidence fix first while still covering the full intended end state.

## Workstream Overview

| ID | Priority | Outcome | Main surfaces |
| --- | --- | --- | --- |
| `GT1` | P0 | GT probe survives transient throttling better | `worker/src/lib/geckoterminal-price-probe.ts` |
| `GT2` | P0 | GT probe behavior is visible in cron metadata | `worker/src/cron/enrich-prices.ts`, `worker/src/cron/sync-stablecoins.ts`, `worker/src/cron/sync-stablecoins/metadata.ts` |
| `GT3` | P1 | Probe prefers authenticated CoinGecko `/onchain` pools where available | `worker/src/lib/geckoterminal-price-probe.ts`, `worker/src/lib/coingecko-onchain.ts`, scheduled callsites |
| `GT4` | P1 | Tests cover retry behavior, metadata propagation, and CG-onchain fallback logic | worker unit + cron tests |
| `GT5` | P1 | Docs and methodology surfaces match the final runtime behavior | pricing docs and methodology/version files |
| `GT6` | P0/P1 | Production verification confirms breaker behavior on the next eligible runs | Wrangler tail, `/api/health`, remote `cron_runs` |

## Phase 0 - Characterization Lock

### GT1.1 Add characterization tests before changing probe mechanics

**Purpose**

Make the behavior change explicit before modifying retry and source preference logic.

**Files**

- `worker/src/lib/__tests__/geckoterminal-price-probe.test.ts`
- `worker/src/cron/__tests__/sync-stablecoins.test.ts`

**Implementation**

1. Add a regression test showing that a two-request probe with one transient `429` followed by success should end as source success after retries are introduced.
2. Add a regression test for the all-hard-failure path still recording breaker failure.
3. Add a characterization test for stats propagation into the final `sync-stablecoins` metadata payload.
4. If Phase 2 is implemented in the same branch, add tests for:
   - CoinGecko `/onchain` preferred when API key + chain mapping exist
   - GT public fallback used when no API key exists
   - GT public fallback used when CG `/onchain` returns no pools / unusable pools

**Exit Criteria**

- Current and intended GT probe behavior are both represented in tests before rollout.

## Phase 1 - Public GT Probe Hardening

### GT1.2 Increase resilience of the existing GT public path

**Goal**

Reduce false breaker reopens caused by short-lived Worker-edge throttling on a tiny probe set.

**Files**

- `worker/src/lib/geckoterminal-price-probe.ts`
- possibly `worker/src/lib/constants.ts` if retry count or timeout is promoted into a constant

**Implementation**

1. Increase GT probe fetch retries from `0` to `1` as the baseline default.
2. Keep the current `fetchWithRetry()` `429` handling, including `Retry-After` support.
3. Re-evaluate `GT_PROBE_TIMEOUT_MS = 5_000`:
   - keep it if tests and prod observation suggest the issue is throttling-only
   - otherwise consider a modest increase only if needed
4. Preserve the current source-health semantics:
   - `404` / `422` remain lookup misses
   - breaker success still tracks hard upstream reachability, not token coverage
5. Keep the request count and pacing conservative; do not increase parallelism.

**Acceptance Criteria**

- A single transient `429` no longer guarantees a 30-minute breaker reopen.
- An all-`429` / all-transport-failure run still reopens the breaker.
- The probe still emits at most a tiny number of serialized requests and does not change slot-level fetch pressure materially.

## Phase 2 - GT Probe Observability

### GT2.1 Persist GT probe stats into `sync-stablecoins` metadata

**Goal**

Make GT probe behavior visible from `cron_runs` and status debugging without requiring live tails.

**Files**

- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/cron/sync-stablecoins/metadata.ts`
- related tests in `worker/src/cron/__tests__/sync-stablecoins.test.ts`

**Implementation**

1. Extend the GT probe pass return shape as needed so `sync-stablecoins` retains:
   - `probed`
   - `pricesObtained`
   - `divergences500bps`
   - `skippedLowTvl`
   - `lookupMisses`
   - `upstreamErrors`
   - optionally `updatedCount`
2. Thread those stats into the `buildStablecoinsSyncResult(...)` metadata payload under a dedicated key such as `gtProbe`.
3. Keep metadata additive and backward-compatible.
4. Ensure the metadata stays compact enough for `cron_runs.metadata`.

**Acceptance Criteria**

- Remote `cron_runs` inspection can tell whether the GT probe:
  - skipped because no candidates were eligible
  - found no usable pools
  - hit lookup misses
  - hit hard upstream errors
- No D1 schema change is required.

## Phase 3 - Authenticated CoinGecko `/onchain` Preference

### GT3.1 Use CG `/onchain` pools when the runtime can access them

**Goal**

Prefer the provider-recommended authenticated surface for GT-equivalent pool data where available, while preserving GT fallback behavior.

**Files**

- `worker/src/lib/geckoterminal-price-probe.ts`
- `worker/src/lib/coingecko-onchain.ts`
- `worker/src/cron/enrich-prices.ts`
- `worker/src/cron/sync-stablecoins.ts`
- `worker/src/handlers/scheduled/quarter-hourly.ts`
- possibly `worker/src/handlers/scheduled/context.ts` only if signature threading needs adjustment

**Implementation**

1. Expand the GT probe entrypoint to accept `coingeckoApiKey` where needed.
2. For each eligible asset:
   - if `COINGECKO_API_KEY` is configured and the chain has a CG on-chain network mapping, attempt `fetchCgTokenPools(...)` first
   - parse the returned pool set with the existing CG-onchain-compatible helpers
   - run the same pool-selection / TVL-gating logic used by the current GT probe
3. If the CG `/onchain` call yields:
   - no usable response
   - no pools
   - no pool surviving the current TVL/price extraction gates
   then fall back to the current GT public `/pools` call.
4. Keep the probe logically serialized and low-volume; do not batch or parallelize this path yet.
5. Preserve current output semantics:
   - same `SourcePrice` shape
   - same weight
   - same consensus reinjection behavior
6. Add clear logging/metadata about which transport path was used if that can be done without bloating hotspot files.

**Acceptance Criteria**

- On environments with `COINGECKO_API_KEY`, eligible CG-mapped assets probe via `/onchain` before public GT.
- GT public remains available as fallback for uncovered or unsuccessful CG-onchain probes.
- Assets like `gyd-gyroscope` still retain a live path even if CG-onchain coverage is absent.

### GT3.2 Keep methodology semantics honest

**Goal**

Avoid accidental drift between the runtime transport path and the documented meaning of the source.

**Implementation**

1. Decide explicitly whether the probe remains documented as a GeckoTerminal-equivalent pool probe fetched from either:
   - public GT, or
   - CoinGecko authenticated on-chain mirror
2. If yes:
   - keep source labels stable
   - update docs to explain the transport preference
3. If no:
   - treat this as a methodology change
   - update versioning/timeline surfaces in Phase 4

**Default Recommendation**

Treat the CG `/onchain` path as a transport preference for equivalent pool-level data, not as a different source family, unless implementation evidence shows materially different coverage/selection semantics.

## Phase 4 - Documentation And Methodology Surfaces

### GT5.1 Update verified docs

**Files**

- `docs/pricing-pipeline.md`
- possibly `docs/worker-and-api-limits.md`

**Implementation**

1. Update the GT probe section in [pricing-pipeline.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/pricing-pipeline.md) to describe:
   - retry behavior
   - persisted GT probe diagnostics in cron metadata, if documented
   - authenticated CG `/onchain` preference plus GT public fallback, if Phase 3 lands
2. Update [worker-and-api-limits.md](/home/ahirice/Documents/git/stablecoin-dashboard/docs/worker-and-api-limits.md) only if the enforced throttle/timeout/retry assumptions materially change.

### GT5.2 Update methodology versioning only if semantics changed

**Files, only if needed**

- `shared/lib/pricing-pipeline-version.ts`
- `docs/pricing-pipeline-timeline.md`
- `src/app/methodology/sections/core-sections.tsx`

**Decision Rule**

- No version bump if this is strictly reliability hardening plus transport preference with unchanged pricing semantics.
- Version bump required if the pricing-source meaning or selection contract changes in a way users would reasonably treat as methodology, not transport.

## Phase 5 - Validation

### Mandatory Local Validation

Run after the implementation is complete:

```bash
npx vitest run worker/src/lib/__tests__/geckoterminal-price-probe.test.ts worker/src/cron/__tests__/sync-stablecoins.test.ts
npm run lint
cd worker && npx tsc --noEmit
npm run test:merge-gate
```

Add any additional targeted tests required by the final touch set, especially if `coingecko-onchain.ts` helpers or scheduled callsites change.

## Phase 6 - Deploy And Monitor

### GT6.1 Post-deploy verification checklist

Because the GT breaker uses a 30-minute cooldown, deployment validation must watch the next eligible quarter-hourly windows, not just immediate health.

**Verification Steps**

1. Confirm the new worker deployment is live via:
   - `npx wrangler deployments list`
2. Start live logs:
   - `cd worker && npx wrangler tail --format=pretty`
3. Watch the next eligible `*/15` run after deployment.
4. Inspect:
   - `https://api.pharos.watch/api/health`
   - remote `cron_runs` row for `sync-stablecoins`

**Success Criteria**

- Best case:
  - `geckoterminal-probe` closes on the next eligible probe
- Acceptable intermediate case:
  - breaker remains open, but `cron_runs.metadata.gtProbe` shows reduced hard failures or successful CG-onchain preference / fallback behavior
- Failure case:
  - breaker still reopens due to all-hard-failure runs after retries and preferred CG-onchain path

### GT6.2 Immediate rollback threshold

Rollback is warranted if the follow-up causes any of the following:

- `sync-stablecoins` runtime regression or cron failure
- asset price regressions outside the two GT-probe candidates
- new connection-budget or timeout issues in the quarter-hourly slot
- unexpected widespread source-label or confidence drift

## Recommended PR Strategy

```text
PR 1  GT probe retry hardening + GT probe metadata + tests + pricing doc update
PR 2  Authenticated CG /onchain preference + GT fallback + tests + docs/methodology updates if needed
```

This split keeps the first deploy tightly scoped and makes the second change measurable against improved metadata.

## Exit Criteria

The workstream is complete when all of the following are true:

- the GT probe no longer reopens on a single transient Worker-edge throttle event
- GT probe run diagnostics are visible in `sync-stablecoins` metadata
- authenticated CG `/onchain` preference is implemented where supported, with GT public fallback retained
- tests and docs match the final runtime contract
- post-deploy monitoring of the next eligible quarter-hourly runs confirms the intended behavior
