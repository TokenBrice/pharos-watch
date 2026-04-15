# Redemption Backstop Adapter Upgrade Research Dossier

Date: 2026-04-15

## Purpose

Research every adapter/probe upgrade that should be considered before tightening Redemption Backstop Safety Score eligibility. This dossier supports the rollout plan in `agents/plans/2026-04-15-redemption-backstop-adapter-upgrade-rollout-plan.md`.

The focus is implementability:

- source URLs
- machine-readable or onchain path
- exact fields to collect
- expected capacity tier
- freshness model
- route-status signals
- scoring use
- risks and tests

## Research Standard

Use this decision rule:

- If a protocol exposes current queue position, current available liquidity, current route status, or current onchain balances, build or upgrade an adapter.
- If the source only proves general reserve backing or legal/issuer terms, use it for route quality and provenance, not high Safety Score Liquidity / Exit.
- If current evidence requires private credentials, make the adapter optional and fail closed when credentials are missing.
- If no current public state exists, keep the route visible but expect some score loss under stricter Safety Score eligibility.

## Final Verification Corrections

The final primary-source verification pass did not find major underconfidence. It mainly found places where the plan needed sharper product separation or a more conservative capacity tier.

Corrections to carry into implementation:

- **Frax:** split `frxusd-frax` and `fpi-frax`. frxUSD is a multi-path RWA/custodian redemption system. FPI is CPI-indexed and mints/redeems against FRAX through the controller pool; do not model FPI like a dollar redemption asset.
- **M0:** keep primary-market / permissioned semantics. Protocol and Orchestration APIs are API-keyed and should not imply broad any-holder redemption.
- **Usual:** split direct `DaoCollateral` redemption from indirect `SwapperEngine` order matching. The indirect path has a minimum size and partner matching constraints.
- **Sky:** frame DAI/USDS as Sky LitePSM + DAI/USDS converter routes, not generic legacy Maker PSM.
- **GHO:** model facilitator bucket / GSM behavior, not issuer-style cash redemption. Track current facilitator/GSM architecture.
- **Ethena:** treat USDe redemption as greenlisted, RFQ/quote/limit driven, not open unconditional liquidity.
- **Falcon:** model classic vs claim redemption paths and 7-day cooldown explicitly; do not treat transparency TVL as immediate redeemable liquidity.
- **Reservoir:** verify the exact product-specific redemption surface before expanding; generic reservoir.fi DEX/asset-management docs are not enough.
- **OpenEden:** split USDO and TBILL. TBILL is FIFO queue / next-business-day semantics; USDO has daily queue plus instant facility with capped liquidity.
- **USD.AI:** split USDai instant route from sUSDai 30-day FIFO queue and offchain servicing.
- **Re:** split reUSD immediate-bounded capacity from reUSDe windowed/Curve-liquidity route.
- **Neutrl:** not first-wave; audit PDFs and roles are not enough for current capacity.
- **Mento:** update naming/scope. Mento V3 centers on USDm/EURm; legacy cUSD/cEUR reserve semantics need current mapping before adapter work.
- **Liquity:** split V1 LUSD and V2 BOLD. Redemptions are profitability-driven and collateral-mix based, not reserve-capacity based.
- **Issuer transparency:** Circle, Paxos, Ripple, SG-FORGE, Brale/Bridge are transparency/provenance upgrades, not live-capacity adapters unless a current redemption status/capacity API is found.
- **Gold/Kinesis:** physical-bullion redemption routes need withdrawal minimums/logistics; do not score as instant generic liquidity.

## A. Cleanest Score-Preservation Candidates

### A1. Cap cUSD

Assets:

- `cusd-cap`

Sources:

- `https://docs.cap.app/protocol-overview/cusd-mechanics`
- `https://docs.cap.app/concepts/vault`
- `https://docs.cap.app/smart-contracts/vault`
- `https://docs.cap.app/concepts/vault/minter`
- `https://docs.cap.app/concepts/vault/fractional-reserves`
- `https://docs.cap.app/developers/addresses`

Research findings:

- cUSD can be redeemed proportionally from the underlying basket.
- Vault docs describe `mint`, `burn`, `redeem`, `borrow`, `repay`.
- Vault state includes asset list, total supplies, total borrows, utilization, available balance, asset pause, and protocol pause.
- Mint/burn are disabled if oracle prices are stale.

Adapter path:

- New onchain adapter: `cap-vault`.
- Capacity kind: `live-direct-bounded`.
- Freshness: `same-run-onchain`, plus oracle `updatedAt`.
- Holder eligibility: any holder for proportional redemption.
- Settlement: atomic/immediate.

Probe fields:

- `assets()`
- `totalSupplies(asset)`
- `totalBorrows(asset)`
- `availableBalance(asset)`
- `utilization(asset)`
- asset `paused(asset)`
- protocol pause state
- oracle price and `updatedAt`
- redeem quote / fee if exposed through Minter
- current basket composition and per-asset amount out

Scoring use:

- Replace `documented-eventual` full-supply route with live bounded basket capacity.
- Eligible for Safety Score uplift when vault and assets are unpaused and oracle is fresh.

Risks:

- Basket socialization during underlying depeg.
- Stale oracle should hard-disable capacity.
- Per-asset pause can reduce proportional redeemability.
- Dynamic fee math can drift from docs.

Tests:

- protocol paused -> routeStatus `paused`, no uplift
- one asset paused -> capacity reduced or route degraded
- stale oracle -> `missing-capacity` or `degraded`
- total supply vs available balance reconciliation
- fee quote math

### A2. Frax frxUSD / FPI

Assets:

- `frxusd-frax`
- `fpi-frax`

Sources:

- `https://docs.frax.com/frxusd`
- `https://docs.frax.com/fraxnet/contracts/fraxnetDeposit`
- `https://docs.frax.com/fraxnet/contracts/frxUsdCustodians`
- `https://docs.frax.com/fraxnet/contracts/rwaRedemptionCoordinator`
- `https://docs.frax.com/protocol/integration/api`
- `https://docs.frax.finance/frax-price-index/overview-cpi-peg-and-mechanics`
- `https://docs.frax.finance/frax-price-index/fpi-controller-pool`

Research findings:

- frxUSD has custodian-specific mint/redeem surfaces and an RWA redemption coordinator.
- Public docs describe custodian balances, mint/redeem caps, fees, max slippage, and route selection.
- FPI has an onchain controller pool and documented redeem fee / CPI peg mechanics.

Adapter path:

- New adapter: `frax-redemption`.
- Capacity kind:
  - frxUSD: `live-direct-bounded`
  - FPI: `live-direct-bounded`
- Freshness: `same-run-onchain` plus oracle timestamps where used.
- Holder eligibility:
  - frxUSD direct onchain route where available; bank/KYC paths remain restricted.
  - FPI controller pool semantics.

Probe fields:

- custodian balance
- custodian mint cap / redeem cap
- redeem fee
- `maxSlippage`
- coordinator path selection
- RWA redemption threshold
- bridge/cross-chain target status if route uses cross-chain path
- FPI pool balance
- FPI `twammToPeg` / controller state
- CPI oracle answer and `updatedAt`

Scoring use:

- Move from `documented-eventual` to current bounded capacity.
- Add route status when caps are exhausted, oracle stale, pool depleted, or slippage guard would fail.

Risks:

- Multiple redemption paths with different liquidity.
- Custodian route vs RWA path can have different settlement semantics.
- Cross-chain/bridge dependency.
- Oracle/CPI staleness.

Tests:

- cap exhausted
- path-selection between custodian and RWA coordinator
- max slippage failure
- stale oracle
- fee math
- FPI pool depleted

### A3. M0 / M

Assets:

- `m-m0`
- M0-backed extensions such as `usdn-noble-dollar`, `musd-metamask` if mapped later

Sources:

- `https://docs.m0.org/api/overview/`
- `https://docs.m0.org/api/authentification/`
- `https://docs.m0.org/api/orchestration/supported-assets/`
- `https://docs.m0.org/api/recipes/network-supply/`
- `https://docs.m0.org/api/recipes/collateral-composition/`
- `https://docs.m0.org/api/recipes/token-overview/`
- `https://docs.m0.org/api/changelog/`
- `https://protocol-api.m0.org/graphql`
- `https://gateway.m0.xyz/v1/orchestration`

Research findings:

- M0 has documented Protocol API and Orchestration API.
- APIs are authenticated.
- Public docs include GraphQL collateral composition, network supply, token overview, supported assets, and orchestration quote surfaces.
- M is an issuance-layer / primary-market asset, not a broad retail redemption rail.

Adapter path:

- New adapter: `m0-redemption` or `m0-protocol-state`.
- Capacity kind: conservative `documented-bound` or `live-proxy-validated` unless direct burn/redeem path is proven for the relevant holder cohort.
- Freshness:
  - API timestamp / block timestamp where available.
  - Direct chain RPC fallback for score-grade fields if API indexer lag is unacceptable.
- Holder eligibility: `whitelisted-primary`.

Probe fields:

- total owed M (`totalOwedMs`)
- eligible collateral total
- token total supply by chain
- holder / extension balances
- supported assets list
- orchestration quote status if credentials exist
- block timestamp / indexer lag
- unsupported chain / stale API state

Scoring use:

- Preserve some M route credibility, but avoid treating it as any-holder immediate liquidity.
- Useful for M0-backed stablecoins if route-specific adapters later map orchestration paths.

Risks:

- API key dependency.
- Indexer lag explicitly exists.
- M0 primary route may not map cleanly to retail redemption.
- Chain coverage gaps.

Tests:

- missing API key fail closed
- stale indexer suppresses dynamic capacity
- direct-chain vs API divergence
- unsupported chain
- collateral/supply reconciliation

### A4. Usual USD0

Assets:

- `usd0-usual`

Sources:

- `https://docs.usual.money/usual-products/usd0-stablecoin/usd0/flow-and-architecture`
- `https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/usd0`
- `https://docs.usual.money/start-here/faq`
- `https://tech.usual.money/overview/features/usd0-mint-and-redeem-engine`
- `https://tech.usual.money/overview/architecture/role-management`
- `https://docs.usual.money/resources-and-ecosystem/analytics`

Research findings:

- USD0 has direct onchain redemption through `DaoCollateral`.
- Indirect USDC mint/redeem path uses `SwapperEngine` and collateral providers.
- Docs mention minimum order constraints and real-time onchain reserve verification.
- Route has permissioned and permissionless/indirect components.

Adapter path:

- New adapter: `usual-usd0`.
- Capacity kind:
  - direct collateral route: `live-direct-bounded`
  - indirect CP route: `live-proxy-validated` or `documented-bound`
- Freshness: same-run onchain for direct path; public analytics only as supporting evidence.
- Holder eligibility: split by path.

Probe fields:

- `DaoCollateral` reserve balances
- `SwapperEngine` order/matching state
- direct redeem availability
- collateral-provider coverage
- indirect minimum size
- oracle freshness
- Counter Bank Run / emergency mode
- eligible collateral set
- pause/role state

Scoring use:

- Preserve USD0 uplift where current direct/indirect capacity is proven.
- Cap indirect route if capacity depends on counterparties/CPs.

Risks:

- Dual-route semantics can overstate broad availability.
- CP dependence.
- Minimum order threshold.
- CBR/emergency states.
- Role/partner gating.

Tests:

- direct vs indirect route selection
- min order threshold
- pause/CBR state
- oracle freshness
- CP route unavailable

### A5. Superstate USTB

Assets:

- `ustb-superstate`

Sources:

- `https://docs.superstate.com/superstate-funds/ustb`
- `https://docs.superstate.com/superstate-funds/ustb/redeeming-ustb`
- `https://docs.superstate.com/welcome-to-superstate/smart-contracts`
- `https://docs.superstate.com/introduction-to-superstate/api`
- liquidity API referenced at `api.superstate.com`

Research findings:

- USTB redemptions can pay out USD or USDC.
- Docs say USDC redemptions are processed immediately when liquidity is available and point to a liquidity API.
- Ethereum token can initiate redemption via `offchainRedeem()`.
- Docs reference protocol redemption and RedemptionIdle contract.
- Continuous Pricing means redemption uses NAV/S when shares are received.

Adapter path:

- New adapter: `superstate-ustb-liquidity`.
- Capacity kind: `live-direct-bounded` when liquidity API or RedemptionIdle balance confirms USDC capacity.
- Freshness: liquidity API timestamp and onchain oracle / same-run balance.
- Holder eligibility: allowlisted / qualified investors.
- Settlement:
  - USDC payout immediate when liquidity exists.
  - USD payout same-day before cutoff, T+1 after cutoff.

Probe fields:

- liquidity API current capacity
- RedemptionIdle USDC balance
- `offchainRedeem()` availability
- `calculateUstbIn`
- `calculateSuperstateTokenOut`
- price oracle `latestRoundData`
- fund holiday / cutoff state if public
- allowlist status if caller-neutral check exists

Scoring use:

- Upgrade USTB from eventual issuer route to current USDC hot-liquidity bounded route.

Risks:

- Portal actions may require authentication.
- Allowlist gating.
- Market-day / holiday timing.
- Idle pool depletion.

Tests:

- liquidity API stale
- idle pool zero
- price oracle stale
- market cutoff behavior
- allowlist-denied route visible but not broadly eligible

### A6. Midas mTBILL

Assets:

- `mtbill-midas`

Sources:

- `https://docs.midas.app/tokens/mtbill`
- `https://docs.midas.app/how-does-it-work/issuance-and-redemption`
- `https://docs.midas.app/defi-integration/atomic-redemption`
- `https://docs.midas.app/how-does-it-work/transparency`
- `https://docs.midas.app/tokens/mtbill/independent-reporting`
- `https://docs.midas.app/defi-integration/price-oracle`
- `https://docs.midas.app/protocol-mechanics/smart-contracts`

Research findings:

- Midas docs describe atomic redemption and standard redemption.
- Independent reporting docs describe daily attestations and continuous collateral monitoring.
- Route can switch between instant/atomic capacity and standard queued settlement.
- Fee is documented at approximately 0.07% in source research.

Adapter path:

- New adapter: `midas-atomic-redemption`.
- Capacity kind:
  - `live-direct-bounded` for instant pool capacity
  - `live-queue` for standard redemption queue
- Freshness: daily attestation date plus onchain oracle freshness.
- Holder eligibility: KYC/AML screened / approved users.
- Settlement:
  - atomic when instant capacity exists
  - otherwise 1-7 business days

Probe fields:

- instant redemption capacity
- standard redemption queue state
- `redemptionMode`
- pending queue depth
- transparency attestation date
- oracle price
- minimums
- sanctions/KYC eligibility markers if public
- fee

Scoring use:

- Preserve current mTBILL route quality where instant pool exists.
- Cap route when only standard queue is available.

Risks:

- Shared redemption pool across products.
- Mode switching.
- Queue lag.
- Transparency page may require scraping unless API exists.

Tests:

- instant vs standard mode
- pool depleted
- queue depth parsing
- fee math
- stale attestation
- oracle mismatch

## B. Existing Live / Proxy Adapter Hardening

### B1. Sky / Maker PSM

Assets:

- `dai-makerdao`
- `usds-sky`

Current repo signal:

- `sky-makercore` emits current PSM USDC balance as `immediateRedeemableUsd`.
- Classified as live proxy.

Sources:

- Block Analitica/Sky group source in repo adapter.
- Sky / Maker LitePSM route docs in current config.

Upgrade:

- Keep as `live-proxy-validated`.
- Add explicit `capacityBasis = psm-balance-share`.
- Store source timestamp.
- Store supply denominator and derived ratio.
- Add LitePSM wrapper status if contract state is available.

Risks:

- PSM balance is executable route capacity but sourced from grouped reserve telemetry, not a dedicated limit API.
- DAI/USDS share the same liquidity path and need de-duplication notes.

### B2. GHO GSM

Asset:

- `gho-aave`

Current repo signal:

- Onchain tracked GSM backing, frozen/seized exclusion, and live worst buy fee.
- Strong direct current route.

Sources:

- `https://aave.com/help/gho-stablecoin/stability-module`
- current adapter reads GSM contracts.

Upgrade:

- Move flat fields into nested telemetry.
- Preserve same-run onchain freshness.
- Add routeStatus when all modules are frozen/seized or fee strategy read fails.
- Keep residual issuance note as lower-bound semantics.

Risks:

- Tracked GSM modules may not cover all issuance.
- Residual issuance warning should not invalidate lower-bound capacity but should stay visible.

### B3. ZCHF Frankencoin Bridge

Asset:

- `zchf-frankencoin`

Current repo signal:

- Onchain VCHF StablecoinBridge balance from `collateral-positions-api`.

Sources:

- Frankencoin bridge Etherscan source already in config.
- Frankencoin and VNX docs.

Upgrade:

- Classify as `live-direct-bounded`.
- Store bridge token balance, block freshness, and price source.
- Probe pause/owner controls if available.

Risks:

- Direct route exits to VCHF, not fiat CHF.
- Price source must remain trustworthy.

### B4. Ethena USDe

Asset:

- `usde-ethena`

Current repo signal:

- Existing adapter can emit Liquid Cash stable bucket, but current production row is fallback/low-confidence.

Sources:

- `https://docs.ethena.fi/solution-overview/peg-arbitrage-mechanism`
- `https://docs.ethena.fi/resources/usde-terms-and-conditions`
- Ethena collateral API.

Upgrade:

- Normalize capacity ratio against USDe supply.
- Treat Liquid Cash as `live-proxy-validated`, not direct.
- Require source timestamp and route status.
- Add whitelisted-primary holder eligibility.
- Cap Safety Score uplift unless direct hot redemption amount is proven.

Risks:

- Liquid Cash is not necessarily public any-holder redemption capacity.
- Terms restrict users and can impose operational constraints.

### B5. Falcon USDF

Asset:

- `usdf-falcon`

Current repo signal:

- Transparency API stable bucket.

Sources:

- Falcon redeem guide.
- Falcon transparency API.
- Falcon redemptions docs.

Upgrade:

- Add settlement delay: 7-day cooldown for redemption.
- Classify as `live-queue` or `live-proxy-validated`.
- Add TVL, issued/staked supply, cooldown status, insurance fund, and redemption type.
- Reduce noise from de minimis unmapped assets.

Risks:

- KYC/geo restrictions.
- Classic vs claim redemptions have different semantics.
- No documented public queue API.

### B6. InfiniFi iUSD

Asset:

- `iusd-infinifi`

Current repo signal:

- `totalLiquidAssetNormalized`, total TVL, pending redemptions.

Upgrade:

- Add source timestamp requirement or fail to unverified.
- Use pending redemptions to reduce current capacity.
- Distinguish liquid asset bucket from executable redemption capacity.
- Add route status if protocol API exposes enabled/paused state.

Risks:

- Protocol API currently lacks trustworthy timestamp in current adapter.
- Liquid assets may not equal immediate redeemable capacity.

### B7. Reservoir wsrUSD

Asset:

- `wsrusd-reservoir`

Current repo signal:

- Timestamp-poor balance sheet feed; current production uses documented fallback.

Sources:

- `https://docs.reservoir.xyz/protocol-architecture/peg-stability-module`

Upgrade:

- Find/read onchain PSM balances if addresses are public.
- Preserve documented 25 bps fallback.
- If onchain route found, classify as `live-direct-bounded` or `live-proxy-validated`.

Risks:

- Current API has no trustworthy source timestamp.
- USDC positions may not equal public redemption capacity.

### B8. OpenEden USDO

Asset:

- `usdo-openeden`

Current repo signal:

- Adapter emits USDC amount and ratio, but current production row is unresolved due degraded latest snapshot.

Sources:

- `https://openeden.com/usdo/transparency`
- `https://docs.openeden.com/tbill/redemptions`

Upgrade:

- Fix source degradation / timestamp parsing.
- Classify USDO USDC amount as `live-direct-bounded`.
- Add route-status and settlement metadata.
- Consider separate TBILL queue adapter.

Risks:

- OpenEden source may block/fail with browser checks.
- USDO and TBILL settlement semantics differ.

## C. Queue Adapter Research

### C1. Maple syrupUSDC / syrupUSDT

Assets:

- `syrupusdc-maple`
- `syrupusdt-maple`

Sources:

- `https://docs.maple.finance/integrate-syrupusd/backend-integrations`
- `https://docs.maple.finance/syrupusdc-for-lenders/risk`
- `https://docs.maple.finance/technical-resources/withdrawal-managers/withdrawal-manager-queue`
- `https://api.maple.finance/v2/graphql`

Research findings:

- Maple documents contract and GraphQL access.
- WithdrawalManagerQueue exposes queue state.
- Withdrawals are FIFO, usually under 24h, but can take up to 30 days.

Adapter path:

- New adapter: `maple-withdrawal-queue`.
- Capacity kind: `live-queue`.
- Freshness: onchain queue state plus GraphQL/subgraph timestamp.
- Settlement delay cap:
  - <= 24h best case
  - up to 30d stress cap

Probe fields:

- `WithdrawalManagerQueue.nextRequest.id`
- next request shares
- next request status
- queue order/position
- pool lending balance
- total shares
- available liquidity
- `requestRedeem()` events

Risks:

- Permissioned/KYC pool.
- Admin `removeRequest`.
- FIFO blockage under low liquidity.
- Exchange-rate drift.

Tests:

- queue-depth indexing
- stale API suppression
- partial processing
- admin removal
- 30d cap behavior

### C2. USD.AI USDai / sUSDai

Assets:

- `usdai-usd-ai`
- `susdai-usd-ai`

Sources:

- `https://docs.usd.ai/faq/usdai-and-susdai-101`
- `https://docs.usd.ai/technical-protocol-overview`
- `https://docs.usd.ai/technical-overview/contract-addresses`
- `https://docs.usd.ai/app-guide/activity`
- `https://docs.usd.ai/structured-finance-for-limited-liquidity/queue-extractable-value-qev`

Research findings:

- USDai has instant redemption semantics.
- sUSDai has fixed 30-day redemption windows.
- Activity UI shows unlock dates/time remaining.
- Redemption logic is onchain; no public queue API confirmed.

Adapter path:

- New adapter: `usdai-redemption`.
- Capacity kind:
  - USDai: `live-direct-bounded`
  - sUSDai: `live-queue`
- Freshness: onchain buffer and queue state; app snapshot only as supporting evidence.

Probe fields:

- instant liquidity buffer
- next redemption window
- pending withdrawals
- unlock date
- time remaining
- FIFO queue state
- `serviceRedemptions()` processing

Risks:

- Long-dated collateral.
- Offchain servicing cadence.
- Queue/auction ordering.

Tests:

- instant vs queued route
- buffer depletion
- next-window ETA
- queue ordering
- serviceRedemptions consumption

### C3. Falcon USDF

See B5. Queue-specific additions:

- Track classic vs claim redemption path.
- Track 7-day cooldown.
- Track sUSDf unstake 3-day cooldown if relevant for route graph.
- Use insurance fund as stress context, not direct capacity unless route docs prove it.

### C4. Neutrl NUSD

Asset:

- `nusd-neutrl`

Sources:

- official docs pages were not enough during this pass.
- Public audit PDFs found:
  - `https://docs.neutrl.fi/pdf/report-cantinacode-neutrl-2407.pdf`
  - `https://docs.neutrl.fi/pdf/2025.09.12%20-%20Final%20-%20Neutrl%20Public%20Audit%20Contest%20Report.pdf`

Research findings:

- Public audit docs mention roles like `REDEEMER_ROLE`, `KEEPER_ROLE`, `WHITELISTER_ROLE`, `PAUSER_ROLE`, and adjustable waiting periods.
- No clean public queue/status/capacity surface was verified.

Recommendation:

- Do not include Neutrl in first-wave score-preservation adapter builds.
- Create research-first task:
  - verify contract addresses / ABI
  - inspect pause/waiting-period/redemption role state
  - only then decide adapter viability

Capacity kind:

- Not defensible as high-confidence current capacity yet.

### C5. Re Protocol reUSD / reUSDe

Assets:

- `reusd-re-protocol`

Sources:

- `https://app.re.xyz/transparency`
- `https://app.re.xyz/redeem`
- `https://app.re.xyz/reusd`
- `https://app.re.xyz/reusde`

Research findings:

- Dashboard exposes Total Redemption Capacity and Remaining Daily.
- reUSD can be instant when capacity exists; queues until capacity replenishes when not.
- reUSDe has quarterly windows or Curve exit.

Adapter path:

- New adapter: `re-protocol-redemption`.
- Capacity kind:
  - reUSD: `live-direct-bounded`
  - reUSDe: `live-queue` or `documented-eventual`
- Freshness: dashboard/API timestamp; fail closed if stale.

Probe fields:

- total redemption capacity
- remaining daily capacity
- per-chain capacity
- total supply
- reserves
- TVL
- premium receivable
- queue/open status

Risks:

- Dashboard may not expose official API.
- Minimum capital requirement.
- Chain-specific limits.

Tests:

- capacity drain
- queue fallback
- stale dashboard
- per-chain totals
- windowed redemptions

### C6. Avant avUSD / savUSD / avUSDx

Assets:

- `avusd-avant`

Sources:

- `https://docs.avantprotocol.com/overview/using-the-avant-protocol/redeeming-avassets`
- `https://docs.avantprotocol.com/overview/using-the-avant-protocol/redeeming-avassetx`
- `https://docs.avantprotocol.com/overview/using-the-avant-protocol/unstaking-savassets`
- `https://docs.avantprotocol.com/security/contract-addresses`
- `https://docs.avantprotocol.com/legal-and-risk/risks`

Research findings:

- avUSD redemptions often complete within hours but can take up to 7 days.
- Active redemptions are visible in the portfolio.
- Requests can be canceled or adjusted before finalization.
- Fees may apply and are displayed in UI.

Adapter path:

- New adapter: `avant-redemption-queue`.
- Capacity kind: `live-queue`.
- Freshness: onchain/app active-redemption state.

Probe fields:

- active redemptions
- ready time
- cooldown status
- cancel/adjust state
- redemption fee
- multiple request handling

Risks:

- No official public queue API confirmed.
- Timer reset on adjustment.
- Fee variability.

Tests:

- active lifecycle
- cancel/adjust overwrite
- cooldown rollover
- final-price/fee handling

### C7. Cygnus cgUSD

Assets:

- `cgusd-cygnus-finance`

Sources:

- `https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/protocol-mechanics/redemption`
- `https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/faq/withdrawals`
- `https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/token-and-contract/cgusd`
- `https://wiki.cygnus.finance/whitepaper/cygnus-omnichain-liquidity-validation-system-lvs/cygnus-lvs-integration/cgusd-v1/token-and-contract/cgusd/how-it-works`

Research findings:

- Redemption path is queue/NFT based.
- Queue and claimable states are onchain.
- Settlement typically 2-5 days.
- Release depends on oracle/batch updates and treasury conversion to USDC.

Adapter path:

- New adapter: `cygnus-redemption-queue`.
- Capacity kind: `live-queue`.
- Freshness: onchain queue/NFT state plus oracle update cadence.

Probe fields:

- application queue NFT tokenId
- requested amount
- queue position
- claimable state NFTs
- current USDC/USDT balance
- next oracle update
- claimable batch state

Risks:

- Batch update dependency.
- Treasury conversion lag.
- Policy/fee changes.

Tests:

- NFT issuance
- queue order
- claim transition
- oracle-triggered release
- ETA computation

## D. Broader Adapter Upgrade Pass

### D1. Circle USDC / EURC

Assets:

- `usdc-circle`
- `eurc-circle`

Sources:

- `https://www.circle.com/en/transparency`
- `https://www.circle.com/en/eurc`

Adapter idea:

- Extend `circle-transparency`.
- Capacity kind: `documented-bound` / issuer current-reserve evidence.
- Use for issuer route confidence and reserve freshness, not direct any-holder immediate capacity.

Probe fields:

- reserve report freshness
- composition totals
- attestation dates
- issuance/redemption availability if public

### D2. Paxos PYUSD / USDP / USDG / PAXG

Assets:

- `pyusd-paypal`
- `usdp-paxos`
- `usdg-paxos`
- `paxg-paxos`

Sources:

- `https://www.paxos.com/mint-and-redeem`
- `https://www.paxos.com/attestations/`
- `https://www.paxos.com/pyusd-transparency`
- `https://www.paxos.com/usdg-transparency`
- `https://www.paxos.com/paxg-transparency`

Research findings:

- Paxos explicitly describes direct 1:1 redemption for some issued stablecoins and zero fees for PYUSD/USDG.
- Monthly reserve reports are public.

Adapter idea:

- New or extended `paxos-transparency`.
- Capacity kind: `documented-bound` with fresh attestation; not broad live-direct unless a current capacity API exists.

### D3. Ripple RLUSD

Asset:

- `rlusd-ripple`

Sources:

- `https://ripple.com/solutions/stablecoin/transparency/`

Adapter idea:

- Reserve report freshness / attestation adapter.
- Issuer route status/provenance upgrade.

### D4. SG-FORGE CoinVertible

Assets:

- `usdcv-societe-generale-forge`
- `eurcv-societe-generale-forge`

Sources:

- `https://www.sgforge.com/product/coinvertible/`

Adapter idea:

- Extend existing SG-FORGE reserve adapter with redemption telemetry.
- Daily reserve/circulation timestamp.
- Capacity kind: `documented-bound` / issuer current-reserve evidence.

### D5. Brale / Bridge-Issued Stablecoins

Assets:

- `sbc-brale`
- `cash-phantom`
- `musd-metamask`
- possible Bridge-issued routes

Sources:

- `https://brale.xyz/stablecoins/sbc`
- `https://docs.brale.xyz/`
- `https://brale.xyz/blog/our-approach-to-attestations`
- `https://apidocs.bridge.xyz/platform/issuance/faq`

Adapter idea:

- Brale API-keyed issuer-state adapter where credentials exist.
- Bridge issuance API adapter only if stable route/status can be queried.
- Fail closed without credentials.

### D6. Hashnote USYC

Asset:

- `usyc-hashnote`

Sources:

- `https://usyc.docs.hashnote.com/`
- `https://usyc.docs.hashnote.com/overview/subscription-and-redemption`
- `https://www.hashnote.com/products/cash-management`

Adapter idea:

- NAV/oracle freshness and redemption route-status adapter.
- Capacity kind: likely `documented-bound` or `live-proxy-validated` if a current redemption/Teller capacity API is found.

### D7. Mento Stable Assets - cUSD / cEUR / USDm / EURm Scope Check

Assets:

- `cusd-celo`
- `ceur-celo`

Sources:

- `https://docs.mento.org/mento/overview/getting-started/analytics-and-dashboards`
- `https://docs.mento.org/mento/overview/core-concepts/the-reserve`
- `https://reserve.mento.org/`

Adapter idea:

- Extend Mento reserve dashboard adapter.
- Current reserve/collateral composition and route state.
- Capacity kind: likely `live-proxy-validated` or `documented-bound`, depending on whether direct redeemable capacity can be proven.

### D8. Liquity LUSD / BOLD

Assets:

- `lusd-liquity`
- `bold-liquity`

Sources:

- `https://docs.liquity.org/liquity-v1/faq/lusd-redemptions`
- `https://docs.liquity.org/v2-faq/redemptions-and-delegation`

Adapter idea:

- Existing `liquity-v1` already emits redemption fee telemetry.
- Add capacity/status:
  - total debt
  - total collateral
  - redemption fee/base rate
  - paused/critical system status
  - trove ordering / redemption availability if feasible

Capacity kind:

- `live-direct-bounded` for fully onchain redemption route, but cap for market impact / collateral quality.

### D9. OpenEden TBILL

Asset:

- `tbill-openeden`

Sources:

- `https://docs.openeden.com/tbill/redemptions`
- `https://docs.openeden.com/tbill/faq`

Adapter idea:

- Extend OpenEden adapter to queue/next-business-day TBILL redemption.
- Probe redemption queue/status if public.
- Capacity kind: `live-queue` or `documented-bound`.

### D10. Tokenized Gold: PAXG / XAUt / XAUm / Kinesis

Assets:

- `paxg-paxos`
- `xaut-tether`
- `xaum-matrixdock`
- `kau-kinesis`
- `kag-kinesis`

Sources:

- Paxos PAXG transparency.
- Tether gold transparency/attestation.
- Matrixdock XAUm pages / redemption proof.
- Kinesis supply/reserve data already partially tracked in repo.

Adapter idea:

- Reserve/attestation freshness.
- Physical redemption threshold, settlement, eligibility.
- Do not treat physical redemption as immediate retail liquidity unless current executable route is public.

## E. Additional Final-Pass Candidates

The config inventory still contains many routes outside the first three waves. The following groups are worth capturing as backlog candidates so the rollout does not implicitly stop at the already-famous names.

### E1. Reserve Protocol RTokens / Basket Redeem Routes

Assets:

- `eusd-electronic-usd`
- `honey-berachain`

Current repo signal:

- Basket-redeem, eventual-only, documented-bound.
- Some assets have `evm-branch-balances` live reserve adapters.

Adapter idea:

- Add a generic `reserve-r-token` / basket-redemption adapter where contracts are public:
  - basket assets
  - backing manager balances
  - redemption basket quote
  - disabled basket / default state
  - issuance/redemption throttle if exposed
  - current fee if exposed

Capacity kind:

- `live-direct-bounded` if onchain basket redemption quote is current and route is open.
- Otherwise `documented-eventual` with improved reserve provenance.

Include/defer:

- Include as Tier 4/5 backlog. Stronger than generic issuer docs, but lower priority than Cap/Frax/Maple because expected product impact and current coverage are smaller.

### E2. Origin OUSD

Asset:

- `ousd-origin-protocol`

Current repo signal:

- Stablecoin-redeem, eventual-only, documented-bound, curated reserve fallback.

Adapter idea:

- Extend reserve/protocol adapter:
  - OUSD vault assets
  - current redeem quote
  - withdrawal fee
  - supported assets and paused/defaulted strategies
  - vault liquidity vs strategy-deployed assets

Capacity kind:

- `live-direct-bounded` only for immediately withdrawable vault liquidity.
- `documented-eventual` for strategy unwind capacity.

Include/defer:

- Include as backlog. Good defensible onchain candidate if contract ABI is straightforward.

### E3. Alchemix Transmuter

Asset:

- `alusd-alchemix`

Current repo signal:

- Queue-redeem, eventual-only, documented-bound.

Adapter idea:

- Add transmuter queue adapter:
  - transmuter buffer
  - total unexchanged claims
  - exchange rate / claimable amount
  - expected settlement velocity if derivable

Capacity kind:

- `live-queue`.

Include/defer:

- Include. It is a queue-style route with a protocol-native mechanism and should use the same queue telemetry model as Maple/Cygnus.

### E4. PSM / Swap-Floor Systems

Assets:

- `dola-inverse-finance`
- `buck-bucket-protocol`
- `lisusd-lista`
- `usdd-tron-dao-reserve`
- `dusd-alto`

Current repo signal:

- PSM routes, mostly supply-ratio documented bounds.
- Some have live reserve adapters: `dola-inverse`, `usdd-data-platform`.

Adapter idea:

- Add or extend per-protocol PSM adapters:
  - current stablecoin reserves in PSM
  - daily limits
  - fee bps
  - pause/route status
  - min/max redemption
  - current supply denominator

Capacity kind:

- `live-direct-bounded` if actual PSM balance is readable.
- `live-proxy-validated` where only reserve share is available.

Include/defer:

- Include as a dedicated PSM batch after current live adapters. These are high-value because PSM semantics are exactly what the backstop model wants, but each protocol needs source-specific proof.

### E5. Accountable / Dashboard-Backed Strategy Routes

Assets:

- `yusd-aegis`
- `usn-noon`
- `uty-xsy`
- `yzusd-yuzu`
- `aznd-mu-digital`
- `usdu-unitas`
- possibly `usdf-astherus` if its public dashboard/API is confirmed

Current repo signal:

- Several use Accountable or similar dashboards for reserves.
- Many are whitelisted/queue/strategy-backed and currently rely on conservative supply ratios.

Adapter idea:

- Build a generic dashboard-backed strategy adapter extension:
  - latest dashboard timestamp
  - stablecoin/cash buffer
  - strategy collateral split
  - immediate withdrawal buffer
  - queue status if shown
  - route eligibility and settlement docs

Capacity kind:

- `live-proxy-validated` for fresh dashboard cash buffer.
- `live-queue` if queue/current withdrawal state is available.
- Otherwise `documented-bound`.

Include/defer:

- Include as a research-and-adapter batch, but do not count on all of these preserving scores. Dashboards may prove collateral, not redemption capacity.

### E6. Additional Regulated Fiat Issuers

Assets / issuers:

- STASIS EURS
- Native Markets USDH
- Hex Trust USDX
- Fidelity FIDD
- MNEE
- Agora AUSD
- Tether USA-T
- StablR EURR/USDR
- Quantoz USDQ/EURQ
- Plume pUSD
- Gemini GUSD
- FDUSD First Digital
- TrueUSD
- VNX VEUR/VCHF/VGBP
- GMO GYEN/ZUSD
- IDRX
- MXNB
- JPYC
- AnchorX / Anchored Coins
- Banking Circle EURI
- AllUnity EURAU/CHFAU
- Monerium EURe
- Anzens USDA
- OSL USDGO
- WSPN WUSD
- Tether USDT if issuer transparency route is expanded beyond current curated fallback

Final-pass source notes:

- STASIS EURS has a public transparency page and a Chainlink PoR feed candidate; include as current reserve telemetry if feed semantics verify.
- Native Markets USDH has a public transparency page; include.
- Hex Trust USDX has issuer/product pages; include as issuer route/status evidence.
- Fidelity FIDD has official launch/explainer pages; include as issuer route evidence.
- MNEE has transparency and monthly third-party attestations; include.
- Agora AUSD has product/developer/docs surfaces; include.
- USAT has reserve-report pages; include as issuer transparency.
- StablR EURR/USDR has proof-of-reserve pages; include.
- Quantoz USDQ/EURQ has transparency, fee, and product pages; include.
- Plume pUSD has current docs/site references and was a prior audit hotspot; include if the reserve feed can expose current backing or redeemable inventory.
- Banking Circle EURI, Monerium EURe, StraitsX XUSD/XSGD, AllUnity EURAU/CHFAU, OSL USDGO, USDM, GYEN, JPYC, BRZ, IDRT, TRYB, CADC, TGBP, AUDD, and AXCNH remain defensible route-doc/provenance targets, but defer adapter work unless current public reserve/capacity feeds are found.

Adapter idea:

- Group these into issuer-transparency adapter families rather than one-off scoring logic:
  - attestation/report freshness
  - reserves vs circulating supply
  - issuer terms and eligibility
  - redemption fee / minimum / settlement
  - route status if public

Capacity kind:

- Usually `documented-bound` with current reserve freshness.
- Do not mark `live-direct` unless a current redeemable-capacity endpoint exists.

Include/defer:

- Include as Tier 5 / long-tail issuer transparency. Useful for provenance and confidence, but most should not materially raise Safety Score Liquidity / Exit without current executable capacity.

### E7. Additional Collateral-Redeem / CDP Routes

Assets:

- `fxusd-f-x-protocol`
- `feusd-felix`
- `meusd-mezo`
- `nect-beraborrow`
- `reusd-resupply`
- `satusd-river`
- `usbd-bima`
- `usdq-quill`
- `usdk-orki`
- `usnd-nerite`
- `usdaf-asymmetry`
- `ebusd-ebisu`
- `usdp-parallel`
- `ussd-sonic-labs`

Adapter idea:

- For each protocol, add current redemption state only when onchain mechanics are explicit:
  - total debt/supply
  - collateral backing
  - redemption fee
  - redemption queue/limit if any
  - paused/recovery mode
  - oracle freshness
  - protocol-specific minimums/slippage

Capacity kind:

- `live-direct-bounded` for fully onchain redemption routes with healthy current state.
- `documented-eventual` when only broad full-system redemption is documented.

Include/defer:

- Include as a broad CDP batch after Liquity/Frax templates exist. Use templates to avoid custom one-offs for every fork.

### E8. Additional Stablecoin Redeem Routes

Assets:

- `aid-gaib`
- `apxusd-apyx`
- `dusd-dtrinity`
- `jupusd-jupiter`
- `msusd-main-street`
- `ousg-ondo-finance`
- `u-united-stables`
- `usda-avalon`
- `usdf-astherus`
- `usr-resolv`
- `usx-solstice`
- `yousd-yield-optimizer`

Adapter idea:

- Split into:
  - whitelisted/issuer-mediated routes needing current app/API status
  - protocol-native vault redeem routes needing onchain liquidity/queue
  - incident-sensitive routes needing availability registry first

Capacity kind:

- Varies; default to `documented-bound` or `documented-eventual` until current machine-readable state is found.

Include/defer:

- Include as a final audit batch. Main Street and Ondo remain explicitly research-first; Resolv should be route-availability/incident-registry first before any capacity uplift.

## Recommended Wave Order

### Wave 1 - Build With Highest Confidence

1. Cap cUSD
2. Frax frxUSD / FPI
3. Usual USD0
4. Superstate USTB
5. Midas mTBILL
6. GHO / ZCHF hardening
7. Sky hardening

### Wave 2 - Queue Current-State Adapters

1. Maple syrupUSDC / syrupUSDT
2. USD.AI USDai / sUSDai
3. Re Protocol reUSD
4. Cygnus cgUSD
5. Avant avUSD
6. Falcon USDF

### Wave 3 - Actionable Issuer / RWA Transparency

1. Circle USDC / EURC
2. Paxos PYUSD / USDP / USDG / PAXG
3. Ripple RLUSD
4. SG-FORGE CoinVertible
5. Brale / Bridge-issued assets
6. STASIS EURS
7. Native Markets USDH
8. Hex Trust USDX
9. Fidelity FIDD
10. MNEE
11. Agora AUSD
12. Tether USA-T
13. StablR EURR / USDR
14. Quantoz USDQ / EURQ
15. Plume pUSD
16. OpenEden TBILL
17. Hashnote USYC
18. Mento stable assets: cUSD/cEUR plus current USDm/EURm scope verification
19. Liquity LUSD / BOLD
20. tokenized gold/Kinesis

### Wave 4 - Additional Protocol Templates

1. Reserve Protocol RTokens / basket-redemption routes
2. Origin OUSD
3. Alchemix Transmuter
4. PSM batch: DOLA, Lista, Bucket, USDD, Alto
5. Accountable/dashboard-backed strategy routes: Aegis, Noon, XSY, Yuzu, Mu, Unitas and similar
6. CDP/collateral-redeem template batch after Liquity/Frax patterns are proven

### Wave 5 - Docs-Heavy / Lower-ROI Issuer Transparency

1. Gemini GUSD, FDUSD, TrueUSD
2. VNX, GMO, IDRX, MXNB, JPYC, AnchorX
3. Banking Circle, AllUnity, Monerium, StraitsX
4. Anzens, OSL, WSPN, USDM, BRZ, IDRT, TRYB, CADC, TGBP, AUDD, AXCNH

### Hold / Research-First

- Neutrl NUSD until public current status/queue/capacity source is found.
- Ondo USDY/OUSG until product-specific machine-readable redemption capacity/status is found.
- Main Street msUSD until public current cap/queue/cooldown state is found.
- Reservoir wsrUSD product-specific route surface until verified beyond generic Reservoir docs.
