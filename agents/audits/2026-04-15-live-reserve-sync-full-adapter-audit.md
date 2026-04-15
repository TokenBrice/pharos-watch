# Live Reserve Sync Full Adapter Audit - 2026-04-15

## Scope

Goal: audit the live reserve sync implementation, including every registered adapter, for data accuracy, maintainability, and coverage expansion opportunities.

Assumptions:

- "Live reserve sync" covers `worker/src/cron/sync-live-reserves.ts`, `worker/src/cron/reserve-adapters/*`, the live reserve D1 store, `GET /api/stablecoin-reserves/:id`, report-card collateral passthrough, and the coverage/status semantics tied to those snapshots.
- "Live coverage tier" means scoring-eligible live reserve coverage, not just a `mode="live"` reserve endpoint response. The current scoring gate is `loadFreshIndependentLiveReserveMap()`.
- No code changes were requested. This is an audit/research artifact only.

Success criteria:

- Enumerate every registered adapter and current configured usage.
- Identify systemic implementation risks and adapter-specific accuracy gaps.
- Distinguish display-live/proof/static-validated coverage from report-card live collateral coverage.
- Provide an actionable improvement order for quality and coverage expansion.

## Current Baseline

Local registry/config state:

- 40 registered adapter keys in `shared/types/live-reserves.ts`.
- 36 adapter keys currently configured in `shared/data/stablecoins/*.json`.
- 138 configured live reserve coins.
- 4 registered but currently unconfigured adapters: `abracadabra`, `frax`, `lista`, `tether`.

Production sample:

- Sampled `https://pharos.watch/_site-data/stablecoin-reserves/:id` for all 138 configured coins at `2026-04-15T22:30:11Z`.
- All 138 returned `mode="live"`.
- Only 51 were `provenance.scoringEligible=true`.
- 87 were display-live but not scoring-live.
- Current sync status: 132 `ok`, 5 `degraded`, 1 `error`.

Why this matters:

- The public reserve endpoint is now broadly live for detail-page display.
- The live coverage tier still has a large qualitative gap: most "live" reserve views are either weak probes, curated-validated static views, or independent feeds blocked by freshness/degradation policy.

Current non-scoring independent feeds from the production sample:

| Asset | Adapter | Current blocker |
| --- | --- | --- |
| `aznd-mu-digital` | `accountable` | source timestamp older than 3-day dashboard freshness policy |
| `uty-xsy` | `accountable` | current fetch failure against `accountable.xsy.fi` |
| `btcusd-btcfi` | `btcfi` | unverified freshness |
| `usdy-ondo-finance` | `chainlink-nav` | `getPrice()` oracle mode has no update timestamp |
| `deuro-deuro` | `collateral-positions-api` | unverified freshness |
| `zchf-frankencoin` | `collateral-positions-api` | unverified freshness |
| `crvusd-curve` | `crvusd` | Curve market API leg is timestamp-less |
| `fdusd-first-digital` | `fdusd-transparency` | stale disclosure date |
| `fxusd-f-x-protocol` | `fx` | unverified freshness |
| `gho-aave` | `gho` | residual issuance outside tracked GSM modules is material |
| `iusd-infinifi` | `infinifi` | unverified freshness and unverified redemption telemetry degrade sync |
| `wsrusd-reservoir` | `reservoir` | unverified freshness and unverified redemption telemetry degrade sync |

## High-Priority Findings

### 1. Adapter input kinds are not enforced by schema

`LiveReservesConfigSchema` discriminates adapter-specific `params`, but `inputs.primary` remains the generic `LiveReserveInputSchema` for every adapter (`shared/lib/live-reserve-adapters-schemas.ts:15`, `shared/lib/live-reserve-adapters-config.ts:6`). The registry test explicitly accepts a `tether` config with `onchain-solana`, even though `fetchTetherReserves()` requires `http-json` (`worker/src/cron/reserve-adapters/__tests__/registry.test.ts:61`, `worker/src/cron/reserve-adapters/tether.ts:65`).

Impact:

- Bad adapter/input combinations can pass data validation and fail only during the hourly cron.
- This is most risky when adding coverage quickly through metadata edits.

Fix:

- Add adapter-level input-kind constraints to the shared config schema.
- Add a data invariant test over every configured coin: adapter key, primary input kind, required params, breaker scope, source model, and allowed freshness mode.

### 2. Freshness validation has no future-timestamp guard

`validateAdapterOutput()` checks max age with `Math.max(0, now - sourceTimestamp)` (`worker/src/cron/reserve-adapters/validate.ts:205`). A future timestamp is treated as age zero. Several adapters trust numeric upstream timestamps directly, for example `falcon` uses `snapshot_date > 0` as verified freshness (`worker/src/cron/reserve-adapters/falcon.ts:186`) and `jupusd` uses snapshot timestamp parsing from an auxiliary feed (`worker/src/cron/reserve-adapters/jupusd.ts:165`).

Impact:

- Millisecond/second mistakes or upstream clock errors can promote snapshots as fresh instead of failing/degrading.

Fix:

- Add a future skew policy, e.g. fatal or degraded when `sourceTimestamp > now + 10 minutes`.
- Add tests with seconds, milliseconds, stale values, and future values for validation and every timestamped adapter family.

### 3. Display-live and scoring-live are easy to conflate

`resolveReserveResult()` returns `mode="live"` for any fresh authoritative snapshot, including weak probes and static-validated adapters (`worker/src/lib/live-reserves-store-response.ts:96`). Scoring eligibility is a separate provenance flag (`worker/src/lib/live-reserves-store-provenance.ts:24`).

Impact:

- Operators and product copy can overstate live reserve quality unless the UI consistently distinguishes `Live`, `Proof`, and `Curated-Validated`.
- The current production baseline is 138 display-live vs 51 scoring-live.

Fix:

- Keep `displayBadge` taxonomy strict.
- In coverage/status surfaces, prefer "scoring live" counts alongside "reserve endpoint live" counts.
- Add a status metric for `independent_ok_but_unverified` by adapter, not just aggregate counts.

### 4. Some adapters silently accept unknown exposure

Most bucketed adapters emit warnings and `unknownExposurePct`. `jupusd` is an exception: unknown holding names default to `risk: "medium"` without a warning or unknown exposure metric (`worker/src/cron/reserve-adapters/jupusd.ts:63`). Because JupUSD is currently scoring-eligible, a new unmapped reserve asset could enter report-card scoring without a degraded sync.

Fix:

- Make `jupusd` follow the common unknown-exposure policy: explicit unknown slice, `unknownExposurePct`, and degraded warning when material.
- Add a cross-adapter invariant test for configured independent dynamic adapters: unknown/default branches must either quantify unknown exposure or fail closed.

### 5. Several adapters derive freshness from a non-conservative row

Examples:

- `ethena` uses the maximum collateral-row timestamp (`worker/src/cron/reserve-adapters/ethena.ts:113`). If one row is stale and another is fresh, the snapshot can still look fresh.
- `sky-makercore` uses the first group row's `datetime` (`worker/src/cron/reserve-adapters/sky-makercore.ts:138`) rather than validating all group timestamps.
- `m0` takes the max across several update fields (`worker/src/cron/reserve-adapters/m0.ts:68`). This may be correct if those fields represent a single global disclosure, but it should be documented/tested as such.

Fix:

- Prefer the minimum timestamp across rows that materially contribute reserve value.
- Store timestamp spread metadata and degrade when spread exceeds a small threshold.
- Where max timestamp is intentional, document the source semantics in code and tests.

### 6. Internal adapter fan-out can exceed the advertised connection shape

The scheduled handler says live reserve adapters run sequentially with `Connection budget: 1/6 peak` (`worker/src/handlers/scheduled/hourly-live-reserves.ts:1`). Internally, several adapters fan out:

- `gho`: facilitator reads plus tracked GSM module calls, with each module reading multiple functions in parallel (`worker/src/cron/reserve-adapters/gho.ts:309`, `worker/src/cron/reserve-adapters/gho.ts:514`).
- `cap-vault`: 5 on-chain reads per asset in parallel (`worker/src/cron/reserve-adapters/cap-vault.ts:204`).
- `anzen-usdz`: multi-chain supply probes in parallel (`worker/src/cron/reserve-adapters/anzen-usdz.ts:51`).
- `crvusd`: sequential market loop with per-market parallel metadata reads and a Yield Basis factory scan (`worker/src/cron/reserve-adapters/crvusd.ts:137`, `worker/src/cron/reserve-adapters/crvusd.ts:143`).

Impact:

- The cron loop is serialized at coin level, but some individual coins are bursty.
- Connection-budget checks may not reflect adapter-internal fan-out.

Fix:

- Add a small adapter helper for bounded concurrency and use it consistently.
- Extend `check:cron-connections` or add a reserve-specific budget annotation for adapter-internal fan-out.

### 7. Frax/USSD semantics need a targeted accuracy review

`frax-balance-sheet` is configured for `frax-frax`, `frxusd-frax`, and `ussd-sonic-labs`. `ussd-sonic-labs` uses `https://api.frax.finance/v2/frxusd/balance-sheet/latest` as its primary input while its display URL points to a FraxNet balance-sheet embed (`shared/data/stablecoins/usd-minor.json:7497`). In production, `ussd-sonic-labs` returned the same reserve slices and totals as `frxusd-frax`.

Impact:

- This may be correct if USSD is fully backed by the same frxUSD reserve pool, but the adapter/config do not make that relationship explicit.
- If USSD has an address-specific FraxNet balance sheet, the current input is likely too broad.

Fix:

- Confirm the intended USSD reserve source.
- If USSD is a wrapper or network-issued claim on frxUSD reserves, encode that as wrapper dependency metadata.
- If it has its own address-specific API, point the adapter at the specific source and add a regression test asserting USSD does not accidentally mirror frxUSD unless intended.

## Adapter-by-Adapter Audit

| Adapter | Configured coins | Current qualitative read | Key improvement |
| --- | ---: | --- | --- |
| `abracadabra` | 0 | Good unconfigured on-chain cauldron template; prices collateral through DefiLlama and fails closed on missing prices. | Candidate for `mim-abracadabra`; add bounded concurrency and confirm current cauldron list before enabling. |
| `accountable` | 7 | Strong dashboard adapter with verified timestamps and unknown bucket policy. Current production has `AZND` stale and `UTY` fetch failing. | Add upstream reachability fallback/header handling for `UTY`; monitor stale Accountable sources separately from parser failures. |
| `anzen-usdz` | 1 | Honest weak proof: USDz supply vs SPCT supply, not SPCT underlying collateral. | Do not promote without SPCT-level reserve composition/valuation evidence. Anzen docs say USDz is 1:1 backed by SPCT, but SPCT itself represents private credit assets. |
| `asymmetry` | 1 | Good now that timestamp and branch normalization are fixed; scoring-live in production. | Add a timestamp-spread/future guard via shared validation; keep unknown branch warnings fatal/degraded. |
| `btcfi` | 1 | Properly kept out of scoring because source has no trustworthy timestamp. | Ask/source a timestamped feed or replace with current-state on-chain/indexed market data. |
| `cap-vault` | 1 | Strong current-state on-chain adapter with direct capacity telemetry. | Add explicit asset-price assumptions; current valuation treats token units as USD-like amounts. |
| `chainlink-nav` | 5 | Good for timestamped `latestRoundData`/router paths; `USDY` remains unverified because configured `getPrice()` exposes no timestamp. Chainlink docs confirm `latestRoundData()` includes `updatedAt`. | For every `getPrice()` config, research a timestamped router/wrapper oracle or leave non-scoring. |
| `chainlink-por` | 1 | Good timestamped proof feed, but it does not compare reserves to token supply. | Add token `totalSupply()` cross-check and `collateralizationRatio` metadata. |
| `circle-transparency` | 2 | Good HTML adapter; Circle page exposes reserve composition and an `As of` disclosure date. Scoring-live in production. | Keep fixture tests current and add label/order assertions because the source is HTML-scraped. |
| `collateral-positions-api` | 2 | Good collateral math but source is unverified, so correctly non-scoring. | Ask protocols for snapshot timestamps or move positions to current-state on-chain reads. |
| `crvusd` | 1 | Useful display-live mix, but Curve direct-market leg is timestamp-less while Yield Basis leg is on-chain. Curve docs expose LLAMMA band balances, so a full on-chain rewrite is feasible. | Replace direct reserve values from `prices.curve.finance` with current-state LLAMMA/controller reads using batch/multicall. |
| `curated-validated` | 31 | Correctly labeled static-validated; useful for detail/status, not scoring. | Add a separate coverage count so these are not mistaken for independent live reserve feeds. |
| `dola-inverse` | 1 | Timestamped and scoring-live; unknown assets degrade. | Add source total/debt reconciliation if FiRM API exposes aggregate totals. |
| `erc4626-single-asset` | 2 | Good current-state proof for single-asset vault wrappers, including `asset()` consistency warning. | Consider making expected asset mismatch fatal for scoring adapters instead of degraded. |
| `ethena` | 1 | Strong API with browser headers and total reconciliation. | Use min collateral-row timestamp, not max, and store timestamp spread. |
| `evm-branch-balances` | 3 | Good current-state on-chain branch collateral template. | Add optional debt/supply reconciliation where the configured protocol has liabilities. |
| `falcon` | 1 | Strong API with total bucketization and freshness. | Normalize/validate `snapshot_date` with shared timestamp parser and future guard. |
| `fdusd-transparency` | 1 | Parser works, but current disclosure is stale under the 7-day policy. | Keep non-scoring until First Digital publishes a fresh composition date; do not use page publish time as reserve-source freshness. |
| `frax` | 0 | Legacy static-validated adapter remains available but unconfigured. | Keep unconfigured unless there is a specific legacy endpoint need. |
| `frax-balance-sheet` | 3 | Strong source when bound to the right entity; currently scoring-live. | Review `ussd-sonic-labs` source binding and self-referential FRAX/frxUSD capacity handling. |
| `fx` | 1 | Useful display-live collateral mix, correctly non-scoring due missing timestamp. | Move to direct protocol contract reads or source a trustworthy API timestamp. |
| `gho` | 1 | Strong on-chain GSM telemetry but intentionally degraded because 63%+ residual issuance is unmodeled. Aave docs confirm multiple facilitator classes. | Decide methodology: either permit explicit residual scoring or build facilitator/Aave V3/remote GSM decomposition. |
| `infinifi` | 1 | Useful protocol API but unverified freshness and unverified capacity degrade sync. | Source current snapshot timestamps; fix unknown-farm warning to avoid "0.00%" degraded-looking noise when immaterial. |
| `jupusd` | 1 | Scoring-live, but unknown reserve holding names silently default to medium risk. | Add explicit unknown exposure/warnings before relying on this as high-confidence. |
| `lista` | 0 | Unconfigured branch-balance template. | Candidate for `lisusd-lista` if current holders/assets match; verify Binance/Lista contract sources first. |
| `liquity-v1` | 1 | Good direct on-chain LUSD system collateral/debt + redemption metadata. | Add ETH/USD valuation metadata if downstream wants overcollateralization ratio. |
| `liquity-v2-branches` | 4 | Strong current-state adapter for BOLD-style forks. | Generalize ABI mapping for additional forks (`USBD`, `USDK`, `NECT`, etc.) only after contract review. |
| `m0` | 9 | Strong source-invariant adapter with verified timestamps; scoring-live in production. | Document why max timestamp across M0 fields is conservative enough, or move to min/latest disclosure semantics. |
| `mento` | 2 | Good HTML embedded payload parser with reserve-holding timestamps; scoring-live. | Add stronger fixture refresh process because Next/escaped JSON layouts are brittle. |
| `openeden-usdo` | 1 | Current production scoring-live; component total and ratio checks are good. | Keep browser headers and source timestamp tests; add a dedicated filename-aligned test or note coverage under `openeden.test.ts`. |
| `re-metrics` | 1 | Scoring-live after mapping fixes; good timestamp aggregation. | Continue mapping new token symbols quickly because unknowns degrade. |
| `reservoir` | 1 | Useful balance-sheet mix, correctly degraded/non-scoring due unverified capacity/source freshness. | Ask for timestamp field or direct on-chain accounting; keep capacity as proxy. |
| `sgforge-coinvertible` | 1 | Good timestamped single-bucket disclosure. | Use parsed `circulationAmount`, `cashAmount`, and `bankPct` to verify collateralization and store ratio. |
| `single-asset` | 43 | Honest weak-live/proof class for basic liveness and simple proofs. | Avoid treating this as live coverage; upgrade high-supply assets to dedicated adapters where possible. |
| `sky-makercore` | 2 | Scoring-live and high-value source. | Validate all group timestamps, not only the first result. |
| `superstate-liquidity` | 1 | Good composition proof via Chainlink NAV plus liquidity capacity API. | Add capacity/supply ratio when token supply is available; keep NAV timestamp strict. |
| `tether` | 0 | Coarse total-assets/liabilities feed, correctly weak. | Keep unconfigured for USDT unless it provides composition/timestamped category mix; current curated-validated config is more honest. |
| `usdai-proof-of-reserves` | 1 | Strong parser for share-based proof and page timestamp hydration; scoring-live. | Keep large-integer parsing tests and timestamp binding to the app page. |
| `usd1-bundle-oracle` | 1 | Strong on-chain bundle proof with timestamp cross-check and supply ratio. | Add explicit future timestamp guard through shared validation. |
| `usdd-data-platform` | 1 | Good dynamic mix with fallback-chain URL derivation and verified history timestamp. | Add direct redemption-capacity telemetry if USDD exposes current PSM/stable vault withdrawal limits. |

## Coverage Expansion Priorities

### Existing configured feeds to improve first

1. `UTY`: fix current Accountable fetch failure. This is a quality issue, not a methodology issue.
2. `AZND`: source is currently stale just beyond the 3-day policy; monitor upstream refresh and avoid loosening policy broadly.
3. `FDUSD`: parser is fine but disclosure is stale; wait for fresh issuer data or add a fresher official source.
4. `jupusd`: fix silent unknown holdings before it remains a long-term scoring-live dependency.
5. `frax-balance-sheet`: confirm `ussd-sonic-labs` source identity.
6. `GHO`: decide residual facilitator methodology before promoting.
7. `crvUSD`: build the current-state LLAMMA/controller adapter if we want high-quality scoring-live coverage.

### Existing unconfigured adapter opportunities

1. `lisusd-lista` with `lista`: high tracked supply and a registered adapter already exists, but config must be re-verified against current Lista holders/assets.
2. `mim-abracadabra` with `abracadabra`: registered adapter exists; needs current cauldron config and pricing validation.
3. Legacy `frax` and `tether`: keep unconfigured unless a specific use case emerges; both are lower-quality than current alternatives.

### Top tracked assets without live reserve config

Current top tracked no-live-config assets by sampled supply:

| Asset | Supply sample | Suggested path |
| --- | ---: | --- |
| `usx-solstice` | ~$378M | likely gated/API-key source; needs provider/source access decision |
| `kau-kinesis` | ~$367M | commodity reserve/audit path; existing Kinesis supply sync may help but is not reserve composition |
| `usda-avalon` | ~$271M | dedicated source research |
| `usdgo-osl` | ~$134M | dedicated source research |
| `usdf-astherus` | ~$118M | dedicated source research |
| `dusd-standx` | ~$99M | dedicated source research |
| `pmusd-precious-metals` | ~$99M | commodity reserve/audit source research |
| `fpi-frax` | ~$97M | likely Frax-specific adapter/config extension |
| `usdh-native-markets` | ~$95M | attestation/PDF or issuer API research |
| `lisusd-lista` | ~$76M | existing `lista` adapter candidate |
| `usdm-mega` | ~$67M | dedicated source research |
| `mim-abracadabra` | ~$30M | existing `abracadabra` adapter candidate |

`ousd-origin-protocol` is not in the top supply set today, but it deserves a note: Origin's official API docs list OUSD collateral/strategy endpoints and warn that the API is not intended for mission-critical use. A live check during this audit returned `404` for `/api/v2/ousd/collateral` and `/api/v2/ousd/strategies`, while `/api/v2/ousd/stats/totalSupply` still worked. Treat the earlier OUSD quick-win idea as stale until the collateral endpoint is restored or replaced.

`satusd-river` has a live `https://api-v2.satoshiprotocol.org/protocol-info` response with TVL and chain-circulating data. That is promising for telemetry, but it is not yet a reserve composition adapter because TVL must be tied to collateral/debt semantics.

## Recommended Implementation Order

1. Add schema/invariant hardening:
   - adapter input-kind constraints
   - future timestamp guard
   - configured-coin validation over source model/evidence/freshness contracts
2. Patch high-confidence adapter accuracy issues:
   - `jupusd` unknown holdings
   - `ethena` min timestamp
   - `sky-makercore` timestamp spread
   - `chainlink-por` supply cross-check
   - `sgforge-coinvertible` collateralization check
3. Resolve current production degradations/errors:
   - `UTY`, `AZND`, `FDUSD`, `IUSD`, `wsrUSD`
4. Perform methodology decisions:
   - GHO residual issuance
   - USDz SPCT evidence threshold
   - whether single-bucket proofs should ever count as scoring-live
5. Expand coverage:
   - validate `lista` for `lisusd-lista`
   - validate `abracadabra` for `mim-abracadabra`
   - research current sources for Kinesis KAU, Solstice USX, Avalon USDA, Astherus USDF, StandX DUSD, USDGO, and pmUSD
6. Build larger projects:
   - crvUSD current-state LLAMMA/controller adapter with multicall/batching
   - GHO full facilitator/Aave V3/remote GSM decomposition if we choose strong reserve-quality output

## Verification Performed

- Read core docs: `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`, `docs/live-reserves.md`.
- Audited every registered adapter source file in `worker/src/cron/reserve-adapters/`.
- Sampled production reserve endpoints for all 138 configured live reserve coins.
- Ran focused tests:
  - `npm test -- worker/src/cron/reserve-adapters worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-sync-integration.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts`
  - Result: 47 files passed, 427 tests passed.

## External Source Notes

- Circle transparency page exposes reserve composition and the current `As of` date for USDC/EURC: https://www.circle.com/transparency
- Chainlink Data Feeds docs confirm `latestRoundData()` includes `updatedAt`, while `latestAnswer` lacks timestamp freshness: https://docs.chain.link/data-feeds/api-reference
- Curve LLAMMA docs expose the current-state band methods needed to rebuild crvUSD collateral on-chain: https://dev.curve.finance/crvUSD/amm/
- Curve controller docs state minted crvUSD is backed by collateral deposited into LLAMMA: https://dev.curve.finance/crvUSD/controller/
- Aave GHO facilitator docs describe multiple facilitator classes and bucket capacities, supporting why current GHO residual issuance is not a parser bug: https://www.aave.org/help/gho-stablecoin/facilitators
- Anzen docs describe USDz as backed 1:1 by SPCT and SPCT as private-credit/RWA exposure, supporting the current weak-probe classification: https://docs.anzen.finance/usdz-101/transparency and https://docs.anzen.finance/usdz-101/backing-assets-collateral
- Origin docs list OUSD collateral/strategy APIs but warn they are not mission-critical; current live checks found the documented collateral/strategy endpoints returning 404: https://docs.originprotocol.com/registry/api
