# Live Reserve Sync Audit

Date: 2026-03-12
Scope: `sync-live-reserves`, reserve adapter contract, `GET /api/stablecoin-reserves/:id`, detail-page live reserve fallback, and `/status` coverage.

## Validation

- `npm run build` passed.
- `cd worker && npx tsc --noEmit` passed.
- Focused reserve/status tests passed:
  - `worker/src/cron/__tests__/sync-live-reserves.test.ts`
  - `worker/src/api/__tests__/stablecoin-reserves.test.ts`
  - `worker/src/api/__tests__/status.test.ts`
  - `worker/src/cron/reserve-adapters/__tests__/infinifi.test.ts`
- Per request, current lint failures in these newly added test files were excluded from audit findings because they are already being fixed in parallel.

## Executive Summary

The first live-reserve implementation is small and easy to follow, but it is not yet reliable enough to scale beyond the current single-coin InfiniFi case.

The main issue is operational truthfulness: the cron can fail completely while `/status` still reports the lane as healthy. The second issue is architecture: the current adapter and circuit-breaker model is too narrow for the source families identified in `agents/research/real-time-reserve-update-sources.md`. The third issue is user-facing fallback behavior: live-reserve failures silently collapse back to static curated reserves without telling the user.

## Findings

### 1. High: `sync-live-reserves` can fail while `/status` still shows a healthy cron

Evidence:

- `syncLiveReserves()` increments `failed`, but almost never returns a non-`ok` cron status. It returns plain metadata for:
  - circuit-open skips: [`worker/src/cron/sync-live-reserves.ts:21`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L21)
  - unknown adapters: [`worker/src/cron/sync-live-reserves.ts:34`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L34)
  - empty adapter output: [`worker/src/cron/sync-live-reserves.ts:42`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L42)
  - per-coin exceptions: [`worker/src/cron/sync-live-reserves.ts:64`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L64)
  - final return: [`worker/src/cron/sync-live-reserves.ts:77`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L77)
- `logCronRun()` defaults missing status to `"ok"`: [`worker/src/lib/db.ts:468`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/db.ts#L468)
- `/api/status` treats a fresh `ok` run as healthy: [`worker/src/api/status.ts:273`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status.ts#L273)

Impact:

- In the current one-coin setup, InfiniFi can fail for a full day and the cron card still stays green.
- If an old `reserve_composition` row exists, the public endpoint probe can still return `200`, so neither the cron lane nor the probe lane necessarily reveals that no fresh reserve snapshot was written.

Suggested fix:

- Return explicit cron status:
  - `error` when `synced === 0 && failed > 0`
  - `degraded` when `failed > 0`, `unknownFarms.length > 0`, or the circuit is open
  - `ok` only when all configured coins synced cleanly
- Add reserve-specific freshness/coverage checks to `/api/status`, not just cron-run freshness.

### 2. High: the circuit-breaker model is incorrect once more than one live-reserve source exists

Evidence:

- A single global breaker gates the entire feature: [`worker/src/cron/sync-live-reserves.ts:20`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L20)
- The outcome is recorded once for the whole run, and counts as success if even one coin succeeded: [`worker/src/cron/sync-live-reserves.ts:71`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L71)
- The source key is shared for all live reserves: [`worker/src/lib/constants.ts:139`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/lib/constants.ts#L139)

Impact:

- One broken adapter can open the breaker for unrelated healthy sources.
- Partial success resets the failure count and prevents the breaker from ever opening for flaky subsets.
- The current design is acceptable only for the current single-source rollout.

Suggested fix:

- Move from one global `LIVE_RESERVES` breaker to per-source or per-coin keys such as:
  - `live-reserves:infinifi`
  - `live-reserves:bold-liquity`
- Record breaker outcomes inside the per-coin loop, not once at the end.
- Surface those per-source breaker states in `/api/health` and the status UI.

### 3. High: the adapter/config contract is not generalizable to the researched source families

Evidence:

- `LiveReservesConfig` only carries `adapter`, `url`, and `displayUrl`: [`shared/types/index.ts:141`](/home/ahirice/Documents/git/stablecoin-dashboard/shared/types/index.ts#L141)
- Adapters only receive `(url, signal, ctx)` and `ctx` only exposes Etherscan/Alchemy keys: [`worker/src/cron/reserve-adapters/index.ts:4`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/index.ts#L4)
- The research memo expects reusable adapter families and source-specific semantics:
  - reusable Liquity families: [`agents/research/real-time-reserve-update-sources.md:194`](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/real-time-reserve-update-sources.md#L194)
  - semantics ambiguity for ZCHF: [`agents/research/real-time-reserve-update-sources.md:169`](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/real-time-reserve-update-sources.md#L169)
  - semantics ambiguity for dEURO: [`agents/research/real-time-reserve-update-sources.md:189`](/home/ahirice/Documents/git/stablecoin-dashboard/agents/research/real-time-reserve-update-sources.md#L189)

Impact:

- A shared family adapter cannot be expressed cleanly when it needs per-coin branch addresses, registry ids, or semantic flags.
- Non-EVM/indexer-backed sources are awkward because the worker only passes two EVM API keys.
- Multi-source or fallback source definitions cannot be represented cleanly.

Suggested fix:

- Replace `url: string` with structured adapter input, for example:
  - `adapter`
  - `display`
  - `params`
  - `semantics`
  - `fallbacks`
  - `version`
- Pass full config plus `stablecoinId` into the adapter.
- Add per-adapter runtime validation for both config and output.

### 4. High: live-reserve failures are silently hidden from the detail page

Evidence:

- `fetchStablecoinReserves()` turns `404` into `null`: [`src/lib/api.ts:204`](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/api.ts#L204)
- `useStablecoinReserves()` ignores query error state and returns `null` whenever no `data` exists: [`src/hooks/use-stablecoin-reserves.ts:21`](/home/ahirice/Documents/git/stablecoin-dashboard/src/hooks/use-stablecoin-reserves.ts#L21)
- The view model falls back to static reserves: [`src/lib/stablecoin-detail-view-model.ts:195`](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/stablecoin-detail-view-model.ts#L195)
- The overview only labels live snapshots or estimated templates; curated static fallback shows no status copy at all: [`src/components/stablecoin-detail/overview-section.tsx:48`](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/stablecoin-detail/overview-section.tsx#L48)

Impact:

- For a live-enabled coin, the UI can quietly fall back to a static curated snapshot after a 404, 500, or network error.
- The user is not told that the “live” mechanism is unavailable.

Suggested fix:

- Extend `ReserveResult` with a source mode such as:
  - `live`
  - `curated-fallback`
  - `template`
  - `live-error`
- Bubble query errors into the view model.
- Show an explicit badge/message when a live-enabled coin is not currently using live data.

### 5. Medium: `/status` coverage exists, but it is incomplete and can mislead operators

What is covered today:

- Cron lane registration exists: [`shared/lib/cron-jobs.ts:230`](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/cron-jobs.ts#L230)
- The job is scheduled in the daily slot: [`worker/src/handlers/scheduled/daily-0800.ts:22`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/handlers/scheduled/daily-0800.ts#L22)
- The reserve endpoint is in the public probe set: [`shared/lib/api-endpoints.ts:127`](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/api-endpoints.ts#L127)
- Circuit states are shown via `/api/health`: [`worker/src/api/health.ts:106`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/health.ts#L106)

What is missing:

- No reserve dataset freshness target exists in `/api/status`: [`worker/src/api/status.ts:922`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/status.ts#L922)
- No live-reserve cron metadata summarizer exists: [`src/components/status/cron-metadata-summary.ts:210`](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/status/cron-metadata-summary.ts#L210)
- `stablecoin-reserves-probe` is known to be allowed to return `404` in router tests: [`worker/src/api/__tests__/router-contract.test.ts:68`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/api/__tests__/router-contract.test.ts#L68)
- But status self-check only treats some `503` cache misses as bootstrap misses, not reserve `404`s: [`worker/src/cron/status-self-check.ts:45`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/status-self-check.ts#L45)

Impact:

- `/status` can false-green after failed reserve syncs.
- `/status` can also false-red on new environments before the first successful daily reserve sync.

Suggested fix:

- Add a `reserveComposition` freshness block to `/api/status`.
- Compute:
  - configured coins
  - fresh rows
  - stale rows
  - missing rows
  - oldest successful fetch age
- Add a `sync-live-reserves` metadata summary card for `synced/failed/total`, `unknownFarms`, and `circuitOpen`.
- Treat `/api/stablecoin-reserves/:canary` as bootstrap-optional until at least one successful sync exists for that canary coin.

### 6. Medium: synced reserve data is not authoritative across the rest of the product

Evidence:

- Report cards still use `meta.reserves`: [`shared/lib/report-cards.ts:441`](/home/ahirice/Documents/git/stablecoin-dashboard/shared/lib/report-cards.ts#L441)
- Portfolio analysis still uses `meta.reserves`: [`src/lib/portfolio-analysis.ts:231`](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/portfolio-analysis.ts#L231)
- Dependency map still derives links from static metadata: [`src/components/contagion-graph.tsx:250`](/home/ahirice/Documents/git/stablecoin-dashboard/src/components/contagion-graph.tsx#L250)
- Compare-page reserve descriptions still look at static reserve metadata: [`src/lib/compare-pages.ts:57`](/home/ahirice/Documents/git/stablecoin-dashboard/src/lib/compare-pages.ts#L57)

Impact:

- The detail page can show live reserves while report-card collateral scoring, dependency edges, and portfolio exposure math still use static snapshots.
- This creates internal inconsistency around what “reserve composition” means in the product.

Suggested fix:

- Make an explicit product decision:
  - If live reserves are detail-page-only, document that clearly.
  - If live reserves are meant to be authoritative, expose resolved reserve composition through the worker and have downstream analytics consume it from there.

### 7. Medium: unknown farm handling is too permissive for a risk-sensitive feature

Evidence:

- Unknown farms are assigned heuristic risk (`LIQUID -> low`, otherwise `medium`) and still persisted: [`worker/src/cron/reserve-adapters/infinifi.ts:64`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/reserve-adapters/infinifi.ts#L64)
- They are only logged into metadata with no stablecoin scoping or degraded status: [`worker/src/cron/sync-live-reserves.ts:47`](/home/ahirice/Documents/git/stablecoin-dashboard/worker/src/cron/sync-live-reserves.ts#L47)

Impact:

- A new upstream farm can silently enter the reserve mix with a guessed risk level and no `coinId` linkage.
- Dependency and collateral-quality interpretation become less trustworthy exactly when the source surface changes.

Suggested fix:

- Mark the run `degraded` when unknown farms exist.
- Store unknown inputs in a structured, per-coin shape.
- Consider a stricter mode for stablecoin-like upstreams: require explicit mapping before counting them as low-risk wrappers.

### 8. Low: documentation/source-copy drift remains

Evidence:

- The project rule explicitly requires the about page to be updated when a new data source is added: [`docs/about-page.md:52`](/home/ahirice/Documents/git/stablecoin-dashboard/docs/about-page.md#L52)
- The about page source list and FAQ still omit protocol-specific reserve APIs / dashboards: [`src/app/about/page.tsx:31`](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/about/page.tsx#L31), [`src/app/about/page.tsx:365`](/home/ahirice/Documents/git/stablecoin-dashboard/src/app/about/page.tsx#L365)

Suggested fix:

- Add a dedicated mention of issuer/protocol reserve APIs and live reserve composition syncing to the about-page source copy.
- Add the new flow to the architecture/data-flow docs, not only API/worker docs.

## Suggested Fix Plan

### Phase 1: make the current rollout operationally honest

1. Fix `sync-live-reserves` status semantics.
2. Add reserve freshness/coverage to `/api/status`.
3. Add a `sync-live-reserves` cron metadata summarizer.
4. Add explicit UI fallback states for live-enabled coins.

### Phase 2: make the pipeline truly generalizable

1. Redesign `LiveReservesConfig` into a structured adapter config.
2. Move to per-source/per-coin circuit breakers.
3. Add runtime output validation and adapter-version metadata.
4. Encode source semantics explicitly (`collateral-mix` vs `protocol-reserve` vs `attestation-mix`).

### Phase 3: decide product scope for live reserves

1. Either keep live reserves as a detail-page-only overlay and document that.
2. Or make them authoritative and route downstream scoring/dependency surfaces through the synced data.

## Recommended Priority

Do first:

1. Cron status semantics and `/status` freshness coverage.
2. Frontend fallback labeling.
3. Per-source circuit breakers.

Do before adding the next live-reserve source family:

1. Structured adapter config.
2. Semantic source typing.
3. Better unknown-input handling.
