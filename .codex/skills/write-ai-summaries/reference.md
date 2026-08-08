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
- **Proof of reserves**: `proofOfReserves.type` (independent-audit / real-time / self-reported), `.provider`
- **Dependencies**: `dependencies[]` — upstream stablecoins with `weight` and `type` (wrapper / mechanism / collateral)
- **Blacklist exposure**: `canBeBlacklisted` (true / false / "possible")
- **Yield config**: `yieldConfig.yieldSource`, `yieldConfig.yieldType` (lending-vault / rebase / fee-sharing / lp-receipt / nav-appreciation / governance-set)
- **Deployment footprint**: `contracts[]` (count and chains), `tradedContracts[]`
- **Notices**: `notices[]` — danger/warning/info notices the page surfaces to users
- **Links**: `links[]` — official sources for fact-checking

#### Live Analytical Data (check when refreshing or writing high-profile coins)

The detail page at `pharos.watch/stablecoin/{id}` shows live scoring and analytical data. Use the browser tool (claude-in-chrome or Playwright in Claude Code; `agent-browser` in Codex) to check:

- **Report card (Safety Score V9)**: Overall grade (A+ to F, or NR when evidence is insufficient) and the three pillars — backing, exit, economic control — with per-mechanism breakdown bars, binding caps ("why not higher"), and the mechanism review panel. Look for the interesting story: a strong overall grade with one weak pillar, a cap-held score, or an NR on a well-known coin
- **Peg score**: 0-100 score, active depeg status, depeg event count, worst historical deviation
- **Liquidity score**: 0-100 score, DEX TVL, concentration (HHI), coverage class (primary vs fallback)
- **Redemption backstop**: Route family (stablecoin-redeem / collateral-redeem / psm-swap / offchain-issuer), access model (permissionless vs whitelisted), settlement speed, fee bps, capacity ratio
- **DEWS stress band**: CALM→DANGER scale; the band vocabulary lives in `shared/lib/dews-config.ts` (source file wins)
- **Yield**: Current APY, yield-to-risk ratio, safety grade
- **Mint/burn flows**: Net flow direction, flow intensity, pressure shift

### What to Cover — additional angles

- **Reserve structure**: When the reserve composition tells a story — concentration in a single asset, dependency chains through other stablecoins, exotic collateral, mismatches between backing claims and actual slices — interpret it
- **Exit liquidity reality**: Can you actually get out? The combination of redemption backstop data (route family, access model, settlement speed) and DEX liquidity (TVL, concentration, coverage class) tells the real story of how trapped your dollars are
- **Dependency chain**: When a stablecoin wraps or depends on other stablecoins, trace the trust chain. A coin backed by a coin backed by BlackRock's BUIDL is three layers deep — that's worth noting
