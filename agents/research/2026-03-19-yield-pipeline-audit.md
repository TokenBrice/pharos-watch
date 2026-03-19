# Yield Pipeline Audit

Date: 2026-03-19
Scope: End-to-end Yield Intelligence pipeline across worker ingestion, source resolution, persistence, cache-backed APIs, frontend consumers, docs, deploy flow, and post-deploy observability.

## Method

- Read the core architecture, API, testing, worker-limit, methodology, yield, and deployment docs.
- Audited the yield worker code path:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/yield-sync/{sources,resolve,rankings,cache}.ts`
  - `worker/src/cron/yield-helpers.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/fetch-tbill-rate.ts`
- Audited the public API and frontend yield consumers:
  - `worker/src/api/{cache-handlers,yield-history}.ts`
  - `src/app/yield/client.tsx`
  - `src/components/{yield-leaderboard,yield-detail-section,yield-history-chart,yield-table-logic}.tsx`
- Queried the live API and DeFiLlama pool surface to compare configured coverage against published output.
- Ran the targeted yield test suite before implementation, then added regression coverage around the fixes.
- Used subagents for worker, frontend/API, and deployment review.

## Current Coverage Snapshot

Repo-state counts from `yield-config.ts` and tracked stablecoin metadata:

- Yield-bearing tracked coins: `45`
- Static curated `YIELD_POOL_MAP` coverage: `33`
- Wrapper/variant `YIELD_VARIANT_MAP` coverage: `24`
- Deterministic `ON_CHAIN_RATE_CONFIGS` coverage: `13`
- Benchmark-derived `RATE_DERIVED_CONFIGS` coverage: `5`
- Yield-bearing coins with no static/native deterministic mapping at all: `5`
  - `usdb-blast`
  - `thbill-theo`
  - `cetes-etherfuse`
  - `pusd-polaris`
  - `usg-tangent`

Live-output observations taken from `https://api.pharos.watch/api/yield-rankings` and current DeFiLlama pools:

- Published rankings count: `64`
- Yield-bearing coins missing live ranking coverage: `usyc-hashnote`, `cetes-etherfuse`, `pusd-polaris`, `usg-tangent`
- Wrapper pools such as `fxSAVE` and `msY` are present upstream but are not flagged `stablecoin: true` by DeFiLlama, which previously caused them to be filtered out before variant matching.
- Some `defillama-auto` rows for yield-bearing coins were being published with the coin's native `yieldSource` and `yieldType`, which made alternate lending markets look like canonical native yield.

## Findings

### High

1. Wrapper coverage was being dropped before Layer 2 matching.
   - Location: `worker/src/cron/yield-sync/sources.ts`, `worker/src/cron/dex-liquidity/fetch-primary.ts`
   - Root cause: both the cached DEX pool subset and the direct DeFiLlama fallback filtered on `pool.stablecoin === true` before `YIELD_VARIANT_MAP` matching.
   - Impact: valid savings wrappers like `fxSAVE` and `msY` never reached the resolver, producing real coverage gaps.
   - Status: fixed in this changeset.

2. Deterministic on-chain rows and curated rows could collide on source identity.
   - Location: `worker/src/cron/yield-sync/resolve.ts`
   - Root cause: deterministic rows reused the native pool UUID as `sourceKey`, so previous-rate lookup and history grouping could mix on-chain and curated sources.
   - Impact: contaminated history, incorrect prior-rate selection, and unstable multi-source persistence when both source families coexist.
   - Status: fixed in this changeset by moving deterministic rows to `onchain:<stablecoinId>`.

3. Live safety hydration could silently drop valid yield rows.
   - Location: `worker/src/api/cache-handlers.ts`
   - Root cause: rankings hydration depended on a matching report-card snapshot row instead of falling back to yield defaults.
   - Impact: `/api/yield-rankings` coverage could shrink even when cached yield data existed and remained valid.
   - Status: fixed in this changeset by retaining rows with `DEFAULT_SAFETY_SCORE` and grade `NR`.

4. Malformed warning JSON could take down `yield-history`.
   - Location: `worker/src/api/yield-history.ts`
   - Root cause: warning-signal parsing assumed valid JSON for every row.
   - Impact: a single malformed `warning_signals` value could return HTTP 500 for an entire coin history request.
   - Status: fixed in this changeset by treating malformed warning payloads as `[]`.

5. Yield sync can still delete good rows after a transient source outage.
   - Location: `worker/src/cron/sync-yield-data.ts`
   - Root cause: stale-row cleanup is keyed to “resolved this run” rather than “input set known-good this run”.
   - Impact: if a source family is temporarily unavailable, current rows can be purged immediately instead of retained with a degraded freshness state.
   - Status: not fixed in this changeset. This is the largest remaining pipeline reliability issue.

6. Deploy and smoke flow is not yield-specific enough for a sensitive cron-backed feature.
   - Location: `.github/workflows/deploy-cloudflare.yml`, ops flow
   - Root cause: deploy validates generic API/UI reachability but not the yield pipeline's worker-first / cron-freshness / cache-freshness chain.
   - Impact: a deploy can be “green” while yield cron freshness, cache freshness, or ranking integrity is degraded.
   - Status: not fixed in this changeset.

### Medium

1. Auto-discovered yield-bearing rows could masquerade as canonical native yield.
   - Location: `worker/src/cron/sync-yield-data.ts`
   - Root cause: `yieldConfig` labels won over discovered lending protocol labels.
   - Impact: alternate sources for coins like `frxUSD` and `reUSD` were mislabeled in public payloads.
   - Status: fixed in this changeset by prioritizing protocol-derived labels for `defillama-auto`.

2. Retained benchmark fallback was published as if it were healthy.
   - Location: `worker/src/cron/fetch-tbill-rate.ts`
   - Root cause: retained last-known-good benchmark writes carried `isFallback: false`.
   - Impact: degraded Treasury-benchmark state was under-reported.
   - Status: fixed in this changeset by preserving `isFallback: true`.

3. Price-derived APY still lacks stricter freshness semantics.
   - Location: `worker/src/cron/yield-sync/sources.ts`, `worker/src/cron/sync-yield-data.ts`
   - Root cause: price-derived fallback depends on existing price history but does not expose a dedicated freshness budget or stronger degraded state when that history is thin.
   - Impact: fallback quality can vary more than the public provenance currently suggests.
   - Status: not fixed in this changeset.

4. `yield-rankings` freshness can still look healthier than the underlying cache graph.
   - Location: ops freshness / cache handling
   - Root cause: yield freshness is not explicitly coupled to successful `yield-rankings` cache publication after sync.
   - Impact: operator views can overstate health if row writes succeed but rankings cache publication or hydration later fails.
   - Status: not fixed in this changeset.

5. Shared history contract drift remains.
   - Location: shared types vs `worker/src/api/yield-history.ts`
   - Root cause: the actual history response shape and the shared contract are not fully aligned.
   - Impact: type assumptions can drift across the frontend and worker boundary.
   - Status: not fixed in this changeset.

6. Frontend still does not fully exploit source-aware history mode.
   - Location: `src/components/yield-history-chart.tsx`, hooks/api contracts
   - Root cause: the chart path still prefers best-row history instead of making source selection first-class.
   - Impact: alternative-source analysis remains shallower than the backend now supports.
   - Status: not fixed in this changeset.

7. CI smoke does not validate yield semantics end to end.
   - Impact: no automated check currently asserts that rankings publish, hydration works, and representative yield rows are sane after deploy.
   - Status: not fixed in this changeset.

8. Degraded yield runs are observable but not proactively alerted.
   - Impact: operator response still depends too much on manual review.
   - Status: not fixed in this changeset.

### Low

1. Missing or incomplete source-link overrides remain for some discovered protocols, including Morpho Blue.
2. The detail page still has edge cases where a coin with legitimate yield rows can be hidden if ranking fetch state and metadata disagree at the wrong moment.
3. Reward-only alternate sources are still not especially transparent in chart split mode.

## Implemented in This Changeset

1. Added `isYieldRelevantDlPool()` and used it in both the DEX cache writer and the direct DeFiLlama fallback path so wrapper pools can survive pre-filtering.
2. Preserved actual `stablecoin` and `exposure` values in cached minimal DL pools instead of forcing `stablecoin: true`.
3. Switched deterministic rows to stable `onchain:<id>` source keys and restricted previous-rate lookups to rows with non-null `exchange_rate`.
5. Fixed `defillama-auto` label/type resolution so discovered lending rows publish protocol-derived labels and `lending-opportunity`.
6. Marked retained benchmark fallback snapshots as actual fallback mode.
7. Made `yield-history` tolerant of malformed `warning_signals` JSON.
8. Kept rankings rows alive when report-card hydration is incomplete, using `DEFAULT_SAFETY_SCORE` / `NR`.
9. Added regression tests for wrapper filtering, on-chain/native source coexistence, discovered-source labeling, malformed warning JSON, retained benchmark degradation, and rankings hydration fallback.

## Remaining Priority Order

### P0

- Prevent destructive stale-row deletion when source inputs are degraded or unavailable.
- Add yield-specific deploy and smoke gates that verify worker deploy, cron execution, cache publication, and public rankings integrity together.

### P1

- Close the remaining yield-bearing coverage gaps:
  - `usyc-hashnote`
  - `cetes-etherfuse`
  - `pusd-polaris`
  - `usg-tangent`
  - review `usdb-blast` and `thbill-theo`
- Strengthen price-derived provenance and degraded-state signaling.
- Fix the shared `yield-history` contract drift and expose source-aware history mode properly in the frontend.

### P2

- Add missing protocol source-link overrides.
- Add degraded-run alerting.
- Improve reward-only / alternate-source visualization.

## Audit Conclusion

The yield pipeline is structurally solid after the source-aware history and arbitration work, but it still had several correctness leaks at the boundaries:

- input filtering,
- source identity,
- cache hydration,
- malformed persisted data,
- and benchmark degradation signaling.

This changeset closes the most immediate correctness issues. The next material risk is no longer APY calculation itself; it is operational resilience: stale-row deletion on degraded inputs, incomplete yield-specific deploy smoke, and incomplete post-run monitoring.
