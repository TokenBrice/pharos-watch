# Report Cards Scoring — Version Timeline

Internal changelog reconstructed from git history plus the live version metadata source. Covers v1.0 through v7.291 (2026-02-25 → 2026-06-06). The newest sections track the machine-readable version source closely; older reconstructed sections below v6.92 preserve the original authoring-era grouping and are not guaranteed to be in strict descending source order. Use `shared/lib/methodology-versions/safety-score-data.ts` for canonical machine ordering.

> Older entries are archived in [report-cards-timeline-archive.md](./report-cards-timeline-archive.md); this file keeps the 10 most recent.

## v7.291 — Degraded-input history guard (2026-06-06)

- Safety Score scoring is unchanged from v7.29
- `snapshot-safety-grade-history` now suppresses durable seed and grade-transition writes while report-card snapshots are built with stale DEX liquidity or redemption-backstop inputs
- The compact `report_card_cache` score map now carries `degradedInputs` metadata so Chain Health and other lightweight consumers can downgrade freshness when cached scores came from degraded report-card inputs

## v7.29 — fxSAVE live redemption capacity (2026-05-27)

- `fxsave-f-x-protocol` now consumes live ERC-4626 reserve-sync redemption metadata instead of the previous 20% heuristic strategy-buffer estimate
- Fresh clean snapshots use the vault's idle fxSP balance as current direct redemption capacity, allowing the route to reach medium model confidence and feed Liquidity / Exit when the normal route-status and severe-depeg gates pass
- Missing, stale, or degraded fxSAVE live telemetry leaves the redemption route unrated rather than preserving a heuristic Safety Score uplift

## v7.28 — FreezeWatch curated upstream review audit (2026-05-25)

- Re-audits every active asset that still resolved as `No` after the four-status FreezeWatch migration
- M by M0, ISC, and USG now resolve as direct `Yes` based on Solana freeze authority or arbitrary holder-burn evidence
- DLLR, FXD, CJPY, USDQ, and USDK now resolve as `Possible` for mutable proxy, pause, manager-burn, or protocol-control paths without a confirmed active blacklist
- JUSD, SILK, NXUSD, LUAUSD, KRWO, and BNUSD now resolve as `Upstream` through stablecoin reserves, DAI collateral, Open Voucher redemption rails, or Stability Fund stablecoin collateral
- Curated `blacklistabilityReview.reviewedStatus: "inherited"` entries are honored as upstream status when there is no direct `canBeBlacklisted` override

## v7.27 — FreezeWatch removes Dilutable admin-mint tier (2026-05-24)

- Removes `Dilutable` from the report-card-backed FreezeWatch/freezability status model, leaving `Yes`, `Upstream`, `Possible`, and `No`
- Keeps privileged mint and mint-admin risk in the descriptive Mint Authority module rather than treating admin mint authority as holder-freeze exposure
- Re-reviews the former Dilutable set under freeze-only semantics: crvUSD, DAI, DOLA, FPI, JPYT, PHT, REUSD, srUSD, USDD, USDe, USDU, and XAI now resolve as `Upstream`; SMARDEX USDN resolves as `Possible`; KRWO, LUAUSD, and vCRED resolve as `No`

## v7.26 — NAV wrapper peg scoring uses configured peg references first (2026-05-21)

- NAV and savings wrappers with a configured peg reference now ignore their own appreciating share price for Safety Score peg scoring and active-depeg caps
- Yield-accruing wrapper prices above $1 no longer trigger D/F active-depeg caps solely because the share price has appreciated
- Tracked wrappers such as fxSAVE inherit peg risk from the configured base asset, while structural wrapper, dependency, collateral, and liquidity risks remain scored separately

## v7.25 — Wrapper decentralization inherits from tracked parent assets (2026-05-15)

- Tracked wrappers with a resolvable parent asset now derive Decentralization from the wrapped asset's Decentralization score instead of receiving the old flat 10-point wrapper score
- Savings wrappers inherit parent Decentralization minus 3 points; strategy-vault and risk-absorption variants inherit parent minus 5; bond-maturity variants inherit parent minus 8
- yBOLD and sBOLD now inherit from BOLD, while sfrxUSD inherits from frxUSD; wrappers without a resolvable single tracked parent keep the conservative fallback score of 10

## v7.24 — Capacity-aware redemption effective-exit blending (2026-05-12)

- Liquidity / Exit now consumes Redemption Backstop v4 current-capacity semantics instead of treating eventual route quality as current executable exit capacity
- Redemption contribution is scaled by executable capacity relative to modeled exit size and by model confidence
- The DEX/redemption diversification bonus now applies only to plausibly independent issuer rails; wrappers, same-protocol paths, same stablecoin-pool/backing routes, and unknown correlations do not receive the extra independence uplift

## v7.23 — sGHO and Reservoir reserve coverage refinements (2026-05-12)

- `sgho-aave` now uses a dedicated live reserve adapter that reads `previewRedeem(totalSupply)` from the legacy sGHO/stkGHO-compatible contract
- Reservoir reserve classification now maps AUSD and Steakhouse Prime USDC strategy rows from the live balance-sheet API, removing unknown-exposure degradation for clean srUSD/wsrUSD snapshots
- USD.AI reserve freshness now uses the latest scoped proof-row timestamp while preserving oldest/latest spread metadata, and mRe7YIELD permits a weekly Chainlink NAV update cadence

## v7.22 — Additional independent NAV and wrapper reserve feeds (2026-05-12)

- WTGXX, VBILL, ACRED, USTBL, EUTBL, and JTRSY now use timestamped Chainlink NAV feeds instead of curated validation or the failing ERC-7540 vault path
- USDCV now uses the SG Forge CoinVertible parser, aligning USD and EUR CoinVertible reserve freshness handling
- sUSDD and sUSN now use ERC-4626 wrapper reads with parent `coinId` links, so clean snapshots can drive collateral and dependency inputs from live reserve data

## v7.21 — crvUSD direct on-chain LLAMMA reserve reads (2026-05-12)

- `crvusd-curve` now reads Curve ControllerFactory markets and LLAMMA band balances directly on-chain, so its live reserve snapshot can use `freshnessMode: not-applicable`
- `bands_y` collateral balances drive BTC, tBTC, ETH, and LST reserve buckets; `bands_x` crvUSD soft-liquidation inventory is retained as metadata instead of being counted as external collateral
- Yield Basis exposure remains included through the existing on-chain factory and LT emergency-withdraw preview path
