# Real-Time Reserve Update Sources

> Research-only memo for the live reserve composition project.
> Date: 2026-03-12
> Scope: all 156 tracked stablecoins in `shared/lib/stablecoins.ts` (shadow assets excluded).
> Method: deep notes for the decentralized batch, then full-corpus coverage by architecture batch for the remaining coins.
> This memo is still research-first. It does not prescribe implementation details coin by coin, but it now includes a short implementation-status note so the research stays aligned with the shipped system.

## Summary

Across the full tracked set, the corpus falls into five practical source buckets:

1. **Direct real-time dashboards / APIs already exposed by the issuer or protocol**: e.g. Ethena, Falcon, infiniFi, Agora, OpenEden, Reservoir, M0, Accountable-powered issuers, Mento Reserve.
2. **On-chain reserve systems that are likely adapter-able, but need protocol-specific accounting**: e.g. Liquity-family CDPs, Maker/Sky, Aave GHO, Curve crvUSD, Maple wrappers, Angle, Gyroscope, Honey, dTRINITY.
3. **Attestation / transparency pages that are scrapeable, but are not true real-time composition feeds**: e.g. Circle, Tether, Paxos, Ripple, StablR, Schuman, VNX, Monerium, Fidelity.
4. **Trivial single-asset or single-custody structures where live composition adds little**: many local-currency fiat coins and most gold / silver tokens are effectively `100% cash`, `100% gold`, or `100% silver`.
5. **Opaque / semantics-blocked cases**: some strategies publish holdings but not machine-readable composition, and some DeFi systems separate “reserve” from minting collateral.

Within the decentralized batch, the coins break into three broad buckets:

1. **Clear on-chain CDP branches**: BOLD, LUSD, meUSD, USDaf, USND, FEUSD.
2. **On-chain, but custom accounting / registry work needed**: crvUSD, satUSD, HYUSD, fxUSD, ALUSD, BtcUSD.
3. **On-chain source exists, but Pharos must first choose between "collateral mix" and protocol-native "reserve" semantics**: ZCHF, DEURO.

## Current Implementation Status

As of the current live-reserve remediation:

- Production live reserve sources now cover:
  - `iusd-infinifi` via the infiniFi protocol API
  - `m-m0`, `musd-metamask`, and `usdn-noble` via the M0 dashboard GraphQL collateral feed
  - `usdo-openeden` via OpenEden's reserve-composition API
  - `aznd-mu-digital` via the Accountable dashboard JSON feed
- The system now uses a structured `liveReservesConfig` contract (`adapter`, `version`, `semantics`, `display`, `inputs`, optional `params`) rather than the earlier minimal `adapter + url` model.
- Operational state is tracked in both:
  - `reserve_composition` for the latest successful snapshot
  - `reserve_sync_state` for the latest attempt / warnings / last success / failure state
- Circuit breakers are now per source/family (`live-reserves:<scope>`), not one global live-reserves breaker.
- The live reserve API returns resolved presentation state for live-enabled coins, including explicit bootstrap/fallback metadata.
- Product scope is still intentionally narrow: live reserves currently power the stablecoin detail-page reserve card only. Report cards, dependency map, compare copy, and portfolio analysis still use curated static reserve metadata.

Implication for this memo:

- the source-family recommendations below are still valid,
- but future candidates should be evaluated against the **current structured config + sync-state architecture**, not the original one-off InfiniFi bootstrap plan.

## Recommended Priorities

### P1: cleanest follow-ups

| Coin | Why |
|---|---|
| `bold-liquity` | Already scoped in the implementation plan; explicit ActivePool model. |
| `lusd-liquity` | Single-collateral Liquity v1; simplest possible on-chain adapter. |
| `meusd-mezo` | Official docs explicitly say collateral is viewable live and routed to `ActivePool`. |
| `usnd-nerite` | Official repo is a Liquity v2 fork with contracts, subgraph, and frontend. |
| `feusd-felix` | Official dev docs expose branch contract addresses and read functions. |
| `usdaf-asymmetry` | Liquity v2 fork; strong fit for the same adapter family as BOLD. |

### P2: likely viable, but more accounting work

| Coin | Main complication |
|---|---|
| `crvusd-curve` | Dynamic market registry and grouping many markets into Pharos buckets. |
| `satusd-river` | Omnichain CDP plus swap/vault modules create scope ambiguity. |
| `hyusd-hylo` | Solana account decoding and Sanctum-based LST valuation. |
| `fxusd-f-x-protocol` | Need net pool accounting, not just raw token balances. |
| `alusd-alchemix` | Backing sits in yield strategies and adapters, not a single vault balance. |
| `btcusd-btcfi` | Public docs confirm model, but implementation-ready contract registry was not obvious. |

### P3: source exists, but semantics decision first

| Coin | Decision required |
|---|---|
| `zchf-frankencoin` | Track aggregated minting collateral, or protocol-native reserve pool / borrower reserves? |
| `deuro-deuro` | Same issue as ZCHF; protocol docs explicitly separate "reserve" from minting collateral. |

==> In such cases, track the collateral

## Per-Coin Findings

### `bold-liquity` (`BOLD`)

- **Recommended source:** Ethereum mainnet branch `ActivePool` balances for WETH, wstETH, and rETH.
- **Adapter shape:** On-chain `eth_call` adapter.
- **Feasibility:** High.
- **Why this works:** Liquity v2 is explicitly branch-based. The official docs and repo describe `CollateralRegistry`, per-branch `TroveManager`, and `ActivePool`; the implementation plan already records concrete ActivePool addresses for the three BOLD branches.
- **Notes:** This is the template to reuse for other Liquity v2 forks.
- **Primary sources:** [Liquity BOLD docs](https://docs.liquity.org/v2-faq/bold-and-earn), [Liquity v2 repo](https://github.com/liquity/bold), [existing Pharos implementation plan](../plans/2026-03-12-real-time-reserve-composition-updater.md)

### `lusd-liquity` (`LUSD`)

- **Recommended source:** Liquity v1 `ActivePool` ETH balance, or equivalent total-system collateral read from the core contracts.
- **Adapter shape:** On-chain `eth_call` adapter.
- **Feasibility:** High.
- **Why this works:** Liquity v1 accepts ETH only. There is no live composition problem beyond reading total ETH backing and valuing it.
- **Notes:** If Pharos keeps the current semantic, the live breakdown is always `100% ETH`.
- **Primary sources:** [Liquity v1 docs](https://docs.liquity.org/liquity-v1), [borrowing docs](https://docs.liquity.org/liquity-v1/faq/borrowing)

### `crvusd-curve` (`crvUSD`)

- **Recommended source:** Curve lending market registry plus per-market collateral stats, preferably via the official lending SDK or direct on-chain reads from the market controllers/vaults.
- **Adapter shape:** On-chain or official SDK-backed adapter.
- **Feasibility:** Medium-high.
- **Why this works:** Curve’s official lending SDK can enumerate markets with `fetchMarkets()`, expose `collateral_token`, and return market stats/balances. That is enough to build a live market-level collateral mix.
- **Main complication:** Pharos currently groups many markets into coarse buckets (`WBTC/cbBTC`, `tBTC`, `wstETH/sfrxETH/weETH`, `ETH`). A live adapter must map each live market into those buckets or intentionally move to a finer-grained display.
- **Primary sources:** [Curve lending JS](https://github.com/curvefi/curve-lending-js), [Curve stablecoin repo](https://github.com/curvefi/curve-stablecoin)

### `satusd-river` (`satUSD`)

- **Recommended source:** River’s per-chain deployed contract set (`BorrowerOperationsFacet`, `TroveManagerProxy`, `StabilityPoolFacet`, collateral contracts), aggregated across supported source chains.
- **Adapter shape:** On-chain multi-chain adapter.
- **Feasibility:** Medium.
- **Why this works:** River publishes deployed contracts by chain, including collateral-specific `TroveManagerProxy` contracts. The docs clearly describe Omni-CDP minting against BTC, ETH, BNB, and LST collateral.
- **Main complication:** River also documents a 1:1 stablecoin swap module and Smart Vault module that mint satUSD internally. Pharos needs to decide whether "reserve composition" should mean:
  - only Omni-CDP collateral, or
  - the full satUSD system balance sheet including swap vault assets and Smart Vault exposures.
- **Primary sources:** [River docs](https://docs.river.inc/), [Omni CDP](https://docs.river.inc/how-to-use/omni-cdp), [BNB deployed contracts example](https://docs.river.inc/outro/deployed-contracts/bnb-chain), [Smart Vault](https://docs.river.inc/products/smart-vault)

### `hyusd-hylo` (`HYUSD`)

- **Recommended source:** Solana program accounts for the Hylo exchange/collateral pool, plus the accepted LST mint set and Sanctum-based LST valuation logic.
- **Adapter shape:** Solana on-chain adapter.
- **Feasibility:** Medium.
- **Why this works:** Hylo’s docs say hyUSD is backed by a collateral pool of Solana LSTs, and that NAV uses the exact staked-SOL amount per LST through Sanctum rather than a simple oracle price.
- **Main complication:** This is not an EVM `balanceOf` job. The adapter will need account decoding for Hylo program state and an explicit mapping from reserve holdings to LST symbols.
- **Primary sources:** [Hylo protocol overview](https://docs.hylo.so/protocol-overview), [Collateral pool docs](https://docs.hylo.so/protocol-overview/collateral-pool-a-basket-of-LST), [risk management](https://docs.hylo.so/protocol-overview/risk-management), [onchain addresses](https://docs.hylo.so/security/onchain-addresses)

### `meusd-mezo` (`meUSD`)

- **Recommended source:** Mezo `ActivePool` BTC collateral balance, or the official Mezo explorer if it exposes the same data cleanly.
- **Adapter shape:** On-chain adapter, with explorer as a secondary display/source reference.
- **Feasibility:** High.
- **Why this works:** Mezo’s developer docs explicitly state BTC is routed to `ActivePool`, and the user docs say collateral can be viewed live on the Mezo explorer.
- **Notes:** The external docs use `MUSD`; Pharos metadata currently uses `meUSD`. Treat this as the same product at implementation time.
- **Primary sources:** [MUSD overview](https://mezo.org/docs/users/musd/), [MUSD developer guide](https://mezo.org/docs/developers/musd/)

### `usdaf-asymmetry` (`USDaf`)

- **Recommended source:** Per-collateral Liquity v2 branch `ActivePool` balances, grouped into the current Pharos buckets.
- **Adapter shape:** On-chain Liquity-v2-family adapter.
- **Feasibility:** High.
- **Why this works:** The docs explicitly say USDaf is built on Liquity v2, remains overcollateralized, and has separate borrow markets / Stability Pools for its collateral set.
- **Main complication:** In this research pass, I did not find an official public contract-address page as explicit as Felix’s. Address discovery will likely need the frontend deployment JSON or repo artifacts.
- **Primary sources:** [What is USDaf?](https://docs.asymmetry.finance/usdaf-stablecoin/what-is-usdaf), [peg docs](https://docs.asymmetry.finance/usdaf-stablecoin/how-does-usdaf-maintain-peg), [borrowing](https://docs.asymmetry.finance/usdaf-stablecoin/borrowing-usdaf), [risks](https://docs.asymmetry.finance/usdaf-stablecoin/risks)

### `usnd-nerite` (`USND`)

- **Recommended source:** Nerite’s per-branch `ActivePool` balances, ideally using the official subgraph if it is already maintained, otherwise direct on-chain reads.
- **Adapter shape:** On-chain or subgraph-backed Liquity-v2-family adapter.
- **Feasibility:** High.
- **Why this works:** Nerite’s docs describe separate Stability Pools per collateral asset, and the official repo states it is a Liquity v2 fork with contracts, subgraph, and frontend.
- **Notes:** This looks like one of the best non-BOLD candidates because the official repo already acknowledges a subgraph/indexing layer.
- **Primary sources:** [Nerite docs](https://docs.nerite.org/), [borrowing and liquidations](https://docs.nerite.org/docs/user-docs/borrowing-and-liquidations), [USND & Earn](https://docs.nerite.org/docs/user-docs/usnd-and-earn), [Nerite repo](https://github.com/NeriteOrg/nerite)

### `alusd-alchemix` (`ALUSD`)

- **Recommended source:** Mainnet Alchemist v2 contracts and strategy adapter balances, with optional use of Alchemix’s own indexing/subgraph layer if available.
- **Adapter shape:** On-chain strategy-accounting adapter.
- **Feasibility:** Medium.
- **Why this works:** Alchemix documents that collateral deposits are invested into yield strategies and that harvested yield flows through the Transmuter. The official repo publishes mainnet deployments and contract artifacts.
- **Main complication:** The backing is not held as plain DAI/USDC/USDT balances. It sits in Yearn/Aave/adapter positions, so a live adapter must either:
  - value wrapper shares directly, or
  - unwrap them to underlying stablecoins for a cleaner Pharos treemap.
- **Primary sources:** [Alchemist docs](https://v2-docs.alchemix.fi/alchemix-ecosystem/alchemist), [Transmuter docs](https://v2-docs.alchemix.fi/alchemix-ecosystem/transmuter), [Alchemix protocol repo](https://github.com/alchemix-finance/alchemix-protocol)

### `feusd-felix` (`FEUSD`)

- **Recommended source:** Felix branch `ActivePool` balances, using the official developer docs as the contract registry.
- **Adapter shape:** On-chain Liquity-v2-family adapter.
- **Feasibility:** High.
- **Why this works:** Felix’s developer docs publish branch-by-branch contract addresses and read functions, including `Active Pool` addresses and a `collBalance` read for total collateral balance.
- **Notes:** This is the cleanest documented candidate after BOLD and LUSD.
- **Primary sources:** [Felix dev docs](https://usefelix.gitbook.io/docs/developers/market-1-feusd-cdp), [Felix overview](https://usefelix.gitbook.io/docs/lending-products/quickstart/how-it-works)

### `btcusd-btcfi` (`BtcUSD`)

- **Recommended source:** Likely the BTCFi/Bifrost on-chain trove system on Bifrost, but this needs contract discovery first.
- **Adapter shape:** On-chain adapter, probably Bifrost-specific.
- **Feasibility:** Medium-low.
- **Why this still looks possible:** Official docs confirm BtcUSD is minted against BTC collateral and that collateral can come from multiple source networks.
- **Main complication:** In this pass, the English docs did not surface a clean public contract registry or read-function page comparable to River or Felix. Implementation would likely require either:
  - frontend bundle/API inspection, or
  - direct repo / explorer work to recover the live contract graph.
- **Primary sources:** [BTCFi docs](https://docs.bifrostnetwork.com/eng.btcfi.one), [Mint BtcUSD](https://docs.bifrostnetwork.com/eng.btcfi.one/dashboard/3.-mint-btcusd)

### `zchf-frankencoin` (`ZCHF`)

- **Recommended source:** Official Frankencoin position indexing layer (`MintingHub` + `Position` contracts), potentially via the project’s own API/indexer rather than raw chain scans.
- **Adapter shape:** Indexer-backed on-chain adapter.
- **Feasibility:** Medium.
- **Why this works:** Frankencoin’s site states the backing assets are publicly visible on-chain. The official org exposes smart contracts, a web app, an `@frankencoin/api` package, and a `ponder` indexing service.
- **Main complication:** Frankencoin’s own docs explicitly say minting collateral is **not** the same thing as the protocol "reserve." Pharos must choose whether live data should track:
  - aggregated open-position collateral composition, which matches the current Pharos `reserves` field better, or
  - Frankencoin’s native reserve framework (borrower reserves + reserve pool + bridged stablecoins).
- **Primary sources:** [Frankencoin docs overview](https://docs.frankencoin.com/), [positions](https://docs.frankencoin.com/positions), [reserve](https://docs.frankencoin.com/reserve), [Frankencoin site](https://www.frankencoin.com/), [Frankencoin GitHub org](https://github.com/Frankencoin-ZCHF)

### `fxusd-f-x-protocol` (`fxUSD`)

- **Recommended source:** Official short-pool / manager contracts, with wstETH and WBTC pools as the core live backing view.
- **Adapter shape:** On-chain pool-accounting adapter.
- **Feasibility:** Medium.
- **Why this works:** The docs say fxUSD only uses wstETH and WBTC collateral, and the developer docs expose the protocol’s short-pool and credit-note accounting model.
- **Main complication:** Unlike a simple CDP, the relevant live reserve number is likely a net pool state after accounting for debts / credit notes / stability pool interactions, not just raw token balances in one contract.
- **Primary sources:** [fxMINT docs](https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/fxmint-borrowing-fxusd-against-your-btc-and-eth), [stability pool](https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool), [credit notes](https://fxprotocol.gitbook.io/fx-docs/developers/processing-the-rebalances-and-liquidations/creditnotes)

### `deuro-deuro` (`DEURO`)

- **Recommended source:** The dEURO position system plus any bridge/reserve contracts that the protocol counts as reserve.
- **Adapter shape:** Indexer-backed on-chain adapter.
- **Feasibility:** Medium.
- **Why this works:** Official docs say all collateral, debt positions, and liquidations are visible on-chain, and the protocol documents both the position system and the separate reserve framework.
- **Main complication:** Same as ZCHF, but more explicit: the docs say the collateral used to mint dEURO is **not** considered reserve on the protocol’s own balance sheet. Pharos should decide whether the live treemap is meant to reflect:
  - user-position collateral composition, or
  - dEURO’s protocol-native reserve accounting.
- **Primary sources:** [dEURO positions](https://docs.deuro.com/positions.html), [dEURO reserve](https://docs.deuro.com/reserve.html), [dEURO site](https://www.deuro.com/index.html)

## Practical Family Reuse

These groups can probably share adapter families:

| Family | Coins | Likely reusable approach |
|---|---|---|
| Liquity v2 branch adapters | `bold-liquity`, `usdaf-asymmetry`, `usnd-nerite`, `feusd-felix` | Read `ActivePool` per branch, fetch prices, aggregate to slices |
| Liquity v1 / Threshold-style single-asset | `lusd-liquity`, `meusd-mezo` | Read single `ActivePool` collateral balance and price |
| Position-registry / oracle-free | `zchf-frankencoin`, `deuro-deuro` | Index open positions by collateral type, then decide whether to augment with protocol reserve data |
| Custom market registries | `crvusd-curve`, `fxusd-f-x-protocol` | Enumerate markets / pools from official registry and compute net collateral value per market |

Implementation note: the current Pharos config/runtime can already express `http-json`, `http-html`, `indexer`, and `onchain-evm` source inputs, plus explicit `semantics` and `breakerScope`. Non-EVM live sources still need adapter/runtime work beyond the current implementation.

## Current Recommendation

With `iusd-infinifi` now implemented, the next decentralized candidates with the lowest engineering risk remain:

1. `bold-liquity`
2. `lusd-liquity`
3. `feusd-felix`
4. `usnd-nerite`
5. `meusd-mezo`
6. `usdaf-asymmetry`

Those six have the strongest combination of:

- documented on-chain architecture,
- relatively direct collateral accounting,
- and low ambiguity about what "reserve composition" should mean.

From the current implementation point of view, they also fit the system best because they map naturally onto the newly generalized source model:

- structured per-coin inputs
- explicit `semantics`
- per-family circuit scopes
- per-coin sync-state monitoring

The main coins I would avoid implementing before a narrower scope decision are:

- `satusd-river`
- `zchf-frankencoin`
- `deuro-deuro`
- `alusd-alchemix`

The blocker for those is not lack of data. It is deciding which balance-sheet definition Pharos wants to show.

## Full-Corpus Coverage

The remaining 142 tracked coins are covered here in batch form. For exact per-coin coverage status, see the companion tracker: [live-reserve-source-research-tracker.md](../tasks/live-reserve-source-research-tracker.md).

### Batch 2 — `rwa-backed` + `centralized`

- **Good live/dashboard candidates:** `usdy-ondo-finance`, `ausd-agora`, `m-m0`, `musd-metamask`, `usdn-noble`, `pmusd-precious-metals`, `usdz-anzen`, `usdo-openeden`, `aznd-mu-digital`, `usdm-moneta`, `tusd-trueusd`, `dgld-gold-token-sa`.
  Source pattern: official dashboards, oracle feeds, or reserve portals that already look machine-readable enough for a worker adapter.
  Assessment: high-confidence research targets after the decentralized batch.
- **Transparency / attestation pages, but not true real-time composition:** `buidl-blackrock`, `ousg-ondo-finance`, `ustb-superstate`, `mtbill-midas`, `tbill-openeden`, `fidd-fidelity`, `rlusd-ripple`, `usdt-tether`, `usdc-circle`, `pyusd-paypal`, `usdg-paxos`, `usd1-world-liberty-financial`, `fdusd-first-digital`, `eurc-circle`, `eurcv-societe-generale-forge`, `usdcv-societe-generale-forge`, `euri-banking-circle`, `usdp-paxos`, `gusd-gemini`, `xusd-straitsx`, `mnee-mnee`, `sbc-brale`, `usdr-stablr`, `eurr-stablr`, `europ-schuman`, `eurq-quantoz`, `eurau-allunity`, `veur-vnx`, `eure-monerium`, `xsgd-straitsx`, `audd-novatti`, `gyen-gyen`, `zarp-zarp`, `brz-transfero`, `usdq-quantoz`, `usdx-hex-trust`, `usdh-native-markets`, `usdtb-ethena`, `usyc-hashnote`, `ylds-figure`.
  Source pattern: issuer transparency pages, reserve attestations, PDF holdings packs, or regulated trust-center pages.
  Assessment: useful for static/manual refreshes or last-known-good baselines, but usually not true live composition sources.
- **Trivial single-asset / no meaningful composition:** `a7a5-old-vector`, `aeur-anchored-coins`, `axcnh-anchorx`, `idrt-rupiah-token`, `jpyc-jpyc`, `tryb-bilira`, `vchf-vnx`, `vgbp-vnx`, `tgbp-tokenised`, `cadc-cad-coin`, `eurs-stasis`, `xaut-tether`, `paxg-paxos`, `kau-kinesis`, `xaum-matrixdock`, `cgo-comtech`, `pgold-pleasing`, `ggbr-goldfish-gold`, `kag-kinesis`.
  Source pattern: fiat bank balances or vaulted bullion.
  Assessment: even when an attestation exists, a live treemap would usually collapse to a single slice, so implementation value is low.
- **Custom / unclear / later research:** `u-united-stables`, `avusd-avant`, `cash-phantom`, `cgusd-cygnus-finance`, `zeusd-zoth`, `usat-tether`, `usdgo-osl`, `usda-anzens`, `pusd-plume`, `wusd-worldwide`, `aid-gaib`, `apxusd-apyx`, `gusd-gate`.
  Source pattern: issuer sites or on-chain vaults exist, but I did not find a clearly exposed live composition feed in this pass.
  Assessment: medium-to-low priority follow-up research.

### Batch 3 — `rwa-backed` + `centralized-dependent`

- **Strong live/on-chain candidates:** `cusd-cap`, `frxusd-frax`, `wsrusd-reservoir`, `syrupusdc-maple`, `syrupusdt-maple`, `jupusd-jupiter`, `usdm-mega`.
  Source pattern: protocol reserve portals, ERC-4626 / vault accounting, or parent-rail reserve dashboards.
  Assessment: good candidates. `syrupUSDC` and `syrupUSDT` especially look like adapter-able wrapper products because `totalAssets` and underlying Maple pool data should be derivable on-chain.
- **Medium-confidence / partial-source candidates:** `frax-frax`, `usd0-usual`.
  Source pattern: treasury-wrapper compositions and affiliated protocol dashboards.
  Assessment: likely possible, but composition semantics need to be pinned down before implementation.
- **Low-confidence / blocked for now:** `usdai-usd-ai`, `pusd-pleasing`, `isc-international-stable-currency`.
  Source pattern: issuer docs exist, but I did not find a clean public live reserve feed or machine-readable holdings source.
  Assessment: low priority until the easier reserve dashboards are exhausted.

### Batch 4 — `crypto-backed` + `centralized-dependent`

- **Direct dashboard / transparency candidates:** `usde-ethena`, `usdf-falcon`, `usr-resolv`, `iusd-infinifi`, `reusd-re-protocol`, `usdu-unitas`, `usn-noon`, `eusd-electronic-usd`, `nusd-neutrl`, `yzusd-yuzu`, `usdd-tron-dao-reserve`, `dola-inverse-finance`, `eura-angle`.
  Source pattern: official transparency dashboards, protocol analytics pages, or Accountable/Chaos-style reserve portals.
  Assessment: strongest non-decentralized crypto-backed group after `iusd-infinifi`.
- **Likely on-chain custom adapters:** `usds-sky`, `dai-makerdao`, `gho-aave`, `usda-avalon`, `usx-solstice`, `lisusd-lista`, `reusd-resupply`, `honey-berachain`, `gyd-gyroscope`, `nect-beraborrow`, `buck-bucket-protocol`, `msusd-metronome`, `ebusd-ebisu`, `hollar-hydrated`, `uusd-youves`, `ousd-origin-protocol`, `usdu-usdu-finance`, `dusd-dtrinity`, `mim-abracadabra`, `susd-synthetix`.
  Source pattern: CDP vaults, facilitator buckets, AMO reserves, ERC-4626 vault shares, or protocol treasuries on-chain.
  Assessment: feasible, but each needs protocol-specific accounting rather than a single generic adapter.
- **Opaque or mixed strategy books:** `usdf-astherus`, `dusd-standx`, `rwausdi-multipli`, `uty-xsy`, `msusd-main-street`, `usp-pikudao`, `pht-pht`, `yousd-yield-optimizer`, `usdb-blast`.
  Source pattern: CEX custody, delta-neutral books, managed strategy baskets, or blended custodial/on-chain setups.
  Assessment: these need a product-by-product decision on whether Pharos wants true holdings composition, wrapper composition, or just “strategy buckets.”

### Batch 5 — `crypto-backed` + `centralized`

- **Single clear candidate:** `yusd-aegis`.
  Source pattern: official Accountable dashboard.
  Assessment: high-confidence real-time candidate, even though the underlying strategy is off-exchange delta-neutral BTC basis rather than plain on-chain collateral.

### Batch 6 — `algorithmic` + `centralized-dependent`

- **High-confidence live reserve candidates:** `cusd-celo`, `ceur-celo`.
  Source pattern: Mento’s live reserve portal (`reserve.mento.org`) and on-chain reserve balances.
  Assessment: these are among the cleanest live sources outside the decentralized and Accountable-style cohorts.
- **No meaningful live reserve composition target:** `fpi-frax`.
  Source pattern: FRAX-backed AMO system rather than a clean reserve portal with composition slices.
  Assessment: low implementation value for a live treemap unless Pharos explicitly wants to model the FRAX/AMO system as backing rather than treat FPI as a derived index product.

## Portfolio-Level Takeaways

- **Best next source families after `infinifi`:** Liquity-family CDPs, Accountable dashboards, Mento reserve pages, M0 dashboards, Reservoir reserves, and issuer reserve pages that already expose structured holdings.
- **Most common blocker across centralized issuers:** attestations are common; machine-readable live composition is rare.
- **Most common blocker across crypto-backed hybrids:** the data exists, but the protocol accounting is custom enough that each adapter will need its own balance-sheet definition.
- **Lowest-value implementation targets:** local-currency fiat coins and bullion tokens whose live composition would almost always remain a single slice.
