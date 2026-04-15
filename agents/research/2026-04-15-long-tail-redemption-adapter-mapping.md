# Long-Tail Redemption Adapter Mapping Research

Date: 2026-04-15

## Scope

This research covers the long-tail routes previously grouped as:

- **CDP / collateral-redeem routes:** 14 stablecoins
- **stablecoin-redeem routes:** 12 stablecoins

Total in scope: **26 stablecoins**.

The previous execution ledger correctly blocked generic full-supply upgrades as unsafe. This pass goes deeper and identifies which routes have enough public/onchain/API surface to justify a protocol-specific live-reserve or redemption-capacity adapter.

## Summary

| Status | Count | Meaning |
| --- | ---: | --- |
| Implementable with existing adapter template or modest extension | 10 | Public/onchain/API data exists and a concrete adapter shape is clear |
| Researchable but needs ABI/app endpoint discovery | 9 | Docs prove route semantics, but exact current-state source needs contract/app mapping |
| Defer / route-availability first | 7 | Current source is insufficient, whitelisted/offchain, or incident-sensitive |

## CDP / Collateral-Redeem Routes

### `fxusd-f-x-protocol`

Current evidence:

- Config docs: `https://fxprotocol.gitbook.io/fx-docs`, `https://fx.aladdin.club`
- Existing live reserve adapter: `fx`
- Route: direct oracle-priced collateral redemption when fxUSD trades below peg.

Adapter shape:

- Extend existing `fx` adapter into redemption telemetry.
- Current reserve/collateral data already comes from `https://api.aladdin.club/api1/get_fx_tvl`.
- Needed fields:
  - current fxUSD supply / debt
  - current redeemable collateral buckets
  - redemption fee / slippage if exposed
  - route pause/status if API exposes it
  - oracle freshness

Status: **implementable with existing adapter extension**.

Capacity tier:

- `live-proxy-validated` initially from existing TVL source.
- Promote to `live-direct-bounded` only if the API/onchain contract exposes current redeem quote/capacity.

### `feusd-felix`

Current evidence:

- Docs/site: `https://usefelix.xyz/`, `https://usefelix.gitbook.io/docs`
- Audit confirms Felix is a Liquity V2 fork on HyperEVM.
- Existing live reserve adapter: `evm-branch-balances`
- Route: Liquity V2-style redemption against troves.

Adapter shape:

- Build a generic **Liquity V2 fork adapter** reusable for Felix, Nectar, Nerite, Quill, BIMA-like forks where ABIs line up.
- Existing branch-balance config already tracks collateral holders/assets, but not system redemption state.
- Needed fields:
  - total debt / total collateral
  - branch collateral/debt per market
  - current base rate / redemption fee
  - sorted trove / lowest-interest or lowest-CR state where available
  - paused/recovery mode
  - oracle freshness

Status: **researchable, likely implementable after ABI mapping**.

Capacity tier:

- `live-direct-bounded` only with Liquity V2 system-state probes.
- Existing branch balances remain collateral-mix evidence, not direct redemption capacity.

### `meusd-mezo`

Current evidence:

- Developer docs: `https://mezo.org/docs/developers/musd/musd-redemptions/`
- User docs: `https://mezo.org/docs/users/musd/liquidation-mechanics/`
- Existing live reserve adapter: `single-asset` over explorer token supply.
- Docs expose redemption helper parameters such as `_upperPartialRedemptionHint`.

Adapter shape:

- Build a Mezo/MUSD-specific adapter or Liquity-like adapter if contracts match.
- Needed fields:
  - trove manager/system contract addresses
  - total system collateral / debt
  - current redemption fee
  - redemption availability / recovery mode
  - BTC collateral valuation oracle freshness

Status: **implementable after contract address / ABI mapping**.

Capacity tier:

- `live-direct-bounded` with system-state contract reads.

### `nect-beraborrow`

Current evidence:

- Nerite/Beraborrow-style route in config, but current repo uses curated/static data.
- Likely Liquity V2-style redemption mechanics.

Adapter shape:

- Same generic Liquity V2 fork adapter, pending official Beraborrow/Nectar contract docs.

Status: **researchable, needs protocol-specific ABI/source confirmation**.

Capacity tier:

- `documented-eventual` until ABI/current-state source is mapped.

### `reusd-resupply`

Current evidence:

- Official docs: `https://docs.resupply.fi/resupply-protocol/stability-mechanics`
- Docs explicitly describe a communal redemption model and 1% redemption fee.

Adapter shape:

- Build `resupply-redemption` adapter.
- Needed fields:
  - total reUSD supply/debt
  - lending pool collateral balances
  - current redemption fee
  - redemption module state / paused state
  - available collateral per pool

Status: **implementable after contract/API mapping**.

Capacity tier:

- `live-direct-bounded` if redemption module exposes current collateral and route state.

### `satusd-river`

Current evidence:

- Official docs: `https://docs.river.inc/`
- Omni-CDP docs: `https://docs.river.inc/products/editor`
- River whitepaper describes cross-chain position state but exact onchain schema is not in current repo.

Adapter shape:

- Research-first adapter.
- Needed fields:
  - position/global debt state
  - collateral by source chain
  - satUSD supply by destination chain
  - cross-chain message state
  - redemption route availability, if any

Status: **defer until River exposes stable ABI/API mapping**.

Capacity tier:

- `documented-eventual` until concrete current-state source is known.

### `usbd-bima`

Current evidence:

- Official docs: `https://docs.bima.money/redeeming-usbd`
- Mint/redeem docs: `https://docs.bima.money/minting-and-redeeming-usbd`
- Docs describe redemption fee = `coreRate + 75 bps`; redemption affects `coreRate`.

Adapter shape:

- BIMA-specific adapter or Liquity-style fork if contracts line up.
- Needed fields:
  - current `coreRate`
  - total debt / collateral
  - supported collateral branches
  - PSM liquidity if separate from direct redemption
  - route pause/status

Status: **implementable after contract ABI mapping**.

Capacity tier:

- `live-direct-bounded` for direct collateral redemption, possibly with PSM sub-route.

### `usdq-quill`

Current evidence:

- Official docs: `https://docs.quill.finance/faq/usdusdq`
- Redemptions: `https://docs.quill.finance/faq/liquidations-oracle-and-redemptions`
- Fee model: `https://docs.quill.finance/faq/fee-model`
- Quill/Liquity V2 relation: `https://docs.quill.finance/faq/quill-and-liquity-v2`

Adapter shape:

- Liquity V2 fork adapter.
- Needed fields:
  - total debt/collateral
  - current base rate/redemption fee
  - collateral markets
  - sorted trove ordering / lowest-risk redemption targets
  - oracle freshness

Status: **implementable after ABI mapping**.

Capacity tier:

- `live-direct-bounded`.

### `usdk-orki`

Current evidence:

- Current repo config has documented full-system collateral redemption but no live reserve adapter.
- Official machine-readable surface not confirmed in this pass.

Adapter shape:

- Research-first.
- Check if Orki is a Liquity fork or CDP with public trove/state contracts.

Status: **defer pending source/ABI discovery**.

Capacity tier:

- `documented-eventual`.

### `usnd-nerite`

Current evidence:

- Official redemptions/delegation: `https://docs.nerite.org/docs/user-docs/redemption-and-delegation`
- Borrowing/liquidations: `https://docs.nerite.org/docs/user-docs/borrowing-and-liquidations`
- Docs confirm Liquity V2-style markets for ETH, wstETH, and rETH.

Adapter shape:

- Liquity V2 fork adapter.
- Needed fields:
  - branch/market debt and collateral
  - branch stability pools
  - current redemption fee
  - current sorted trove state
  - oracle freshness

Status: **implementable after ABI mapping**.

Capacity tier:

- `live-direct-bounded`.

### `usdaf-asymmetry`

Current evidence:

- Official docs: `https://docs.asymmetry.finance/usdaf-stablecoin/redemptions`
- Peg docs: `https://docs.asymmetry.finance/usdaf-stablecoin/how-does-usdaf-maintain-peg`
- Existing live reserve adapter: `asymmetry`
- Docs say users can track redemptions in a Dune dashboard.

Adapter shape:

- Extend `asymmetry` adapter or add Liquity V2 fork adapter.
- Needed fields:
  - current redemption fee/rate
  - total debt / collateral branches
  - Dune redemption history is useful context but not current capacity
  - route health/status

Status: **implementable after ABI or API mapping**.

Capacity tier:

- `live-direct-bounded` if protocol state is readable.
- Existing reserve adapter remains collateral-mix evidence.

### `ebusd-ebisu`

Current evidence:

- Current repo route is documented but no live adapter.
- No official current-state source verified in this pass.

Adapter shape:

- Research-first; determine if it is a Liquity/CDP fork or custom redemption.

Status: **defer pending source/ABI discovery**.

Capacity tier:

- `documented-eventual`.

### `usdp-parallel`

Current evidence:

- Official docs: `https://docs.parallel.best/products/parallel-v3/how-it-works/parallelizer-module`
- Integration docs: `https://docs.parallel.best/developers-hub/parallel-v3/build-on-parallel/parallelizer-module-integration`
- Docs explicitly describe Mint, Burn, and Redeem actions.

Adapter shape:

- Build `parallelizer` adapter.
- Needed fields:
  - supported collateral reserves
  - current burn/redeem fee
  - collateral redemption availability
  - module pause/status
  - per-asset caps/weights

Status: **implementable after contract address / ABI mapping**.

Capacity tier:

- `live-direct-bounded`.

### `ussd-sonic-labs`

Current evidence:

- Current repo references Sonic Labs documentation and Frax-style balance sheet for live reserves.
- No redemption-specific contract/API mapping verified in this pass.

Adapter shape:

- Research-first.
- Check whether USSD has dedicated zero-fee mint/redeem contracts and current route status.

Status: **defer pending source/ABI discovery**.

Capacity tier:

- `documented-eventual`.

## Stablecoin-Redeem Routes

### `aid-gaib`

Current evidence:

- Official docs: `https://docs.gaib.ai/products/gaib-products/ai-dollar-aid`
- How AID works: `https://docs.gaib.ai/how-aid-works`
- Docs state whitelisted users/partners can mint/redeem through contracts.

Adapter shape:

- Build `gaib-aid` adapter if contract addresses expose reserves or mint/redeem status.
- Needed fields:
  - stable asset reserve/cash buffer
  - redemption contract status
  - holder eligibility / whitelist gating
  - fee/spread if exposed

Status: **researchable, needs contract addresses/API mapping**.

Capacity tier:

- `documented-bound` or `live-proxy-validated`; likely not broad any-holder.

### `apxusd-apyx`

Current evidence:

- Official docs: `https://docs.apyx.fi/`
- Buy/mint docs: `https://docs.apyx.fi/app-guide/how-to-buy-apxusd`
- Contract overview/locking docs exist for apyUSD, but direct current redemption capacity was not verified.

Adapter shape:

- Research-first.
- Check contract addresses for vault liquidity, allowlist state, and redemption status.

Status: **defer pending app/API/contract mapping**.

Capacity tier:

- `documented-bound`.

### `dusd-dtrinity`

Current evidence:

- dUSD docs: `https://docs.dtrinity.org/core-components/dusd-stablecoin`
- Mint/redeem guide: `https://docs.dtrinity.org/user-guide/how-to-mint-and-redeem`
- Protocol docs: `https://docs.dtrinity.org/protocol-components/stablecoins/dusd`
- Docs state dUSD can be minted/redeemed permissionlessly via smart contracts; reserve undercollateralization can pause network mint/redeem.

Adapter shape:

- Build `dtrinity-dusd` adapter.
- Needed fields:
  - reserve assets and balances
  - NAV / mint-redemption ratio per reserve asset
  - route pause status by network
  - oracle freshness
  - redemption fee if exposed

Status: **implementable after contract/API mapping**.

Capacity tier:

- `live-direct-bounded` if reserve contracts expose current balances and route status.

### `jupusd-jupiter`

Current evidence:

- Developer docs: `https://dev.jup.ag/jupusd`
- Audit: `https://jupusd.money/homepage/audits/pashov.pdf`
- Docs state benefactor-authorized mint/redeem with USDC or USDtb, plus transparency page for real-time reserves/backing/audit data.

Adapter shape:

- Build Solana/onchain `jupusd` adapter.
- Needed fields:
  - vault token accounts for USDC/USDtb
  - reserve composition
  - benefactor/route status
  - fees and risk parameters if onchain
  - total supply

Status: **implementable after Solana account mapping from dev docs/audit**.

Capacity tier:

- `live-direct-bounded` for benefactor-gated route; holder eligibility should remain `whitelisted-primary`.

### `msusd-main-street`

Current evidence:

- Main Street docs/site in config.
- Previous research found redemption cap/cooldown docs but no public current cap/queue state.

Adapter shape:

- Research-first.
- Needed fields:
  - current cap usage
  - current queue/pending redemptions
  - cooldown state
  - available USDC

Status: **defer until current public route state is found**.

Capacity tier:

- `documented-bound`.

### `ousg-ondo-finance`

Current evidence:

- Chainlink NAV adapter already covers NAV/proof.
- No product-specific redemption capacity/status source verified.

Adapter shape:

- Research-first.
- Needed fields:
  - OUSG instant manager liquidity
  - allowlist status / route open
  - daily/transaction limits
  - USDC/BUIDL liquidity

Status: **defer pending product-specific source**.

Capacity tier:

- `documented-bound`, not live capacity.

### `u-united-stables`

Current evidence:

- Official site: `https://www.u.tech/`
- Terms: `https://www.u.tech/terms/`
- Terms indicate redemption rights require becoming a Mint User and satisfying compliance.

Adapter shape:

- Research-first.
- Needed fields:
  - supported collateral contracts
  - mint/redeem contract route status
  - allowed collateral balances
  - eligibility/allowlist state

Status: **defer pending contract/API mapping**.

Capacity tier:

- `documented-bound`, whitelisted.

### `usda-avalon`

Current evidence:

- USDa docs: `https://docs.avalonfinance.xyz/avalon-products/cedefi-cdp-usda/how-to-use-usda`
- RWA.xyz summary notes USDT conversion vault and one-business-day claims.
- Audit report references functions/events such as `RequestUSDT`, `ClaimUSDT`, `DepositUSDT`, `RedeemUSDT`, `RedeemUSDA`.

Adapter shape:

- Build `avalon-usda-conversion-vault` adapter if contract addresses are public.
- Needed fields:
  - conversion vault USDT balance
  - pending requests
  - claimable amount
  - one-business-day window state
  - pause/status

Status: **implementable after contract address / ABI mapping**.

Capacity tier:

- `live-queue` or `live-direct-bounded` depending vault mechanics.

### `usdf-astherus`

Current evidence:

- Aster docs/site: `https://docs.asterdex.com/overview/usdf-stablecoin`, `https://www.asterdex.com/en/usdf`
- Current source confirms fully collateralized stablecoin, but no current redeemable-capacity endpoint was verified.

Adapter shape:

- Research-first.
- Needed fields:
  - current collateral reserve
  - redemption path status
  - settlement delay
  - user eligibility

Status: **defer pending source discovery**.

Capacity tier:

- `documented-bound`.

### `usr-resolv`

Current evidence:

- Known incident-sensitive route from prior investigation.
- Official communications during incident constrained operations/cohort.

Adapter shape:

- Route availability registry first, not capacity.
- Needed fields:
  - current protocol status notice
  - redemption portal/API health if stable
  - cohort limitations

Status: **route availability / incident registry first**.

Capacity tier:

- no uplift until current broad redemption route is proven open.

### `usx-solstice`

Current evidence:

- Official app/source: `https://claim-solstice.app/`
- Source says whitelisted users can request real-time mint/redeem quotes using USDC/USDT.
- Direct mint/redemption is reserved for KYC institutional users.

Adapter shape:

- Build quote/status adapter if endpoint is discoverable.
- Needed fields:
  - current quote availability
  - USDC/USDT route liquidity
  - route status
  - KYC/whitelist gating

Status: **researchable; needs quote endpoint discovery**.

Capacity tier:

- `live-proxy-validated` or `documented-bound`; whitelisted-primary.

### `yousd-yield-optimizer`

Current evidence:

- Current repo has route docs but no strong live reserve source.

Adapter shape:

- Research-first.
- Needed fields:
  - ERC-4626/vault liquidity
  - withdrawal buffer
  - 24h unwind status
  - cross-chain position state

Status: **defer pending source/API discovery**.

Capacity tier:

- `documented-bound`.

## Implementation Recommendation

Highest ROI protocol-specific adapters from this set:

1. **Liquity V2 fork template**: Felix, Nerite, Quill, possibly Nectar/BIMA/USDaf after ABI confirmation.
2. **dTRINITY dUSD adapter**: docs indicate permissionless smart-contract mint/redeem and pauseable route by network.
3. **Parallelizer adapter**: Parallel docs explicitly expose mint/burn/redeem module semantics.
4. **Avalon conversion vault adapter**: audit/docs point to request/claim/redeem functions.
5. **JupUSD Solana vault adapter**: developer docs/audit identify benefactor-gated USDC/USDtb reserves.
6. **Resupply communal redemption adapter**: official docs describe a concrete communal redemption mechanism.

Routes to keep deferred until better sources are found:

- River satUSD
- Orki USDK
- Ebisu ebUSD
- Sonic USSD
- AID
- apxUSD
- Main Street msUSD
- Ondo OUSG
- United Stables U
- Astherus USDF
- Resolv USR
- Solstice USX
- YOUSD

## Next Implementation Shape

The most reusable next adapter is a Liquity V2 fork adapter:

Inputs needed:

- chain/rpc mode
- borrower operations / trove manager addresses by collateral branch
- stablecoin token address
- collateral asset metadata per branch
- optional base-rate / redemption fee selector
- optional recovery-mode / shutdown selector

Outputs:

- reserve slices from branch collateral
- `metadata.redemption.capacityKind = "live-direct-bounded"`
- `metadata.redemption.routeStatus = open/degraded/paused`
- current redemption fee if available
- oracle freshness if price feed timestamps are accessible

Blocker:

- Exact ABI/address mapping is protocol-specific and cannot be safely guessed from docs alone.

