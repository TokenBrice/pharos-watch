# Curated-Validated / Proof Live Candidate Audit — 2026-04-15

## Scope

Audit the `Curated-Validated` and `Proof` reserve-view populations for candidates that could become true `Live` reserve feeds under the existing report-card gate:

- `evidenceClass = independent`
- latest sync state `ok`
- fresh authoritative snapshot
- `freshnessMode = verified` or `not-applicable`

This is research-only. No metadata or adapter edits are made in this audit.

Local population from `ACTIVE_STABLECOINS` and `getReserveDisplayBadgeKindForAdapter()`:

- `Curated-Validated`: 32 rows (`curated-validated` 31, `frax` 1)
- `Proof`: 46 rows (`single-asset` 46)

Subagent result integrated: the strongest non-commodity proof candidate is `USYC`, followed by `TBILL`, then `AUSD`.

## Top Candidates

| Rank | Asset | Current badge | Why it is attractive | Proposed path | Effort | Caveat |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | `USYC` | Proof | Hashnote publishes a timestamped price-report API and documents a Chainlink-style on-chain oracle. The oracle/NAV model maps well to the existing independent `chainlink-nav` adapter. | Implemented in working tree: switched from weak `single-asset` to `chainlink-nav` using USYC token `0x136471a34f6ef19fE571EFFC1CA711fdb8E49f2b` and oracle `0x74f2199AEb743f68f05943e5715A33EaF2b61f53`. | S/M | Live smoke returned `ok`, verified freshness. |
| 2 | `FRAX` | Curated-Validated | Frax already has a live v2 balance-sheet API with `asOfTimestamp`; the repo already has an independent `frax-balance-sheet` adapter used by related assets. | Implemented in working tree: moved `frax-frax` from legacy `frax` adapter/combineddata to `frax-balance-sheet` endpoint `https://api.frax.finance/v2/frax/balance-sheet/latest` and expanded token classification. | M | Live smoke returned `ok`; future unknown exposure degrades only if material. |
| 3 | `TBILL` | Proof | OpenEden documents a public token price oracle/API/subgraph and TBILL transparency/NAV reports. Reserve source shape is similar to tokenized-Treasury NAV products. | Implemented in working tree: switched from weak `single-asset` to `chainlink-nav` using TBILL token `0xdd50c053c096cb04a3e3362e2b622529ec5f2e8a` and oracle `0xCe9a6626Eb99eaeA829D7fA613d5D0A2eaE45F40`. | M | Live smoke returned `ok`, verified freshness. |
| 4 | `AUSD` | Curated-Validated | Agora has a Chaos Labs proof-of-reserves integration, and metadata already marks it as `real-time`. | Build a Chaos Labs PoR adapter if a stable JSON/on-chain feed can be identified for total NAV, supply, and timestamp. | M | Public portal is clear, but machine-readable endpoint/feed address was not obvious from quick inspection. |
| 5 | `USD1` | Proof | The public PoR page advertises Chainlink-sourced reserves, total supply, and collateralization ratio. | Implemented in working tree: added `usd1-bundle-oracle` adapter for Chainlink oracle `0x691b74146cdba162449012aa32d3cbf5df77d4c4`, decoding `latestBundle()` and checking `latestBundleTimestamp()`. | M | Live smoke returned `ok`, verified freshness. |
| 6 | `DGLD` | Proof | DGLD has an official explorer backend exposing current allocated bar inventory. | Not implemented: `POST https://production-backend.dgld.ch/search` returns bar inventory and fine weights, but the inventory payload lacks an explicit as-of timestamp. | M | Would require accepting query-time/health-endpoint freshness, which would weaken the current gate. |

## Near-Term Watchlist

These are plausible but less compelling until a machine-readable source is confirmed:

| Asset | Current badge | Reason to watch | Blocker |
| --- | --- | --- | --- |
| `BUIDL` | Proof | Securitize/BNY tokenized fund; on-chain token plus institutional NAV may exist. | Need a timestamped NAV/reserve API or oracle. ERC-20 supply alone is not reserve proof. |
| `CETES` | Proof | Etherfuse publishes PoR/legal pages for tokenized sovereign bonds. | Need machine-readable current holdings/NAV timestamp, not just legal/report pages. |
| `MSUSD`, `pUSD`, `thBILL`, `PHT` | Proof | Protocol/wrapper-style backing may be directly readable from vault/contracts. | Requires contract-specific adapter review. Current single-asset probe is insufficient. |
| `PAXG`, `XAUT`, `XAUm`, `KAG` | Proof | Large commodity-backed products with audits/reports. | Most public sources are periodic attestations; true live needs bar inventory API or Chainlink PoR/NAV feed. |

## Curated-Validated Triage

| Asset | Triage | Notes |
| --- | --- | --- |
| `USDT` | Not near-term | Tether has transparency attestations and a dedicated weak `tether` proof family exists, but true independent live composition would need machine-readable, timestamped balance-sheet slices. |
| `USDG` | Not near-term | Paxos-style monthly transparency/attestation; no obvious live API in current metadata. |
| `RLUSD` | Not near-term | Ripple transparency is attestation-style. Candidate only if a timestamped reserve API/feed exists. |
| `USDTB` | Possible M | Anchorage/BUIDL-backed product. Could become live if Anchorage exposes machine-readable reserve/NAV data or if BUIDL + USDC weights are on-chain/timestamped. |
| `U` | Not near-term | Mixed stablecoin/fiat composition with no clear independent timestamped source. |
| `USDai` | Not needed/low | Base USDai is already structurally tied to PYUSD; sUSDai was the stronger live-reserve target and was handled in prior work. |
| `YLDS` | Possible M | SEC-registered Figure product with KPMG/prospectus; live conversion needs a timestamped NAV/reserve feed. |
| `FRAX` | Strong candidate | Live v2 Frax balance-sheet API exists; needs risk-map cleanup. |
| `AUSD` | Strong candidate | Chaos Labs real-time PoR integration; needs feed/API discovery. |
| `satUSD` | Not near-term | Crypto CDP basket; no obvious current-state source/config beyond curated static mix. |
| `GUSD` (Gate) | Not near-term | Self-reported Gate disclosure; no independent live source. |
| `rwaUSDi` | Not near-term | AFI verification exists but basket is broad/complex; likely custom adapter + source review. |
| `avUSD` | Conditional | USDC strategy product; live only if 0xPartners/protocol contracts expose reserve allocation. |
| `PUSD` | Not near-term | Primarily USDT wrapper/gold interoperability; no clear live reserve source. |
| `CASH` | Possible M/L | Phantom/Cash reserve disclosures may be fresh, but needs API/source discovery. |
| `cgUSD` | Not near-term | Treasury-backed, but no obvious machine-readable reserve feed. |
| `AEUR` | Not near-term | Fiat reserves; likely periodic attestations. |
| `REUSD` | Conditional M/L | Could be built from Curve/Frax lending-vault on-chain positions, but it depends on solving upstream crvUSD/frxUSD live modeling. |
| `EURI` | Not near-term | Banking Circle/EY attestation style; no live feed identified. |
| `USDP` | Not near-term | Paxos monthly transparency/attestation; no live feed identified. |
| `HYUSD` | Conditional M/L | Solana LST basket may be on-chain readable; needs protocol-specific source and valuation. |
| `USDB` | Conditional M | Blast yield-bearing stable; could be on-chain if DAI/sDAI bridge accounting is accessible. |
| `ZeUSD` | Not near-term | Tokenized assets, no clear timestamped source. |
| `EURE` | Not near-term | Monerium financial reports, likely attestation/static. |
| `NECT` | Conditional M/L | Beraborrow CDP collateral might be on-chain readable; needs protocol adapter. |
| `FIDD` | Not near-term | Fidelity attestation/product docs; live feed not identified. |
| `WUSD` | Not near-term | WSPN disclosures; no obvious live API. |
| `SBC` | Not near-term | Brale/Abdo attestation style. |
| `OUSD` | Conditional M/L | Origin analytics may expose live strategy allocations; needs source/adapter review. |
| `EUROP` | Not near-term | Schuman/KPMG audit style. |
| `EURQ` | Not near-term | Quantoz transparency, self-reported/attestation style. |
| `apxUSD` | Not near-term | APYx protocol, no clear machine-readable reserve source in current metadata. |

## Proof Triage

| Asset | Triage | Notes |
| --- | --- | --- |
| `USD1` | Strong candidate | Public PoR page claims Chainlink/on-chain reserve/supply/ratio; discover feed/API. |
| `PYUSD` | Not near-term | Paxos/KPMG monthly transparency; no live feed identified. |
| `USYC` | Strongest candidate | Hashnote docs/API/oracle are timestamped and Chainlink-style. |
| `BUIDL` | Watchlist | Strong institutional product; need timestamped NAV/reserve API/oracle. |
| `A7A5` | Reject | Sanctioned/ruble banking risk; live proof would not improve report-card quality enough. |
| `BRZ` | Not near-term | Self-reported PDF-style reserve report. |
| `MNEE` | Not near-term | Transparency attestation, no live feed identified. |
| `TBILL` | Strong candidate | OpenEden token price/oracle/subgraph docs; needs adapter source selection. |
| `USDQ` | Not near-term | Quantoz self-reported transparency. |
| `GUSD` (Gemini) | Not near-term | Monthly attestation style. |
| `USDX` | Not near-term | Hex Trust disclosures, no obvious API. |
| `XUSD` | Not near-term | StraitsX attestation style. |
| `USDCV` | Not near-term | SG-FORGE self-reported reserve page; no live API found. |
| `meUSD` | Conditional M/L | BTC-backed protocol; source is explorer token endpoint only today. Needs actual reserve contract/asset reads. |
| `EURS` | Not near-term | STASIS transparency/audits; likely static/periodic. |
| `USAT` | Not near-term | Early/issuer materials; no live source. |
| `MSUSD` | Conditional M | USDC-backed wrapper; could be contract-readable if Main Street exposes vault backing. |
| `pUSD` | Conditional M | Nucleus/BoringVault USDC backing may be contract-readable; needs vault address/asset validation. |
| `USDR` | Not near-term | Grant Thornton periodic proof. |
| `thBILL` | Watchlist | Tokenized T-bill wrapper; source could be on-chain if tULTRA/NAV contract is public. |
| `XSGD` | Not near-term | Attestation/accountant reports. |
| `GYEN` | Not near-term | GMO/The Network Firm attestation. |
| `AUDD` | Not near-term | William Buck attestation. |
| `JPYC` | Not near-term | Fiat/bond reserves; no live source identified. |
| `AxCNH` | Not near-term | Cash reserve claim, no live feed identified. |
| `IDRT` | Not near-term | Bank-deposit reserve claim, no live feed identified. |
| `TRYB` | Not near-term | Bank-deposit reserve claim, no live feed identified. |
| `XAUT` | Watchlist | Large gold product; needs bar/reserve API or Chainlink PoR/NAV. |
| `PAXG` | Watchlist | Large gold product; needs bar/reserve API or Chainlink PoR/NAV. |
| `XAUm` | Watchlist | Audit-backed gold; needs live inventory API. |
| `DGLD` | Candidate | Real-time explorer claim; investigate API. |
| `PGOLD` | Not near-term | Gold claim, no live source identified. |
| `GGBR` | Reject | Issuer-managed gold exposure, high risk/opaque. |
| `KAG` | Watchlist | Physical silver audit; needs live inventory API. |
| `VEUR` | Not near-term | VNX audit/attestation style. |
| `EURR` | Not near-term | Grant Thornton proof page, likely periodic. |
| `EURAU` | Not near-term | AllUnity self-reported trust center. |
| `CHFAU` | Not near-term | AllUnity self-reported trust center. |
| `VCHF` | Not near-term | VNX attestation style. |
| `VGBP` | Not near-term | VNX attestation style. |
| `tGBP` | Not near-term | Tokenised GBP reserve claim, no live source identified. |
| `ZARP` | Not near-term | Kempen audit periodic PDF. |
| `CADC` | Conditional M | Dune/on-chain dashboard exists; needs API access or direct trust-account source. |
| `PHT` | Conditional M | USDT wrapper/CDP; possible only if apcxUSDT backing is contract-readable. |
| `CETES` | Watchlist | Etherfuse PoR/legal source; needs machine-readable current holdings/NAV. |
| `AID` | Not near-term | GPU financing collateral, no stable reserve API identified. |

## Recommended Next Work

1. Implement `USYC` as the next proof-to-live conversion candidate.
   - Implemented in working tree; live smoke passed.
2. Implement/clean up `FRAX`.
   - Implemented in working tree; live smoke passed with only an informational tiny unknown-exposure warning.
3. Implement `TBILL` and `USD1`.
   - Implemented in working tree; live smoke passed.
4. Keep `AUSD` and `DGLD` in research/future-candidate status until their feeds publish payload-native freshness inside the live gate.
