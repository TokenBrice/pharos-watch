# Report Cards Scoring — Version Timeline - Archive

Older entries moved from [report-cards-timeline.md](./report-cards-timeline.md) to keep routed reads small; the live file holds the 10 most recent.

---

## v7.20 — Expanded Dilutable admin-mint classification with source provenance (2026-05-11)

- Expands the `Dilutable` freezability tier after a full tracked-universe sweep for explicit uncapped admin mint authority
- DAI, DOLA, FPI, PHT, USDD, USDe, USDN (SMARDEX), crvUSD, REUSD, USDU, and XAI now resolve as `Dilutable`
- Every `canBeBlacklisted: "dilutable"` metadata override now carries a `canBeBlacklistedSource` contract-source link, and the asset schema rejects Dilutable entries without one
- The homepage table and stablecoin detail hero expose the source link directly from the Dilutable status label

## v7.19 — Dilutable freezability tier and upgradeable-proxy / admin-mint audit (2026-05-11)

- Introduces a new `Dilutable` freezability tier between `No` and direct `Yes` for tokens whose admin can mint without bound but cannot freeze existing balances
- vCRED, LUAUSD, and srUSD now resolve as `Dilutable` because their token contracts expose `Ownable` mint or `AccessControl` minter-grant authority without supply caps
- HBD, mRe7YIELD, FEUSD (Felix), USDQ (Quill), and USDK (Orki) now resolve as direct `Freezable: Yes` after the audit confirmed transparent upgradeable proxies, Midas `Blacklistable`/`Pausable` mixins, or chain-native witness-seizure precedent (Hive Hardfork 23)
- BabelFish XUSD's explicit `canBeBlacklisted: false` override is removed so its bridged USDT/USDC reserve exposure now resolves to `Upstream` by default
- DJED, IUSD (Indigo), HYUSD, FXD, FUSD (Zano), NXUSD, SILK, DLLR, USG, LUSD, BOLD, CJPY, and JUSD (Juicedollar) keep their `Freezable: No` after token-contract or chain-level review

## v7.18 — Redemption freshness and daily-limit eligibility gates (2026-05-10)

- Severe active-depeg survivability now requires direct live capacity-kind evidence in addition to live-direct confidence, dynamic source mode, permissionless access, and atomic/immediate settlement
- Nested live redemption freshness marked `unverified` is excluded from Liquidity / Exit unless a route-specific lower-bound allowlist explicitly permits it
- Adapter-emitted daily redemption limits cap the usable redemption capacity for scoring, while raw immediate capacity and route constraints remain visible on redemption surfaces

## v7.17 — USD3 centralized-collateral dependency correction (2026-05-07)

- `usd3-reserve-protocol` now uses governance `centralized-dependent` instead of `decentralized`
- The correction reflects Savings USDS, Aave USDC, wrapped Compound USDCv3, and Steakhouse USDC strategy exposure in the curated and live reserve configuration
- Scoring weights, thresholds, reserve risks, and live reserve adapter behavior are unchanged

## v7.16 — Follow-up freezability classification audit (2026-05-06)

- Reviewed six disputed resolved `Freezable: No` classifications: HBD, vCRED, Freedom Dollar, LUAUSD, HomeCoin, and NXUSD
- HomeCoin now resolves as `Freezable: Possible` because the holder-facing HOME token is a transparent upgradeable proxy with an active proxy-admin upgrade surface
- HBD, vCRED, Freedom Dollar, LUAUSD, and NXUSD remain `Freezable: No` after reviewing their native protocol or verified contract surfaces for freeze, blacklist, pause, denylist, arbitrary burn, or upgrade controls
- Owner mint authority and user/allowance burn functions remain supply-control signals, not freeze signals, unless the contract also exposes holder-facing transfer gates, arbitrary burns, blacklist controls, or mutable holder-control surfaces

## v7.15 — Direct freezability metadata audit (2026-05-05)

- Reviewed every active stablecoin in the resolved `Freezable: No` cohort against holder-facing token/vault freeze, denylist, blacklist, pause, and arbitrary role-burn controls
- JupUSD, eSui Dollar, MAI, JUSD, Alpha Partner USDA, Ring USDR, DOC, USDRIF, and Nest inALPHA now resolve as direct `Freezable: Yes`
- sBOLD and Enosys CDP now resolve as `Freezable: Possible` because the audited contracts expose direct vault pause or mutable branch-control surfaces rather than a current address-level blacklist
- The remaining resolved `No` cohort stays unchanged where no direct holder-facing freeze, blacklist, pause, denylist, or arbitrary burn surface was confirmed

## v7.14 — Live reserve dependencies align with scoring (2026-04-24)

- Score-grade live reserve slices with tracked `coinId` links now drive Dependency Risk, raw dependency inputs, topological ordering, and the public dependency graph from the same effective dependency map
- Unmapped live reserve share remains implicit self-backed or non-stablecoin exposure instead of falling back to stale curated dependency percentages
- Tracked variant parent wrapper edges remain synthetic, dominant, and de-duplicated even when live reserve slices also link to the parent

## v7.13 — Reserve-driven blacklist risk moves to Upstream (2026-04-22)

- Shared blacklist resolution now reserves `possible` for curated direct token/vault pause, freeze, or blacklist controls
- Reserve-side stablecoins, wrapped/custodied collateral, custody/CEX rails, and tracked parent-asset exposures now resolve to `inherited` / `Upstream` regardless of reserve weight; any matched reserve path is enough and does not route through `Possible`
- This re-buckets reserve-driven freeze risk without changing the existing tracked-variant dependency ceilings or parent-overall cap behavior

## v7.12 — sBOLD joins tracked risk-absorption variants (2026-04-22)

- `sbold-k3-capital` now declares canonical `variantOf = bold-liquity` and `variantKind = risk-absorption`
- sBOLD now joins the tracked risk-absorption cohort beside `stUSDS` and `stkGHO.v1`, using the existing parent-minus-5 dependency ceiling and parent-overall cap
- This phase keeps parent-linked `pegReferenceId` inheritance for sBOLD, so severe parent depegs still constrain the child until direct NAV/peg handling ships in a later pass

## v7.11 — Strategy-vault children join the tracked variant framework (2026-04-22)

- `sUSDai`, `msY`, `sAID`, and `stcUSD` now declare canonical `variantOf` / `variantKind` metadata as tracked `strategy-vault` children of already-tracked parent stablecoins
- Dependency Risk now supports a tracked `strategy-vault` wrapper ceiling of parent minus 5 points
- The homepage variant owner on `/` now includes a `Strategy` filter state alongside the existing tracked-variant families
- This phase keeps parent-linked `pegReferenceId` inheritance for those four products, so parent severe-depeg caps still constrain the child until direct NAV/peg handling ships in a later pass

## v7.10 — Bond-maturity variants join the parent-linked wrapper framework (2026-04-22)

- `bUSD0` now declares canonical `variantOf = usd0-usual` and `variantKind = bond-maturity`
- Dependency Risk now supports a tracked `bond-maturity` wrapper ceiling of parent minus 8 points
- The homepage variant owner on `/` now includes a `Bond` filter state, and variant detail/parent cards link back into that owner instead of introducing a dedicated route family

## v7.09 — Tracked wrapper and staked variants become explicit parent-linked cards (2026-04-22)

Tracked savings and staked wrappers now carry an explicit parent relationship in Safety Scores instead of relying on reserve-shape quirks:

- Nine tracked wrapped or staked stablecoins now declare canonical `variantOf` / `variantKind` metadata and contribute a synthetic `wrapper` edge from parent to child in dependency scoring, topological ordering, and the dependency graph
- Dependency Risk now caps tracked savings wrappers at parent minus 3 points and tracked risk-absorption wrappers at parent minus 5 points, while legacy non-variant wrapper dependencies keep the original parent-minus-3 behavior
- Tracked variants cannot outscore their parent overall card; live cards and stressed recomputation now expose `overallCapped`, `uncappedOverallScore`, `rawInputs.variantParentId`, and `rawInputs.variantKind` so parent-cap drag is distinct from peg drag in the UI and stress tooling
- Severe active-depeg caps now follow inherited `pegReferenceId` links for these tracked wrappers, so a parent's open depeg still constrains the child

## v7.08 — Strategy reserve tier clarification (2026-04-21)

Reserve-risk tiering now distinguishes transparent spot/wrapped market exposure from actively managed strategy books:

- Delta-neutral wording no longer implies a medium tier by itself
- Transparent spot or wrapped market exposure can remain medium when the reserve slice is mainly asset exposure and custody/counterparty risk is handled by the custody dimension
- Externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy reserves are high unless stronger granular evidence shows the slice is only an idle stablecoin or cash-equivalent buffer
- avUSD's 0xPartners-managed reserve slices moved from medium to high because protocol materials describe capital being actively deployed across strategy managers and market-neutral yield strategies, not just held as idle USDC

## v7.07 — Stale DEX liquidity stays usable for Exit scoring (2026-04-18)

Liquidity / Exit and the redemption-backstop snapshot both now reuse the last-known DEX liquidity score when its freshness runway has elapsed, instead of suppressing it:

- Reverses v6.1's rule that stripped stale DEX liquidity out of `effectiveExitScore`; the score is now computed from the last-known DEX snapshot regardless of age
- Staleness is surfaced only via `liquidityStale` and `inputFreshness.dexLiquidity.stale` on `/api/report-cards`, so UI can warn on age without losing the dimension
- `GET /api/redemption-backstops` row field `effectiveExitScore` stays populated during stale windows under the same freshness policy instead of diverging to `null`; the cron field remains a raw best-path blend and still differs numerically from the report-card `dimensions.liquidity.score`, which applies Safety Score eligibility gates on top
- The redemption-backstop cron still marks its run `degraded` and sets `metadata.liquidityStale = true` when upstream DEX input is past the runway, preserving operational visibility
- Absent DEX snapshots (loader rejects or empty table) still produce `liquidityScore = null` and trigger the documented offchain-issuer primary-market-floor exclusion as before; the rule only distinguishes between "present but old" and "truly missing"
- Motivated by recent cron cadence reductions shifting the effective `sync-dex-liquidity` refresh window well past the previous 1h freshness runway and cascading documented offchain-issuer routes (USDC, USDP, USDT, GUSD, …) to `NR` on routine sync lag

## v7.06 — GHO residual decomposition (2026-04-16)

The GHO reserve adapter now decomposes residual issuance across active facilitators and routes unmapped labels through the standard `material-unknown-exposure` validator, replacing the previous GHO-specific `aggregated-residual-issuance` warning:

- Aave V3 direct-minter facilitators contribute medium-risk residual slices; FlashMinter and unmapped facilitators contribute high-risk slices
- Unmapped residual share accumulates into `metadata.unknownExposurePct` so material unknown exposure can degrade the GHO sync consistently with other reserve adapters
- If the facilitator registry is unreadable in a run, the entire residual is treated as unknown so the fail-closed unknown-exposure policy still applies
- Direct `GhoReserve` / `GhoDirectFacilitator` / RemoteGSM reads remain a follow-up pending verified Aave deployment addresses

## v7.05 — Primary-market exit bonus (2026-04-16)

Liquidity / Exit now recognizes documented offchain issuer redemption as a secondary path only when observable DEX liquidity already exists:

- Documented-bound offchain issuer routes with eventual-only capacity semantics can contribute the diversification bonus in the effective-exit formula
- The contribution is DEX-gated: issuer redemption cannot replace missing DEX liquidity or turn no-DEX assets into liquidity-rated assets by itself
- Low-confidence, impaired, stale, route-limited, and severe-depeg-ineligible redemption rows still fail closed
- Eventual-only non-issuer routes remain visible-only unless separate immediate-bounded/current capacity evidence exists

## v7.04 — Redemption freshness runway (2026-04-15)

Liquidity / Exit now keeps redemption backstop inputs through normal 4-hourly sync lag:

- Report-card redemption freshness now uses a 2x 4-hourly sync runway before suppressing redemption inputs
- Resolved medium- and high-confidence immediate-bounded redemption backstops continue to improve Liquidity / Exit between normal 4-hourly redemption runs
- Missing, materially stale, low-confidence, impaired, eventual-only, and severe-depeg-ineligible routes still fail closed

## v7.03 — USTB live liquidity capacity (2026-04-15)

Liquidity / Exit can now use USTB's current Superstate liquidity capacity:

- USTB now uses Superstate's current Circle USD and USDC RedemptionIdle liquidity as bounded redemption capacity
- USTB's on-chain NAV oracle remains reserve evidence and is not treated as immediate liquidity
- Malformed or unavailable Superstate liquidity telemetry fails closed to no redemption uplift rather than falling back to NAV/AUM

## v7.02 — frxUSD live redemption capacity (2026-04-15)

Liquidity / Exit can now use frxUSD's fresh Frax balance-sheet redemption capacity:

- frxUSD now resolves redemption capacity from live reserve-sync metadata instead of a static full-supply eventual route
- Live route-status telemetry from reserve adapters can suppress redemption uplift when a route is paused, degraded, or cohort-limited
- Live capacity rows with nested capacity amounts no longer reuse flat reserve-composition ratios as supply-relative capacity ratios

## v7.01 — Safety-eligible redemption tiers (2026-04-15)

Liquidity / Exit now distinguishes standalone redemption-route quality from Safety Score-eligible exit capacity:

- Eventual-only redemption routes remain visible on redemption surfaces but no longer uplift the Safety Score Liquidity / Exit dimension by themselves
- Queue-like redemption routes can still contribute when resolved and current, but their Safety Score contribution is capped before blending with DEX liquidity
- Immediate-bounded and live-direct or validated-live routes continue to improve Liquidity / Exit when they are resolved, fresh, non-low-confidence, and not impaired by route-availability evidence

## v7.0 — Independent NAV and bundle-oracle reserve feeds (2026-04-15)

Additional proof-style reserve feeds now use independent timestamped sources instead of weak single-asset liveness probes:

- USYC and TBILL now use Chainlink-style NAV oracles with verified oracle timestamps and 4-day business-day freshness windows
- FRAX now uses the Frax v2 balance-sheet API with verified as-of timestamps and explicit token risk mapping
- USD1 now uses its Chainlink bundle oracle for timestamped reserve size and live supply comparison
- AUSD and DGLD remain outside live collateral passthrough for now because their discovered feeds do not currently provide payload-native freshness inside the live gate

## v6.99 — Asymmetry USDaf live reserve freshness promotion (2026-04-15)

USDaf's Asymmetry reserve feed now preserves the protocol API timestamp and normalizes branch symbols before risk classification:

- The Asymmetry adapter emits verified source freshness from the protocol API timestamp when available
- Branch-name normalization prevents casing-only symbols such as `wBTC` from degrading the feed as unknown exposure
- The global live collateral gate remains unchanged: only independent ok-status snapshots with scoring-eligible freshness can drive report-card collateral scoring

## v6.98 — Timestamp-backed reserve feeds restored to collateral passthrough (2026-04-15)

Several live reserve adapters now consume source timestamps already exposed by their upstream dashboards or disclosure pages:

- Circle, M0, Mento, and USD.AI reserve adapters emit verified freshness when their upstream source exposes a usable disclosure or update timestamp
- Yuzu and Re Protocol reserve feeds have explicit mappings for newly observed buckets/tokens, preventing clean fresh feeds from being degraded as unknown exposure
- OpenEden reserve sync sends browser-style origin hints to reduce upstream transport failures while preserving verified timestamp validation
- Feeds that still lack trustworthy source freshness remain detail-visible only; the report-card live collateral gate still requires independent evidence, ok sync status, and verified or not-applicable freshness

## v6.97 — Active-depeg cap source and stale redemption gating (2026-04-15)

Safety Score active-depeg handling and report-card input freshness were tightened:

- Peg Stability now passes through `computePegScore()` directly during active depegs instead of applying the legacy 65-point peg-dimension cap before the multiplier
- `activeDepegBps` now uses the open depeg event's absolute peak deviation, aligning final D/F caps with the severe-redemption impairment source
- Stale redemption-backstop snapshots are suppressed from Safety Score Liquidity / Exit; report cards fall back to the last-known DEX snapshot with staleness surfaced, or `NR` when no DEX snapshot exists
- Partially unavailable upstream dependency scores are applied at the 70-point unavailable fallback for their declared weights instead of being treated as self-backed
- Contagion stress recomputation now propagates through transitive downstream dependency chains

## v6.96 — Severe active depegs disable weak redemption uplift (2026-04-14)

Liquidity / Exit no longer accepts static or non-live-direct redemption uplift during severe active depegs unless current live-open redemption evidence exists:

- Redemption uplift now requires a resolved non-low-confidence route that is not impaired by route availability or severe active-depeg contradiction
- Active depegs at or above 2500 bps disable static, documented-bound, live-proxy, issuer/API, queue, and estimated redemption uplift until live-open evidence returns
- Live-direct, dynamic, permissionless, atomic or immediate redemption routes can still contribute to Liquidity / Exit during a severe depeg because they provide current direct exercisability evidence

---

## v6.95 — Direct inherited freeze risk now counts custodied BTC wrappers and issuer-seizable collateral (2026-04-07)

Blacklistability attribution now treats centralized-custody BTC wrappers, tokenized gold, and issuer-seizable tokenized collateral as direct reserve-side freeze exposure when they dominate a stablecoin's backing mix:

- Shared `isBlacklistable()` logic now counts centralized-custody BTC wrappers such as WBTC and cbBTC as direct reserve-side freeze exposure instead of only possible exposure
- Issuer-seizable tokenized collateral such as tokenized gold and reviewed tokenized share symbols now also counts as direct inherited freeze risk when present in reserve labels
- Coins with these reviewed collateral assets gained inherited-freeze treatment in this phase; v7.13 later superseded the reserve-weight gate with the current any-reserve `Upstream` policy

---

## v6.94 — NAV wrappers inherit peg risk from referenced base stablecoins (2026-04-06)

Safety Score structure is unchanged, but NAV wrappers that are explicit stablecoin wrappers no longer get a neutral peg multiplier just because their own share price is not the right peg-tracking surface:

- Configured NAV wrappers can now inherit `pegScore` from a referenced base stablecoin when the wrapper itself is a NAV/share token over that stable asset
- Pure fund-share NAV tokens with no configured peg reference still keep `pegScore = NR` and the neutral multiplier treatment
- sUSDai now inherits USDAI peg risk, so the steeper v6.93 peg multiplier applies consistently to the wrapper stack instead of creating a free pass

---

## v6.93 — Steeper peg multiplier + active depeg grade cap (2026-04-05)

The peg multiplier became meaningfully stronger and severe ongoing depegs now hard-cap the final grade:

- `PEG_MULTIPLIER_EXPONENT` increased from `0.20` to `0.40`, making weak pegs more punitive while leaving strong pegs only lightly affected
- Active depegs of at least 1000 bps cap the overall score at D (`49`); active depegs of at least 2500 bps cap at F (`39`)
- `activeDepegBps` was added to report-card raw inputs so the frontend and stressed-grade recomputations apply the same cap logic

---

## v6.92 — Direct Liquity v1 reserve observation for LUSD (2026-04-04)

Safety Score structure is unchanged, but LUSD's reserve telemetry is now promoted from a proof-style liveness probe to direct independent on-chain observation:

- LUSD now uses a dedicated `liquity-v1` live reserve adapter that reads `getEntireSystemColl()` and `getEntireSystemDebt()` from the official Ethereum `TroveManager`
- Clean authoritative LUSD reserve snapshots now qualify as independent single-bucket live evidence for collateral-quality passthrough instead of remaining stuck in the generic `weak-live-probe` family
- This is a targeted adapter upgrade only; the generic `single-asset` family still remains proof/detail-visible unless the underlying source is strong enough to justify a dedicated independent adapter

---

## v1.0 — Initial implementation (Feb 25)

**Commits:** `66ec5c4`, `9c7ccc9`, `c11e37c`

Six weighted dimensions:

| Dimension        | Weight | Scoring approach                                                                               |
| ---------------- | ------ | ---------------------------------------------------------------------------------------------- |
| Peg Stability    | 25%    | pegScore passthrough, capped at 65 during active depeg, +3 bonus if last depeg > 12 months ago |
| Liquidity        | 25%    | liquidityScore from DEX data, HHI penalty (−5 if >0.5, −10 if >0.8)                            |
| Safety           | 20%    | Bluechip rating passthrough (A+=100 … F=25), NR if no rating                                   |
| Resilience       | 15%    | 2-factor: chain distribution 60% + freeze rate 40%                                             |
| Decentralization | 10%    | 3-tier: decentralized=95, centralized-dependent=70, centralized=50                             |
| Dependency Risk  | 5%     | CeFi-Dependent only: unweighted avg of upstream scores, −10 if any <75. Others=95              |

Grade thresholds: A+≥97, A≥93, A-≥90, B+≥85, B≥80, B-≥75, C+≥70, C≥65, C-≥60, D≥50, F≥0.
Minimum 3 rated dimensions required, otherwise overall = NR.

### Patch notes from the initial v1.0 launch day

- **Weighted dependencies** (`9c7ccc9`): Switch from `string[]` to `DependencyWeight[]` (`{id, weight}`). Upstream scores multiplied by declared weight before averaging.
- **Peg bonus fix** (`f5ad69a`): +3 bonus now only applies when `eventCount > 0` and last event was old. Zero-event coins no longer get the bonus.
- **NAV tokens** (`c9f83dd`): Included in grading, depeg cap edge case fixed.
- **Dependency renormalization fix** (`1debd1d`): `sum(w×score)/sum(w)` was cancelling weights. Fixed to `sum(w×score) + (1−totalW)×95` so partial backing is properly penalized. Also rebalanced: dependency 5%→15%, resilience 15%→10%, decentralization 10%→5%.

Weights after patches:

| Peg | Liquidity | Safety | Resilience | Decentralization | Dep Risk |
| --- | --------- | ------ | ---------- | ---------------- | -------- |
| 25% | 25%       | 20%    | 10%        | 5%               | 15%      |

---

## v2.0 — Remove Safety dimension (Feb 26)

**Commit:** `a272ca8`

**Rationale:** Only ~20 of 142 coins had Bluechip ratings. Sparse coverage caused inconsistent weight redistribution across remaining dimensions. Safety removed entirely; Bluechip display kept for informational use.

| Peg | Liquidity | Resilience | Decentralization | Dep Risk |
| --- | --------- | ---------- | ---------------- | -------- |
| 25% | 25%       | 15%        | 10%              | 25%      |

Other changes in the v2.0 era:

- **Self-backed CeFi-Dependent score lowered** (`3bc1232`): 95→75. PSMs/arbitrage carry systemic coupling risk even for non-stablecoin collateral.
- **Peg adjustments removed** (`2b85a87`): Active-depeg cap (65) and +3 bonus stripped. PSI already encodes depeg severity.
- **HHI penalty removed** (`2b85a87`): Liquidity score passed through as-is.
- **Decentralization widened** (`6651e3c`): decentralized 95→100, centralized-dependent 70→50, centralized 50→0.
- **"Possible" blacklist tier** (`b3cf8c7`): Resilience blacklist factor now 0/50/100 for blacklistable/possible/not.
- **Chain-risk penalty on decentralization** (`4c5eecf`, `1539d0d`): Non-centralized coins penalized by worst chain tier. Final values: stage1-l2 −15, established-alt-l1 −50, unproven −65.
- **Chain score adjustments** (`4bdfa7a`): `established-alt-l1` 33→20, `alt-lst-bridged` 33→20.
- **RWA inference** (`22ce2e1`): `rwa-backed + centralized-dependent` infers correct collateral/custody.

---

## v3.0 — Resilience 4-factor model (Feb 26)

**Commits:** `ff9d589`, `46fe511`, `c45f007`

Complete redesign of Resilience from 2 factors (chain distribution + freeze rate) to 4 equal sub-factors (25% each):

| Sub-factor           | Tiers and scores                                                      |
| -------------------- | --------------------------------------------------------------------- |
| Chain Risk           | ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0         |
| Collateral Quality   | native=100, eth-lst=66, alt-lst-bridged-or-mixed=20, rwa=50, exotic=0 |
| Custody Model        | onchain=100, institutional=50, cex=0                                  |
| Blacklist Capability | not-blacklistable=100, possible=50, blacklistable=0                   |

New types: `ChainRisk`, `CollateralQuality`, `CustodyModel`. Defaults inferred from backing + governance.

| Peg | Liquidity | Resilience | Decentralization | Dep Risk |
| --- | --------- | ---------- | ---------------- | -------- |
| 25% | 20%       | 20%        | 10%              | 25%      |

### Chain-risk penalty note from the v3.0 era (Feb 26)

**Commit:** `69ea4c9`

Unversioned note for the steeper chain-risk penalties already applied inside the v3.0 era (stage1-l2 −15, established-alt-l1 −50, unproven −65). This was not a machine-readable methodology version in `shared/lib/methodology-versions/safety-score.ts`.

### v3.2 — Dependency type ceilings (Feb 27)

**Commit:** `fa1d992`

New `DependencyType` field: `wrapper`, `mechanism`, or `collateral` (default).
After blended score is computed, ceilings apply:

- **wrapper** → ceiling = upstream_score − 3
- **mechanism** → ceiling = upstream_score
- **collateral** → no ceiling

Prevents thin wrappers (e.g. a USDC wrapper) from scoring higher than their upstream.

### v3.3 — Reserve-derived collateral quality (Feb 27)

**Commits:** `25602d1`, `1cd1bb9`

For coins with curated `reserves[]` arrays, collateral quality is computed as a weighted average instead of using the enum fallback:

| Reserve Risk Tier | Score |
| ----------------- | ----- |
| very-low          | 100   |
| low               | 75    |
| medium            | 50    |
| high              | 25    |
| very-high         | 5     |

Display thresholds: ≥88 "Very low risk", ≥62 "Low risk", ≥37 "Medium risk", ≥15 "High risk", <15 "Very high risk".

Also: decentralization 10%→15%, dependency risk 25%→25% (confirmed).

---

## v4.0 — Peg stability becomes a multiplier (Feb 27)

**Commit:** `6ed2ec9`

**Biggest structural change.** Peg Stability removed from weighted dimensions entirely. Applied as a post-hoc power-curve multiplier:

```
final = base × (pegScore / 100) ^ 0.20
```

| pegScore | Multiplier | Impact                |
| -------- | ---------- | --------------------- |
| 100      | 1.000      | none                  |
| 90       | ~0.979     | −2%                   |
| 50       | ~0.870     | −13%                  |
| 10       | ~0.631     | −37%                  |
| 0        | 0          | dead                  |
| null     | 1.0        | NAV token, no penalty |

Base dimensions:

| Liquidity | Resilience | Decentralization | Dep Risk |
| --------- | ---------- | ---------------- | -------- |
| 25%       | 25%        | 10%              | 30%      |

Grade thresholds lowered 5 points (structural deflation): A+≥92, A≥88, A-≥85, B+≥80, B≥75, B-≥70, C+≥65, C≥60, C-≥55, D≥45.
Minimum rated dimensions: 3→2 (peg now separate).

### v4.1 — Liquidity weight increase + reclassifications (Feb 27)

**Commit:** `122733d`

Liquidity 25%→30% ("swappability is the most defining aspect of a stablecoin"), resilience 25%→20%.

5 coins reclassified from `centralized-dependent` to `decentralized`: crvUSD, FRXUSD, USR, GYD, ALUSD.

Final v4.1 weights (after also adjusting decentralization/dep-risk):

| Liquidity | Resilience | Decentralization | Dep Risk |
| --------- | ---------- | ---------------- | -------- |
| 30%       | 20%        | 15%              | 25%      |

---

## v5.0 — GovernanceQuality + universal dependency scoring (Feb 28)

**Commits:** `e915623`, `e516bbf`, `d4dd044`, `0b603d2`, `83a540a`

### Decentralization: 3-tier → 6-tier GovernanceQuality

| Tier           | Score | Replaces                       |
| -------------- | ----- | ------------------------------ |
| dao-governance | 85    | decentralized (was 100)        |
| multisig       | 55    | centralized-dependent (was 50) |
| single-entity  | 20    | centralized (was 0)            |
| wrapper        | 10    | new                            |

Resolved via `meta.governanceQuality ?? inferGovernanceQuality(meta.flags.governance)`.

### Dependency Risk: universal, not CeFi-only

All coins with upstream dependencies now get scored (not just centralized-dependent). Self-backed scores vary:

- decentralized → 90
- centralized-dependent → 75
- centralized → 95

Dependencies auto-derived from `reserves[].coinId` via `deriveDependencies()`, falling back to manual `dependencies` array.

### Resilience: chain infra restructured

Chain infrastructure scored as `CHAIN_TIER_SCORE[chainTier] × DEPLOYMENT_MULT[deploymentModel]`:

- **ChainTier**: ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0
- **DeploymentModel** multiplier: single-chain=1.0, canonical-bridge=0.85, third-party-bridge=0.60, native-multichain=0.40

Threshold-based penalty on Decentralization: score 80-100→0, 50-79→−15, 15-49→−50, 0-14→−65.

Weights unchanged from v4.1: 30/20/15/25.

### v5.1 — Regulated-entity tier + blacklist softening (Feb 28)

**Commits:** `38cbe20`, `86b8ce1`, `01ed304`, `fc6cd6c`

- **Blacklist softened**: blacklistable 0→33, possible 50→66, not 100 (unchanged). Non-zero floor for blacklistable tokens.
- **`regulated-entity` tier added**: GovernanceQuality score = 40. Auto-promoted from `single-entity` when: `jurisdiction.regulator` set + `jurisdiction.license` set + `proofOfReserves.type === "independent-audit"`. Exempt from chain infra penalty.
- **Grade thresholds lowered another 5 points** (C-range overcrowding): A+≥87, A≥83, A-≥80, B+≥75, B≥70, B-≥65, C+≥60, C≥55, C-≥50, D≥40.

### v5.2 — Immutable-code governance tier (Feb 28)

**Commit:** `c6c0b77`

`immutable-code → 100` added as highest GovernanceQuality tier. For protocols with no admin keys, no upgrade path, no DAO attack surface (LUSD, BOLD). Exempt from chain infra penalty.

Full GovernanceQuality table:

| Tier             | Score |
| ---------------- | ----- |
| immutable-code   | 100   |
| dao-governance   | 85    |
| multisig         | 55    |
| regulated-entity | 40    |
| single-entity    | 20    |
| wrapper          | 10    |

### v5.3 — Remove chain infra from Resilience (Feb 28)

**Commit:** `8c060b3`

Chain infra was scored in both Resilience (25% sub-factor) and Decentralization (penalty). Double-counting fixed: chain infra now exclusively in Decentralization.

Resilience becomes a **3-factor model** (each 1/3): Collateral Quality, Custody Model, Blacklist Capability.

### v5.4 — No-liquidity penalty (Feb 28)

**Commit:** `14131fa`

When Liquidity is NR (no DEX data), overall score receives a 10% penalty:

```
final = score × 0.9
```

Previously, NR dimensions redistributed weight to rated ones, inflating scores for coins without liquidity data. As DEX pipeline coverage matures, absence of data is increasingly suspect.

Applied as the last step before clamping, after the peg multiplier.

### v5.5 — Peg score fairness for young coins (Mar 1)

Three fixes landed in peg scoring to prevent young coins with repeated brief depegs from being over-scored:

- **Tracking window capped to coin age:** when first-seen supply history exists, tracking starts at `max(firstSeen, fourYearsAgo)` via `coinTrackingStart(...)`.
- **Severity magnitude floor:** each depeg contributes at least `(peakBps / 2000) * recencyWeight`, even when duration is short.
- **Steeper active-depeg penalty:** active events now penalize via `max(5, absBps / 50)` (capped at 50).

Weights and grade thresholds are unchanged from v5.4.

### v5.6 — Exit-liquidity integration (Mar 12)

Safety Score liquidity now evaluates modeled exit quality, not just raw DEX depth:

- Added a redemption-backstop dataset for redeemable assets, covering onchain collateral redemptions, stable-basket redemptions, queue-based buffer systems, and issuer redemption rails.
- The Liquidity dimension now uses `effectiveExitScore`, which preserves DEX liquidity as the floor while allowing redemption quality to improve the dimension when a credible direct route exists.
- Added route-family caps so queue-based and offchain issuer systems cannot look unrealistically liquid even when redemption exists.

Weights and grade thresholds are unchanged from v5.5.

### v5.7 — Canonical ETH wrapper reserve alignment (Mar 13)

Reserve-derived collateral quality now treats direct ETH and canonical wrapped ETH as the same very-low-risk asset class:

- Updated the shared reserve-asset risk map so canonical `WETH` no longer falls into the generic wrapped-asset bucket.
- Aligned curated reserve metadata and live reserve-adapter overrides for coins that expose direct `ETH` or `WETH` slices.
- Mixed strategy buckets are unchanged. Delta-neutral ETH exposure, bridged ETH, and mixed BTC/ETH reserve slices still use their explicit manually-modeled tiers.

Weights and grade thresholds are unchanged from v5.6.

### v5.8 — Live reserve passthrough for collateral quality (Mar 14)

Collateral quality scoring now consumes live reserve snapshots when available:

- For coins with `liveReservesConfig`, the collateral quality score uses the hourly live snapshot from `reserve_composition` instead of curated `StablecoinMeta.reserves` when a fresh live snapshot is available.
- The `collateralFromLive` flag in `RawDimensionInputs` indicates which source was used.
- A delta alert fires when the live-derived score diverges from curated by >15 points, signaling that curated metadata may need human review.
- Dependency inference (`deriveDependencies`) remains on curated data because live adapter slices do not carry `coinId` links.

Weights and grade thresholds are unchanged from v5.7.

### v5.9 — Classification corrections: centralized-custody DeFi coins (Mar 20)

Three DeFi-classified coins with majority centralized custody exposure were corrected using the live reserve view:

- meUSD, ALUSD, and BtcUSD were reclassified from decentralized to centralized-dependent
- ALUSD's earlier v4.1 reclassification was explicitly reversed after reserve review showed 65% direct USDC/USDT exposure
- meUSD and BtcUSD were corrected after live reserves confirmed custodial BTC-variant exposure (for example WBTC, BTCB, cbBTC, SolvBTC)

Weights and grade thresholds are unchanged from v5.8.

---

## v6.0 — Custody model tiers, mature-alt-l1, 2-factor Resilience (2026-03-21)

- Custody model expanded from 3 to 6 tiers: onchain (100), institutional-top (80), institutional-regulated (55), institutional-unregulated (30), institutional-sanctioned (5), cex (0)
- New chain tier: mature-alt-l1 (score 45) for Solana and BNB Chain
- Resilience becomes 2-factor: (collateral + custody) / 2; blacklist reported descriptively only
- 5-band chain penalty replaces 4-band: ≥80→0, ≥60→-10, ≥40→-25, ≥20→-40, <20→-60
- Wrapper governance exempted from chain infrastructure penalty
- Deployment multipliers: canonical-bridge 0.85→0.90, native-multichain 0.40→0.75

## v6.91 — Reserve-side blacklist exposure heuristics (2026-03-30)

Safety Score structure is unchanged, but blacklistability attribution now scans curated and live reserve labels plus reserve-rail text for stablecoin, wrapper, and CEX custody clues:

- `isBlacklistable()` returned `possible` for reserve slices or reserve-rail text that implied blacklist or custodial-freeze exposure below the then-active inherited gate
- Curated and live reserve names began sharing the same direct blacklist clue detection instead of relying only on `coinId` or explicit `blacklistable` flags; v7.13 later promoted any matched reserve path to `Upstream`
- Only coins with no explicit blacklist function, no reserve-side blacklist clues, and no CEX custody signal remain in the `no` bucket unless an explicit `false` override applies
- The collateral passthrough gate itself is unchanged: `static-validated`, `weak-live-probe`, and `freshnessMode=unverified` reserve feeds remain detail-visible only and do not override curated collateral scoring

Weights and grade thresholds are unchanged from v6.9.

## v6.9 — Explicit inherited blacklistability (2026-03-30)

Safety Score structure is unchanged, but blacklistability attribution is now more explicit for decentralized protocols with freeze-prone collateral:

- `isBlacklistable()` no longer treats `centralized-dependent` governance as `possible` by default
- Computed inherited blacklistability now resolves to `inherited`, separating upstream freeze risk from mutable-contract risk
- Inherited status became an explicit upstream-freeze category driven by curated reserve-slice `blacklistable` markers and upstream stablecoin `coinId` links; v7.13 later removed the reserve-weight gate
- The shared resolver now converges to a fixed point across the tracked graph, and enriched live reserve names can contribute to blacklist attribution when report cards have live reserve input

Weights and grade thresholds are unchanged from v6.8.

## v6.8 — On-chain reserve freshness alignment (2026-03-25)

Safety Score structure is unchanged, but the live reserve freshness contract is refined for direct on-chain adapters:

- `evm-branch-balances` snapshots now carry `freshnessMode=not-applicable` instead of remaining timestamp-less and implicitly ineligible
- Clean branch-balance reserve feeds can override curated collateral quality again when their latest reserve sync status is `ok`

Weights and grade thresholds are unchanged from v6.7.

## v6.7 — CeFi-dependent blacklistability fallback (2026-03-25)

Safety Score structure is unchanged, but blacklistability attribution is now stricter for centralized-dependent governance:

- `isBlacklistable()` now defaults centralized-dependent stablecoins to `possible` unless an explicit override or inherited-reserve classification is more specific
- Inherited reserve exposure still takes precedence, preserving `possible-inherited` for reserve-heavy dependency cases
- Explicit `canBeBlacklisted` overrides remain authoritative, including explicit `false` exceptions

Weights and grade thresholds are unchanged from v6.6.

## v6.6 — Timestamp-backed live reserve scoring gate (2026-03-24)

Safety Score structure is unchanged, but collateral-quality passthrough now requires stronger freshness evidence from live reserve feeds:

- Independent live reserve feeds now need scoring-eligible freshness evidence in addition to fresh authoritative `ok` snapshots
- Snapshots with `freshnessMode = "unverified"` no longer override curated collateral quality in report-card scoring
- Direct on-chain reserve adapters can still qualify when freshness is marked `not-applicable`

Weights and grade thresholds are unchanged from v6.5.

## v6.5 — Clean independent live reserve passthrough (2026-03-22)

Safety Score structure is unchanged, but the collateral-quality live reserve passthrough is now stricter about evidence quality and warning-bearing feeds:

- Live collateral passthrough now requires a fresh authoritative snapshot whose latest `reserve_sync_state.last_status` is `ok`
- The live reserve adapter registry now separates reserve shape (`sourceModel`) from evidence strength (`evidenceClass`)
- `single-asset` and other proof-class feeds are now tagged `weak-live-probe`, so they remain visible on reserve detail/status surfaces but no longer override curated collateral scoring
- Source-age and material unknown-exposure warnings now degrade reserve sync health and automatically keep those snapshots out of report-card collateral passthrough

Weights and grade thresholds are unchanged from v6.4.

## v6.4 — Live Liquity redemption fee telemetry (2026-03-22)

Safety Score structure is unchanged, but Liquity-style formula routes can now use current on-chain redemption fees when live reserve telemetry is available:

- LUSD and BOLD now reuse live reserve sync metadata for current redemption fee bps instead of always sitting in the generic reviewed-formula bucket
- These routes remain labeled as `formula` fee models and `eventual-only` capacity routes, so Pharos still does not present them as having an immediate redeemable buffer
- If live fee telemetry is unavailable, the liquidity dimension falls back to the prior reviewed-formula treatment

Weights and grade thresholds are unchanged from v6.3.

## v6.3 — Documented-bound Liquity redemption confidence (2026-03-22)

Safety Score structure is unchanged, but the liquidity dimension now recognizes a narrow class of fully on-chain redemption routes as stronger evidence than heuristic capacity models:

- LUSD and BOLD now use `documented-bound` eventual redemption capacity instead of generic heuristic `supply-full` modeling
- These routes still render as eventual-only redemption paths, so Pharos does not present full current supply as an immediate redeemable buffer
- Reviewed Liquity-style `min 50 bps + baseRate` fee formulas remain dynamic formula inputs rather than fixed-fee assumptions

## v6.2 — Independent live reserve contract tightening (2026-03-22)

Safety Score structure is unchanged, but the collateral-quality live reserve passthrough is now more precise about which live feeds qualify:

- Live collateral passthrough now uses fresh authoritative snapshots only: `reserve_composition` must match `reserve_sync_state.last_success_at` and the slice set must be non-empty
- Only independent live feed classes can override curated collateral scoring: `dynamic-mix` and `single-bucket`
- `validated-static` feeds such as `curated-validated` and `frax` remain reserve-detail/status data, but they no longer count as independent live collateral inputs
- Single-bucket live feeds now count for collateral passthrough and reserve drift; the old implicit `>= 2 slices` gate is no longer the scoring contract

Weights and grade thresholds are unchanged from v6.1.

## v6.1 — Redemption confidence gating and capacity semantics (2026-03-22)

Safety Score structure is unchanged, but the liquidity dimension is now stricter about what redemption evidence can improve it:

- Low-confidence / heuristic redemption routes remain visible in detail surfaces, but they no longer uplift the Safety Score liquidity dimension
- When the reused DEX liquidity snapshot is stale, report-card liquidity does not blend it into `effectiveExitScore`; the dimension falls back to redemption-only logic or `NR`
- Redemption detail surfaces now distinguish immediate redeemable buffer from eventual issuer/protocol redeemability, so `supply-full` models no longer present full supply as immediately available capacity

Weights and grade thresholds are unchanged from v6.0.

---

## Quick Reference: Weight Evolution

| Version        | Peg            | Exit Liquidity | Safety  | Resilience | Decentralization | Dep Risk |
| -------------- | -------------- | -------------- | ------- | ---------- | ---------------- | -------- |
| v1.0           | 25%            | 25%            | 20%     | 15%        | 10%              | 5%       |
| v1.0 patch     | 25%            | 25%            | 20%     | 10%        | 5%               | 15%      |
| v2.0           | 25%            | 25%            | removed | 15%        | 10%              | 25%      |
| v3.0           | 25%            | 20%            | —       | 20%        | 10%              | 25%      |
| v3.3           | 25%            | 20%            | —       | 20%        | 15%              | 25%      |
| v4.0           | multiplier     | 25%            | —       | 25%        | 10%              | 30%      |
| v4.1           | multiplier     | 30%            | —       | 20%        | 15%              | 25%      |
| v5.0–5.8       | multiplier     | 30%            | —       | 20%        | 15%              | 25%      |
| **v6.0–current** | **multiplier** | **30%**        | **—**   | **20%**    | **15%**          | **25%**  |

## Quick Reference: Grade Thresholds

| Grade | v1.0 | v4.0 (−5) | v5.1 (−5) |
| ----- | ---- | --------- | --------- |
| A+    | 97   | 92        | **87**    |
| A     | 93   | 88        | **83**    |
| A-    | 90   | 85        | **80**    |
| B+    | 85   | 80        | **75**    |
| B     | 80   | 75        | **70**    |
| B-    | 75   | 70        | **65**    |
| C+    | 70   | 65        | **60**    |
| C     | 65   | 60        | **55**    |
| C-    | 60   | 55        | **50**    |
| D     | 50   | 45        | **40**    |
| F     | 0    | 0         | **0**     |
