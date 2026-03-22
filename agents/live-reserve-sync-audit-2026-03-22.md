# Live Reserve Sync Audit

Date: 2026-03-22

Scope: full live reserve sync implementation, including the adapter registry, shared helpers, hourly sync orchestration, D1 persistence, API/read paths, reserve-health/status consumers, and every registered adapter currently referenced by `ACTIVE_STABLECOINS`.

Primary goals:

- data accuracy
- implementation reliability
- maintainability / mutualization / LOC reduction

## Executive Summary

The reserve-sync expansion materially increased surface area, but the implementation is still split across three very different classes of evidence:

- 40 live-enabled coins use `independent` evidence
- 26 use `validated-static` evidence
- 48 use `weak-live-probe` evidence

That means only 40 of the 114 live-enabled coins currently have scoring-eligible independent live evidence. The rest are probe-validated or curated/static compositions presented through the live pipeline. This is acceptable if explicitly intentional, but it should shape planning: the recent coverage increase improved UI/status coverage much more than it improved independently measured reserve truth.

The most serious implementation issue is not adapter parsing. It is state management: failed/skipped sync attempts overwrite the last successful adapter metadata in `reserve_sync_state`, even though downstream systems use that metadata for redemption capacity and live fee telemetry. A single failed hourly run can therefore erase usable live metadata while the last successful reserve snapshot still exists.

The next largest problem is contract quality:

- warning-bearing snapshots are always marked `degraded`, regardless of warning severity or materiality
- malformed stored slices are silently filtered and still served as authoritative live output
- freshness guarantees are inconsistent across adapters, especially HTML/dashboard feeds
- several adapters round to whole percentages or drop sub-0.05% tails, which is not aligned with the stated goal of precision

The codebase is also showing predictable adapter-sprawl symptoms:

- repeated fetch/parse/normalize patterns
- repeated hardcoded token/farm/bucket maps
- repeated "validate a probe, then emit static slices" logic across several adapters
- repeated HTML scraping with bespoke regexes and no shared extraction layer

## What I Reviewed

- Docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/live-reserves.md`
- Shared contract: `shared/lib/live-reserve-adapters.ts`
- Orchestration: `worker/src/cron/sync-live-reserves.ts`
- Storage/read path: `worker/src/lib/live-reserves-store.ts`
- API/status/scoring consumers:
  - `worker/src/api/stablecoin-reserves.ts`
  - `worker/src/lib/status-evaluation.ts`
  - `worker/src/api/status-supplements.ts`
  - `worker/src/lib/report-cards-snapshot.ts`
  - `worker/src/lib/redemption-backstop-sources.ts`
- Every adapter in `worker/src/cron/reserve-adapters/`
- Relevant tests in:
  - `worker/src/cron/__tests__/sync-live-reserves.test.ts`
  - `worker/src/lib/__tests__/live-reserves-store.test.ts`
  - representative adapter tests

Additional repo facts confirmed from current config:

- 114 live-enabled coins
- 27 registered adapters
- 0 configured fallback inputs
- only 3 shared breaker scopes currently group multiple coins:
  - `m0`
  - `mento-reserve`
  - `sky-makercore-collateral`

## Severity-Ordered Findings

### 1. Critical: failed/skipped runs erase last successful live metadata

Files:

- `worker/src/cron/sync-live-reserves.ts:176`
- `worker/src/cron/sync-live-reserves.ts:180`
- `worker/src/cron/sync-live-reserves.ts:183`
- `worker/src/lib/live-reserves-store.ts:167`
- `worker/src/lib/live-reserves-store.ts:188`
- `worker/src/lib/redemption-backstop-sources.ts:156`
- `worker/src/lib/redemption-backstop-sources.ts:249`

Why this matters:

- successful reserve snapshots persist adapter metadata only in `reserve_sync_state.metadata`
- on failure or circuit-open skip, `recordFailure()` writes `metadata: { reason }`
- that overwrites prior `immediateRedeemableUsd`, `immediateRedeemableRatio`, `redemptionFeeBps`, and any other reusable live telemetry
- redemption-backstop capacity and live redemption fee logic read from `reserve_sync_state.metadata`, not from the last successful reserve snapshot

Practical impact:

- a single failed reserve-sync attempt can make backstop capacity fall back to configured estimates or null
- a single failed run can remove current redemption fee telemetry for BOLD/LUSD-style routes
- this contradicts the subsystem goal of reusing last-known telemetry from D1 when the latest sync is stale or degraded

Required remediation:

- preserve last successful metadata separately from operational attempt state
- either store metadata in `reserve_composition` or split `reserve_sync_state` into:
  - last successful snapshot metadata
  - last attempt operational state
- never replace successful metadata with `{ reason }` on failure

### 2. High: stored live snapshots are silently "repaired" and still served as authoritative

Files:

- `worker/src/lib/live-reserves-store.ts:115`
- `worker/src/lib/live-reserves-store.ts:129`
- `worker/src/lib/live-reserves-store.ts:240`
- `worker/src/lib/live-reserves-store.ts:333`
- `worker/src/lib/live-reserves-store.ts:615`

Why this matters:

- `parseSlices()` filters invalid slices instead of failing closed
- `resolveReserveResult()` can therefore return `mode="live"` for a partially corrupt stored snapshot
- if a malformed row drops one or more slices, the percentages shown to users are no longer the adapter output that was validated and written

Practical impact:

- reserve composition can silently become incomplete while still being presented as live authoritative data
- drift/scoring/status consumers can operate on a truncated composition

Required remediation:

- fail closed when stored slices are malformed or incomplete
- at minimum, detect row corruption and force fallback / `unavailable` rather than silently filtering
- if best-effort parsing is retained for ops visibility, surface it as degraded and exclude it from authoritative reads

### 3. High: warning handling is too coarse and currently collapses material and informational issues into the same degraded state

Files:

- `worker/src/cron/sync-live-reserves.ts:233`
- `worker/src/cron/sync-live-reserves.ts:253`
- `worker/src/cron/reserve-adapters/chainlink-nav.ts:128`
- `worker/src/cron/reserve-adapters/gho.ts:486`

Why this matters:

- any non-empty `warnings[]` marks the sync state `degraded`
- `LiveReserveWarning.severity` exists but is not used by the orchestrator
- some warnings are operationally informative, not necessarily evidence-invalidating

Current examples:

- `chainlink-nav` in `getPrice()` mode always warns because freshness cannot be proven from the oracle response
- `gho` warns whenever residual issuance remains aggregated outside tracked GSM modules

Practical impact:

- USDY is structurally incapable of reaching `ok` despite a successful live fetch
- GHO is likely structurally incapable of reaching `ok` unless tracked GSM coverage reaches full supply
- these feeds remain excluded from scoring and permanently depress reserve-sync health

Required remediation:

- define warning classes with explicit consequences:
  - informational: visible, does not degrade
  - degraded: visible and excluded from scoring
  - fatal: hard-fail
- use `severity` or a stricter typed warning code policy to drive this

### 4. High: freshness guarantees are inconsistent and absent for many HTTP/HTML adapters

Files:

- `shared/lib/live-reserve-adapters.ts:301`
- `shared/lib/live-reserve-adapters.ts:312`
- `shared/lib/live-reserve-adapters.ts:359`
- `shared/lib/live-reserve-adapters.ts:367`
- `shared/lib/live-reserve-adapters.ts:368`
- `shared/lib/live-reserve-adapters.ts:369`
- `shared/lib/live-reserve-adapters.ts:392`
- `worker/src/cron/reserve-adapters/circle-transparency.ts:62`
- `worker/src/cron/reserve-adapters/mento.ts:103`
- `worker/src/cron/reserve-adapters/openeden.ts:83`
- `worker/src/cron/reserve-adapters/tether.ts:41`

Why this matters:

- several adapters use dashboard or HTML disclosures but provide neither `sourceTimestamp` metadata nor a `maxSourceAgeSec` validation policy
- the sync can stay `ok` even if the upstream page stops updating

Most notable feeds with missing freshness protection:

- `circle-transparency`
- `mento`
- `m0`
- `openeden-usdo`
- `infinifi`
- `reservoir`
- `fx`
- `tether`
- `frax`

Required remediation:

- inventory which upstreams expose disclosure dates / block numbers / report dates
- standardize on emitting `sourceTimestamp` wherever possible
- add adapter-level freshness policies for every dashboard/HTML/API feed that is not inherently on-chain latest-state

### 5. Medium: precision is being thrown away in several adapters

Files:

- `worker/src/cron/reserve-adapters/helpers.ts:359`
- `worker/src/cron/reserve-adapters/asymmetry.ts:45`
- `worker/src/cron/reserve-adapters/crvusd.ts:92`
- `worker/src/cron/reserve-adapters/infinifi.ts:80`
- `worker/src/cron/reserve-adapters/infinifi.ts:98`
- `worker/src/cron/reserve-adapters/reservoir.ts:124`
- `worker/src/cron/reserve-adapters/reservoir.ts:136`

Why this matters:

- `normalizeSlices()` defaults to `decimals = 0`
- several adapters call it without overriding precision
- `infinifi` and `reservoir` also drop small tails before normalization

Practical impact:

- small but real exposures disappear
- the largest slice absorbs rounding error
- "precise" live data becomes integer-quantized in some adapters but not others

Required remediation:

- make one-decimal precision the minimum default for reserve output
- stop dropping tails before computing unknown exposure / final percentages
- if UI wants rounded display, do it in presentation, not storage

### 6. Medium: adapter test coverage is materially weaker than the implementation complexity

Files:

- `worker/src/cron/reserve-adapters/__tests__/gho.test.ts:1`
- `worker/src/cron/reserve-adapters/__tests__/evm-branch-balances.test.ts:1`
- `worker/src/cron/__tests__/sync-live-reserves.test.ts:1`

Why this matters:

- the pure transform layers are tested in many adapters, but the highest-risk fetch/decode paths are not
- `gho` tests only the final `adaptGhoFacilitators()` transformation, not the custom ABI decoding / on-chain read logic
- `sync-live-reserves` tests do not cover:
  - fallback-input execution
  - adapter timeout handling
  - D1 write timeout handling
  - metadata preservation across failures
  - severity-aware warning behavior
  - stale-but-error classification

Required remediation:

- add contract tests around the real high-risk paths, not just post-processed happy paths
- prioritize tests for metadata persistence, decoder correctness, and degraded/failure state transitions

## System-Wide Architectural Observations

### Coverage quality is mixed by design

Current live-enabled coverage splits as:

- `dynamic-mix / independent`: 32 coins
- `single-bucket / independent`: 8 coins
- `validated-static / static-validated`: 26 coins
- `single-bucket / weak-live-probe`: 48 coins

Implication:

- the current system is best described as "broad reserve-surface coverage with uneven evidence strength", not "114 coins with independent live reserve verification"

Recommendation:

- expose evidence strength more prominently in ops planning and possibly in the detail API / admin UI
- treat weak-probe coverage as separate from independent live coverage in KPIs

### The storage model mixes operational state and reusable business telemetry

This is the root cause behind the metadata-loss bug. The subsystem needs two concepts:

- latest successful reserve evidence
- latest operational attempt state

They should not overwrite each other.

### The current within-run cache is too narrow

`sharedSourceMode = "source-invariant"` only reuses final adapter results when the output is coin-invariant. That misses a useful middle layer:

- identical raw fetches that still require coin-specific parsing

Examples:

- Circle HTML can be fetched once, then parsed differently for USDC and EURC
- Frax API payload can be fetched once, then mapped to different static reserve slices per coin

Recommendation:

- add helper-level raw-response memoization keyed by request signature
- keep result-level sharing for truly coin-invariant adapters

### No reserve snapshot history means poor forensic ability

Current tables only retain the latest row per coin. That limits:

- regression analysis
- source drift diagnosis
- parser breakage debugging
- evidence review after operator incidents

Recommendation:

- add a lightweight append-only history table for successful snapshots and failed attempts
- retain hashes / key metadata even if full raw payload retention is too expensive

## Adapter-by-Adapter Audit

### `accountable`

Strengths:

- emits `sourceTimestamp`
- flexible bucket selection
- warns on unmapped buckets

Weaknesses:

- duplicates config parsing instead of using the shared Zod-backed adapter parser
- `exposure_split` recursively sums nested numerics with no reconciliation guard
- does not verify chosen bucket totals against `total_reserves`

Improvements:

- use `parseLiveReserveAdapterParams()`
- add bucket-total reconciliation
- replace open-ended recursive summing with an explicit schema for each supported bucket

### `asymmetry`

Strengths:

- simple and easy to reason about

Weaknesses:

- integer normalization
- hardcoded branch map
- no freshness metadata

Improvements:

- use one-decimal normalization
- move branch mapping into shared config or canonical reserve-asset metadata

### `btcfi`

Strengths:

- fails closed on non-BTC collateral

Weaknesses:

- very brittle hardcoded BTC symbol allowlist
- no freshness metadata
- collapses everything into a single bucket, losing composition detail

Improvements:

- degrade unknown BTC wrappers into a tracked "other BTC variant" bucket instead of total failure
- attach source timestamp if available

### `chainlink-nav`

Strengths:

- direct on-chain reads
- explicit staleness enforcement in `latestRoundData()` mode

Weaknesses:

- `getPrice()` mode is permanently warning-bearing
- uses inline `Date.now()` instead of injected clock
- no severity distinction between "cannot prove freshness" and actual data problems

Improvements:

- treat unverified freshness as informational or downgrade evidence class for `getPrice()` routes
- emit a typed "freshness unknown" state instead of permanent degraded status

### `chainlink-por`

Strengths:

- direct on-chain feed usage
- explicit staleness enforcement

Weaknesses:

- same inline-clock issue as `chainlink-nav`
- single-bucket output is inherently low-information

Improvements:

- centralize Chainlink timestamp handling

### `circle-transparency`

Strengths:

- direct reserve composition extraction

Weaknesses:

- brittle regex scraping
- no source timestamp
- no adapter freshness policy
- manual param parsing instead of shared parser

Improvements:

- parse with a resilient HTML extraction helper
- extract the statement/report date and validate it

### `collateral-positions-api`

Strengths:

- real asset-level composition
- computes `unknownExposurePct`

Weaknesses:

- any missing price hard-fails the adapter
- `inferCoinId()` coverage is narrow
- no freshness metadata

Improvements:

- degrade missing-price assets into an unknown bucket when impact is immaterial
- widen coinId mapping through shared canonical symbol resolution

### `crvusd`

Strengths:

- conservative unknown-market handling

Weaknesses:

- integer normalization
- narrow collateral symbol classifier
- no freshness metadata

Improvements:

- switch to shared canonical asset classification
- preserve one-decimal precision

### `curated-validated`

Strengths:

- intentionally conservative evidence class
- very small implementation

Weaknesses:

- non-zero supply probe is not reserve validation
- detail/status surfaces still present this through the live pipeline

Improvements:

- make the presentation contract explicit: "validated static" rather than "live reserves"
- potentially merge with a more generic probe-validated-static adapter family

### `dola-inverse`

Strengths:

- emits `sourceTimestamp`
- conservative bucketing

Weaknesses:

- growing hardcoded asset lists
- no shared taxonomy reuse

Improvements:

- centralize asset bucket rules

### `erc4626-single-asset`

Strengths:

- direct on-chain probe
- optional asset mismatch warning

Weaknesses:

- manual params parsing despite a shared schema
- `totalAssets() > 0` is a weak correctness check for complex vaults

Improvements:

- use shared params parser
- consider optional share-price / asset-balance verification extensions

### `ethena`

Strengths:

- source timestamp
- total reconciliation
- unknown exposure tracking

Weaknesses:

- hardcoded asset allowlists

Improvements:

- move bucket taxonomy into shared reserve-asset classification

### `evm-branch-balances`

Strengths:

- direct on-chain balance reads
- good fit for branch/vault style systems

Weaknesses:

- `branch.token.chain` is only used for pricing, not for on-chain reads; this is a config footgun
- price map keys by branch name, so duplicate names would collide
- uses spot prices instead of protocol/accounting valuations

Improvements:

- either enforce same-chain branches at schema level or actually support per-branch chain reads
- key pricing by chain/address, not display name

### `falcon`

Strengths:

- good unknown-asset warning logic
- source timestamp

Weaknesses:

- large hardcoded allowlists
- manual taxonomy maintenance burden is high

Improvements:

- centralize asset classification and "known other" policy

### `fdusd-transparency`

Strengths:

- source timestamp extraction
- direct composition output

Weaknesses:

- brittle regex scraping

Improvements:

- move to shared HTML parser utilities

### `frax`

Strengths:

- intentionally excluded from independent scoring

Weaknesses:

- returns curated/static slices after only checking that the API exposes collateral summary data
- no source timestamp

Improvements:

- collapse into a generic probe-validated-static adapter
- avoid implying live composition where only static composition exists

### `fx`

Strengths:

- direct value-based composition

Weaknesses:

- tiny hardcoded token set
- no freshness metadata
- total failure on any new positive collateral key

Improvements:

- degrade new collateral into "other" until reviewed, instead of total failure

### `gho`

Strengths:

- richest on-chain adapter in the set
- useful redemption metadata

Weaknesses:

- complex custom ABI decoding with light test coverage
- residual issuance warning likely makes the adapter structurally degraded
- sequential facilitator reads can become slow as the registry grows

Improvements:

- add decoder-level tests
- distinguish informational residual aggregation from evidence-invalidating issues
- use bounded parallel reads for facilitator metadata

### `infinifi`

Strengths:

- useful liquidity/immediate-redeemable metadata

Weaknesses:

- hardcoded farm map
- drops sub-0.05% exposures before normalization
- integer normalization
- no freshness metadata

Improvements:

- keep tails for accuracy, even if hidden in presentation
- add source timestamp if the upstream exposes one

### `m0`

Strengths:

- explicit subtotal reconciliation
- shared-source reuse configured correctly

Weaknesses:

- hardcoded `cashScaleApplied = 1_000` is a fragile unit assumption
- no freshness metadata

Improvements:

- validate units against a secondary invariant or documented field
- extract and enforce a report timestamp if available

### `mento`

Strengths:

- shared-source reuse configured correctly

Weaknesses:

- escaped-JSON HTML scraping is brittle
- no source timestamp
- no freshness policy despite dashboard source

Improvements:

- add source-date extraction
- replace delimiter-based extraction with a safer parser

### `openeden-usdo`

Strengths:

- strong component and ratio reconciliation
- useful immediate redeemability metadata

Weaknesses:

- no freshness metadata

Improvements:

- extract and validate source disclosure time if available

### `reservoir`

Strengths:

- useful immediate redeemability metadata

Weaknesses:

- substring label matching is brittle
- integer normalization
- no freshness metadata

Improvements:

- replace label substring matching with explicit asset IDs if the API exposes them
- preserve one-decimal precision

### `sgforge-coinvertible`

Strengths:

- source timestamp extraction

Weaknesses:

- regex scraping is brittle
- it reports a 100% single-bank cash slice even though it only captures `bankPct` as metadata
- if the page ever shows multiple banks or bank share <100%, the composition becomes misleading

Improvements:

- only emit a single-bank 100% slice when `bankPct` is actually 100
- otherwise emit a generic multi-bank cash bucket or parse all banks

### `single-asset`

Strengths:

- compact
- good for weak-probe coverage
- supports live redemption fee probes

Weaknesses:

- on-chain mode only proves non-zero supply, not reserve backing
- http-json mode accepts any positive JSON-path value, which is intentionally weak
- 47-coin coverage here should not be mistaken for independent reserve verification

Improvements:

- keep it, but expose its weak evidence class more clearly in ops/product semantics
- split fee-probe support into a composable helper so the adapter stays simpler

### `sky-makercore`

Strengths:

- source timestamp
- shared-source reuse
- unknown exposure tracking

Weaknesses:

- relies on external protocol aggregation rather than direct accounting
- growing hardcoded token lists

Improvements:

- move token taxonomy into a shared classification layer

### `tether`

Strengths:

- simple and intentionally conservative

Weaknesses:

- no source timestamp
- no freshness policy
- single-bucket attestation is very low-information

Improvements:

- extract report date if the payload exposes it

## Mutualization / LOC Reduction Opportunities

### 1. Split adapters into a few reusable shapes

Recommended families:

- `probe-validated-static-slices`
  - covers `single-asset` on-chain mode
  - covers `curated-validated`
  - covers `frax`
- `html-percentage-disclosure`
  - covers `circle-transparency`
  - covers `fdusd-transparency`
  - covers `mento`
  - part of `sgforge-coinvertible`
- `onchain-single-bucket-proof`
  - covers `chainlink-nav`
  - covers `chainlink-por`
  - overlaps conceptually with `erc4626-single-asset`

### 2. Centralize asset classification

Today, asset/farm/token allowlists live inside many adapters:

- `asymmetry`
- `crvusd`
- `dola-inverse`
- `ethena`
- `falcon`
- `fx`
- `infinifi`
- `reservoir`
- `sky-makercore`

This should be pulled toward a shared classification helper or config layer keyed by canonical symbol / address / coinId.

### 3. Standardize adapter metadata

Common fields should be typed and shared:

- `sourceTimestamp`
- `unknownExposurePct`
- `supplyUsd`
- `totalReserveUsd`
- `immediateRedeemableUsd`
- `immediateRedeemableRatio`
- `redemptionFeeBps`

Today these are stringly-typed conventions.

### 4. Add raw-response memoization

This would cut duplicate fetches for same-URL multi-coin adapters without requiring the final parsed output to be coin-invariant.

## Recommended Remediation Workstreams

### Workstream A: Correctness and state contract

1. Separate last successful metadata from last attempt status.
2. Fail closed on malformed stored snapshots.
3. Introduce typed warning classes and severity-aware sync status handling.
4. Add history/audit rows for successful and failed attempts.

### Workstream B: Freshness and evidence quality

1. Add source timestamp extraction wherever possible.
2. Add freshness policies for every dashboard/HTML/API source that is not inherently latest-state.
3. Revisit evidence-class expectations for feeds that are structurally warning-bearing today.

### Workstream C: Precision and maintainability

1. Make one-decimal precision the minimum stored output standard.
2. Stop dropping small tails before final normalization.
3. Consolidate probe/static adapters and HTML disclosure adapters.
4. Centralize token/farm/bucket classification.

### Workstream D: Test hardening

1. Add sync-state metadata preservation tests.
2. Add malformed-row fail-closed tests.
3. Add decoder-path tests for `gho`, `chainlink-nav`, and `chainlink-por`.
4. Add fallback-input and timeout tests in `sync-live-reserves`.

## Planning Recommendation

Implement remediation in this order:

1. storage/state contract fixes
2. malformed-snapshot fail-closed behavior
3. warning severity redesign
4. freshness coverage expansion
5. precision fixes
6. adapter-family mutualization / LOC reduction

That sequence addresses the current correctness risks first, then removes the main maintainability drag.
