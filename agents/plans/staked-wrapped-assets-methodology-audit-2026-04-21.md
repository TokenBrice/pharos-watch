# Staked and Wrapped Stablecoin Listing Audit

Date: 2026-04-21

## Question

Pharos generally does not list staked/wrapped versions of stablecoins independently from their base assets. The current exception is `susdai-usd-ai`, because `sUSDai` has a materially different reserve/yield-side collateral stack from base `USDai`.

This note checks whether that policy is defensible and whether other major staked/savings assets should be treated like `sUSDai`.

## Scoring Lens

The relevant Safety Score dimensions are:

- Liquidity / Exit
- Resilience: collateral quality and custody model
- Decentralization: governance quality and chain/deployment model
- Dependency Risk
- Peg multiplier, including NAV-wrapper peg inheritance when configured

A wrapper should be independently listed only when it creates a distinct stablecoin-like economic exposure that would materially change those dimensions. A pure savings receipt over the base token should usually remain a yield source for the base asset.

## Recommended Rule

Keep the current approach, but describe the exception test as:

> Do not list staked/wrapped receipts separately when they are pass-through wrappers over the base stablecoin and do not materially alter backing, custody, loss waterfall, redemption rights, or intended price/NAV behavior. List or separately model the wrapper when it introduces a distinct reserve book, active strategy book, lock/maturity bond, slashing/loss absorption, materially different redemption queue, or other economic exposure that would change Safety Score inputs.

Collateral composition is the cleanest exception, but not the only one. Loss waterfall and exit mechanics can also justify separate treatment.

## Major Assets Reviewed

| Asset | Base | Separate listing? | Safety-score impact if independently modeled | Rationale |
| --- | --- | --- | --- | --- |
| `sDAI` | `DAI` | No | Mostly inherited base score; likely lower only for wrapper/dependency/liquidity if modeled mechanically. | Tokenized DSR wrapper. Sky says DSR DAI is not lent again; sDAI repo calls it a tokenized wrapper around DSR. No separate collateral book. |
| `sUSDS` | `USDS` | No | Mostly inherited base score; wrapper upgradeability and liquidity are not enough for a stablecoin-list entry. | ERC-4626 Sky Savings Rate implementation over USDS. No fees and no separate reserve composition. |
| `scrvUSD` | `crvUSD` | No | Mostly inherited crvUSD score; possible lower liquidity/contract risk if modeled as a holder-specific wrapper, but not a distinct stablecoin. | Curve docs/GitHub describe a Yearn V3 ERC-4626 vault accepting crvUSD. Deposited crvUSD is not moved or rehypothecated; rewards come from crvUSD controller fees. |
| current `sGHO` | `GHO` | No | Mostly inherited GHO score; current product has no cooldown, no slashing, and no rehypothecation. | Aave docs describe sGHO as native savings over deposited GHO with rewards paid in GHO. |
| `sUSDe` | `USDe` | Usually no, but watch | Same underlying backing, but materially different exit and control surface: 7-day cooldown and sUSDe-specific freeze/redistribution roles. | Ethena staking contract receives USDe and distributes USDe rewards. Not a different collateral book, but a holder of sUSDe does not have the same immediate exit/legal control surface as a USDe holder. |
| `sfrxUSD` | `frxUSD` | Strong candidate exception | Likely different/lower if BYS strategy assets are scoring-relevant. | Frax docs say the vault allocates staked frxUSD to the best of carry-trade, AMO/DeFi, or IORB/T-bill strategies. This is not just idle frxUSD plus protocol-fee distribution. |
| `bUSD0` / legacy `USD0++` | `USD0` | Do not fold into USD0; separate only if Pharos covers bond tokens. | Materially different. Peg/liquidity/exit score would be lower before maturity. | Usual docs define bUSD0 as locked USD0 until 2028 maturity; early par redemption requires rt-bUSD0, while floor redemption can be below par. |
| `stUSDS` | `USDS` | Candidate exception if in stablecoin universe | Materially lower/different: SKY-backed lending, bad-debt risk, utilization-constrained withdrawals. | Sky explicitly distinguishes stUSDS from sUSDS; it is risk capital for SKY-backed borrowing and structurally isolated from sUSDS/USDS. |
| `stkGHO` / Umbrella GHO staking | `GHO` | Separate if ever in scope; do not conflate with current `sGHO`. | Materially lower/different because slashing and cooldown affect principal and exit. | Aave Umbrella docs describe automated slashing; current sGHO is the no-slashing savings product. |
| `sUSDai` | `USDai` | Yes, already tracked | Materially different. | Base USDai is modeled as a liquid PYUSD rail; sUSDai exposes GPU/infrastructure loan reserves and 30-day redemption windows. |
| `stcUSD` | `cUSD` | Candidate exception | Likely lower/different if tracked as a stablecoin-like wrapper. | Cap docs describe operator borrowing from reserves, strategy yield generation, and restaker slashing protection. |
| `sUSDat` | `USDat` | Candidate exception | Likely materially lower/different. | Local metadata and secondary/source trail indicate base USDat is M0/T-bill backed while sUSDat routes yield through STRC/Bitcoin-credit exposure. Needs primary-source confirmation before implementation. |
| `sAID` | `AID` | Strong candidate exception | Likely materially lower/different. | GAIB describes AID as T-bill/stablecoin backed and sAID as a NAV vault over AI infrastructure financing with monthly withdrawal cycles and unrealized-loss-aware unstaking NAV. |
| `sUSDp` | `USDp` | No based on current evidence | Mostly inherited base score. | Parallel describes sUSDp as protocol-fee savings over USDp without external strategy exposure. |
| `msY` | `msUSD` | Strong candidate exception | Likely materially lower/different. | Main Street describes msUSD as 1:1 USDC-backed while msY accrues options box-spread strategy returns through a segregated multi-token system. |
| `syrupUSDC` / `syrupUSDT` | `USDC` / `USDT` | Separate when threshold-eligible | Materially lower/different. | Maple syrup tokens are ERC-4626 lending pool LP tokens that accrue value from borrower loan repayments, not fiat/T-bill stablecoin reserves. |
| `yUSD` / `yoUSD` | `USDC` | Candidate exception | Materially lower/different. | YieldFi yUSD uses USDC as the native underlying but actively allocates into Pendle PTs, Morpho/Silo vaults, and private-credit vaults. |
| `srUSD` / `wsrUSD` | `rUSD` | Candidate exception | Near base but usually lower/different. | Reservoir savings liabilities are minted via rUSD, have separate interest accrual and PSM-liquidity-dependent redemption behavior. |
| `USDN` | `M` / `wM` | Candidate exception for deployment/dependency, not collateral | Collateral can inherit M, but chain/deployment/dependency score should differ. | Noble USDN is an M0 extension minted by locking M through M0 Portal/Wormhole NTT and adds Noble reward-routing/rebasing logic. |
| `sBOLD` | `BOLD` | Watchlist exception | Likely lower/different if listed. | sBOLD routes BOLD into Liquity V2 Stability Pools, earns interest and liquidation gains, and adds K3 vault, oracle, solver/swap, and fee-switch controls. |
| `sDOLA` | `DOLA` | No | Mostly inherited base score. | Inverse describes sDOLA as an ERC-4626 wrapper around the DOLA Savings Account fed by protocol lending revenue, with no lock-up and no rehypothecation of user deposits. |

## Current High-Confidence Calls

No separate listing:

- `sDAI`
- `sUSDS`
- `scrvUSD`
- current `sGHO`
- probably `sUSDp`

Keep/consider separate treatment:

- `sUSDai` (already)
- `sfrxUSD`
- `bUSD0` / legacy `USD0++` if bond tokens are in scope
- `stUSDS`
- `stkGHO` / Umbrella GHO staking if in scope
- `stcUSD`
- `sUSDat`
- `sAID`
- `msY`
- `syrupUSDC` / `syrupUSDT` if Pharos tracks these vault-token products
- `yUSD` / `yoUSD`
- `srUSD` / `wsrUSD`
- `USDN`
- `sBOLD`

Watchlist / needs more issuer-source verification before changing data:

- `sUSDe` because it shares USDe collateral but has separate freeze/cooldown mechanics.
- Smaller wrappers such as `sNUSD`, `sUSDa`, `sUSDf`, `savUSD`, `siUSD`, `sUSDu`, `sUSN`, `sdUSD`, `sftUSD`, and `sUSDh`, because many base assets are already active strategy stablecoins. The question is whether the wrapper adds a second risk book or only routes the base asset's native yield.

## Source Trail

- Pharos scoring model: `docs/report-cards.md`, `shared/lib/report-card-*.ts`
- Pharos yield wrapper map: `worker/src/cron/yield-config-variants.ts`
- Pharos current exception data: `shared/data/stablecoins/usd-major.json` entries for `usdai-usd-ai` and `susdai-usd-ai`
- Sky sUSDS docs: https://developers.skyeco.com/protocol/tokens/susds/
- Sky DSR/rate mechanism: https://developers.skyeco.com/deep-dives/rate-mechanism/
- Sky Pot docs: https://developers.skyeco.com/protocol/rates/pot/
- sDAI repo: https://github.com/sky-ecosystem/sdai
- Sky stUSDS product page: https://sky.money/stusds
- Curve scrvUSD docs: https://dev.curve.finance/scrvusd/overview/
- Curve scrvUSD repo: https://github.com/curvefi/scrvusd
- Curve crvUSD overview: https://dev.curve.finance/crvUSD/overview/
- Aave sGHO docs: https://aave.com/docs/aave-v3/guides/sgho
- Aave GHO docs: https://aave.com/docs/ecosystem/gho
- Aave Umbrella docs: https://aave.com/help/umbrella/umbrella
- Aave 2025 recap: https://aave.com/blog/aave-2025-recap
- Ethena staking docs: https://docs.ethena.fi/solution-design/staking-usde
- Ethena staking key functions: https://docs.ethena.fi/solution-design/staking-usde/staking-key-functions
- Ethena USDe overview: https://docs.ethena.fi/solution-overview/usde-overview
- Frax frxUSD docs: https://docs.frax.com/protocol/assets/frxusd/frxusd
- Frax sfrxUSD docs: https://docs.frax.com/protocol/assets/frxusd/sfrxusd
- Usual bUSD0 docs: https://docs.usual.money/usual-products/yield-products/usd-products/bond-usd0
- USD.AI dashboards: https://docs.usd.ai/app-guide/dashboards
- USD.AI USDai/sUSDai FAQ: https://docs.usd.ai/faq/usdai-and-susdai-101
- USD.AI buy/stake guide: https://docs.usd.ai/app-guide/buy-stake
- Cap stcUSD mechanics: https://docs.cap.app/protocol-overview/stcusd-mechanics
- Parallel sUSDp guide: https://blog.parallel.best/how-to-stake-usdp-into-susdp
- Parallel PIP-51: https://gov.parallel.best/t/pip-51-l-launch-usdp-the-new-parallel-usd-stablecoin/476
- GAIB AID docs: https://docs.gaib.ai/products/gaib-products/ai-dollar-aid
- GAIB sAID docs: https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said
- Main Street docs: https://mainstreet-finance.gitbook.io/mainstreet.finance/
- Maple syrup lending docs: https://docs.maple.finance/syrupusdc-usdt-for-lenders/lending
- YieldFi yUSD docs: https://docs.yield.fi/technical-docs/ytokens/yusd
- Reservoir srUSD/wsrUSD docs: https://docs.reservoir.xyz/products/savings-srusd-and-wsrusd
- Noble USDN docs: https://docs.noble.xyz/usdn/overview/
- Liquity sBOLD post: https://www.liquity.org/blog/sbold---the-on-chain-defi-savings-account
- Inverse sDOLA docs: https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola
