# Remaining Live Reserve Promotion Candidates — 2026-04-15

## Scope

Follow-up audit after commit `b277294e` promoted 17 configured reserve-sync assets by preserving verified upstream timestamps and fixing reserve mappings.

Assumption: a reserve-sync asset is a good candidate only if it can pass the existing report-card live collateral gate without weakening it:

- latest sync state must be `ok`
- snapshot must be fresh and matched to sync state
- adapter evidence class must be `independent`
- freshness must be `verified` or `not-applicable`, not merely `unverified`

Current remaining configured-after-17 set: `USDY`, `GHO`, `FDUSD`, `crvUSD`, `IUSD`, `USDz`, `fxUSD`, `ZCHF`, `UTY`, `USDaf`, `AZND`, `BtcUSD`, `wsrUSD`, `DEURO`.

Checked live upstreams and local adapter validation at about `2026-04-15 07:56 UTC`.

## Implemented Candidate

| Asset | Result |
| --- | --- |
| `USDaf` | Implemented in the current working tree: the `asymmetry` adapter now parses the API top-level timestamp as verified freshness and normalizes branch keys before risk lookup, so `wBTC` no longer degrades the feed. Live-source smoke returned `ok`, `freshnessMode=verified`, and no warnings. |

## Remaining Best Candidate

| Asset | Current live-source state | Why it is reasonable | Suggested fix |
| --- | --- | --- | --- |
| `AZND` | `accountable` currently validates `ok` with `freshnessMode=verified`, `sourceTimestamp=1776239599`, and no warnings. | No code needed if the upstream remains fresh. It was previously just over the 3-day freshness threshold; the provider has since refreshed. | Let the next live reserve sync and report-card publish run. If it does not promote, inspect D1 sync state/circuit state rather than adapter code. |

Expected remaining upside from reasonable near-term work: `AZND` automatically if the source remains fresh.

## Deep Research: Conditional / Policy Candidates

| Asset | Current blocker | Why this is conditional |
| --- | --- | --- |
| `GHO` | Production reserve sync is `degraded` because residual issuance outside configured GSM modules is large. On-chain freshness is otherwise `not-applicable`. | Aave docs say facilitators are governance-approved entities that mint/manage GHO and that Aave V3 borrowing is backed by collateral; a March 2026 governance post describes the newer RemoteGSM architecture where GhoDirectFacilitator mints into a GhoReserve and GSMs draw from it. A complete reserve adapter would need to model more than current GSM backing: Aave V3 facilitator debt/collateral, bridge/remote reserve accounting, and direct-minter/reserve allocations. A policy exception could promote tracked GSM telemetry, but would leave a large residual slice in scoring and should be treated as methodology work. Sources: https://www.aave.org/help/gho-stablecoin/facilitators, https://governance.aave.com/t/remotegsm-upgrade-enabling-l2-gsms-for-gho/24240 |
| `USDz` | `anzen-usdz` is `not-applicable` freshness and `ok`, but evidence class is intentionally `weak-live-probe`. | Anzen docs state USDz is backed 1:1 by SPCT and that SPCT represents tokenized RWA/private credit, but the current adapter only proves SPCT supply vs USDz supply. It does not independently verify SPCT's underlying private-credit portfolio, asset eligibility, valuation, or custody. Promotion would require SPCT-level reserve composition/valuation evidence, ideally from Anzen/RWA.io or direct issuer disclosures, not just the existing supply parity probe. Sources: https://docs.anzen.finance/usdz-101/transparency, https://docs.anzen.finance/usdz-101/backing-assets-collateral |
| `crvUSD` | Adapter is `ok` but `freshnessMode=unverified`; Yield Basis leg is current-state on-chain, but Curve direct-market leg comes from `prices.curve.finance` without a trustworthy update timestamp. | Curve docs make the on-chain path plausible: each crvUSD market has a Controller, collateral is deposited into LLAMMA, and LLAMMA exposes band-level balances such as `bands_x`, `bands_y`, `get_xy`, and `get_sum_xy`. A robust promotion would replace the Curve prices API direct-market leg with current-state contract reads across every active crvUSD controller/AMM and retain the existing Yield Basis on-chain leg. That is feasible but materially larger than a timestamp/mapping fix. Sources: https://dev.curve.finance/crvUSD/controller/, https://dev.curve.finance/crvUSD/amm/ |

### crvUSD implementation path

Current state:

- `worker/src/cron/reserve-adapters/crvusd.ts` combines:
  - direct mint-market values from `https://prices.curve.finance/v1/crvusd/markets`
  - on-chain Yield Basis LT exposure reads through the Yield Basis factory
- The direct Curve market leg is the blocker: it gives useful `collateral_amount_usd` values but no current source timestamp.
- The adapter therefore correctly emits `freshnessMode = "unverified"` even though the Yield Basis leg is latest-state on-chain.

Primary-source basis:

- Curve Controller docs state that each crvUSD mint market has its own Controller and that collateral provided by borrowers is deposited into LLAMMA, backing minted crvUSD.
- Curve LLAMMA docs expose the relevant current-state primitives: `min_band`, `max_band`, `bands_x`, `bands_y`, `get_xy`, and `get_sum_xy`. `get_sum_xy(user)` is user-scoped, so market-wide totals should be computed from band balances, not from a single user call.

Feasibility probe:

- For the current WBTC LLAMMA (`0xE0438Eb3703bF871E31Ce639bd351109c88666ea` from the Curve market API), `min_band = -105`, `max_band = 1037`, and `active_band = -65`, a span of 1,143 bands.
- A raw sum over `bands_x` / `bands_y` found 202 non-zero bands. This confirms that direct band reads are feasible, but an unbatched per-band loop would be too slow and too RPC-heavy for the hourly reserve lane.

Recommended design:

1. Treat the Curve markets API only as a discovery/config source, not as a reserve-value source. Safer option: move active Controller/LLAMMA/collateral-token addresses into adapter params or a shared curated registry so source freshness remains on-chain-only.
2. For each configured mint market:
   - read Controller `amm()` and `collateral_token()` as a consistency check if not hardcoded
   - read LLAMMA `min_band()`, `max_band()`, and optionally `active_band()`
   - batch `bands_y(n)` and, if needed for accounting diagnostics, `bands_x(n)` across the band range
   - value summed external collateral balances with DefiLlama prices by collateral token address
3. Use Multicall3 (`aggregate3`) or JSON-RPC batch support to avoid thousands of individual HTTP calls. The existing `worker/src/lib/evm-rpc.ts` has single-call helpers only, so this likely needs a small reusable batch/multicall helper.
4. Keep the existing Yield Basis on-chain leg, which already reads current-state asset balances with `preview_emergency_withdraw(totalSupply)`.
5. Emit `freshnessMode = "not-applicable"` only when all reserve-value legs are current-state on-chain reads. If any timestamp-less API value still drives the reserve mix, keep `unverified`.

Open modeling questions:

- Whether `bands_x` (crvUSD side of LLAMMA soft-liquidation bands) should be counted as reserve value, ignored, or treated as debt-offset. The current API-based adapter effectively consumes external collateral value by symbol; before replacing it, we should compare an on-chain reconstruction against Curve's `collateral_amount_usd` output over several markets.
- Whether PegKeeper / PSR stablecoin pools should appear in reserve composition. Current curated metadata focuses on minted-market collateral, while peg keepers defend the secondary peg rather than directly backing borrower debt.
- How to handle new markets. Hardcoded market params are safest for freshness semantics but require metadata updates when Curve adds collateral markets. API discovery is operationally easier but should not control reserve values.

Implementation size:

- Medium-to-large. This is a real adapter rewrite plus an EVM batching helper, not a one-line freshness fix.
- Expected files: `worker/src/cron/reserve-adapters/crvusd.ts`, new/extended EVM batch helper under `worker/src/lib` or adapter helpers, `shared/data/stablecoins/usd-major.json` params if using curated market registry, tests in `worker/src/cron/reserve-adapters/__tests__/crvusd.test.ts`, docs/methodology version bump.

### GHO implementation paths

Current state:

- `worker/src/cron/reserve-adapters/gho.ts` reads:
  - GHO total supply
  - facilitator list and bucket levels
  - reviewed GSM modules (`stataUSDC`, `stataUSDT`) for current backing, swappability, and fees
- It stores a current-state on-chain snapshot with `freshnessMode = "not-applicable"`.
- It deliberately emits a degraded warning when `totalSupply - trackedGsmBacking` is material. The latest production issue was residual issuance around 63.65%.

Primary-source basis:

- Aave's facilitator docs describe facilitators as DAO-authorized entities/protocols that mint/manage GHO and state that the Aave V3 Ethereum market lets users borrow GHO against supplied collateral.
- Aave's GHO page describes the normal user flow: supply collateral, borrow GHO, repay GHO plus interest.
- Aave's RemoteGSM governance proposal describes a newer remote architecture: GhoDirectFacilitator mints into a GhoReserve, and network GSMs source GHO from that reserve. This means some labels in the residual bucket are accounting/bridge/reserve rails, not a single collateral class.

Path A: policy promotion of the current tracked GSM snapshot

- Change the `aggregated-residual-issuance` warning from `degraded` to `info` or allowlist it for report-card collateral passthrough.
- This is technically easy and mirrors a narrow redemption-backstop exception already documented for GHO.
- It is not a full reserve implementation: the report-card collateral score would use tracked GSM slices plus a large generic residual slice, currently medium-risk.
- This is acceptable only if we decide "partial current-state reserve composition with explicit residual" is better than curated fallback for collateral quality. That is a methodology decision.

Path B: classify every facilitator into explicit live slices

- Extend `gho` params with facilitator classification rules keyed by facilitator address/label:
  - reviewed GSM modules: direct stablecoin slices
  - Core/Aave V3 facilitator: Aave V3 collateral basket
  - cross-chain/remote facilitators: remote GSM or bridge-reserve bucket
  - flashmint: usually zero after a block; if non-zero, fatal/degraded
  - Horizon/Lido/direct minter labels: separate reviewed buckets if they represent standing issuance
- This would remove the generic "Residual facilitators / reserve buffer" label, but it still might not produce true collateral composition unless the largest buckets can be decomposed.
- Good intermediate step if we can source and review each facilitator's semantics, but still methodology-sensitive.

Path C: compute Aave V3 GHO debt collateral composition

- The hard part is attributing the Aave V3 GHO borrow facilitator to collateral types.
- Protocol-level reserve data is not enough; GHO borrowers can have multiple collateral assets and potentially other borrows. Accurate composition requires user-level collateral/debt positions, or an authoritative analytics API that already aggregates "collateral backing GHO debt".
- Potential data sources:
  - Aave/TokenLogic analytics if they expose a stable API for GHO collateral composition
  - Aave subgraphs / event-derived data, but this is a larger pipeline and may be too heavy for hourly reserve sync
  - direct on-chain user enumeration is not viable inside the reserve cron unless an indexed user set exists
- This is the most correct path for GHO collateral scoring, but it is not a small adapter change.

Path D: remote GSM / bridge reserve modeling

- For the RemoteGSM rails, read GhoReserve / remote facilitator contracts directly if public getters expose reserve balances and GSM allocations.
- This can likely improve the residual bucket, but it does not solve Aave V3 borrower-collateral composition by itself.

Recommended GHO decision:

1. Do not silently promote the current degraded snapshot as a bug fix.
2. If we want quick coverage, write an explicit methodology update that allows current-state GHO snapshots with named residual buckets to pass collateral scoring, and make the warning effect configurable for `aggregated-residual-issuance`.
3. If we want strong reserve-quality output, first research/implement an authoritative GHO collateral composition source for Aave V3 debt, then layer in remote GSM/bridge allocations.

Implementation size:

- Path A: small code change + methodology update, but policy-heavy.
- Path B/D: medium adapter/config work.
- Path C: large indexing/API integration project.

## Not Good Local Candidates Right Now

| Asset | Blocker | Notes |
| --- | --- | --- |
| `USDY` | Configured Ondo oracle uses `getPrice()`, which exposes no update timestamp. `latestRoundData()`, `getAssetPrice(token)`, and `tokenToRWAOracle(token)` against the configured oracle did not provide a working timestamp path. | Needs a different oracle/source that exposes `updatedAt`, or Ondo/Chainlink-style timestamped wrapper support. |
| `FDUSD` | Parser works, but latest composition date is `Feb 28, 2026`; source-age policy is 7 days. | Will self-promote only when First Digital publishes a fresh composition/as-of date. Page `Last-Modified` / Webflow `Last Published` does not prove reserve-source freshness. |
| `IUSD` | infiniFi API has no reserve snapshot timestamp; only farm maturity fields were found. | Needs provider timestamp or direct current-state/on-chain replacement for the reserve composition source. |
| `fxUSD` | API response has no temporal fields. | Needs provider timestamp or a direct current-state adapter over protocol contracts. |
| `ZCHF`, `DEURO` | Position APIs expose position `created` fields only; price mapping APIs expose fresh price timestamps, but not a reserve-position snapshot timestamp. | Price freshness alone is not enough because the reserve mix also depends on live positions/balances. Needs top-level position snapshot timestamp or direct current-state reads. |
| `UTY` | Accountable source timestamp remains stale (`1774881167`, about 15.7 days old). | Upstream refresh required; increasing freshness tolerance would weaken policy. |
| `BtcUSD` | Market and handler APIs expose no trustworthy timestamp. | Needs upstream timestamp or direct on-chain/current-state replacement. |
| `wsrUSD` | Reservoir balance-sheet API has no temporal fields. | Needs provider timestamp or direct current-state balance-sheet reads. Existing redemption modeling already has a documented fallback; report-card collateral passthrough should stay stricter. |

## Recommended Next Step

Re-check `AZND` after the next reserve/report-card cycle. If it remains configured despite current source freshness, investigate runtime sync state, not the adapter.

For the hard conditional set, the only path that looks like a code project rather than policy/source negotiation is `crvUSD`: build a direct on-chain crvUSD controller/LLAMMA collateral adapter. `GHO` and `USDz` require methodology/evidence decisions before implementation.
