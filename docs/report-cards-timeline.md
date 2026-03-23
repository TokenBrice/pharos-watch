# Report Cards Scoring — Version Timeline

Internal changelog reconstructed from git history plus the live version metadata source. Covers v1.0 through v6.13 (2026-02-25 → 2026-03-23).

---

## v1.0 — Initial implementation (Feb 25)

**Commits:** `66ec5c4`, `9c7ccc9`, `c11e37c`

Six weighted dimensions:

| Dimension        | Weight | Scoring approach                                                        |
|------------------|--------|-------------------------------------------------------------------------|
| Peg Stability    | 25%    | pegScore passthrough, capped at 65 during active depeg, +3 bonus if last depeg > 12 months ago |
| Liquidity        | 25%    | liquidityScore from DEX data, HHI penalty (−5 if >0.5, −10 if >0.8)    |
| Safety           | 20%    | Bluechip rating passthrough (A+=100 … F=25), NR if no rating            |
| Resilience       | 15%    | 2-factor: chain distribution 60% + freeze rate 40%                      |
| Decentralization | 10%    | 3-tier: decentralized=95, centralized-dependent=70, centralized=50      |
| Dependency Risk  | 5%     | CeFi-Dependent only: unweighted avg of upstream scores, −10 if any <75. Others=95 |

Grade thresholds: A+≥97, A≥93, A-≥90, B+≥85, B≥80, B-≥75, C+≥70, C≥65, C-≥60, D≥50, F≥0.
Minimum 3 rated dimensions required, otherwise overall = NR.

### v1.0 patches (same day)

- **Weighted dependencies** (`9c7ccc9`): Switch from `string[]` to `DependencyWeight[]` (`{id, weight}`). Upstream scores multiplied by declared weight before averaging.
- **Peg bonus fix** (`f5ad69a`): +3 bonus now only applies when `eventCount > 0` and last event was old. Zero-event coins no longer get the bonus.
- **NAV tokens** (`c9f83dd`): Included in grading, depeg cap edge case fixed.
- **Dependency renormalization fix** (`1debd1d`): `sum(w×score)/sum(w)` was cancelling weights. Fixed to `sum(w×score) + (1−totalW)×95` so partial backing is properly penalized. Also rebalanced: dependency 5%→15%, resilience 15%→10%, decentralization 10%→5%.

Weights after patches:

| Peg | Liquidity | Safety | Resilience | Decentralization | Dep Risk |
|-----|-----------|--------|------------|------------------|----------|
| 25% | 25%      | 20%    | 10%        | 5%               | 15%      |

---

## v2.0 — Remove Safety dimension (Feb 26)

**Commit:** `a272ca8`

**Rationale:** Only ~20 of 142 coins had Bluechip ratings. Sparse coverage caused inconsistent weight redistribution across remaining dimensions. Safety removed entirely; Bluechip display kept for informational use.

| Peg | Liquidity | Resilience | Decentralization | Dep Risk |
|-----|-----------|------------|------------------|----------|
| 25% | 25%      | 15%        | 10%              | 25%      |

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

| Sub-factor           | Tiers and scores                                                         |
|----------------------|--------------------------------------------------------------------------|
| Chain Risk           | ethereum=100, stage1-l2=66, established-alt-l1=20, unproven=0           |
| Collateral Quality   | native=100, eth-lst=66, alt-lst-bridged-or-mixed=20, rwa=50, exotic=0   |
| Custody Model        | onchain=100, institutional=50, cex=0                                     |
| Blacklist Capability | not-blacklistable=100, possible=50, blacklistable=0                      |

New types: `ChainRisk`, `CollateralQuality`, `CustodyModel`. Defaults inferred from backing + governance.

| Peg | Liquidity | Resilience | Decentralization | Dep Risk |
|-----|-----------|------------|------------------|----------|
| 25% | 20%      | 20%        | 10%              | 25%      |

### v3.1 — Chain-risk penalty bump (Feb 26)

**Commit:** `69ea4c9`

Formal version bump recognizing the steeper chain-risk penalties already applied (stage1-l2 −15, established-alt-l1 −50, unproven −65).

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
|-------------------|-------|
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

| pegScore  | Multiplier | Impact  |
|------|------------|---------|
| 100  | 1.000      | none    |
| 90   | ~0.979     | −2%     |
| 50   | ~0.870     | −13%   |
| 10   | ~0.631     | −37%   |
| 0    | 0          | dead    |
| null | 1.0        | NAV token, no penalty |

Base dimensions:

| Liquidity | Resilience | Decentralization | Dep Risk |
|-----------|------------|------------------|----------|
| 25%       | 25%        | 10%              | 30%      |

Grade thresholds lowered 5 points (structural deflation): A+≥92, A≥88, A-≥85, B+≥80, B≥75, B-≥70, C+≥65, C≥60, C-≥55, D≥45.
Minimum rated dimensions: 3→2 (peg now separate).

### v4.1 — Liquidity weight increase + reclassifications (Feb 27)

**Commit:** `122733d`

Liquidity 25%→30% ("swappability is the most defining aspect of a stablecoin"), resilience 25%→20%.

5 coins reclassified from `centralized-dependent` to `decentralized`: crvUSD, FRXUSD, USR, GYD, ALUSD.

Final v4.1 weights (after also adjusting decentralization/dep-risk):

| Liquidity | Resilience | Decentralization | Dep Risk |
|-----------|------------|------------------|----------|
| 30%       | 20%        | 15%              | 25%      |

---

## v5.0 — GovernanceQuality + universal dependency scoring (Feb 28)

**Commits:** `e915623`, `e516bbf`, `d4dd044`, `0b603d2`, `83a540a`

### Decentralization: 3-tier → 6-tier GovernanceQuality

| Tier              | Score | Replaces                |
|-------------------|-------|-------------------------|
| dao-governance    | 85    | decentralized (was 100) |
| multisig          | 55    | centralized-dependent (was 50) |
| single-entity     | 20    | centralized (was 0)     |
| wrapper           | 10    | new                     |

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

| Tier              | Score |
|-------------------|-------|
| immutable-code    | 100   |
| dao-governance    | 85    |
| multisig          | 55    |
| regulated-entity  | 40    |
| single-entity     | 20    |
| wrapper           | 10    |

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

## v6.1 — Redemption confidence gating and capacity semantics (2026-03-22)

Safety Score structure is unchanged, but the liquidity dimension is now stricter about what redemption evidence can improve it:

- Low-confidence / heuristic redemption routes remain visible in detail surfaces, but they no longer uplift the Safety Score liquidity dimension
- When the reused DEX liquidity snapshot is stale, report-card liquidity does not blend it into `effectiveExitScore`; the dimension falls back to redemption-only logic or `NR`
- Redemption detail surfaces now distinguish immediate redeemable buffer from eventual issuer/protocol redeemability, so `supply-full` models no longer present full supply as immediately available capacity

Weights and grade thresholds are unchanged from v6.0.

## v6.5 - Clean independent live reserve passthrough (2026-03-22)

Safety Score structure is unchanged, but the collateral-quality live reserve passthrough is now stricter about evidence quality and warning-bearing feeds:

- Live collateral passthrough now requires a fresh authoritative snapshot whose latest `reserve_sync_state.last_status` is `ok`
- The live reserve adapter registry now separates reserve shape (`sourceModel`) from evidence strength (`evidenceClass`)
- `single-asset` and `tether` style feeds are now tagged `weak-live-probe`, so they remain visible on reserve detail/status surfaces but no longer override curated collateral scoring
- Source-age and material unknown-exposure warnings now degrade reserve sync health and automatically keep those snapshots out of report-card collateral passthrough

Weights and grade thresholds are unchanged from v6.4.

## v6.6 - Reviewed lower-cap redemption coverage expansion (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes a broader reviewed issuer-backed redemption set outside the largest stablecoins:

- CASH, MNEE, USDP, GUSD, XUSD, XSGD, USDQ, EURQ, EURe, EURI, TBILL, EURCV, and USDCV now use reviewed `documented-bound` eventual redemption capacity instead of generic heuristic `supply-full` modeling
- TBILL, EURI, EURCV, and USDCV also now disclose reviewed non-instant settlement constraints, so their routes are more defensible without pretending same-size cash is immediately available
- These routes still render as eventual-only issuer exits and do not claim a separately measured immediate redemption buffer, but they can now contribute medium-confidence redemption evidence instead of remaining low-confidence by default

Weights and grade thresholds are unchanged from v6.5.

## v6.7 - Second lower-cap redemption review tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes an additional issuer-style batch outside the largest stablecoins:

- USDH, FIDD, AEUR, USDX, USDM, SBC, EURR, USDR, WUSD, and AUDD now use reviewed `documented-bound` eventual redemption capacity instead of generic heuristic `supply-full` modeling
- USDM and AEUR now also disclose reviewed non-instant settlement expectations from issuer materials, while USDH carries an explicit reviewed fee-free redemption path and SBC now uses reviewed pricing language instead of an undocumented fee assumption
- These routes still render as eventual-only issuer exits and do not claim a separately measured immediate redeemable buffer, but they now contribute medium-confidence redemption evidence instead of staying low-confidence by default

Weights and grade thresholds are unchanged from v6.6.

## v6.8 - Third lower-cap redemption review tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes another small group of reviewed lower-cap redemption routes and a corrected frxUSD route family:

- thBILL, XAUm, USDGO, and USA₮ now use reviewed `documented-bound` eventual redemption capacity instead of generic heuristic `supply-full` modeling
- XAUm now discloses a reviewed 25 bps redemption fee and T+3 settlement expectations, while USDGO now uses the reviewed zero-fee StableHub exchange rail documented by OSL
- frxUSD now models the direct onchain USDC mint/redeem contract path as a reviewed `stablecoin-redeem` route instead of remaining in a generic issuer bucket

Weights and grade thresholds are unchanged from v6.7.

## v6.9 - Mid-cap redemption route correction tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes a higher-cap batch of corrected or newly covered redemption routes:

- USX, USDa, and M now have reviewed redemption configs instead of remaining uncovered, while NUSD now uses reviewed `documented-bound` queue semantics instead of a generic heuristic capacity ratio
- USD.AI now models the base token's direct stablecoin burn-and-withdraw path instead of inheriting slower sUSDai unstaking assumptions
- These routes still do not expose a separately measured live instant redemption buffer, but they now contribute medium-confidence evidence instead of staying missing or low-confidence by default

Weights and grade thresholds are unchanged from v6.8.

## v6.10 - Live-buffer synthetic-dollar redemption tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes two larger synthetic-dollar redemption routes with live reserve-backed capacity inputs:

- USDe now models Ethena's whitelisted direct stablecoin redemption rail with fresh live `Liquid Cash` telemetry as the current buffer and a conservative documented 0.5% fallback bound when telemetry is unavailable
- USDf now models Falcon's KYC-only queued redemption route with fresh live stablecoin-buffer telemetry from Falcon's transparency feed and a reviewed zero protocol-fee assumption
- These routes materially expand medium-confidence redemption evidence, while still preserving Falcon's 7-day cooldown and Ethena's documented ability to suspend or delay transactions

Weights and grade thresholds are unchanged from v6.9.

## v6.11 - Reviewed lower-cap redemption cleanup tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes a final small docs-only redemption cleanup batch before the remaining queue turns mostly telemetry-heavy:

- PUSD and PGOLD now use reviewed Pleasing redemption semantics instead of generic heuristic issuer assumptions, with PUSD mapped to the documented screened USDT off-ramp and PGOLD mapped to the KYC-gated physical-delivery rail
- apxUSD now reflects Apyx's documented whitelist-gated mint/redeem route rather than a generic permissionless stablecoin redemption assumption
- These routes still do not expose separate live buffer telemetry, but they now contribute medium-confidence redemption evidence instead of remaining low-confidence heuristics

Weights and grade thresholds are unchanged from v6.10.

## v6.14 - Moderate-effort redemption confidence tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes the next group of already-modeled low-confidence routes where Pharos has reviewed redemption semantics without yet adding protocol-native live buffer telemetry:

- DOLA and JupUSD now treat their published stable-buffer bounds as reviewed `documented-bound` capacity instead of leaving those ratios in the heuristic bucket
- rwaUSDi, mTBILL, MUSD, USDN, YUSD, USN, UTY, and YZUSD now use reviewed redemption semantics and documented-bound capacity instead of generic low-confidence placeholders
- These routes still avoid claiming a separately measured live instant buffer unless the issuer or protocol publishes one, but they now contribute medium-confidence redemption evidence across another moderate-cap tranche

Weights and grade thresholds are unchanged from v6.13.

## v6.13 - Docs-backed redemption quick-win tranche (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now recognizes a higher-impact docs-only batch among already-modeled low-confidence redemption routes:

- avUSD, cUSD, USDu, cgUSD, HONEY, EUSD, AID, OUSD, and USBD now use reviewed `documented-bound` redemption capacity instead of staying low-confidence under heuristic supply models
- USDu and AID now reflect whitelist-gated direct redemption access, while cgUSD and AID also disclose reviewed fee assumptions from official docs instead of generic unknown-fee handling
- These routes still do not expose separate live instant-buffer telemetry, but they now contribute medium-confidence redemption evidence rather than remaining visible-only heuristics

Weights and grade thresholds are unchanged from v6.12.

## v6.12 - Maple queue-route correction (2026-03-23)

Safety Score structure is unchanged, but the liquidity dimension now treats Maple's syrup withdrawal rail as a reviewed queued exit instead of an overstated instant-buffer assumption:

- syrupUSDC and syrupUSDT now model Maple's documented `requestRedeem` FIFO withdrawal queue rather than a generic near-instant `stablecoin-redeem` route with a heuristic 30% capacity ratio
- Access is now treated as whitelist-gated onchain because Maple's PoolPermissionManager gates `requestRedeem` and `redeem`, and the routes use reviewed `documented-bound` eventual capacity instead of pretending a measurable live instant buffer exists
- These routes can now contribute medium-confidence redemption evidence while preserving Maple's documented under-24-hour typical servicing target and up-to-30-day tail risk

Weights and grade thresholds are unchanged from v6.11.

## v6.4 - Live Liquity redemption fee telemetry (2026-03-22)

Safety Score structure is unchanged, but Liquity-style formula routes can now use current on-chain redemption fees when live reserve telemetry is available:

- LUSD and BOLD now reuse live reserve sync metadata for current redemption fee bps instead of always sitting in the generic reviewed-formula bucket
- These routes remain labeled as `formula` fee models and `eventual-only` capacity routes, so Pharos still does not present them as having an immediate redeemable buffer
- If live fee telemetry is unavailable, the liquidity dimension falls back to the prior reviewed-formula treatment

Weights and grade thresholds are unchanged from v6.3.

## v6.3 - Documented-bound Liquity redemption confidence (2026-03-22)

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

---

## Quick Reference: Weight Evolution

| Version    | Peg        | Liquidity | Safety  | Resilience | Decentralization | Dep Risk |
|------------|------------|-----------|---------|------------|------------------|----------|
| v1.0       | 25%        | 25%       | 20%     | 15%        | 10%              | 5%       |
| v1.0 patch | 25%        | 25%       | 20%     | 10%        | 5%               | 15%      |
| v2.0       | 25%        | 25%       | removed | 15%        | 10%              | 25%      |
| v3.0       | 25%        | 20%       | —       | 20%        | 10%              | 25%      |
| v3.3       | 25%        | 20%       | —       | 20%        | 15%              | 25%      |
| v4.0       | multiplier | 25%       | —       | 25%        | 10%              | 30%      |
| v4.1       | multiplier | 30%       | —       | 20%        | 15%              | 25%      |
| v5.0–5.8 | multiplier | 30% | — | 20%  | 15%          | 25%  |
| **v6.0–6.13** | **multiplier** | **30%** | **—** | **20%**  | **15%**          | **25%**  |

## Quick Reference: Grade Thresholds

| Grade | v1.0 | v4.0 (−5) | v5.1 (−5) |
|-------|------|-----------|-----------|
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
