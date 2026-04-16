# Live Reserve Sync Total Execution Plan - 2026-04-15

## Status

Draft for plan review. No implementation may begin until the review loop reports fewer than 2 minor residual issues and no major issues.

## Scope Statement

This plan executes the audit in `agents/audits/2026-04-15-live-reserve-sync-full-adapter-audit.md` across:

- systemic live-reserve quality hardening,
- configured-adapter accuracy fixes,
- current production blocker remediation,
- coverage expansion where a defensible source exists,
- research-backed deferrals where a live/scoring adapter would overstate evidence quality,
- documentation/methodology updates,
- validation and logical commits.

The plan intentionally distinguishes:

- **Display-live**: `GET /api/stablecoin-reserves/:id` can serve a fresh authoritative reserve snapshot.
- **Score-grade live**: report-card collateral scoring can consume a fresh, `ok`, independent, scoring-freshness-eligible snapshot.
- **Proof / weak-live-probe**: useful liveness/proof telemetry, not score-grade reserve composition.
- **Static-validated**: curated reserve mix validated by a current liveness probe, not independent reserve measurement.

## Non-Negotiable Quality Rules

- Do not promote a feed into score-grade live coverage solely because it has a current HTTP response.
- Do not fabricate source freshness from page publish time, HTTP cache headers, Vercel headers, or local fetch time.
- Do not weaken the global `freshnessMode` gate to make stale/unverified feeds count.
- Do not turn monthly/attestation-only PDFs into live reserve feeds unless methodology explicitly creates a separate non-live tier.
- Do not use current reserve adapter metadata for scoring when the sync state is `degraded`, unless an explicit methodology/version change says that specific warning class is score-safe.
- Commit only files changed for this work. Do not include unrelated dirty worktree files.

## Research Inputs Already Gathered

Local state:

- 40 registered adapter keys.
- 138 configured live reserve coins.
- 36 adapter keys configured.
- 4 registered but unconfigured adapter implementations: `abracadabra`, `frax`, `lista`, `tether`.
- Current public sample at `2026-04-15T22:30:11Z`: 138 display-live, 51 score-grade live, 87 display-live but not scoring-live.

Subagent research:

- Systemic hardening plan from subagent `Ohm`.
- Configured-blocker research from subagent `Erdos`.
- Coverage-expansion source research from subagent `Jason`, summarized in `agents/research/2026-04-15-live-reserve-expansion-source-matrix.md`.

Live source checks:

- `https://mu.accountable.capital:10443/dashboard` is currently fresh; public Pharos `AZND` row was stale at sample time and should self-heal after the next sync.
- `https://accountable.xsy.fi:10443/dashboard` returns `503 {"message":"No data available","res":"err"}`.
- `https://cache.accountable.capital/dashboard/xsy` returns usable Accountable JSON but the timestamp is ~16 days stale.
- FDUSD official page still exposes `As of Feb 28, 2026`, stale under current 7-day disclosure policy.
- InfiniFi and Reservoir APIs expose useful current-looking data but no source timestamp/block number.
- JupUSD API is live and timestamped through snapshots, but current adapter silently maps unknown holdings.
- Origin docs list OUSD collateral/strategy APIs, but live checks returned 404 for those paths; totalSupply still works.
- satUSD River `https://api-v2.satoshiprotocol.org/protocol-info` is live and useful for TVL/supply telemetry but not enough for collateral composition without more semantics.
- USDGO official public endpoint `https://www.usdgo.com/api/lark-bitable` is the strongest new candidate, but score-grade use requires a source-provenance gate and a methodology decision if freshness is date-only.
- Solstice official attestation endpoint `https://attestation-api.solstice.finance/dashboard` is implementable as aggregate solvency telemetry; it must start as non-scoring proof unless timestamped asset-level reserve composition is verified.

External source basis:

- Chainlink `latestRoundData()` includes `updatedAt`; `latestAnswer` lacks freshness.
- Curve LLAMMA exposes band balances and controller/AMM methods needed for an on-chain crvUSD rewrite.
- Aave GHO facilitator docs and RemoteGSM governance confirm residual issuance is a real modeling issue, not parser drift.
- Anzen docs confirm USDz is 1:1 backed by SPCT, while SPCT itself is a private-credit/RWA claim requiring separate valuation/custody evidence.

## Execution Phases

### Phase 0 - Worktree Protection And Baseline

Objective: avoid committing unrelated work and make validation/review reproducible.

Actions:

1. Record `git status --short`.
2. Record current branch and last commit.
3. Create `agents/research/2026-04-15-live-reserve-expansion-source-matrix.md` if the expansion subagent produces source findings not already captured in this plan.
4. Run focused baseline tests once before edits:
   - `npm test -- worker/src/cron/reserve-adapters worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-sync-integration.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts`
5. If dirty unrelated files exist, commit only this plan/audit if needed or leave unrelated files untouched.

Commit:

- Commit only planning/research artifacts if the user expects commits for planning. Otherwise first implementation commit starts at Phase 1.

### Phase 1 - Adapter Config Schema Hardening

Objective: invalid adapter/input-kind combinations fail before cron runtime.

Files:

- `shared/lib/live-reserve-adapters-schemas.ts`
- `shared/lib/live-reserve-adapters-config.ts`
- `worker/src/cron/reserve-adapters/__tests__/registry.test.ts`
- `shared/lib/__tests__/stablecoins.test.ts`

Implementation:

1. Export `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS satisfies Record<LiveReserveAdapterKey, readonly LiveReserveInput["kind"][]>`.
2. Allowed primary/fallback input kinds:
   - `abracadabra`: `onchain-evm`
   - `accountable`: `http-json`
   - `anzen-usdz`: `onchain-evm`
   - `asymmetry`: `http-json`
   - `btcfi`: `http-json`
   - `cap-vault`: `onchain-evm`
   - `chainlink-nav`: `onchain-evm`
   - `chainlink-por`: `onchain-evm`
   - `circle-transparency`: `http-html`
   - `collateral-positions-api`: `http-json`
   - `crvusd`: `http-json`
   - `curated-validated`: `onchain-evm`, `onchain-solana`
   - `dola-inverse`: `http-json`
   - `erc4626-single-asset`: `onchain-evm`
   - `ethena`: `http-json`
   - `evm-branch-balances`: `onchain-evm`
   - `falcon`: `http-json`
   - `fdusd-transparency`: `http-html`
   - `frax`: `http-json`
   - `frax-balance-sheet`: `http-json`
   - `fx`: `http-json`
   - `gho`: `onchain-evm`
   - `infinifi`: `http-json`
   - `jupusd`: `http-json`
   - `lista`: `onchain-evm`
   - `liquity-v1`: `onchain-evm`
   - `liquity-v2-branches`: `onchain-evm`
   - `m0`: `http-json`
   - `mento`: `http-html`
   - `openeden-usdo`: `http-json`
   - `re-metrics`: `http-html`
   - `reservoir`: `http-json`
   - `sgforge-coinvertible`: `http-html`
   - `single-asset`: `http-json`, `onchain-evm`
   - `sky-makercore`: `http-json`
   - `superstate-liquidity`: `onchain-evm`
   - `tether`: `http-json`
   - `usdai-proof-of-reserves`: `http-json`
   - `usd1-bundle-oracle`: `onchain-evm`
   - `usdd-data-platform`: `http-json`
3. Replace generic `inputs.primary` schema variant with per-adapter input schemas.
4. Enforce `inputs.fallbacks` against the same adapter input-kind set.
5. Preserve strict object schemas.
6. Update registry test that currently allows `tether` + `onchain-solana`.
7. Add configured data invariant tests:
   - every configured `liveReservesConfig` parses through `LiveReservesConfigSchema`;
   - every configured adapter input kind appears in `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`;
   - unsupported primary and fallback input kinds are rejected.

Validation:

- `npm test -- worker/src/cron/reserve-adapters/__tests__/registry.test.ts shared/lib/__tests__/stablecoins.test.ts`

Commit:

- `reserve-sync: enforce adapter input schemas`

### Phase 2 - Shared Freshness Validation

Objective: timestamps cannot be future-dated or accidentally treated as fresh.

Files:

- `worker/src/cron/reserve-adapters/validate.ts`
- `worker/src/cron/reserve-adapters/freshness.ts`
- `worker/src/cron/reserve-adapters/chainlink-nav.ts`
- `worker/src/cron/reserve-adapters/chainlink-por.ts`
- `worker/src/cron/__tests__/reserve-adapter-validate.test.ts`
- affected adapter tests if local stale checks move to helper behavior.

Implementation:

1. Add `MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC = 600`.
2. In `validateAdapterOutput()`:
   - validate `metadata.sourceTimestamp` for all adapters;
   - validate `metadata.redemption.sourceTimestamp` when present;
   - fatal `future-source-timestamp` if a timestamp is greater than `now + 600`;
   - compute age without `Math.max(0, ...)`.
3. Add helper functions in `freshness.ts` only if they reduce duplication:
   - `isTimestampBeyondFutureSkew(timestamp, now, skewSec?)`
   - `getTimestampAgeSec(timestamp, now, skewSec?)`
4. Update `chainlink-nav` and `chainlink-por` local stale checks so future timestamps fail/degrade consistently instead of being clamped.
5. Tests:
   - reject future `sourceTimestamp`;
   - allow within skew;
   - reject future `redemption.sourceTimestamp`;
   - preserve stale-source warning behavior.

Validation:

- `npm test -- worker/src/cron/__tests__/reserve-adapter-validate.test.ts worker/src/cron/reserve-adapters/__tests__/chainlink-nav.test.ts worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts`

Commit:

- `reserve-sync: reject future source timestamps`

### Phase 3 - Conservative Timestamp Semantics

Objective: multi-row adapters cannot hide stale material rows behind fresher rows.

Files:

- `worker/src/cron/reserve-adapters/freshness.ts`
- `worker/src/cron/reserve-adapters/warnings.ts`
- `worker/src/cron/reserve-adapters/ethena.ts`
- `worker/src/cron/reserve-adapters/sky-makercore.ts`
- `worker/src/cron/reserve-adapters/m0.ts`
- corresponding adapter tests.

Shared implementation:

1. Add `SOURCE_TIMESTAMP_SPREAD_DEGRADE_SEC = 3600`.
2. Add `summarizeSourceTimestamps(timestamps)`:
   - filters finite positive timestamps;
   - returns min as `sourceTimestamp`;
   - returns max as `latestSourceTimestamp`;
   - returns spread and count.
3. Add warning helper `sourceTimestampSpreadWarning(adapterName, spreadSec)`.

Ethena:

1. Use only rows with `usdAmount > 0`.
2. Emit source timestamp as oldest material row timestamp.
3. Preserve current display max as `lastUpdatedAt`.
4. Add `latestRowUpdatedAt`, `sourceTimestampSpreadSec`, `sourceTimestampCount`.
5. Add degraded warning when spread exceeds threshold.

Sky:

1. Extract pure timestamp summary logic.
2. Use only positive-debt groups.
3. Emit source timestamp as oldest material group timestamp.
4. Add latest/spread/count metadata and warning.

M0:

1. Replace `getLatestM0SourceTimestamp()` with a summary helper.
2. Use minimum candidate timestamp as source timestamp.
3. Preserve previous max as `latestCollateralSourceTimestamp`.
4. Add `earliestCollateralSourceTimestamp`, `sourceTimestampSpreadSec`, `timestampCandidateCount`.
5. Add degraded spread warning.

Validation:

- `npm test -- worker/src/cron/reserve-adapters/__tests__/ethena.test.ts worker/src/cron/reserve-adapters/__tests__/sky-makercore.test.ts worker/src/cron/reserve-adapters/__tests__/m0.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts`

Commit:

- `reserve-sync: use conservative source freshness`

### Phase 4 - Unknown Exposure And Collateralization Accuracy

Objective: scoring-live adapters fail closed or degrade when source content changes materially.

Files:

- `worker/src/cron/reserve-adapters/jupusd.ts`
- `shared/lib/live-reserve-adapters-definitions.ts`
- `worker/src/cron/reserve-adapters/chainlink-por.ts`
- `worker/src/cron/reserve-adapters/sgforge-coinvertible.ts`
- relevant tests.

JupUSD:

1. Replace default unknown holding meta with explicit unknown classification.
2. Aggregate unknown holdings into `Unmapped JupUSD reserve holdings`, risk `high`.
3. Emit `metadata.unknownExposurePct`.
4. Emit `buildUnknownExposureWarning({ code: "unknown-holding", ... })`.
5. Add `maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT` to `jupusd` definition.
6. Tests for clean path, immaterial unknown, material unknown.

Chainlink PoR:

1. Stop ignoring `coin` in `fetchChainlinkPorReserves()`.
2. Resolve same-chain tracked token address and decimals.
3. Fetch `totalSupply()`.
4. Extend adapter result metadata:
   - `totalReserveUsd`;
   - `supplyUsd`;
   - `supplyRaw`;
   - `supplyDecimals`;
   - `supplyTokenAddress`;
   - `collateralizationRatio`.
5. Emit degraded warning `por-reserve-under-supply` when ratio `< 0.995`.
6. Document limitation: same-chain supply only, not multichain supply.

SGForge:

1. Compute and store `collateralizationRatio = cashAmount / circulationAmount`.
2. Store `cashCoveragePct`.
3. Require positive finite `circulationAmount` and `cashAmount`; reject non-finite ratio values.
4. Validate `bankPct` in `(0, 100]`.
5. Emit degraded warning when ratio `< 0.995`; do not fatal on source-indicated undercoverage.

Validation:

- `npm test -- worker/src/cron/reserve-adapters/__tests__/jupusd.test.ts worker/src/cron/reserve-adapters/__tests__/chainlink-por.test.ts worker/src/cron/reserve-adapters/__tests__/sgforge-coinvertible.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts`

Commit:

- `reserve-sync: harden reserve content validation`

### Phase 5 - Adapter I/O Concurrency Guardrail

Objective: reserve adapters stay within a documented per-attempt I/O peak rather than relying on sequential coin iteration alone.

Files:

- `worker/src/cron/reserve-adapters/concurrency.ts` new.
- `worker/src/cron/reserve-adapters/types.ts`
- `worker/src/cron/reserve-adapters/request.ts`
- `worker/src/cron/reserve-adapters/onchain.ts`
- `worker/src/cron/sync-live-reserves.ts`
- `shared/lib/cron-jobs.ts`
- `worker/src/handlers/scheduled/hourly-live-reserves.ts`
- tests.

Implementation:

1. Add `RESERVE_ADAPTER_MAX_PARALLEL_IO = 2`.
2. Add `createAdapterIoLimiter(max = 2)` with queue/release-on-error tests.
3. Add `runAdapterIo(ctx, label, factory)`.
4. Add `ioLimiter?: AdapterIoLimiter` to `AdapterContext`.
5. In `runAdapterAttempt()`, create/pass a fresh limiter per adapter attempt.
6. Wrap leaf I/O functions only:
   - `fetchJsonWithRetry`;
   - `fetchJsonPostWithRetry`;
   - `fetchTextWithRetry`;
   - `fetchOnchainUint256`;
   - `fetchOnchainRawCall`.
7. Audit all reserve-adapter network/RPC callsites before lowering documented connection budget. Known bypasses that must be routed through the limiter:
   - `worker/src/cron/reserve-adapters/defillama.ts` direct `fetchWithRetry`;
   - `worker/src/cron/reserve-adapters/crvusd.ts` direct `fetchEvmCallHexAtBlock`;
   - any new multicall/batch helper added for crvUSD.
8. Avoid wrapping higher-level fanout loops with the same limiter to prevent self-deadlock.
9. Update cron connection budget metadata and scheduled handler comment only after all adapter I/O routes through limiter-covered helpers.

Validation:

- `npm test -- worker/src/cron/reserve-adapters/__tests__/concurrency.test.ts worker/src/cron/__tests__/sync-live-reserves.test.ts`
- `npm run check:cron-connections`

Commit:

- `reserve-sync: bound adapter io concurrency`

### Phase 6 - Current Production Blocker Remediation

Objective: fix what can be fixed safely without weakening evidence quality.

Tasks:

1. `UTY`:
   - Add `https://cache.accountable.capital/dashboard/xsy` as `inputs.fallbacks[0]`.
   - Expected effect: current runtime can move from `error` to stale/degraded detail-live if primary remains 503.
   - No score-grade promotion until Accountable source freshness recovers.
2. `AZND`:
   - No code change initially because direct upstream is fresh. After next sync, use D1/status if still degraded.
   - If stale persists despite fresh upstream, inspect `reserve_sync_state`, circuit breaker state, and shared-source cache behavior.
3. `FDUSD`:
   - No parser code change. Source disclosure is stale.
   - Create research note documenting why page publish time cannot be used.
4. `IUSD`:
   - Add explicit farm mappings for currently observed tiny unknowns (`SwapFarm`, `tokemak-auto-infinifiUSD`) only if live source confirms semantics.
   - This removes noisy warning quality debt but does not promote scoring.
   - Keep unverified freshness until provider timestamp/block or on-chain adapter exists.
5. `wsrUSD`:
   - No scoring change. Current API lacks source timestamp.
   - Add research note scoping on-chain replacement using Reservoir contract docs.

Validation:

- `npm run check:stablecoin-data`
- targeted adapter tests for any config/mapping changes.

Commit:

- `reserve-sync: improve current blocker resilience`

### Phase 7 - Coverage Expansion: Safe Near-Term Implementations

Objective: add score-grade or display-live coverage only where the source evidence is defensible.

Candidate A - `usdgo-osl` with new `usdgo-transparency` adapter:

1. Add adapter key and registry/schema/display entries:
   - `shared/types/live-reserves.ts`
   - `shared/lib/live-reserve-adapters-definitions.ts`
   - `shared/lib/live-reserve-adapters-schemas.ts`
   - `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`
   - `shared/lib/live-reserve-display.ts`
   - `worker/src/cron/reserve-adapters/index.ts`
2. Adapter source:
   - primary input `http-json`;
   - endpoint `https://www.usdgo.com/api/lark-bitable`;
   - display URL `https://www.usdgo.com/transparency`;
   - attestation context `https://www.anchorage.com/platform/usdgo-reserve-attestations`.
3. Expected payload fields:
   - `collateralizationRatio`;
   - `buidlUsdM`;
   - `gsUsdM`;
   - `usdUsdM`;
   - `backingAssetsM`;
   - `circulationSupplyMFormatted`;
   - `lastUpdated`.
4. Source-provenance gate before score-grade use:
   - prove the payload fields are publicly documented or visibly rendered by the official `usdgo.com/transparency` page with the same meanings;
   - prove each planned slice identity and risk tier from official source material, especially `STBXX` / Goldman Sachs Stablecoin Reserves Fund;
   - prove `lastUpdated` is a reserve-source timestamp, not a page publish/cache timestamp;
   - if only date-granularity freshness exists, add an explicit methodology/version decision and boundary tests before allowing score-grade passthrough.
5. Slice model only after that gate passes:
   - BUIDL/tokenized treasury bucket, `risk: low`, `coinId: buidl-blackrock`;
   - STBXX / Goldman Sachs Stablecoin Reserves Fund bucket using a risk tier justified by official fund/reserve evidence; if the underlying assets/custody/valuation are not source-verified, keep it as a named conservative/unknown slice or non-scoring telemetry;
   - USD/cash bucket, `risk: very-low`.
6. Freshness:
   - parse `lastUpdated` as source timestamp;
   - because date-only values resolve to UTC midnight, document and test date-only semantics;
   - apply dashboard/disclosure max-age policy in the adapter definition.
7. Validation:
   - component total must reconcile to `backingAssetsM` within 1%;
   - reserve/supply ratio must reconcile to `collateralizationRatio` within 2%;
   - output must include `supplyUsd`, `totalReserveUsd`, `collateralizationRatio`.
8. Tests:
   - happy path with live-like payload;
   - stale `lastUpdated` degrades through shared validation;
   - missing component total fails;
   - component total mismatch fails.
9. Docs:
   - update `docs/live-reserves.md` adapter table/counts;
   - update `src/app/about/page.tsx` data-source text because this is a new source.
10. If source-provenance gate fails, implement only non-scoring proof/display telemetry or defer; do not mark it independent scoring-live.

Candidate B - `usx-solstice` with new `solstice-attestation` adapter:

1. Add adapter key and registry/schema/display entries, including `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`.
2. Adapter source:
   - primary input `http-json`;
   - endpoint `https://attestation-api.solstice.finance/dashboard`;
   - display URL `https://attestation.solstice.finance/`;
   - docs `https://docs.solstice.finance/legal-documents/attestations-and-proof-of-solvency.md`.
3. First implementation tier:
   - emit aggregate solvency/proof telemetry only;
   - default to `weak-live-probe` and non-scoring when asset split cannot be mapped safely.
4. Evidence decision:
   - if payload exposes stable asset-level split with a timestamp, classify as `dynamic-mix` / `independent`;
   - if only aggregate reserve/supply is defensible, do not classify as independent score-grade unless methodology explicitly maps aggregate delta-neutral solvency proofs to reserve risk;
   - if it is only solvency/liveness, classify as `weak-live-probe`.
5. Validation:
   - preserve verified timestamp when available;
   - compute `collateralizationRatio`;
   - fail/degrade on reserve/supply undercoverage below threshold.
6. Tests:
   - explicit test that aggregate/no-split Solstice output has `evidenceClass = weak-live-probe` and `provenance.scoringEligible = false`;
   - only asset-level timestamped composition can pass a scoring-eligible fixture.
7. Docs mirror USDGO.

Candidate C - `satusd-river` with new `river-protocol-info` adapter:

1. Add adapter key and registry/schema/display entries, including `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`, only if display-live telemetry is valuable enough.
2. Source:
   - `https://api-v2.satoshiprotocol.org/protocol-info`;
   - docs `https://docs.river.inc/products/editor.md`;
   - contracts `https://docs.river.inc/outro/deployed-contracts.md`;
   - oracle docs `https://docs.river.inc/outro/satusd-oracle.md`.
3. Evidence classification:
   - do not make it score-grade collateral mix initially;
   - source exposes TVL and circulating supply, not reserve composition by asset.
4. Potential implementation:
   - `sourceModel: single-bucket`;
   - `evidenceClass: weak-live-probe` unless the implementation explicitly validates the curated reserve composition against live collateral evidence;
   - metadata: `tvl`, `circulatingSupply`, chain-level TVL/circulation, timestamp.
5. This candidate can wait until after higher-value score-grade work unless the status/detail UI benefits from River telemetry.

Candidate D - `lisusd-lista` using existing `lista` adapter:

1. Research exact Lista collateral holder/token addresses and official docs.
2. If and only if current holders/assets are verified:
   - add `liveReservesConfig.adapter = "lista"`;
   - configure BSC on-chain branches;
   - use fixed price only for USD stable assets where appropriate;
   - use DefiLlama prices for volatile collateral;
   - add tests with sample branch balances.
3. Official research basis:
   - Lista collateral docs list BNB, ETH, slisBNB, wBETH, BTCB, FDUSD, wstETH, USDT;
   - PSM docs describe USDT/USDC 1:1 conversions;
   - developer docs describe CDP integration.
4. If addresses cannot be verified from official docs/contracts, create research deferral note only.

Candidate E - `mim-abracadabra` using existing `abracadabra` adapter:

1. Research current active cauldron list, collateral token addresses, and whether `totalCollateralShare()` is sufficient for reserve composition.
2. If verified:
   - add `liveReservesConfig.adapter = "abracadabra"`;
   - configure cauldrons;
   - decide whether `totalCollateralShare` requires BentoBox share-to-amount conversion. If it does, do not enable until the adapter is corrected.
3. Official research basis:
   - Abracadabra docs describe cauldrons/markets;
   - app bundles expose current cauldron configuration;
   - `api.abracadabra.money` currently has TLS issues, so do not rely on it.
4. If share accounting is not already correct, implement share conversion first or defer.

Candidate F - `pmusd-precious-metals` on-chain RWf(x) adapter:

1. Research exact RAAC RWf(x) contract topology:
   - pmUSD token from repo metadata;
   - fGOLD/BaseToken from RAAC deployment docs;
   - Treasury/FractionalToken links.
2. Do not implement until exact contracts are verified.
3. If verified, build new `raac-rwfx` current-state adapter:
   - read pmUSD supply;
   - read TokenBlender/Treasury base-token backing;
   - compute collateralization ratio;
   - classify as high-risk gold/RWA claim unless source proves stronger custody.

Candidate G - `fpi-frax` on-chain FPI adapter:

1. Frax docs identify FPI Controller Pool and Comptroller.
2. Tested obvious FPI balance-sheet API variants returned 404.
3. Implement only if controller/comptroller/AMO on-chain reads can reconcile FPI supply to backing assets.
4. Otherwise keep curated wrapper view.

Candidate H - `crvUSD` score-grade promotion:

1. Treat this as a separate design gate before implementation.
2. Design-gate deliverable:
   - exact `crvusd` params schema for market registry if using curated params;
   - bounded multicall/batch contract with max band span, chunk size, request timeout, and failure behavior;
   - adapter timeout budget proof under the 20s attempt timeout;
   - reconciliation tests comparing on-chain reconstruction against current Curve market API samples;
   - explicit decision for `bands_x`, PegKeeper/PSR treatment, and discovery of new markets.
3. Implement only after the design gate passes with no major issues.
4. Replace timestamp-less reserve value dependency with current-state on-chain reads:
   - either curate market params in `crvusd` config, or use Curve API only for non-value discovery;
   - read controller `amm()` and `collateral_token()`;
   - read LLAMMA `min_band`, `max_band`, `bands_y`, and optionally `bands_x`;
   - value external collateral balances with DefiLlama prices;
   - keep Yield Basis on-chain leg.
5. Add batching/multicall helper before using this in production; unbatched band scans are too expensive.
6. Open modeling question to resolve before implementation:
   - whether `bands_x` should be counted as crvUSD-side reserve, ignored, or used only as debt-offset diagnostics.
7. If modeling cannot be resolved with source-backed confidence, document design and defer implementation rather than overstating live coverage.

Candidate I - OUSD:

1. Local worktree already has curated-validated config.
2. Do not build a live adapter from documented Origin collateral/strategy endpoints until they stop returning 404 or another official source exists.

Validation:

- coverage additions require `npm run check:stablecoin-data`, targeted adapter tests, `npm test -- shared/lib/__tests__/stablecoins.test.ts`, and docs count updates.

Commit:

- One commit per coverage source family, e.g.:
  - `reserve-sync: add USDGO transparency adapter`
  - `reserve-sync: add Solstice attestation adapter`
  - `reserve-sync: add River protocol telemetry`
  - `reserve-sync: add Lista live branch coverage`
  - `reserve-sync: add Abracadabra live cauldron coverage`
  - `reserve-sync: promote crvusd onchain reserve evidence`

### Phase 8 - Coverage Expansion: Research-Backed Deferrals

Objective: execute on coverage priorities without creating low-quality adapters.

For each top no-live or non-score target without a defensible source, add/update a research tracker with:

- current official sources checked;
- exact endpoint/doc status;
- why it cannot be score-grade live today;
- what provider/API/on-chain evidence would unblock it;
- whether a display-live/proof adapter is acceptable.

Targets:

- `kau-kinesis`: physical-gold audits, not live composition unless audit/API source exists.
- `usda-avalon`: needs direct collateral/debt source for BTC/CDP and credit-line claims.
- `usdf-astherus`: Ceffu/MirrorX delta-neutral source needs timestamped portfolio evidence.
- `dusd-standx`: Ceffu/delta-neutral source needs timestamped portfolio evidence.
- `pmusd-precious-metals`: public site currently bot-protected; on-chain TokenBlender/TB/ION.au path needs source validation.
- `fpi-frax`: likely Frax source, but exact FPI reserve source must be verified.
- `usdh-native-markets`: official attestations are PDF/monthly; not live under current policy.
- `usdm-mega`: likely USDtb/USDC reserve mix, but needs official live source.
- `USDz`: keep weak proof until SPCT-level reserve evidence exists.
- `GHO`: methodology/modeling decision before score-grade promotion.
- `IUSD`/`wsrUSD`/`fxUSD`/`BtcUSD`/`DEURO`/`ZCHF`: provider timestamp or on-chain reconstruction needed.

Artifact:

- `agents/research/2026-04-15-live-reserve-expansion-source-matrix.md`

Commit:

- `agents: document live reserve expansion blockers`

### Phase 9 - Documentation And Methodology

Docs:

- `docs/live-reserves.md`
- `docs/worker-and-api-limits.md`
- `docs/testing.md`
- `docs/report-cards.md` if scoring-live eligibility or collateral passthrough behavior changes.
- `docs/report-cards-timeline.md` if methodology changes.
- `src/app/methodology/scoring-changelog/content-v7-0.tsx` and `shared/lib/safety-score-version-data.ts` if methodology version changes.
- `src/app/about/page.tsx` if new live data sources are added.

Doc updates by change type:

- Schema/freshness/concurrency hardening: `docs/live-reserves.md`, `docs/worker-and-api-limits.md`, `docs/testing.md`.
- New live data source: `docs/live-reserves.md`, `src/app/about/page.tsx`.
- Any new score-grade live adapter or promotion that can change `collateralFromLive` behavior: `docs/report-cards.md`, `docs/report-cards-timeline.md`, public methodology changelog UI, `shared/lib/safety-score-version-data.ts`, and `src/app/about/page.tsx`.
- Policy exception or changed scoring gate: full report-card methodology version bump. Current version is `v7.05`; use `v7.06` for the next minor update or `v8.0` for a major scoring change.

Commit:

- `docs: update live reserve methodology and operations`

### Phase 10 - Validation And Final Commits

Targeted validation after each phase:

```bash
npm test -- worker/src/cron/reserve-adapters worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-sync-integration.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts shared/lib/__tests__/stablecoins.test.ts
npm run check:cron-connections
npm run check:stablecoin-data
cd worker && npx tsc --noEmit
```

Full validation before final report:

```bash
npm run lint
npm test
npm run test:merge-gate
```

If a full merge gate failure is unrelated to touched files, document it with evidence and continue fixing only owned failures.

## Plan Review Loop

Review process:

1. Draft this plan.
2. Run at least two independent plan reviews:
   - one code/systems reviewer,
   - one data/source-quality reviewer.
3. Classify issues:
   - **Major**: could cause incorrect scoring-live promotion, unsafe implementation order, test gap in changed behavior, or unbounded runtime risk.
   - **Minor**: wording, sequencing clarity, docs placement, or non-blocking residual caveat.
4. Patch this plan.
5. Repeat review until:
   - 0 major issues;
   - fewer than 2 minor issues.
6. Only then start Phase 0 implementation.

Current review state:

- Review pass 1: complete.
- Review pass 1 findings: 6 major issues and 3 minor issues after de-duplicating overlapping Solstice findings.
- Fixes applied:
  - Solstice defaulted to non-scoring `weak-live-probe` unless timestamped asset-level composition or explicit methodology exists.
  - USDGO now requires a source-provenance and date-freshness methodology gate before score-grade use.
  - Any new score-grade live adapter or promotion now requires Report Card methodology/docs/changelog updates.
  - River telemetry narrowed to `weak-live-probe` unless it validates curated composition.
  - Adapter I/O limiter phase now audits direct `fetchWithRetry` / `fetchEvmCallHexAtBlock` bypasses before changing budget metadata.
  - crvUSD moved behind a separate design gate with bounded multicall/band-scan requirements.
  - SGForge ratio invariants and commit list were corrected.
- Residual issues after fixes: pending review pass 2.
- Review pass 2: complete.
- Review pass 2 findings: 1 major issue and 2 minor issues.
- Review pass 2 fixes applied:
  - USDGO score-grade gate now requires per-slice identity and risk evidence, especially for STBXX / Goldman Sachs Stablecoin Reserves Fund.
  - River source-matrix wording now says weak-live-probe / aggregate TVL telemetry.
  - New adapter checklist now explicitly includes `LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS`.
- Residual issues after fixes: pending review pass 3.
- Review pass 3: complete.
- Review pass 3 findings: 0 major issues, 0 minor issues.
- Decision: APPROVED FOR IMPLEMENTATION.

## Logical Commit Plan

1. `reserve-sync: enforce adapter input schemas`
2. `reserve-sync: reject future source timestamps`
3. `reserve-sync: use conservative source freshness`
4. `reserve-sync: harden reserve content validation`
5. `reserve-sync: bound adapter io concurrency`
6. `reserve-sync: improve current blocker resilience`
7. Coverage commits as source validation permits:
   - `reserve-sync: add USDGO transparency adapter`
   - `reserve-sync: add Solstice attestation proof adapter`
   - `reserve-sync: add River protocol telemetry`
   - `reserve-sync: add Lista live branch coverage`
   - `reserve-sync: add Abracadabra live cauldron coverage`
   - `reserve-sync: promote crvusd onchain reserve evidence`
8. `agents: document live reserve expansion blockers`
9. `docs: update live reserve methodology and operations`

## Stop/Defer Criteria

Despite the user request to execute exhaustively, the following are not implementation blockers but quality gates:

- If a source lacks a timestamp/block/current-state proof, the execution is a research-backed deferral, not a scoring-live adapter.
- If official docs/API cannot verify collateral holder addresses, do not add metadata config from guesswork.
- If an adapter would require broad methodology change, create the versioned methodology change before enabling scoring impact.
- If a code path would exceed Worker connection/runtime budgets without a batching helper, implement the helper first or defer the coverage expansion.
