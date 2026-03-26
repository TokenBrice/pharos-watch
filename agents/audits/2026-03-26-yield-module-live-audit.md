# Yield Module Live Audit

Date: 2026-03-26
Owner: Codex
Status: Audit complete, remediation in progress

## Scope

- Required docs:
  - `docs/architecture.md`
  - `docs/api-reference.md`
  - `docs/testing.md`
  - `docs/worker-and-api-limits.md`
  - `docs/yield-intelligence.md`
  - `docs/yield-intelligence-operations.md`
  - `docs/yield-intelligence-timeline.md`
- Core worker code:
  - `worker/src/cron/sync-yield-data.ts`
  - `worker/src/cron/sync-yield-supplemental.ts`
  - `worker/src/cron/yield-config.ts`
  - `worker/src/cron/yield-coverage-audit.ts`
  - `worker/src/cron/yield-helpers.ts`
  - `worker/src/cron/yield-sync/{sources,resolve,evaluation,publication,history,cache,identity,types}.ts`
  - `worker/src/api/{cache-handlers,yield-history}.ts`
  - `worker/src/lib/yield-source-links.ts`
- Verification:
  - yield-focused local tests
  - live `api.pharos.watch` payload inspection
  - remote D1 production cron history inspection via Wrangler

## Baseline Verification

- Yield-focused local suite passed:
  - 26 files
  - 272 tests
- Live production checks showed:
  - `sync-yield-data` currently writing `316` source rows per run
  - `sync-yield-supplemental` currently writing `274-276` candidates per run
  - live `/api/yield-rankings` count: `90`
  - live published yield-bearing coverage: `45 / 47`
  - missing live yield-bearing rows: `usbd-bima`, `ftusd-flying-tulip`

## Priority Findings

### 1. High: supplemental dedupe is still collapsing Aave rows across different coins

Files:

- `worker/src/cron/sync-yield-supplemental.ts`

Evidence:

- `sync-yield-supplemental` metadata reports `aaveV3: 15`
- current production `yield_data` has only `3` rows where `source_key LIKE 'aave-v3-onchain:%'`
- current keys are chain-only:
  - `aave-v3-onchain:ethereum`
  - `aave-v3-onchain:base`
  - `aave-v3-onchain:arbitrum`

Root cause:

- Aave supplemental rows use a chain-only `sourceKey`
- `dedupeCandidates()` dedupes only by `yield.sourceKey`
- that collapses all same-chain Aave assets into one cached candidate

Impact:

- 12 live Aave rows are being discarded before hourly publication even sees them
- production supplemental counts under-report the real family output
- yield coverage and alternative-source breadth are both lower than intended

### 2. Medium: supplemental monitoring hides candidate loss

Files:

- `worker/src/cron/sync-yield-supplemental.ts`

Evidence:

- raw family counts sum to `288` on the current production run
- deduped persisted count is `276`
- metadata reports `rowsDropped: 0`

Root cause:

- the cron returns only deduped counts
- no raw-candidate vs deduped-candidate accounting exists

Impact:

- operators cannot see when a family silently loses rows
- regressions like the Aave collapse look healthy in cron history

### 3. Medium: monthly coverage audit still overstates gaps because it treats only native static UUIDs as covered DL pools

Files:

- `worker/src/cron/yield-coverage-audit.ts`

Evidence:

- production `yield-coverage-audit` cache currently reports:
  - `coveredPoolCount: 34`
  - `unmatchedHighTvlPoolCount: 547`
  - `missingProtocolCount: 176`
- the same report flags many pools on already-supported allowlisted protocols and ignores exact covered DL surfaces outside `YIELD_POOL_MAP`

Root cause:

- covered DL pool set is built only from `YIELD_POOL_MAP`
- exact auto-discovery overrides and explicit curated pool overrides are not counted
- high-TVL gap reporting does not exclude already-supported allowlisted protocol surfaces

Impact:

- the operator audit is noisy
- high-signal expansion work is harder to distinguish from already-supported runtime coverage

### 4. Medium: fallback price-derived rows are surfacing visibly stale and sometimes negative yields

Files:

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-sync/sources.ts`

Evidence:

- live `/api/yield-rankings` currently publishes:
  - `usda-avalon`: `-2.817%`, `data-stale`
  - `cetes-etherfuse`: `-25.225%`, `data-stale`
  - `ustb-superstate`: `data-stale`
- these rows are all coming from `price-derived`

Assessment:

- this is real output noise, but not the first remediation target because it is methodology-sensitive
- it should be re-evaluated after the source-identity and monitoring fixes land

### 5. Known live coverage gaps remain

Files:

- `worker/src/cron/yield-config.ts`
- `worker/src/cron/yield-sync/sources.ts`

Evidence:

- live published yield-bearing gaps:
  - `usbd-bima`
  - `ftusd-flying-tulip`
- current upstream BIMA feed is low-signal:
  - TVL about `$11.84`
  - APR `0`
- current DL cache has no `sUSBD` or `sftUSD` pool entries

Assessment:

- these are real gaps
- they do not currently have a clean, trustworthy source-level fix available from existing upstreams
- the short-term action is better monitoring and explicit documentation, not fabricated coverage

## Remediation Order

1. Fix supplemental source identity and dedupe semantics.
2. Expose supplemental row-loss in cron metadata and tests.
3. Reduce coverage-audit noise so operator reports become actionable again.
4. Re-run validation and inspect live runs post-deploy.
5. Re-assess stale/negative price-derived fallback behavior after the publication surface stabilizes.
