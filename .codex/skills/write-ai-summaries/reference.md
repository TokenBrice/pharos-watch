## AI Summary Writer — Extended Reference

The data-source field catalogs, claim-token rules and additional editorial angles. Source files win over every list here.

### Data Sources

#### Static Metadata (always read)

Stablecoin metadata lives in `shared/data/stablecoins/coins/*.json` (generated into `shared/data/stablecoins/coins.generated.json` at build-time). Find the coin's entry by `id` and check:

- **Classification flags**: `flags.backing`, `flags.governance`, `flags.pegCurrency`, `flags.yieldBearing`, `flags.navToken` (a pricing flag only)
- **Listing class**: the coin's authored class in `shared/data/stablecoins/listing-decisions.json`; [listing classes](../../../docs/listing-policy.md#listing-classes) decides whether it counts in stablecoin totals and whether it is graded
- **Collateral & mechanism**: `collateral` (free-text description), `pegMechanism` (how peg is maintained)
- **Reserve composition**: `reserves[]` — slices with `name`, `pct`, `coinId` + `depType` for dependency tracking, and the Safety Score backing fields (`assetClass`, `issuerOrObligor`, `liquidityHorizon`, `maturityDaysMax`, `riskFactors`) that make a reserve-structure paragraph specific. For many coins this lives in the sidecar `shared/data/stablecoins/domains/reserves/<id>.json`, alongside `reserveReview` and `custodyProfile` — not the base file
- **Resilience sub-factors**: `custodyModel`, `collateralQuality`, `governanceQuality` — valid values live in `shared/types/custody.ts` (`CUSTODY_MODEL_VALUES`), `shared/types/reserves.ts` (`CollateralQualitySchema`) and `shared/types/stablecoin-taxonomy.ts` (`GovernanceQualitySchema`). These drive the Selector and DDR verdicts, not Safety Score grades
- **Jurisdiction**: `jurisdiction.country`, `jurisdiction.regulator`, `jurisdiction.license`
- **Proof of reserves**: `proofOfReserves.type` and `.provider`; read `PROOF_OF_RESERVES_TYPE_VALUES` in `shared/types/reserve-assurance.ts` for the current engagement vocabulary, and `latestReport` for the reviewed assurance scope
- **Dependencies**: `dependencies[]` — upstream stablecoins with `weight` and `type`; `shared/types/dependency-types.ts` owns the vocabulary
- **Blacklist exposure**: `blacklistabilityReview.reviewedStatus` in the base entry or risk-review sidecar; `shared/types/stablecoin-meta-primitives.ts` owns its vocabulary, including inherited exposure. The detail page uses the resolved `blacklistStatus`, not a `canBeBlacklisted` field
- **Yield config**: `yieldConfig.yieldSource`, `yieldConfig.yieldType`; `YIELD_TYPE_VALUES` in `shared/types/yield-vocabulary.ts` owns the current vocabulary
- **Deployment footprint**: `contracts[]` (count and chains), `tradedContracts[]`
- **Notices**: `notices[]` — the page surfaces notice types from `COIN_NOTICE_TYPE_VALUES` in `shared/types/stablecoin-lifecycle.ts`
- **Links**: `links[]` — official sources for fact-checking

#### Live Analytical Data (check when refreshing or writing high-profile coins)

The detail page at `pharos.watch/stablecoin/{id}` shows live scoring and analytical data. Inspect it in a browser when the session can, and check:

- **Report card (Safety Score)**: Overall grade (A+ to F, or NR when evidence is insufficient) and the three pillars — backing, exit, economic control — with per-mechanism breakdown bars, binding caps ("why not higher"), and the mechanism review panel. Look for the interesting story: a strong overall grade with one weak pillar, a cap-held score, or an NR on a well-known coin
- **Peg score**: 0-100 score, active depeg status, depeg event count, worst historical deviation
- **Liquidity score**: 0-100 score, DEX TVL, concentration (HHI), and coverage class from `LiquidityCoverageClassSchema` in `shared/types/dex-liquidity.ts`
- **Redemption backstop**: Route family, access model, settlement model/terms, fees, and capacity ratio; read the current enums in `shared/types/redemption.ts` rather than reducing every route to a permissionless/whitelisted binary
- **DEWS stress band**: CALM→DANGER scale; the band vocabulary lives in `shared/lib/dews-config.ts` (source file wins)
- **Yield**: Current APY, Pharos Yield Score with its source-risk breakdown, safety grade
- **Mint/burn flows**: Net flow direction, flow intensity, pressure shift

### Claim Tokens

- Tokens: `{{grade}}`, `{{score}}`, `{{supplyUsd}}`. Each token used must occur exactly once in `text`, with one `claimTokens` entry carrying `token`, `placeholder`, an allowed `source` from `AI_SUMMARY_CLAIM_REGISTRY` (`shared/types/editorial.ts`), and a calendar-valid `factsAsOf` day.
- Multiple distinct tokens are allowed, but two grade claims cannot bind to different sources through the same `{{grade}}` token.
- The detail page resolves tokens from its live hero/report-card data. A missing value or a malformed/unregistered token withholds the summary card, and the build-time static fallback renders the neutral availability notice.
- Only active coins carry tokens; pre-launch summaries render literally.
- `shared/lib/__tests__/ai-summary-claims.test.ts` validates the edited data file.

### What to Cover — additional angles

- **Reserve structure**: When the reserve composition tells a story — concentration in a single asset, dependency chains through other stablecoins, exotic collateral, mismatches between backing claims and actual slices — interpret it
- **Exit liquidity reality**: Can you actually get out? The combination of redemption backstop data (route family, access model, settlement speed) and DEX liquidity (TVL, concentration, coverage class) tells the real story of how trapped your dollars are
- **Dependency chain**: When a stablecoin wraps or depends on other stablecoins, trace the trust chain. A coin backed by a coin backed by BlackRock's BUIDL is three layers deep — that's worth noting
