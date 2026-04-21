# Stablecoin Support Gap Sweep - 2026-04-21

## Scope

Goal: identify still-untracked stablecoins that Pharos could support properly.

I used this support bar:

- price/depeg path exists through current-style Pharos providers (DefiLlama, CoinGecko, supported contract pricing, or a clearly bounded existing fallback path)
- supply path exists without manual/on-chain/CMC/DEX supply overrides
- reserve evidence can be represented by live reserve sync, either through an existing adapter family or a small dedicated adapter backed by a machine-readable/current source
- redemption backstop can be modeled where the asset has primary-market redemption, wrapper unwrap, protocol redemption, or a documented issuer route
- enough metadata exists for a Safety Score rather than an informational-only page

Current local baseline:

- 205 tracked metadata entries.
- 194 active, 11 pre-launch.
- 142 entries with `llamaId`.
- 187 entries with `geckoId`.
- 159 entries with `liveReservesConfig`.
- 170 redemption backstop configs.

Sources checked:

- Local registry and cemetery:
  - `shared/data/stablecoins/{usd-major,usd-minor,non-usd,commodity,pre-launch}.json`
  - `shared/data/dead-stablecoins.json`
  - `shared/lib/redemption-backstop-configs/*`
  - live reserve adapter registry/docs
- DefiLlama stablecoin list and detail API:
  - `https://stablecoins.llama.fi/stablecoins?includePrices=true`
  - `https://stablecoins.llama.fi/stablecoin/{id}`
- CoinGecko stablecoin category:
  - 398 category rows fetched on 2026-04-21.
- Broader web / primary docs:
  - issuer docs and transparency pages for wrapper, RWA, fiat, regional, and protocol-backed candidates
  - RWA.xyz for tokenized fund-share / treasury-product candidates
  - official wind-down and product notices for exclusion checks

Raw inventory signal:

- DefiLlama returned 360 stablecoin rows. 66 rows above $1M circulating USD were not matched by local `llamaId` or `geckoId`.
- CoinGecko returned 398 stablecoin-category rows. 88 rows above $1M market cap were not matched by local `geckoId`.
- Most unmatched rows are not add candidates: cemetery assets, bridged deployments, chain-specific copies, receipt/LP tokens, internal exchange products, or wrong-identity symbol collisions.

## Best Active Add Candidates

These are the strongest candidates if the goal is assets that can get real Pharos price/supply/reserve/redemption/Safety Score coverage with low bespoke work.

| Priority | Proposed ID | Asset | Supportability | Notes |
| ---: | --- | --- | --- | --- |
| 1 | `susds-sky` | Sky Savings USDS (`sUSDS`) | Strong | Not the same as tracked `stusds-sky` (`stUSDS`). CoinGecko `susds` and DefiLlama/yield data show multi-billion scale. Reserve sync can use `erc4626-single-asset` over tracked `usds-sky`; redemption path is unwrap to USDS, then existing Sky PSM/LitePSM backstop. Sources: `https://developers.sky.money/core-protocol/susds/`, `https://www.coingecko.com/en/coins/susds`. |
| 2 | `susde-ethena` | Ethena Staked USDe (`sUSDe`) | Strong | CoinGecko `ethena-staked-usde`, current CMC/CG size is multi-billion. Reserve sync can model as ERC-4626-style wrapper over tracked `usde-ethena`. Redemption is delayed unwrap/cooldown to USDe, then USDe's own whitelisted/issuer flow; Safety Score should treat this as eventual/queue-style, not immediate cash. Sources: `https://docs.ethena.fi/solution-design/staking-usde`, `https://coinmarketcap.com/currencies/ethena-staked-usde/`. |
| 3 | `sdai-sky` | Savings DAI (`sDAI`) | Strong | CoinGecko `savings-dai` plus `savings-xdai` for Gnosis-specific representation. Reserve sync can use `erc4626-single-asset` over tracked `dai-makerdao`; redemption is unwrap to DAI, then DAI's existing PSM/liquidity path. Needs careful handling of Gnosis `savings-xdai` to avoid duplicate representation. |
| 4 | `sfrxusd-frax` | Frax Staked frxUSD (`sfrxUSD`) | Strong | CoinGecko `staked-frax-usd`; Frax docs describe an ERC-4626-like yielding token fully redeemable for frxUSD. Reserve sync should wrap tracked `frxusd-frax`, with reserve risk inherited from frxUSD/Frax rather than treated as a new reserve book. Source: `https://docs.frax.com/protocol/assets/frxusd/sfrxusd`. |
| 5 | `scrvusd-curve` | Savings crvUSD (`scrvUSD`) | Strong | CoinGecko `savings-crvusd`; Curve savings vault is an ERC-4626-style token over tracked `crvusd-curve`. Reserve sync can use wrapper semantics; redemption is unwrap to crvUSD, then existing crvUSD route/liquidity model. Source: `https://resources.curve.finance/crvusd/scrvusd/`. |
| 6 | `cusdo-openeden` | Compounding OpenDollar (`cUSDO`) | Strong with wrapper review | CoinGecko `compounding-open-dollar`; OpenEden docs say cUSDO can be unwrapped/redeemed into USDO. Best modeled as a wrapper over tracked `usdo-openeden` plus existing OpenEden live reserve path, not a separate reserve book. Source: `https://docs.openeden.com/usdo/developers/integration-guide`. |
| 7 | `syusd-aegis` | Aegis Staked YUSD (`sYUSD`) | Strong but smaller | CoinGecko `staked-yusd`; base `yusd-aegis` is tracked. Model as ERC-4626-style wrapper/cooldown to YUSD, then inherit Aegis reserve/redemption risk. Need avoid collision with dead Synnax `syUSD`. Source: `https://docs.aegis.im/tokens/syusd-stablecoin`. |
| 8 | `rusd-reservoir` | Reservoir rUSD | Strong but base/wrapper decision | Pharos tracks `wsrusd-reservoir`, not base `rUSD`. DefiLlama id `217` and CoinGecko `reservoir-rusd` show ~$1.37M supply/market cap. Existing `reservoir` live reserve adapter already fetches `https://app.reservoir.xyz/api/reserves/raw`, which includes rUSD liabilities and reserve assets. Redemption can use Reservoir PSM semantics. Add only if the product wants both base rUSD and wsrUSD rows. Sources: `https://docs.reservoir.xyz/products/proof-of-reserves`, `https://docs.reservoir.xyz/products/savings-srusd`. |
| 9 | `zusd-gmo` | GMO-Z.com ZUSD | Good, below normal size threshold | DefiLlama id `43` shows about $0.73M, below the usual $1M scan threshold, but support quality is high: regulated NY trust issuer, monthly attestations, and account-holder redemption. Would fit the existing offchain-issuer fiat-backed pattern. Sources: `https://stablecoin.z.com/zusd/`, `https://support.stablecoin.z.com/hc/en-us/articles/28734531119897-Stablecoin-User-Terms-and-Conditions`. |
| 10 | `brl1-brl1-network` | BRL1 | Good small regional add | CoinGecko `brl1` is about $1.39M. BRL peg support already exists in Pharos via the BRL/`peggedREAL` path. Fact Finance publishes a BRL1 reserve page that verifies reserves via custodian connections and tracks token supply. Sources: `https://fact.finance/en/reserves/brl1`, `https://www.coingecko.com/en/coins/brl1`. |
| 11 | `eur0-usual` | Usual EUR0 | Good, small/product-dependent | CoinGecko `usual-eur`; docs describe 100% Spiko `euTBL` backing and on-chain redemption. Fits EUR fiat/RWA coverage if Pharos wants Usual's EUR leg. Sources: `https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/eur0`, `https://tech.usual.money/smart-contracts/token-contracts/eur0`. |

## Wrapper/NAV Batch Recommendation

If the next add batch should maximize coverage per implementation cost, the wrapper/NAV set is the cleanest:

1. `sUSDS`
2. `sUSDe`
3. `sDAI`
4. `sfrxUSD`
5. `scrvUSD`
6. `cUSDO`
7. `sYUSD`

Why this batch is clean:

- every base asset is already tracked
- reserve risk can inherit from the base plus wrapper mechanics
- redemption routes are wrapper unwrap/cooldown first, then the base asset's existing path
- existing `erc4626-single-asset`, wrapper, and source-specific live reserve patterns cover most of the work
- avoids adding questionable long-tail stablecoins just because upstream categories include them

Implementation caveat: treat yield-bearing/NAV tokens as NAV wrappers, not flat $1 peg assets. For Safety Score, their peg/reference should point at the base asset or NAV exchange rate, and Liquidity / Exit should not treat delayed unstaking as immediate same-day redemption.

## Non-Wrapper Add Candidates

These are plausible but need more adapter or source work than the wrapper batch.

| Candidate | Source signal | Support path | Main blocker |
| --- | --- | --- | --- |
| `doc-money-on-chain` / Dollar on Chain | DefiLlama id `30`; CoinGecko `dollar-on-chain`, about $5.2M market cap. | Rootstock is supported locally. Official Money On Chain docs say DOC is Bitcoin/rBTC collateralized and redeemable through the dApp. Sources: `https://moneyonchain.com/doc-stablecoin/`, `https://www.coingecko.com/en/coins/dollar-on-chain`. | Focused follow-up cleared the coin for tracking and a documented redemption route; a Money On Chain / Rootstock reserve adapter is still needed for score-grade live-reserve support. |
| `djed-coti` or `djed-stability-nexus` / Djed | DefiLlama id `93`; CoinGecko `djed`, about $4.0M market cap. | Cardano chain metadata exists. Stability Nexus docs describe overcollateralized reserves and stablecoin selling/redemption mechanics. Sources: `https://docs.stability.nexus/djed-stablecoin-protocols/how-the-protocol-works`, `https://www.coingecko.com/en/coins/djed`. | Needs a Cardano reserve/ratio adapter and careful crypto-backed vs algorithmic classification. |
| `mai-qi-dao` / MAI | CoinGecko `mimatic`, about $12M market cap. | Official docs describe overcollateralized vaults and a PSM. Sources: `https://docs.mai.finance/stablecoin-economics`, `https://docs.mai.finance/peg-stability-module`. | Needs collateral/reserve adapter and redemption modeling; not a quick metadata-only add. |
| `audf-forte` / Forte AUD | CoinGecko `forte-aud`, about $3.6M market cap. | AUD peg support exists. Official PDS/site say AUDF is 1:1 AUD-backed, redeemable, and has published reserve reports. Sources: `https://www.forteaud.com/`, `https://www.cointree.com/company/pds/audf-pds/`. | Focused follow-up cleared the coin for tracking and a documented issuer redemption route; reserve-report sync remains static/PDF-based rather than a clean machine-readable live feed. |
| `cngn-compliant-naira` / cNGN | CoinGecko `compliant-naira`, about $2.4M market cap. | Official/press sources describe Naira backing and reserves. Sources: `https://cngn.co/terms-and-condition`, `https://techpression.com/cngn-stablecoin-reserves-surpass-circulation-by-over-%E2%82%A65-million/`. | Pharos does not currently support `NGN` in `PEG_CURRENCY_VALUES` / FX sync / peg-summary mapping. Needs peg-currency expansion plus reserve feed review. |
| `krwq-krwq` / KRWQ | CoinGecko `krwt`, about $1.3M market cap. | Official site says KRW on/off ramps, redemption flow, and Korean bond reserve claims. Sources: `https://www.krwq.cash/`, `https://www.prnewswire.com/news-releases/krwq-the-first-korean-won-stablecoin-on-base-302599239.html`. | Pharos does not support `KRW` peg/Fx handling today; reserve evidence is still thin for score-grade support. |
| `solayer-susd` / Solayer USD | DefiLlama id `216`; CoinGecko `solayer-usd`, about $5.5M market cap. | Price/supply are available; docs and market pages describe OpenEden/T-bill backing and Solana Token-2022 interest-bearing mechanics. Sources: `https://www.coingecko.com/en/coins/solayer-usd`, `https://solayer.org/resources/blog/susd-now-live-on-raydium-the-first-token-leveraging-the-token2022-interest-bearing-extension`. | Needs proof/attestation review and likely a Solana Token-2022 / OpenEden-link reserve adapter. |
| `iusd-indigo` / Indigo Protocol iUSD | CoinGecko `iusd`, DefiLlama id `88`; current CG market cap about $9.5M. | Cardano chain exists locally; model would be Cardano CDP/collateral-backed. | Symbol collision with tracked `iusd-infinifi`; needs Cardano reserve adapter and redemption route review. |
| `bnusd-balanced` / Balanced Dollars | DefiLlama id `204`; CoinGecko `balanced-dollars`, about $2.8M. | Multi-chain supply exists; could be modeled if ICON/Archway and collateral mechanics are reviewed. | Local chain support is incomplete for primary ICON/Archway footprint; reserve accounting needs custom review. |
| `usdrif-rif` / RIF US Dollar | DefiLlama id `159`; CoinGecko `rif-us-dollar`, about $1.5M. | Rootstock is supported locally. | Focused follow-up later cleared a static metadata / static reserve add, but live reserve automation and a reviewed weak redemption model remain deferred. |
| `dllr-sovryn` / Sovryn Dollar | DefiLlama id `160`; CoinGecko `sovryn-dollar`, about $3.4M. | Rootstock is supported locally. | Needs Sovryn reserve/redemption adapter review; no current quick reserve-sync path verified. |
| `myrc-blox` / Blox MYRC | CoinGecko `blox-myrc`, about $1.33M market cap. | Official BLOX pages describe 1:1 MYR backing, redemption, contracts, and attestation reports. Sources: `https://www.blox.my/myrc`, `https://www.blox.my/myrc/transparency`. | Pharos does not support `MYR` peg/Fx handling today. Needs peg-currency expansion before proper depeg/Safety Score handling. |
| `kgst-kgstoken` / Kyrgyz Som Stablecoin | CoinGecko `kyrgyz-som-stablecoin`, about $6.2M market cap. | Official site describes 1:1 KGS fiat reserves in Kyrgyz banks and regulatory supervision. Source: `https://www.kgstoken.kg/`. | Pharos does not support `KGS` peg/Fx handling today; reserve sync source still needs verification. |
| `hbd-hive` / Hive Backed Dollar | CoinGecko `hive_dollar`, about $31.8M market cap. | Hive docs describe the 3.5-day HBD/HIVE conversion and haircut rule. Source: `https://hive.io/hbd/`. | No Hive chain/source integration, and reserve/redemption mechanics are unlike current Pharos adapter families. |
| `money-defi-money` / Defi.money MONEY | CoinGecko `defi-money`, about $10M market cap. | Docs describe CDP-backed MONEY. | CG-only supply path; needs focused collateral/reserve and redemption-source review. |

## Product / Taxonomy Expansion Candidates

These are large enough to matter but are tokenized securities, money-market funds, or state/RWA products rather than ordinary stablecoins. They should not be mixed into the normal stablecoin add queue without a product decision.

| Candidate | Why it matters | Blocker |
| --- | --- | --- |
| `frnt-wyoming` / Wyoming Frontier Stable Token | State-issued USD stable token; official materials describe 102% reserve requirement and Franklin Templeton-managed reserves. Sources: `https://stabletoken.wyo.gov/`, `https://app.rwa.xyz/assets/FRNT`. | Not in DefiLlama stablecoins / CoinGecko stablecoins in the normal way. Might replace or graduate a pre-launch Wyoming-related row, but needs source-path and product decision. |
| `benji-franklin` / BENJI | RWA.xyz shows about $1B scale; Franklin OnChain U.S. Government Money Fund. Source: `https://www.franklintempleton.com/investments/options/money-market-funds/products/29386/SINGLCLASS/franklin-on-chain-u-s-government-money-fund/FOBXX`. | Tokenized mutual fund share, not a payment stablecoin. Needs explicit fund-share/NAV taxonomy and RWA.xyz or issuer NAV ingestion. |
| `jtrsy-janus-henderson` / JTRSY | RWA.xyz/tokenized treasury reports show very large AUM. Janus Henderson/Centrifuge/Anemoy tokenized treasury fund. | Same fund-share issue; needs RWA/NAV ingestion and investor-eligibility modeling. |
| `wtgxx-wisdomtree` / WTGXX | WisdomTree money-market digital fund seeks stable $1 NAV; official page/factsheet lists blockchain share records. Source: `https://www.wisdomtree.com/investments/digital-funds/money-market/wtgxx`. | Registered fund share, not a stablecoin. Needs product decision. |
| `ustbl-spiko` / `eutbl-spiko` | Spiko U.S./EU T-bill fund shares are material and are used as collateral by other products. Sources: `https://www.spiko.io/`, `https://www.prnewswire.com/news-releases/spiko-announces-the-deployment-of-the-spiko-us-and-eu-t-bills-money-market-funds-on-arbitrum-302361527.html`. | Tokenized fund shares; could be tracked as dependency/reserve assets first, not necessarily as active stablecoins. |
| `stbt-matrixdock` / STBT | Matrixdock tokenized T-bill product; useful as reserve dependency. | Needs reconciliation of supply/NAV source and a decision whether Pharos tracks reserve assets directly. |

## Do Not Add / Explicit Exclusions

| Asset | Verdict | Reason |
| --- | --- | --- |
| JUSD / Jiritsu vs CoinGecko `jusd` | Blocked | CoinGecko `jusd` is `jusd.app` with BSC contract `0xbf3950db0522a7f5caa107d4cbbbd84de9e047e2`, not Jiritsu's BENJI-backed JUSD. Jiritsu has official product evidence (`https://www.jiritsu.network/tokens/jusd`) but not a clean matching price/depeg source. |
| BFUSD | Do not add | Binance has described BFUSD as a reward-bearing futures-margin asset, not a normal on-chain stablecoin. It is internal to Binance and not suitable for Pharos stablecoin support. Sources: `https://www.theblock.co/post/327134/binance-clarifies-rewards-bearing-bfusd-asset-is-not-a-stablecoin-hasnt-launched`, BFUSD terms PDF. |
| USDT0 | Do not add separately | Already represented by `usdt-tether`. It is a USDT OFT/omnichain representation; a separate canonical row would double count. Source: `https://docs.usdt0.to/`. |
| BUSD / Binance-Peg BUSD | Do not add | Cemetery/wind-down asset. Paxos halted minting in 2023 and support was time-limited. Source: `https://www.paxos.com/newsroom/paxos-will-halt-minting-new-busd-tokens`. |
| deUSD | Do not add | Cemetery/collapse asset; upstream supply is stale/noisy after the Stream/Elixir failure. |
| GYD | Do not add | Cemetery after the 2026 cross-chain contract incident. |
| RAI | Do not add | Managed-float/reflex index, not a fiat stablecoin; Pharos cemetery treats it as inactive. |
| EURA / PAR / old Angle assets | Do not add | Angle wind-down / legacy rows; current active support should not be revived without a focused resurrection review. |
| VAI | Do not add without resurrection audit | Local cemetery and depeg/bad-debt history should remain authoritative unless a focused review says otherwise. |
| USD+ / Overnight | Watch, not normal add | Current external sources show active Overnight USD+ variants, but local cemetery says abandoned. Needs a focused cemetery-vs-current re-audit before any add. Sources: `https://docs.overnight.fi/user-guides/mint-redeem`, `https://www.coingecko.com/en/coins/overnight-fi-usd-base`. |
| Noble USDC, USDC.e, MIM chain-specific rows, DAI on PulseChain, xDAI | Do not add as new canonical stablecoins | Chain variants, bridged copies, or already represented base assets. They may matter for contract/liquidity coverage, not new stablecoin IDs. |
| Curve FRAX/USDC LP, Nest Alpha Vault LP, lending receipts | Do not add | Receipt/LP tokens, not standalone stablecoins. |

## Other Upstream Rows Over $1M Not Promoted

These appeared in the DefiLlama/CoinGecko untracked lists but failed the support bar in this broad pass.

| Candidate | Source signal | Reason not promoted |
| --- | --- | --- |
| `mustang` / Mustang Finance | DefiLlama listed ~$154M; CoinGecko market cap much lower (~$3.2M). | Large DL/CG mismatch, no normal gecko match in DL, Saga primary chain not locally supported, reserve evidence weak. |
| `palm-usd` / Palm USD | CoinGecko ~101M, DefiLlama much smaller (~$3M). | Reserve/redemption evidence not score-grade from this pass; needs issuer proof and identity reconciliation. |
| Ring USD / Royal Dollar / Royal Euro / Unity USD / XTUSD / VCRED | CoinGecko rows mostly $10M-$100M. | Insufficient official reserve/transparency/redemption evidence found in broad pass; several look exchange/ecosystem-specific or thinly documented. |
| Hive Dollar (`HBD`) | CoinGecko ~32M. | Hive chain and HBD conversion mechanics would require new chain/source work; not a current Pharos-style quick add. |
| `web-3-dollar` / USD3 | DefiLlama/CoinGecko around $7M; price around $1.09. | Above-peg NAV/yield behavior and reserve/source clarity need review before stablecoin scoring. |
| `dforce-usd` / USX | CoinGecko/DefiLlama around $6-7M but price around $0.44 in this scan. | Currently impaired/depegged; not supportable as normal active stablecoin. |
| `usd3`, `staked-usd-coin`, `superreturn-ssuperusd`, `stoneyield-usd`, `leverup-usd`, `usdm1`, `pathusd`, `cod3x-usd`, `soulpeg-usd`, `lumi-finance-luausd` | CoinGecko rows mostly $1M-$10M. | Need focused issuer/protocol source review. Not enough verified reserve-sync and redemption evidence in this broad sweep. |
| `FLEXUSD`, `USPD`, `BEAN`, `USDN`, `USDR`, `YUSD Stablecoin`, `R`, `USDL`, `HUSD`, `FEI`, `EURA`, `MUSD`, `VAI`, `syUSD Synnax`, `USDM Mountain`, `PAR`, `NOTE` | DefiLlama/CoinGecko residual supply. | Dead, wound down, abandoned, depegged, or already in local cemetery/exclusion set. |

## Practical Next Batch

Recommended sequence:

1. Add the wrapper/NAV batch first: `sUSDS`, `sUSDe`, `sDAI`, `sfrxUSD`, `scrvUSD`, `cUSDO`, `sYUSD`.
2. Decide whether to add base `rUSD` beside `wsrUSD`; the source path is already excellent through the Reservoir adapter, but it may be redundant.
3. Add `BRL1`, `ZUSD`, and `EUR0` if small regional coverage is acceptable.
4. Open focused research tickets for `DOC`, `DJED`, `MAI`, `AUDF`, `Solayer sUSD`, `cNGN`, `KRWQ`, `MYRC`, and `KGST`.
5. Make a product decision on tokenized fund shares (`BENJI`, `JTRSY`, `WTGXX`, `USTBL/EUTBL`, `STBT`, `FRNT`) before adding them as active stablecoins.

## Follow-Up Implementation Notes

For wrapper additions:

- add the metadata entry and canonical order
- verify CoinGecko IDs by contract address
- add contracts from official docs/explorers
- use `pegReferenceId` to point at the base stablecoin
- use an `erc4626-single-asset` or source-specific wrapper live reserve config where the contract/API proves the exchange rate
- add redemption backstop configs as wrapper unwrap / queue-redeem paths, not immediate fiat exits
- keep reserve slices linked to the base coin via `coinId` and `depType: "wrapper"` where supported by schema

For non-wrapper additions:

- do not add until the reserve source can be synced, not just manually described
- add peg-currency support before `cNGN`/`KRWQ`-style assets
- treat old cemetery conflicts (`USD+`, VAI, etc.) as resurrection audits, not normal add tasks
