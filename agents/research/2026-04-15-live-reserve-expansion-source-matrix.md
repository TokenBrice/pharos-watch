# Live Reserve Expansion Source Matrix - 2026-04-15

## Scope

Source-quality research for live reserve sync expansion priorities. This artifact supports `agents/plans/2026-04-15-live-reserve-sync-total-execution-plan.md`.

Research rule: official docs, official dashboards, public protocol APIs, or on-chain contracts only. No scoring-live adapter should be implemented from secondary commentary alone.

## Implementable Now

| Asset | Candidate source | Adapter path | Expected tier | Risk / condition |
| --- | --- | --- | --- | --- |
| `usdgo-osl` | `https://www.usdgo.com/api/lark-bitable`, `https://www.usdgo.com/transparency`, `https://www.anchorage.com/platform/usdgo-reserve-attestations` | New `usdgo-transparency` HTTP JSON adapter | potential independent `attestation-mix` only after source-provenance gate | Endpoint is public but not a formal API contract; source text attributes data to Anchorage/OSL and disclaims timeliness/completeness. Score-grade use requires proving the fields are documented or visibly rendered by the official page, plus a methodology decision if only date-granularity freshness exists. |
| `usx-solstice` | `https://attestation-api.solstice.finance/dashboard`, `https://attestation.solstice.finance/`, Solstice docs | New `solstice-attestation` adapter or generalized Accountable variant | non-scoring proof/weak-live-probe first | API proves solvency/aggregate reserves more clearly than reserve category mix. It must not become score-grade until timestamped asset-category composition exists or methodology explicitly maps delta-neutral aggregate proofs to reserve risk. |
| `satusd-river` | `https://api-v2.satoshiprotocol.org/protocol-info`, River docs/contracts/oracle docs | New `river-protocol-info` HTTP JSON adapter | display-live weak-live-probe / aggregate TVL telemetry, not score-grade dynamic mix | API exposes TVL and chain circulation, not collateral composition by BTC/ETH/BNB/LST. |

## Implementable After Contract Extraction

| Asset | Source basis | Adapter path | Blocker |
| --- | --- | --- | --- |
| `lisusd-lista` | Lista docs list collateral classes and PSM assets: BNB, ETH, slisBNB, wBETH, BTCB, FDUSD, wstETH, USDT/USDC PSM | Existing `lista` / branch-balance adapter | Need verified current holder contracts/token addresses and ideally debt/supply reconciliation. |
| `mim-abracadabra` | Abracadabra docs confirm market/cauldron structure and app bundles expose current cauldron configs | Existing `abracadabra` adapter after verification | Need active cauldron extraction and confirmation whether `totalCollateralShare()` must be converted through BentoBox shares before valuation. |
| `pmusd-precious-metals` | RAAC RWf(x), deployment, and TokenBlender docs; pmUSD token in repo metadata; fGOLD BaseToken in docs | New `raac-rwfx` on-chain adapter | Dashboard is bot-challenged; exact Treasury/FractionalToken/BaseToken relationship needs contract-level verification. |
| `fpi-frax` | Frax docs identify FPI Controller Pool and Comptroller | New FPI on-chain adapter | Frax API equivalents for FPI returned 404; on-chain AMO/controller balances need reconciliation to supply. |

## Not Score-Grade Implementable Today

| Asset | Current evidence | Decision |
| --- | --- | --- |
| `kau-kinesis` | Audit archive/Inspectorate/Bureau Veritas source, not current machine-readable composition | Keep curated/audit-backed; maybe commodity proof view, not live scoring. |
| `usda-avalon` | Docs describe FBTC/USDC/USDT/CDP risk and custody partners; no public reserve API found | Defer until custody/contract addresses and live collateral/debt source are published. |
| `usdf-astherus` | Docs describe USDT at Ceffu and Binance/MirrorX delta-neutral strategies | Defer; Ceffu/Binance positions are not public. |
| `dusd-standx` | High-level docs/blog only; no reserve API found | Defer. |
| `usdh-native-markets` | Docs and reserves page, but OpenAPI is a sample and source is not machine-readable reserve composition | Keep attestation/static until a real API or parser exists. |
| `usdm-mega` | MegaETH docs do not expose reserve API; repo metadata says mostly USDtb + stablecoins | Possible curated/static wrapper dependency only; no score-grade live source. |
| `ousd-origin-protocol` | Official docs list collateral/strategy API, but live endpoints returned 404; totalSupply endpoint works | Keep current curated-validated config; defer Origin-specific adapter until endpoints recover or on-chain strategy reads are scoped. |
| `USDz/SPCT` | Anzen docs and API show SPCT/private-credit context, but no timestamped SPCT NAV/custody/valuation proof tied to USDz liabilities | Keep weak-live-probe. |
| `GHO` | On-chain telemetry is real, but residual issuance is large and facilitator semantics are heterogeneous | Methodology/modeling decision before scoring-live promotion. |
| `IUSD`, `wsrUSD`, `fxUSD`, `BtcUSD`, `DEURO`, `ZCHF` | Useful APIs but no source timestamp/block or current-state reconstruction | Keep display-live/non-scoring until provider timestamp or on-chain replacement exists. |

## Current Live Checks

- JupUSD endpoints returned current JSON:
  - `https://api.jupusd.money/api/data`
  - `https://api.jupusd.money/api/snapshots`
  - `https://api.jupusd.money/api/oracle`
- InfiniFi protocol API returned current-looking data but no trustworthy top-level timestamp:
  - `https://eth-api.infinifi.xyz/api/protocol/data`
- Reservoir raw reserves returned assets/liabilities but no source timestamp:
  - `https://app.reservoir.xyz/api/reserves/raw`
- XSY Accountable primary returned `503`; cache returned stale data:
  - `https://accountable.xsy.fi:10443/dashboard`
  - `https://cache.accountable.capital/dashboard/xsy`
- First Digital page remains stale by disclosure date:
  - `https://www.firstdigitallabs.com/transparency`
- Origin docs endpoint mismatch:
  - `https://api.originprotocol.com/api/v2/ousd/collateral` -> 404
  - `https://api.originprotocol.com/api/v2/ousd/strategies?structured=true` -> 404
  - `https://api.originprotocol.com/api/v2/ousd/stats/totalSupply` -> 200
