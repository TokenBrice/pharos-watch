# Stablecoin Gap Scan - 2026-04-20

## Scope

Goal: find current stablecoins above roughly $1M market cap that Pharos is not actively tracking and that could be supported without bespoke supply overrides.

Pharos baseline at scan time:

- 191 registry entries, 180 active and 11 pre-launch.
- 139 entries with `llamaId`.
- 175 entries with `geckoId`.
- 147 entries with `liveReservesConfig`.
- Dead/cemetery entries were treated as explicit exclusions even when CoinGecko, CoinMarketCap, or DefiLlama still reported market cap.

Sources checked:

- DefiLlama stablecoin list and detail endpoints:
  `https://stablecoins.llama.fi/stablecoins?includePrices=true`
  and `https://stablecoins.llama.fi/stablecoin/{id}`.
- CoinGecko Pro `/coins/markets?category=stablecoins`, `/coins/{id}`, `/simple/price`, and `/search`.
- CoinMarketCap stablecoin category:
  `/v1/cryptocurrency/category?id=604f2753ebccdd50cd175fc1&limit=500&convert=USD`.
- Issuer and project sources linked in the candidate tables below.
- RWA.xyz, StablecoinWatch, and source-specific searches for non-CG/DL coverage.

## Filter Results

Raw source signal:

- DefiLlama returned 360 stablecoin rows. 70 had more than $1M circulating USD and no local `llamaId` match. After removing assets already represented by local `geckoId`, obvious same-asset collisions, and cemetery hits, 33 remained.
- CoinGecko stablecoin category returned 398 rows. 93 had more than $1M market cap and no local `geckoId` match. Most were wrappers, receipt tokens, dead assets, or same-symbol variants.
- CoinMarketCap stablecoin category returned 264 rows. It was useful mainly for large assets outside CoinGecko's stablecoin category, especially `sUSDe`, `USDT0`, and `BFUSD`.

Main exclusion buckets:

- Already tracked base assets or chain variants: Noble USDC, USDC.e, Aave/Venus receipt tokens, chain-specific MIM rows, DAI on PulseChain, and bridged USDT rows.
- Cemetery or wind-down rows still present upstream: BUSD, Binance-Peg BUSD, deUSD, GYD, USDL, USPD, Stables Labs USDX, syUSD, RAI, EURA, VAI, FEI, HUSD, USTC, USDN, BEAN, and similar. USD+ is a special conflict case: local cemetery says abandoned, while current external sources show active supply and pricing.
- Non-stable receipts or LP shares: Curve FRAX/USDC LP, Nest Alpha Vault LP, lending market receipt tokens.
- Large but unsupported/non-transferable products: BFUSD.

## Highest Confidence Additions

These look supportable today by existing Pharos data paths and have enough public reserve or redemption material to justify a normal research packet.

| Candidate | Size signal | Why it is supportable | Reserve/redemption support | Implementation notes |
| --- | ---: | --- | --- | --- |
| `susde-ethena` / Ethena Staked USDe | ~$3.2B CG/CMC | CoinGecko id `ethena-staked-usde`; EVM contracts on Ethereum and multiple L2s; base `USDe` already tracked. | Ethena docs describe sUSDe as staking USDe into an ERC-4626-style contract, redeemable back to USDe, with a 7-day cooldown in the documented flow. Source: https://docs.ethena.fi/solution-design/staking-usde | Best modeled as NAV/yield wrapper with `pegReferenceId: "usde-ethena"`, `detailProvider: "coingecko"`, `navToken: true`, live reserve via existing `erc4626-single-asset` or validated-static wrapper, redemption backstop to USDe with cooldown. |
| `jusd-jiritsu` / JUSD | ~$106M CG | CoinGecko id `jusd`; BSC and Polygon contracts; price, market cap, and history available. | Jiritsu says the portfolio primarily consists of Franklin Templeton U.S. Treasury-backed tokenized instruments, with 24/7 USDC mint/redeem, BNY Mellon, Franklin Templeton, and PwC roles. Source: https://www.jiritsu.network/tokens/jusd | Add as RWA-backed USD minor. Live reserve support probably needs issuer/API or validated-static first; redemption backstop can be `offchain-issuer`/stablecoin-redeem with eligibility constraints. |
| `usdon-ondo` / Ondo U.S. Dollar Token | ~$68M CG/CMC | CoinGecko id `ondo-u-s-dollar-token`; Ethereum and BSC contracts; price and market cap available. | Ondo docs describe USDon as backed 1:1 by dollars in a Global Markets brokerage account and swappable 1:1 with USDC through the platform flow. Source: https://docs.ondo.finance/ondo-global-markets/available-assets | Add as centralized/RWA USD minor. Need confirm contract addresses from official docs/explorers. Reserve sync likely starts curated until an Ondo/Global Markets transparency feed exists. |
| `ausdt-tether-alloy` / Alloy Tether aUSDT | ~$50M CG | CoinGecko id `alloy-tether`; Ethereum contract; price, market cap, and history available. | Alloy docs say aUSDT is minted against XAUT collateral, tracked through on-chain vaults, with mint/return fees and a 75% liquidation point. Source: https://docs.alloy.tether.to/faqs | Strong candidate for on-chain reserve sync. Model as crypto/commodity-backed USD, dependency on `xaut-tether`, collateral-redeem route with KYC/whitelist constraints. |
| `usdsui-sui` / Sui Dollar USDsui | ~$44M DL | DefiLlama id `373`; price/supply/depeg can use the normal DefiLlama path; Sui chain is already in `shared/lib/chains.ts`. | DefiLlama describes Bridge/Stripe mint and redemption: deposit USD through Bridge, hold cash and Treasuries, burn on redemption. Bridge docs expose reserve allocation concepts. Sources: https://defillama.com/stablecoin/sui-dollar and https://apidocs.bridge.xyz/platform/issuance/reserves | Add with `llamaId: "373"` and `geckoId: "usdsui"` if CoinGecko history is adequate. Live reserves may need a Bridge/Open Issuance adapter or curated-validated fallback. |
| `brlv-crown` / Crown BRLV | ~$44M CG; Crown site shows about R$223M issued | CoinGecko id `crown-brlv`; Base and Ethereum contracts; BRL peg fits existing non-USD support. | Crown says BRLV is 1:1 BRL, backed by Brazilian federal bonds in a bankruptcy-remote reserve structure, with reserve figures on the site. Source: https://www.crown-brlv.com/ | Good non-USD candidate. Needs BRL peg config, reserve source review, and possibly a simple live reserve adapter if the reserve endpoint behind "Ver reservas" is machine-readable. |
| `sfrxusd-frax` / Frax Staked frxUSD | ~$45M CG/CMC | CoinGecko id `staked-frax-usd`; base `frxusd-frax` already tracked. | Frax docs describe sfrxUSD as an ERC4626-like yielding token fully redeemable for frxUSD at an increasing rate. Source: https://docs.frax.com/protocol/assets/frxusd/sfrxusd | Similar implementation shape to sUSDe: NAV wrapper, dependency on `frxusd-frax`, likely `erc4626-single-asset` live reserve. |
| `cusdo-openeden` / OpenEden Compounding OpenDollar | ~$25M CG simple price | CoinGecko id `compounding-open-dollar`; base `usdo-openeden` already tracked. | OpenEden docs describe cUSDO as the non-rebasing wrapped version of USDO, with USDO collateralized by T-bills/tokenized treasuries and redeemable by eligible users for USDC. Source: https://docs.openeden.com/usdo/faq | Add as NAV wrapper with dependency on `usdo-openeden`; likely existing wrapper/reserve patterns apply. |
| `scrvusd-curve` / Savings crvUSD | ~$26M CG/CMC | CoinGecko id `savings-crvusd`; base `crvusd-curve` already tracked. | Wrapper around crvUSD savings exposure; price/history available from CoinGecko. | Needs a short source pass against Curve docs/contracts before implementation. Likely straightforward NAV wrapper plus `erc4626-single-asset` or validated-static reserve. |
| `audm-macropod` / Macropod AUDM | ~$3.7M DL/CG | DefiLlama id `334`; CoinGecko id `macropod`; AUD peg fits existing non-USD support. | Macropod says AUDM is 1:1 AUD backed, held in trust at a major Australian bank, with mint/redeem through the platform and no minimum redemption. Source: https://www.macropod.com/product/audm | Good small non-USD candidate. Ethereum/Solana material supply is supportable; Redbelly chain support can wait unless it becomes material. |
| `usdglo-glo` / Glo Dollar | ~$1.8M DL/CG | DefiLlama id `155`; CoinGecko id `glo-dollar`; chains mostly already supported. | Glo/Brale publish monthly attestations and daily self-reported reserves; February 2026 report shows cash/cash-equivalents plus U.S. government-backed debt. Sources: https://www.glodollar.org/articles/attestations and https://brale.xyz/assets/reports/USDGLO-Glo-Dollar-Reserve-Attestation-Report-02-2026.pdf | Below normal $5M soft threshold, but reserve evidence is strong and Mento/cUSD already has USDGLO reserve dependency references. |

## JUSD Blocker

The originally proposed `JUSD` needs to stay out of the active registry until identity and price coverage are resolved.

- CoinGecko id `jusd` is not Jiritsu JUSD. It resolves to a separate `jusd.app` token with BSC contract `0xbf3950db0522a7f5caa107d4cbbbd84de9e047e2` and Polygon contract `0x0ba8a6ce46d369d779299dedade864318097b703`.
- Jiritsu's official token appears to be BSC `0xfd1479d46c9709ac80e31f3e9613a25c4219d2bb`, but it has no usable CoinGecko, CoinMarketCap, DefiLlama, DefiLlama coins, or DexScreener price surface in this scan.
- Because Pharos would not be able to fetch a price or detect depegs for the Jiritsu token through existing paths, adding it now would violate the support bar.

## Wrapper And NAV Candidates

These are not flat payment stablecoins, but they fit Pharos' existing NAV/yield-bearing precedent if modeled explicitly with `navToken: true`, base-asset dependencies, and no double counting against the base asset.

| Candidate | Size signal | Support path | Main review item |
| --- | ---: | --- | --- |
| `susds-sky` / Savings USDS | Stablewatch source check: about $6.35B | Base `usds-sky` already tracked; Pyth has an `sUSDS` feed. Sky docs describe rate/savings mechanics. Sources: https://www.stablewatch.io/analytics/assets/sUSDS-Sky, https://developers.sky.money/core-protocol/susds/, and rate docs: https://developers.sky.money/deep-dives/rate-mechanism/ | High priority wrapper if Pharos wants the full Sky savings surface. RedStone returned no `sUSDS` price in this scan, so use Pyth/Sky on-chain rate rather than symbol-only RedStone. |
| `sdai-sky` / Savings DAI | CMC source check: large legacy savings wrapper | Base `dai-makerdao` already tracked; Pyth and RedStone both returned `sDAI` prices in this scan. Source: https://coinmarketcap.com/currencies/savings-dai/ | Legacy wrapper likely declining as USDS migration continues. Needs explicit naming to avoid local fuzzy collisions with `usdai-usd-ai` and `susdai-usd-ai`. |
| `susde-ethena` / Ethena Staked USDe | ~$3.2B CG/CMC | Already listed above as a high-confidence addition; Pyth and RedStone both returned `sUSDe` prices. | Must avoid double-counting `USDe` supply and should display as NAV wrapper, not as a $1 peg. |
| `sfrxusd-frax` / Frax Staked frxUSD | ~$45M CG/CMC | Already listed above; Pyth returned an `sfrxUSD` feed. | Smaller than Sky/Ethena wrappers but straightforward because `frxusd-frax` is tracked. |
| `cusdo-openeden` / OpenEden Compounding OpenDollar | ~$25M CG simple price | Already listed above; base `usdo-openeden` is tracked. | Confirm contracts from official OpenEden docs before adding. |
| `scrvusd-curve` / Savings crvUSD | ~$26M CG/CMC | Already listed above; base `crvusd-curve` is tracked. | Needs Curve source review before implementation. |
| `syusd-aegis` / Staked YUSD | ~$12.9M CG | CoinGecko id `staked-yusd`; base `yusd-aegis` already tracked. | Same-symbol collision with dead Synnax `syUSD`. Aegis docs describe ERC-4626-style staking with 7-day cooldown. Source: https://docs.aegis.im/tokens/syusd-stablecoin |

## Tokenized Money-Market Fund Candidates

These are large, stable-NAV RWA instruments rather than stablecoins. They are plausible Pharos NAV-token candidates, but adding them would introduce or formalize an RWA/NAV source surface beyond the normal CoinGecko/DefiLlama stablecoin intake. That means docs/about updates and likely a dedicated source adapter.

| Candidate | Size signal | Why it may fit | Blocker |
| --- | ---: | --- | --- |
| `jtrsy-janus-henderson` / JTRSY | RWA.xyz: about $1.49B total asset value, NAV around $1.10 | Short-term U.S. T-bill fund, USDC subscriptions/redemptions, on-chain AUM. Source: https://app.rwa.xyz/assets/JTRSY | Professional-investor fund share, not a payment stablecoin. Needs RWA.xyz or issuer NAV ingestion. |
| `benji-franklin` / BENJI | RWA.xyz: about $968M, $1 NAV | Franklin OnChain U.S. Government Money Fund share represented by BENJI. Source: https://app.rwa.xyz/assets/BENJI | Permissioned mutual-fund share; no standard CG/DL market price path. |
| `wtgxx-wisdomtree` / WTGXX | RWA.xyz source check: about $864M | WisdomTree government money-market digital fund with stable NAV target. Source: https://www.wisdomtreeconnect.com/digital-funds/money-market/wtgxx | Needs issuer/RWA NAV ingestion and fund-share taxonomy. |
| `eutbl-spiko` / EUTBL and `ustbl-spiko` / USTBL | RWA.xyz source check: EUTBL about $983M, USTBL about $153M | Regulated Spiko money-market fund tokens with daily redemptions. Source: https://www.spiko.io/ | EUTBL is EUR-denominated, so native NAV plus FX treatment must be explicit. |
| `stbt-matrixdock` / STBT | Matrixdock page: about 105M STBT supply and $105M reserve NAV during this scan | Matrixdock publishes supply, reserves NAV, composition, and T+0/T+1 redemption quota. Source: https://www.matrixdock.com/stbt | RWA.xyz and issuer supply differed in subagent checks; reconcile before adding. |

## Good Watchlist

These are probably supportable, but need more review before becoming normal add candidates.

| Candidate | Size signal | Support path | Main review item |
| --- | ---: | --- | --- |
| `djed-coti` / Djed | ~$3.4-4.0M DL/CG | DefiLlama id `93`, CoinGecko id `djed`; Cardano chain already exists. | Active algorithmic/crypto-backed taxonomy is tricky because registry guidance currently avoids active standalone `algorithmic` entries. Djed docs describe overcollateralized reserves and protocol redemption. Source: https://docs.stability.nexus/stablecoins/djed-overview/how-the-protocol-works |
| `audf-forte` / Forte AUD | ~$3.6M CG | CoinGecko id `forte-aud`; EVM contracts. | Looks like a regulated AUD stablecoin with audit reports, but needs issuer/legal review and chain mapping. Source: https://www.forteaud.com/ |
| `cngn-compliant-naira` / cNGN | ~$2.0M CG | CoinGecko id `compliant-naira`; EVM/Solana contracts. | Good Naira-peg candidate if Pharos wants NGN coverage; need FX peg support and reserve verification. Terms describe 1:1 Naira backing and KYC redemption. Source: https://cngn.co/terms-and-condition |
| `krwq-krwq` / KRWQ | ~$1.3M CG | CoinGecko id `krwt`; Ethereum/Base contracts. | Potential first KRW stablecoin candidate, but official reserve docs are thin; source review needed. Source: https://www.krwq.cash/ |
| `mai-qi-dao` / MAI miMATIC | ~$12M CG | CoinGecko id `mimatic`; contracts across Polygon/Gnosis/etc. | Older DeFi stablecoin with price/supply support, but reserve/backstop quality is weaker than the RWA/wrapper candidates. |
| `usd-plus-overnight` / Overnight USD+ | ~$8M DL, ~$40M+ CG/StablecoinWatch depending source | DefiLlama id `46`; CoinGecko simple price id `usd`; RedStone returned `USD+` in this scan. | Conflict: `shared/data/dead-stablecoins.json` marks USD+ as abandoned in 2025, but current Overnight docs, RedStone, CG, and StablecoinWatch show active supply/pricing. Needs a focused cemetery-vs-current re-audit before any add. Sources: https://docs.overnight.fi/user-guides/mint-redeem and https://docs.overnight.fi/core-concept/overnight-tokens%2B |
| `doc-money-on-chain` / Dollar on Chain | ~$4.7-5.2M DL/CG | DefiLlama id `30`; CoinGecko id `dollar-on-chain`; Rootstock chain exists. | BTC-collateral model is supportable, but reserve/live adapter and Rootstock redemption details need review. |
| `bnusd-balanced` / Balanced Dollars | ~$2.8M DL/CG | DefiLlama id `204`; CoinGecko id `balanced-dollars`. | ICON/Archway support and reserve accounting need review before adding. |

## Do Not Add From This Scan

| Asset | Source size signal | Reason |
| --- | ---: | --- |
| BFUSD | ~$1.3B CG/CMC | Binance calls it a reward-bearing margin asset for Futures users, not a normal on-chain stablecoin. It is internal to Binance, has redemption delays in stress, and cannot support Pharos contract/reserve surfaces cleanly. Source: https://academy.binance.com/hr-HR/articles/what-is-bfusd |
| USDT0 | ~$4.1B CG, CMC category | Already folded into local `usdt-tether`: the USDT entry says supply figures include USDT0, and blacklist/liquidity docs already special-case USDT0. Do not add as a new canonical stablecoin unless the product decision changes to first-class wrapper rows. Source: https://www.superchain.eco/projects/usdt0 |
| Binance USD / Binance-Peg BUSD | ~$40M-$280M upstream | BUSD is already in the cemetery. Paxos halted new minting in 2023 and redeemability through Paxos was time-limited. Source: https://www.paxos.com/newsroom/paxos-will-halt-minting-new-busd-tokens |
| Lift Dollar USDL | ~$9M DL | Already in the cemetery. Paxos announced wind-down, stopped new minting, stopped rebasing, and converted remaining balances to USDG. Source: https://www.paxos.com/newsroom/winding-down-usdl-lift-dollar |
| Elixir deUSD | ~$92M DL but CG mcap near $90K and price near zero | Already in the cemetery after the Stream Finance loss/counterparty failure. DefiLlama supply appears stale relative to price/resolution state. |
| Gyroscope GYD | ~$24-26M upstream | Already in the cemetery after the 2026 cross-chain contract incident. CoinGecko detail no longer resolves through `/coins/{id}` even though simple price still has remnants. |
| USPD, Stables Labs USDX, syUSD Synnax, RAI, EURA, FEI, HUSD, VAI, USTC, BEAN, USDN Neutrino, USDR Real USD | Varies | Already cemetery/dead, abandoned, exploited, depegged, or wound down. Upstream rows should not be treated as active add candidates. |
| Noble USDC, USDC.e, Aave/Venus receipt tokens, Curve LP shares, chain-specific MIM rows, DAI on PulseChain, bridged USDT rows | Often large | These are wrappers, receipts, LP shares, or chain variants of already tracked assets, not new canonical stablecoins. They may matter for contract/liquidity coverage, but should not become new stablecoin entries by default. |
| Mustang MUST | $154M DL but only ~$3.2M CG | Huge DL/CG mismatch, no `geckoId` in DL, Saga chain is not in local chain metadata, and reserve evidence is weak. Needs independent sanity check before any consideration. |

## Suggested Next Batch

If the goal is a clean add batch with high supportability and low bespoke work:

1. Add NAV/wrapper assets around already tracked bases:
   `sUSDS`, `sDAI`, `sUSDe`, `sfrxUSD`, `cUSDO`, `scrvUSD`, possibly `sYUSD`.
2. Add RWA/fiat issuers with good official evidence:
   `USDon`, `aUSDT`, `USDsui`, `BRLV`, `AUDM`, `USDGLO`. Keep `JUSD` blocked until the identity/price issue above is resolved.
3. Separately decide whether tokenized money-market fund shares belong in the active stablecoin universe. `JTRSY`, `BENJI`, `WTGXX`, `EUTBL`, `USTBL`, and `STBT` are large enough to matter, but they are fund/NAV instruments and would need source/taxonomy work.

## Flat/RWA Batch Supportability

Short answer: six of the seven flat/RWA issuer candidates can be supported without manual supply overrides. Jiritsu `JUSD` is blocked because the priced CoinGecko `jusd` asset is a different token and the official Jiritsu token has no usable price/depeg source. For the six supportable additions, supply, price, and depeg coverage are straightforward; live reserves and redemption backstops range from strong to acceptable-with-static-review.

| Candidate | Supply/price/depeg | Reserves | Redemption backstop | Verdict |
| --- | --- | --- | --- | --- |
| `jusd-jiritsu` | Blocked: no correct CoinGecko/CMC/DefiLlama/DexScreener price source for the official Jiritsu token. | Curated reserves could be researched, but runtime support would miss price/depeg. | Do not configure until runtime identity is resolved. | Not added. |
| `usdon-ondo` | CoinGecko market-cap/price path; Ethereum/BSC supported. | Curated RWA reserve slices can be added; live reserve sync depends on whether Ondo exposes asset-level reserve/NAV data for USDon. | Model as platform-mediated USDC redemption/swap, with access restrictions. | Supportable, but weakest live-reserve candidate until an Ondo feed is verified. |
| `ausdt-tether-alloy` | CoinGecko market-cap/price path; Ethereum supported. | Strong on-chain collateral candidate because aUSDT is minted against XAUT vault collateral; likely worth a dedicated Alloy vault adapter rather than static-only support. | Model as collateral redemption/return path to XAUT, with Tether/Alloy KYC and fee constraints. | Strong supportability. |
| `usdsui-sui` | DefiLlama id `373` gives normal DL supply/price/depeg; Sui chain exists locally. | Bridge/Open Issuance reserves can be curated now; live sync likely needs a Bridge/Open Issuance adapter. | Model as Bridge/Stripe issuer redemption, with program access constraints. | Strong data path; reserve sync requires new adapter work. |
| `brlv-crown` | CoinGecko market-cap/price path; BRL peg is supported by FX/depeg code; Ethereum/Base supported. | Crown publishes reserve figures; likely HTML/API adapter possible after source inspection. | KYC-gated BRL issuer redemption can fit existing offchain-issuer family. | Supportable and good non-USD candidate. |
| `audm-macropod` | DefiLlama id `334` plus CoinGecko id; AUD peg is supported; Ethereum/Solana supported. Redbelly is not local, but current material supply is mostly Ethereum. | Curated fiat reserve slices can be added; live reserve sync needs official report/API review. | Issuer mint/redeem route appears modelable after legal/source review. | Supportable; small cap and Redbelly coverage are the main caveats. |
| `usdglo-glo` | DefiLlama id `155` plus CoinGecko id; supported chains cover the material supply. VeChain appears non-core unless it grows. | Strong attestation trail through Glo/Brale; curated reserves are easy, live sync may reuse or extend issuer-attestation patterns. | Brale/Glo issuer redemption can fit offchain-issuer modeling. | Supportable despite sub-$5M size; strategically useful because Mento/cUSD already references USDGLO. |

Implementation success criteria for any chosen candidate:

- Confirm `geckoId` with contract lookup when an Ethereum contract exists.
- Confirm DefiLlama id where applicable and avoid adding any manual supply override.
- Verify primary contracts against official docs and explorers.
- Add reserve slices even if a live adapter is available.
- Reuse `erc4626-single-asset`, `single-asset`, `curated-validated`, or a known issuer adapter where possible before adding any new adapter.
- Add redemption backstop only when route evidence is explicit enough to model access, settlement, fees, capacity basis, and holder eligibility.

## Notes

- Attempted to inspect the live `discovery_candidates` D1 table via Wrangler, but the configured account token returned Cloudflare API code 7403. This report therefore relies on direct source/API scans plus the local registry/cemetery.
- Several upstream providers continue to show supply for assets Pharos intentionally moved to the cemetery. The local cemetery file should remain the stronger source for active-tracking decisions.
- Implementation follow-up: USDon, aUSDT, USDsui, BRLV, AUDM, and USDGLO were added on April 20, 2026. JUSD was not added because the official Jiritsu token lacks a usable price/depeg source, and CoinGecko `jusd` points at a different asset. USDsui was added without live reserve sync because Sui's public RPC confirmed metadata but did not expose total supply through `suix_getTotalSupply` for the Bridge coin type.
