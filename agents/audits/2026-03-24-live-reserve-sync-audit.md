# Live Reserve Sync Audit (2026-03-24)

Scope: full review of the live reserve sync implementation, including cron orchestration, adapter registry, validation, storage/API consumption, all 27 adapters, and reserve-specific tests.

Validation performed:
- Read `docs/live-reserves.md`, `docs/architecture.md`, `docs/api-reference.md`, `docs/testing.md`, `docs/worker-and-api-limits.md`
- Reviewed `worker/src/cron/sync-live-reserves.ts`, adapter registry/types/helpers/validation, `worker/src/lib/live-reserves-store.ts`, `worker/src/api/stablecoin-reserves.ts`
- Reviewed every adapter in `worker/src/cron/reserve-adapters/*.ts`
- Ran:
  - `npm test -- worker/src/cron/reserve-adapters/__tests__ worker/src/cron/__tests__/sync-live-reserves.test.ts worker/src/cron/__tests__/reserve-adapter-validate.test.ts worker/src/lib/__tests__/live-reserves-store.test.ts worker/src/api/__tests__/stablecoin-reserves.test.ts`
  - Result: `32` test files passed, `183` tests passed

## Executive Summary

The subsystem is materially stronger than the March 21 audit trail:
- every adapter now has dedicated tests
- D1 write timeout protection exists
- missed-cron alerting exists
- config hygiene gaps like missing display links / missing curated reserve baselines appear resolved

The main remaining problems are no longer broad coverage gaps. They are concentrated in four areas:

1. Freshness assurance is still uneven. A meaningful subset of scoring-eligible adapters have no trustworthy upstream timestamp, so successful syncs can continue to look healthy even if the upstream disclosure itself has gone stale.
2. A few adapters still have concrete correctness risks, especially `fx` and `erc4626-single-asset`.
3. The codebase has mostly converged on shared adapter parsing/helpers, but a small number of adapters still bypass the shared contract and reintroduce drift risk.
4. Manual symbol/bucket maps are duplicated across many adapters. This is manageable today, but it is the main maintainability pressure point as coverage expands further.

## Current High-Priority Findings

### P0. Scoring-eligible freshness is still under-specified for 16 independent-feed coins

Issue:
- Several `independent` adapters emit no reliable `sourceTimestamp`, and most of them only mark `freshnessMode: "unverified"` or omit freshness metadata entirely.
- When the adapter keeps returning syntactically valid data, the pipeline has no way to distinguish “endpoint still responds” from “upstream reserve disclosure is still current”.
- Because collateral passthrough only requires fresh stored snapshots plus `reserve_sync_state.last_status = "ok"`, these feeds can still be admitted into independent live scoring without timestamp-backed freshness evidence.

Affected adapters/coins:
- `asymmetry`: `usdaf-asymmetry`
- `btcfi`: `btcusd-btcfi`
- `circle-transparency`: `usdc-circle`, `eurc-circle`
- `collateral-positions-api`: `zchf-frankencoin`, `deuro-deuro`
- `crvusd`: `crvusd-curve`
- `fx`: `fxusd-f-x-protocol`
- `infinifi`: `iusd-infinifi`
- `m0`: `m-m0`, `musd-metamask`, `usdn-noble`
- `mento`: `ceur-celo`, `cusd-celo`
- `openeden-usdo`: `usdo-openeden`
- `reservoir`: `wsrusd-reservoir`

Evidence:
- adapter validation only degrades on age when `metadata.sourceTimestamp` exists or when an adapter explicitly returns `freshnessMode: "unverified"` alongside an age policy
- several of the adapters above never emit `sourceTimestamp` at all
- some also omit `freshnessMode`, so even the informational warning path is skipped

Why this matters:
- this is the biggest remaining data-accuracy risk in the system
- it affects independent evidence, not just detail-page display
- it can produce false confidence during upstream disclosure stalls

Remediation:
- define a stricter freshness contract for `independent` adapters:
  - either publish a verifiable `sourceTimestamp`
  - or explicitly downgrade to non-scoring evidence until timestamped freshness is available
- fail closed for `independent + maxSourceAgeSec` adapters that have neither `sourceTimestamp` nor an adapter-specific proof that the source is intrinsically realtime
- at minimum, convert “no timestamp” from info-only to degraded for scoring-eligible adapters

### P0. `fx` can materially understate unknown collateral exposure

Issue:
- `worker/src/cron/reserve-adapters/fx.ts` detects unknown positive collateral keys and emits warnings, but those balances are not represented in the output slices.
- The final slices are normalized from known assets only, so a new unknown collateral key can silently disappear from the percentages.

Why this matters:
- this is a direct accuracy issue, not just a telemetry issue
- if the upstream payload adds a new collateral bucket, the reported mix can still sum to 100% known assets while the warning is easy to miss

Recommended fix:
- mirror the `reservoir` / `crvusd` / `ethena` pattern:
  - include an explicit `Other / unmapped collateral` slice
  - populate `unknownExposurePct`
  - keep the degraded warning, but do not hide the exposure in the composition itself

### P1. `erc4626-single-asset` bypasses the main on-chain fetch stack

Issue:
- `worker/src/cron/reserve-adapters/erc4626-single-asset.ts` uses `worker/src/cron/reserve-adapters/evm.ts`
- that path only calls `fetchEvmCallHexAtBlock(..., { chainRpcs, signal, timeoutMs })`
- unlike the shared helper path in `helpers.ts`, it does not honor:
  - `rpcUrl`
  - `fallbackRpcUrl`
  - `rpcMode`
  - Etherscan proxy fallback

Why this matters:
- this adapter is less reliable than the rest of the on-chain adapter family
- config implies richer RPC fallback behavior than the adapter actually uses
- this is also a maintainability smell because the repo now has two parallel on-chain call stacks

Recommended fix:
- remove the separate `evm.ts` fetch path for adapter use
- reimplement ERC-4626 reads through the same `fetchOnchainRawCall` / `fetchOnchainUint256` helper stack used elsewhere
- keep `evm.ts` only if it has a separate consumer with a different contract

### P1. HTML adapters remain structurally brittle

Affected adapters:
- `circle-transparency`
- `fdusd-transparency`
- `mento`
- `sgforge-coinvertible`

Issue:
- all four depend on page-shape assumptions, regexes, or substring delimiters rather than stable APIs
- `mento` is the most fragile because it extracts escaped JSON from a specific HTML substring boundary
- `sgforge-coinvertible` and `fdusd-transparency` rely on specific class names / markup layout
- `circle-transparency` mixes attribute extraction with page-specific element IDs

Why this matters:
- these adapters are operationally reliable only while the target sites keep their current DOM shape
- breakage mode is often hard failure, not graceful degradation to partial composition

Recommended fix:
- prefer embedded JSON / script-data extraction over raw regex where available
- add parser-level “shape changed” metrics or warning codes distinct from network failures
- if any provider exposes a machine-readable endpoint, migrate away from HTML first for these adapters

## Medium-Priority Findings

### P1. Shared adapter parsing is not fully unified

What is good:
- most adapters now use `parseLiveReserveAdapterParams(...)`

Remaining drift:
- `accountable.ts` still uses a custom param parser
- `circle-transparency.ts` reads `config.params` directly
- `erc4626-single-asset.ts` parses `config.params?.slice` manually

Why this matters:
- schema enforcement is now one of the strongest parts of the subsystem
- any adapter that bypasses it is a future drift point

Recommended fix:
- finish the migration so every adapter reads params through the shared schema layer

### P1. `getAdapterTimeout()` exposes a dead extension point

Issue:
- `helpers.ts` supports `config.params.timeoutMs`
- adapter param schemas are strict and do not permit `timeoutMs`
- repo search shows no live config uses it

Why this matters:
- this is effectively dead behavior
- it suggests the contract is broader than the schema actually allows

Recommended fix:
- either add `timeoutMs` to the relevant adapter schemas intentionally
- or delete the param override path and keep timeouts code-owned only

### P1. `fetchDefiLlamaPrices()` does not follow the same request hygiene as the other shared fetch helpers

Issue:
- it does not use the shared request cache in `AdapterContext`
- on non-OK response it throws without explicitly consuming/canceling the body

Why this matters:
- the subsystem explicitly documents connection-budget sensitivity
- most helpers already centralize fetch behavior; price fetches are the main holdout

Recommended fix:
- move `fetchDefiLlamaPrices()` onto the same cached request wrapper pattern as `fetchJsonWithRetry()` / `fetchTextWithRetry()`
- cancel unread non-OK bodies before throwing

### P2. Status overview can understate active failure modes once a feed has gone stale

Issue:
- `computeReserveCompositionOverview()` counts `staleCoins` before `errorCoins` / `degradedCoins`
- a coin with a valid old snapshot plus an active recent adapter failure is counted as stale, not error/degraded

Why this matters:
- the public status summary becomes less diagnostic during prolonged incidents
- operators lose a cleaner split between “old but intact” and “actively failing”

Recommended fix:
- decide which state should dominate operational reporting
- my recommendation: preserve mutually exclusive counts, but prioritize current `error` over `stale`

### P2. Manual bucket maps are the main long-term maintenance risk

The code repeatedly hardcodes token/bucket sets:
- `dola-inverse`
- `ethena`
- `falcon`
- `fx`
- `mento`
- `sky-makercore`
- `btcfi`
- `collateral-positions-api`

Why this matters:
- these are exactly the adapters most likely to drift as reserve products evolve
- every expansion requires touching code, tests, and methodology expectations separately

Recommended fix:
- centralize bucket metadata for symbol-classified adapters into shared declarative maps
- keep adapter-specific overrides, but reduce repeated hand-built `Set(...)` and risk-switch logic

## Low-Priority Findings

### P2. `accountable` flattens nested exposure data recursively

`extractNestedNumericValue()` is pragmatic, but it is intentionally permissive. If the upstream shape changes, it may sum nested values in ways that are numerically valid but semantically wrong.

Recommendation:
- prefer adapter-owned shape decoding over generic recursive numeric flattening

### P2. Some adapters do not emit enough metadata to support forensic debugging

Notably:
- `asymmetry`
- `crvusd`
- `collateral-positions-api`

These return useful slices, but sparse metadata makes production debugging harder when bucket assumptions drift.

Recommendation:
- standardize minimal metadata for all independent adapters:
  - source descriptor
  - raw item count
  - known vs unknown exposure
  - any upstream timestamp or explicit absence reason

### P3. `gho.ts` is a hotspot that is correct-looking but expensive to maintain

Observations:
- largest adapter by far
- manual ABI decoding
- protocol-specific fee/status logic inline

Assessment:
- the adapter is thoughtful and better tested than most
- the weakness is maintainability, not obvious correctness

Recommendation:
- split into smaller local helpers or a `gho/` submodule if this adapter evolves further

## Adapter-by-Adapter Assessment

| Adapter | Coins | Assessment | Key Weaknesses |
| --- | ---: | --- | --- |
| `accountable` | 7 | Medium risk | Custom param parser; permissive nested value flattening; freshness depends on parsable timestamp |
| `asymmetry` | 1 | Medium risk | No timestamp/freshness metadata; unknown branches only warning-based |
| `btcfi` | 1 | Medium risk | No timestamp-backed freshness; wrapper classification depends on a short allowlist |
| `chainlink-nav` | 3 | Strong | `getPrice()` mode still lacks verifiable freshness timestamp |
| `chainlink-por` | 1 | Strong | No major issue beyond usual oracle dependency |
| `circle-transparency` | 2 | Medium risk | HTML parsing brittle; no source timestamp; direct params access |
| `collateral-positions-api` | 2 | Medium risk | No timestamp-backed freshness; hard fails on missing price; symbol mapping is manual |
| `crvusd` | 1 | Medium risk | No timestamp-backed freshness; manual symbol bucketing |
| `curated-validated` | 24 | Strong for its role | Static-validated only; intentionally not independent evidence |
| `dola-inverse` | 1 | Strong | Manual asset bucketing remains drift-prone |
| `erc4626-single-asset` | 2 | Medium risk | Bypasses main on-chain helper stack; manual param parsing |
| `ethena` | 1 | Strong | Bucket lists are manual; freshness comes from payload timestamps only |
| `evm-branch-balances` | 3 | Strong | Could reuse shared price fetch/cache improvements |
| `falcon` | 1 | Strong | Large manual asset allowlists; unknown-known split will need maintenance |
| `fdusd-transparency` | 1 | Medium risk | HTML parsing brittle, though timestamp extraction exists |
| `frax` | 2 | Acceptable | Static-validated only; fallback remains coarse |
| `fx` | 1 | High risk | Unknown collateral can disappear from slices entirely |
| `gho` | 1 | Strong but hotspot | High LOC, manual ABI decoding, expensive to maintain |
| `infinifi` | 1 | Medium risk | No timestamp-backed freshness; manual farm mapping |
| `m0` | 3 | Medium risk | No timestamp-backed freshness; custom unit-scaling assumption is fragile |
| `mento` | 2 | Medium risk | Escaped-JSON HTML scraping is brittle; no source timestamp |
| `openeden-usdo` | 1 | Medium risk | No timestamp-backed freshness despite independent evidence class |
| `reservoir` | 1 | Medium risk | No timestamp-backed freshness; broad label matching rules |
| `sgforge-coinvertible` | 1 | Medium risk | HTML parsing brittle; single-bucket representation trusts page layout heavily |
| `single-asset` | 47 | Acceptable for current role | Weak-live-probe by design; informative but not strong evidence |
| `sky-makercore` | 2 | Strong | Token classification and immediate redeemability logic are manual |
| `tether` | 1 | Acceptable for current role | Weak-live-probe by design; coarse single-bucket summary |

## Cross-Cutting Code Quality / Mutualization Opportunities

### 1. Finish convergence on one adapter-contract path

Target:
- one param parser path
- one on-chain call path
- one request cache path

Concretely:
- migrate `accountable`, `circle-transparency`, `erc4626-single-asset`
- retire adapter-local on-chain fetch path in `evm.ts` for reserve adapters
- cache DefiLlama price requests in the same context cache as other adapter fetches

### 2. Introduce a small shared “bucketed composition adapter” utility

Several adapters share the same pattern:
- iterate upstream assets
- map symbol/label to a bucket
- accumulate known values
- route unknowns to warning + optional “other” slice
- derive `unknownExposurePct`

Candidates:
- `ethena`
- `falcon`
- `dola-inverse`
- `sky-makercore`
- `fx`
- `btcfi`

This does not need a heavy abstraction. A small helper that takes:
- bucket classifier
- bucket display config
- unknown handling mode
- optional coinId/depType enrichment

would remove repeated logic and make unknown-exposure handling more consistent.

### 3. Centralize symbol/risk metadata where possible

Today, asset semantics live partly in:
- `shared/lib/reserve-asset-risk.ts`
- adapter-local `Set(...)`/`Record(...)` maps

Recommended direction:
- keep canonical asset risk in shared
- move adapter-specific symbol aliases / bucket membership into small shared lookup modules where reuse is plausible

### 4. Standardize adapter metadata minimums

Every independent adapter should try to emit:
- `freshnessMode`
- `sourceTimestamp` or explicit timestamp absence
- item/asset count
- `unknownExposurePct` when mapping is partial
- `supplyUsd` / `totalReserveUsd` when meaningful

That would improve both operator visibility and downstream reuse.

## Positives Worth Preserving

- Sequential orchestration is the right choice for this trigger slot.
- The registry split between `sourceModel`, `evidenceClass`, and `sharedSourceMode` is clean and defensible.
- Strict fail-closed snapshot parsing in `live-reserves-store.ts` is good.
- Public API fallback behavior is conservative and well aligned with the product requirement.
- The test surface is now solid: every adapter has dedicated coverage, and the orchestration/store/API contract tests all passed during this audit.

## Recommended Remediation Sequence

### Track A: Accuracy hardening
1. Fix `fx` so unknown collateral becomes an explicit slice plus `unknownExposurePct`.
2. Define and enforce a stricter freshness contract for independent adapters lacking `sourceTimestamp`.
3. Review `m0` cash-unit scaling against upstream documentation and encode the assumption more explicitly.
4. Add richer metadata to low-observability adapters (`asymmetry`, `crvusd`, `collateral-positions-api`).

### Track B: Reliability hardening
1. Rework `erc4626-single-asset` onto the shared on-chain helper stack.
2. Add request caching + body cancellation to `fetchDefiLlamaPrices()`.
3. Improve HTML-adapter parser resilience and differentiate “DOM changed” from generic fetch failure.

### Track C: Maintainability / LOC reduction
1. Finish migration to shared param parsing for all adapters.
2. Extract a small shared bucketed-composition helper.
3. Consolidate repeated symbol/bucket maps where reuse is realistic.
4. Split `gho.ts` if further feature work is planned there.

## Planning Implication

This does not need another broad discovery phase before remediation. The system is already well mapped. The next implementation plan should be a focused remediation plan with three workstreams:
- freshness contract hardening
- adapter correctness fixes (`fx`, `erc4626-single-asset`, selected HTML parsers)
- maintainability cleanup (shared helpers, map consolidation, metadata standardization)
