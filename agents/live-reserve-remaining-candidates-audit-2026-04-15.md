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

## Conditional / Policy Candidates

| Asset | Current blocker | Why this is conditional |
| --- | --- | --- |
| `GHO` | Production reserve sync is `degraded` because residual issuance outside configured GSM modules is large. On-chain freshness is otherwise `not-applicable`. | Aave docs say facilitators are governance-approved entities that mint/manage GHO and that Aave V3 borrowing is backed by collateral; a March 2026 governance post describes the newer RemoteGSM architecture where GhoDirectFacilitator mints into a GhoReserve and GSMs draw from it. A complete reserve adapter would need to model more than current GSM backing: Aave V3 facilitator debt/collateral, bridge/remote reserve accounting, and direct-minter/reserve allocations. A policy exception could promote tracked GSM telemetry, but would leave a large residual slice in scoring and should be treated as methodology work. Sources: https://www.aave.org/help/gho-stablecoin/facilitators, https://governance.aave.com/t/remotegsm-upgrade-enabling-l2-gsms-for-gho/24240 |
| `USDz` | `anzen-usdz` is `not-applicable` freshness and `ok`, but evidence class is intentionally `weak-live-probe`. | Anzen docs state USDz is backed 1:1 by SPCT and that SPCT represents tokenized RWA/private credit, but the current adapter only proves SPCT supply vs USDz supply. It does not independently verify SPCT's underlying private-credit portfolio, asset eligibility, valuation, or custody. Promotion would require SPCT-level reserve composition/valuation evidence, ideally from Anzen/RWA.io or direct issuer disclosures, not just the existing supply parity probe. Sources: https://docs.anzen.finance/usdz-101/transparency, https://docs.anzen.finance/usdz-101/backing-assets-collateral |
| `crvUSD` | Adapter is `ok` but `freshnessMode=unverified`; Yield Basis leg is current-state on-chain, but Curve direct-market leg comes from `prices.curve.finance` without a trustworthy update timestamp. | Curve docs make the on-chain path plausible: each crvUSD market has a Controller, collateral is deposited into LLAMMA, and LLAMMA exposes band-level balances such as `bands_x`, `bands_y`, `get_xy`, and `get_sum_xy`. A robust promotion would replace the Curve prices API direct-market leg with current-state contract reads across every active crvUSD controller/AMM and retain the existing Yield Basis on-chain leg. That is feasible but materially larger than a timestamp/mapping fix. Sources: https://dev.curve.finance/crvUSD/controller/, https://dev.curve.finance/crvUSD/amm/ |

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
