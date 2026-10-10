## AI Summary Writer — Extended Reference

Material moved verbatim from `SKILL.md`: the data-source field catalogs and additional editorial angles.

### Data Sources

#### Static Metadata (always read)

Stablecoin metadata lives in `shared/data/stablecoins/coins/*.json` (generated into `shared/data/stablecoins/coins.generated.json` at build-time). Find the coin's entry by `id` and check:

- **Classification flags**: `flags.backing`, `flags.governance`, `flags.pegCurrency`, `flags.yieldBearing`, `flags.navToken`
- **Collateral & mechanism**: `collateral` (free-text description), `pegMechanism` (how peg is maintained)
- **Reserve composition**: `reserves[]` — slices with `name`, `pct`, `coinId` + `depType` for dependency tracking, and the V9 scoring fields (`assetClass`, `issuerOrObligor`, `liquidityHorizon`, `maturityDaysMax`, `riskFactors`) that make a reserve-structure paragraph specific. For many coins this lives in the sidecar `shared/data/stablecoins/domains/reserves/<id>.json`, alongside `reserveReview` and `custodyProfile` — not the base file
- **Resilience sub-factors**: `custodyModel`, `collateralQuality`, `governanceQuality` — valid values live in `shared/types/core.ts` (the source file wins). These drive the Selector and DDR verdicts, not V9 grades
- **Jurisdiction**: `jurisdiction.country`, `jurisdiction.regulator`, `jurisdiction.license`
- **Proof of reserves**: `proofOfReserves.type` and `.provider`; read `PROOF_OF_RESERVES_TYPE_VALUES` in `shared/types/core.ts` for the current engagement vocabulary, and `latestReport` for the reviewed assurance scope
- **Dependencies**: `dependencies[]` — upstream stablecoins with `weight` and `type`; `shared/types/dependency-types.ts` owns the vocabulary
- **Blacklist exposure**: `blacklistabilityReview.reviewedStatus` in the base entry or risk-review sidecar; `shared/types/stablecoin-meta-schemas.ts` owns its vocabulary, including inherited exposure. The detail page uses the resolved `blacklistStatus`, not a `canBeBlacklisted` field
- **Yield config**: `yieldConfig.yieldSource`, `yieldConfig.yieldType`; `YIELD_TYPE_VALUES` in `shared/types/core.ts` owns the current vocabulary
- **Deployment footprint**: `contracts[]` (count and chains), `tradedContracts[]`
- **Notices**: `notices[]` — the page surfaces notice types from `COIN_NOTICE_TYPE_VALUES` in `shared/types/core.ts` (the source file wins)
- **Links**: `links[]` — official sources for fact-checking

#### Live Analytical Data (check when refreshing or writing high-profile coins)

The detail page at `pharos.watch/stablecoin/{id}` shows live scoring and analytical data. Use available browser-inspection capability (mapped in `docs/process/agent-artifacts.md#harness-configuration`) to check:

- **Report card (Safety Score V9)**: Overall grade (A+ to F, or NR when evidence is insufficient) and the three pillars — backing, exit, economic control — with per-mechanism breakdown bars, binding caps ("why not higher"), and the mechanism review panel. Look for the interesting story: a strong overall grade with one weak pillar, a cap-held score, or an NR on a well-known coin
- **Peg score**: 0-100 score, active depeg status, depeg event count, worst historical deviation
- **Liquidity score**: 0-100 score, DEX TVL, concentration (HHI), and coverage class from `LiquidityCoverageClassSchema` in `shared/types/market.ts`
- **Redemption backstop**: Route family, access model, settlement model/terms, fees, and capacity ratio; read the current enums in `shared/types/redemption.ts` rather than reducing every route to a permissionless/whitelisted binary
- **DEWS stress band**: CALM→DANGER scale; the band vocabulary lives in `shared/lib/dews-config.ts` (source file wins)
- **Yield**: Current APY, yield-to-risk ratio, safety grade
- **Mint/burn flows**: Net flow direction, flow intensity, pressure shift

### What to Cover — additional angles

- **Reserve structure**: When the reserve composition tells a story — concentration in a single asset, dependency chains through other stablecoins, exotic collateral, mismatches between backing claims and actual slices — interpret it
- **Exit liquidity reality**: Can you actually get out? The combination of redemption backstop data (route family, access model, settlement speed) and DEX liquidity (TVL, concentration, coverage class) tells the real story of how trapped your dollars are
- **Dependency chain**: When a stablecoin wraps or depends on other stablecoins, trace the trust chain. A coin backed by a coin backed by BlackRock's BUIDL is three layers deep — that's worth noting
