# Risk Lab

Multi-dimensional risk grades (A+ through F) for every tracked stablecoin. Computed on-demand by the API from live data.

The stablecoin registry currently contains 197 tracked metadata entries. Report-card snapshots score the active subset and the cemetery set; pre-launch tracked entries remain outside the scored snapshot until they launch.

## Overall Grade (v7.08)

Four-step computation:

1. **Base score**: weighted average of 4 base dimensions (each 0-100). NR dimensions have their weight redistributed proportionally among rated ones. Requires at least 2 rated base dimensions; otherwise overall = NR.
2. **Peg multiplier**: `final = base × (pegScore / 100) ^ 0.40`. Coins with good pegs (90+) barely affected (~4% penalty). Coins with broken pegs get sharply penalized (pegScore 10 -> 60% penalty). pegScore = NR (pure NAV tokens with no configured peg reference) -> multiplier 1.0 (no penalty). pegScore = 0 -> multiplier 0.
3. **No-liquidity penalty**: `final × 0.9` when the Liquidity / Exit dimension is NR (no DEX or redemption-backstop signal at all). No free pass — as coverage matures, absence of any exit signal is increasingly suspicious. Implemented via `NO_LIQUIDITY_PENALTY = 0.9` in `shared/lib/report-card-core.ts`.
4. **Active depeg cap**: coins with a severe ongoing depeg are hard-capped after the no-liquidity penalty. `activeDepegBps` is the open event's absolute peak deviation, not the latest spot deviation. Active depegs >= 2500 bps (25%+) cap at F (39), >= 1000 bps (10%+) cap at D (49).

Cemetery coins get a permanent F.

Current-version note: v7.08 clarifies reserve-risk tiering for actively managed strategy books. Delta-neutral wording is not enough to assign a medium tier by itself: transparent spot or wrapped market exposure can remain medium, but reserves delegated into externally managed market-neutral, basis, perp, LP, private-deal, or custody-dependent strategy books are high unless there is stronger granular evidence that the slice is only an idle stablecoin or cash-equivalent buffer. This reclassifies avUSD's 0xPartners-managed strategy and loss-absorption reserve from medium to high. All v7.07 behavior carries forward: Liquidity / Exit (and the redemption-backstop snapshot serving `/api/redemption-backstops`) reuse last-known DEX liquidity when its freshness runway has elapsed, staleness is surfaced via `liquidityStale` and `inputFreshness.dexLiquidity.stale`, absent DEX snapshots still trigger the documented offchain-issuer primary-market-floor exclusion, and the `activeDepegBps` field remains in `RawDimensionInputs` so stressed-grade recomputations and the frontend apply the same cap.

## Dimensions

### Base dimensions (weighted sum)

| Dimension            | Weight | Source                                       | Scoring                                                                                                                                                                                            |
| -------------------- | ------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Liquidity / Exit** | 30%    | `liquidityScore` + `redemptionBackstopScore` | Uses `effectiveExitScore`, which preserves DEX liquidity as the floor and lets direct redemption quality help when present                                                                         |
| **Resilience**       | 20%    | Token metadata (2 sub-factors)               | Average of collateral quality and custody model; blacklist capability is reported descriptively but does not affect the score                                                                      |
| **Decentralization** | 15%    | Governance quality + chain infrastructure    | `GovernanceQuality` tiers: `immutable-code` → 100, `dao-governance` → 85, `multisig` → 55, `regulated-entity` → 40, `single-entity` → 20, `wrapper` → 10. Threshold-based penalty from combined chain infrastructure score |
| **Dependency Risk**  | 25%    | Upstream stablecoin scores                   | No deps → varies by governance (decentralized: 90, centralized-dependent: 75, centralized: 95). With deps → blended score (upstream × weight + self-backed), −10 if any < 75                       |

### Peg Stability (multiplier)

| Source                      | Scoring                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `pegScore` from peg summary | Applied as `(pegScore/100)^0.40` multiplier to base score. Pure NAV tokens stay neutral; configured NAV wrappers can inherit peg risk from a referenced base stablecoin. Active open-event peaks >= 2500 bps cap overall at F; >= 1000 bps cap at D |

### Peg Stability Details

- Direct passthrough of `computePegScore()` output (see [Depeg Detection Pipeline](./depeg-detection.md) for the composite formula)
- v5.5 peg fairness fixes apply automatically: tracking window is capped to coin age (`coinTrackingStart()`), per-event magnitude floors prevent brief severe depegs from being under-penalized, and active-depeg penalties are steeper
- The report-card peg dimension does not apply a second active-depeg cap before the multiplier; final D/F active-depeg caps are applied after the peg multiplier from the open event's peak deviation.
- Pure NAV fund-share tokens (yield-accruing, price-appreciating) receive NR — multiplier 1.0, no penalty
- Configured NAV wrappers over a stablecoin can inherit peg stability from a referenced base asset instead of receiving a neutral pass
- Yield-bearing annotation added to detail text

### Liquidity / Exit Details

- The public DEX liquidity dataset stays unchanged and fully market-based (see [DEX Liquidity Score](./dex-liquidity.md))
- Report cards use `effectiveExitScore`, not raw `liquidityScore`
- `effectiveExitScore` uses a best-path model:
  - `effectiveExitScore = round(min(100, max(liquidityScore, redemptionBackstopScore) + min(liquidityScore, redemptionBackstopScore) × 0.10))`
- If only DEX liquidity exists, `effectiveExitScore = liquidityScore`
- If only eligible immediate/live/queue-style redemption exists, `effectiveExitScore = redemptionBackstopScore` (route family caps are the guardrails, including queue-redeem <= 70)
- Documented offchain-issuer eventual exits do not replace missing DEX liquidity; they can only add the primary-market exit bonus when DEX liquidity is already present.
- Redemption uplift is only used when the redemption route is resolved, above the low-confidence / heuristic tier, and not currently impaired by route-availability evidence
- Eventual-only redemption routes remain visible in the dimension detail. They do not replace missing DEX liquidity, but documented-bound offchain issuer routes can add a capped primary-market exit bonus when DEX liquidity is already available
- Queue-like redemption routes can improve Liquidity / Exit when resolved and current, but their redemption contribution is capped before the best-path blend so delayed exits cannot behave like instant liquidity
- During severe active depegs (`activeDepegBps >= 2500`), redemption uplift requires live-direct dynamic permissionless redemption capacity with atomic or immediate settlement; static, documented-bound, live-proxy, issuer/API, queue, and estimated routes stay visible but do not uplift Liquidity / Exit until live-open evidence returns
- Low-confidence redemption routes stay visible in the dimension detail, but they do not improve the Safety Score liquidity score
- Formula-based routes with live on-chain fee telemetry can use the current redemption fee bps for cost scoring while remaining labeled as formula models
- When DEX liquidity is stale (age beyond `CRON_INTERVALS["sync-dex-liquidity"] * 2`), the last-known score still feeds effective-exit scoring; staleness is surfaced via `liquidityStale` and `inputFreshness.dexLiquidity.stale` so consumers can warn on age without losing the dimension. Scoring only falls back to redemption-only or `NR` when no DEX snapshot exists at all
- When the current redemption-backstop snapshot is stale or missing (defined here as missing or older than twice the 4-hourly redemption sync cadence), report cards suppress redemption inputs for Safety Score liquidity; the dimension falls back to fresh DEX liquidity or `NR`
- If the DEX liquidity snapshot loader fails outright at read time, `/api/report-cards` degrades in place: the (empty) map is used, so coins with no DEX coverage still `NR` as before
- If a redemption route is configured but currently unrated, the dimension stays `NR` without pretending the route is absent; the detail string calls out the configured-but-unrated state explicitly
- High concentration (HHI > 0.5) remains descriptive context, not an extra penalty
- See [Redemption Backstops](./redemption-backstops.md) for redemption component scoring and route-family caps

### Resilience Details

2-factor solvency measure (each sub-factor 1/2 of the resilience score). Chain infrastructure is scored exclusively in the Decentralization dimension to avoid double-counting. Blacklist capability is reported descriptively but does not affect the Resilience score.

| Sub-factor             | Scoring                                    | Tiers                                                                                                                                                         |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Collateral Quality** | Reserve-derived weighted score (see below) | 0–100 from curated reserve compositions, or enum fallback                                                                                                     |
| **Custody Model**      | Who controls the economic backing?         | Fully on-chain (100), Top-tier custodian (80), Regulated custodian (55), Unregulated custodian (30), Sanctioned custodian (5), CEX / off-exchange custody (0) |

**Formula:** `resilience = (collateral + custody) / 2`

For tokenized RWA collateral, the custody model follows the ultimate reserve/legal custody layer rather than only the smart-contract location of the wrapper token.

#### Blacklist Capability Tiers

Blacklist capability is reported descriptively only and does not affect the Resilience score.

| Value                       | Condition                                                             |
| --------------------------- | --------------------------------------------------------------------- |
| Yes                         | `canBeBlacklisted: true` (explicit) or `governance === "centralized"` |
| Possible                    | Explicit `canBeBlacklisted: "possible"` override, sub-majority reserve exposure to blacklistable/custodial assets, or reserve-rail text that clearly implies CEX/custody freeze exposure |
| Upstream                    | >50% of reserves are directly tied to explicitly blacklistable or already-blacklistable upstream assets (resolved transitively) |
| No                          | None of the above                                                     |

`"inherited"` is a **computed** value only — it never appears as a manual override in stablecoin metadata. The `canBeBlacklisted` field in `StablecoinMeta` only accepts `boolean | "possible"`. The inherited tier is derived at scoring time when reserve compositions show that a majority of a coin's reserves are either explicitly marked blacklistable or backed by upstream assets that are themselves blacklistable. Coins with reserve-side blacklist clues below that majority threshold now resolve to `"possible"` rather than incorrectly falling through to `"no"`.

#### Collateral Quality: Reserve-Derived Scoring (v3.3)

For coins with curated reserve compositions, collateral quality is computed as a weighted average of per-slice risk scores:

#### Live Reserve Passthrough (v5.8, tightened in v6.2, v6.5, and v6.6)

Three reserve-related labels mean different things:

| Label | Meaning | Score impact |
| ----- | ------- | ------------ |
| Reserve view | The stablecoin detail page can show a reserve composition from live sync, curated validation, proof/liveness, curated metadata, or estimated templates | Informational unless the feed also satisfies the score-grade live reserve rules |
| Score-grade live reserve | The current report-card snapshot used a fresh, clean, independent live reserve snapshot for collateral quality | Can replace curated collateral slices in the Resilience dimension |
| Redemption telemetry | A live reserve adapter emitted current redemption capacity, fee, freshness, or route status | Can feed Redemption Backstop capacity or fee scoring; does not automatically change collateral quality |

For coins with live reserve sync (`liveReservesConfig`), the collateral quality score
can use the 4-hourly live snapshot from `reserve_composition` instead of curated
`StablecoinMeta.reserves`, but only when the snapshot is both authoritative and
independent:

- authoritative = fresh (< 48h), non-empty, and matched to `reserve_sync_state.last_success_at`
- clean = `reserve_sync_state.last_status === "ok"`; warning-bearing `degraded` snapshots stay visible on reserve detail/status surfaces but do not drive scoring
- independent = adapter `evidenceClass` is `independent`
- scoring-eligible freshness = `freshnessMode === "verified"` or `freshnessMode === "not-applicable"`; `freshnessMode === "unverified"` stays detail-visible but does not drive scoring
- timestamp-backed dashboard/disclosure feeds can qualify only when the adapter preserves a trustworthy upstream `sourceTimestamp` and the adapter's source-age policy still marks it fresh
- direct one-bucket on-chain reserve proofs can qualify when they are registered as independent (for example LUSD's dedicated `liquity-v1` adapter); generic liveness probes do not qualify just because they are on-chain
- `validated-static` feeds (for example `curated-validated` and `frax`) and `weak-live-probe` feeds (for example `single-asset` and `tether`) remain authoritative for reserve detail/status surfaces, but they do not override curated collateral scoring
- the live reserve registry now enforces an explicit per-adapter freshness contract, so latest-state on-chain proofs, timestamp-backed disclosures, and explicitly unverified dashboard feeds cannot silently drift into undocumented freshness semantics

This keeps reserve displays broad while keeping collateral scoring strict.

The `collateralFromLive` flag in `RawDimensionInputs` indicates which source was used.
Dependency inference (`deriveDependencies`) remains on curated data because live
adapter slices do not carry `coinId` links.

A delta alert fires when the independent live-derived score diverges from curated by >15 points,
signaling that curated metadata (and potentially the governance classification) may
need human review.

Delta alerts are fired from the 4-hourly reserve sync cron via `checkCollateralDrift()`.
Drift data is also included in the report-cards snapshot as `collateralDriftCoins` for
`/status` visibility. Coins using curated fallback (no fresh independent live data) are tracked as
`liveToFallbackCoins` in the snapshot metadata.

If the live reserve snapshot loader is temporarily unavailable at read time, report cards
continue serving from curated reserve metadata and mark the affected coins in
`liveToFallbackCoins` for operator visibility instead of failing the endpoint.

**Blacklist Reserve Enrichment**

When live reserve data is available, `isBlacklistable()` uses enriched live
slices instead of curated reserves. The enrichment scans live slice names for
known blacklistable coin symbols (e.g., "sUSDe" matches USDe, "stataUSDC"
matches USDC) plus direct stablecoin/custody clues such as named USDC baskets
or explicit CEX/custodian descriptors. This ensures that composition shifts
detected by live adapters are reflected in blacklist status without waiting for
curated data updates.

The resolver now converges to a fixed point across the tracked coin set rather
than relying on a single order-sensitive pass, so cyclic reserve graphs do not
produce traversal-dependent blacklist statuses. When no live reserves exist,
curated `StablecoinMeta.reserves` are used as fallback, and the same reserve-name
heuristics are applied there as well. The collateral drift alert (>15pt
divergence) helps operators detect when curated metadata needs updating for
other scoring dimensions.

| Reserve Risk Tier | Score | Description                        | Examples                                                                      |
| ----------------- | ----- | ---------------------------------- | ----------------------------------------------------------------------------- |
| `very-low`        | 100   | No/minimal counterparty risk       | Government securities, cash, repos, physical gold/silver, ETH, canonical WETH |
| `low`             | 75    | Stablecoin/tokenized layer         | USDC, BUIDL, USYC, ETH LSTs, other stablecoins                                |
| `medium`          | 50    | Wrapped/structured market exposure | wBTC, tokenized gold, transparent spot/wrapped market exposure, tokenized ETFs |
| `high`            | 25    | Active strategy / volatile exposure | SOL, BNB, TRX, alt-chain tokens, externally managed market-neutral or basis books, LP/private-deal/perp strategy reserves |
| `very-high`       | 5     | Governance/exotic/opaque           | Governance tokens, algorithmic mechanisms, sanctioned assets                  |

**Formula:** `score = round(Σ(slice_pct × tier_score) / Σ(slice_pct))`

**Display thresholds:** ≥88 → "Very low risk", ≥62 → "Low risk", ≥37 → "Medium risk", ≥15 → "High risk", <15 → "Very high risk"

Reserve compositions are maintained in `StablecoinMeta.reserves` as arrays of `{ name, pct, risk }` slices.

Direct ETH reserve slices and canonical wrapped ETH (`WETH`) use the same `very-low` tier. ETH liquid staking tokens (`stETH`, `wstETH`, `rETH`, etc.) remain `low`, while strategy buckets or bridged ETH exposures can still be modeled separately when the reserve slice represents more than spot ETH custody. Delta-neutral labels are evaluated by structure: transparent spot/wrapped exposure can remain medium, but capital delegated to external managers, off-exchange or perp books, LPs, private liquidity deals, or complex DeFi strategy baskets is high unless a stronger source proves the slice is only a liquid stablecoin/cash-equivalent buffer.

#### Collateral Quality: Enum Fallback

For coins without curated reserves, the legacy enum-based scoring is used:

| Enum Value                 | Score |
| -------------------------- | ----- |
| `native`                   | 100   |
| `eth-lst`                  | 66    |
| `rwa`                      | 50    |
| `alt-lst-bridged-or-mixed` | 20    |
| `exotic`                   | 0     |

**Default inference:** When sub-factor fields aren't explicitly set on `StablecoinMeta`, defaults are inferred from `backing` + `governance`:

| Backing + Governance                      | Chain Tier | Deployment Model | Collateral Quality | Custody Model |
| ----------------------------------------- | ---------- | ---------------- | ------------------ | ------------- |
| `rwa-backed` + `centralized`              | ethereum   | single-chain     | rwa                | institutional-regulated |
| `rwa-backed` + `centralized-dependent`    | ethereum   | single-chain     | rwa                | institutional-regulated |
| `crypto-backed` + `decentralized`         | ethereum   | single-chain     | native             | onchain       |
| `crypto-backed` + `centralized-dependent` | ethereum   | single-chain     | eth-lst            | onchain       |
| `algorithmic` + any                       | ethereum   | single-chain     | native             | onchain       |

Explicit overrides exist for coins where defaults are incorrect (e.g. HYUSD on Solana, USDe with CEX custody, BOLD with third-party bridge).

Data sources: `collateralQuality`, `custodyModel` optional fields on `StablecoinMeta`. `canBeBlacklisted` field (falls back to governance type). Reserve compositions on `StablecoinMeta.reserves`.

### Decentralization Details

Score from `GovernanceQuality` tier (v5.1), with chain infrastructure penalty for protocols on less decentralized chains. The coarse 3-level `GovernanceType` is replaced by a 6-tier quality classification that can be explicitly overridden per coin.

**Governance Quality Tiers:**

| Tier               | Score | Default for GovernanceType | Examples                                               |
| ------------------ | ----- | -------------------------- | ------------------------------------------------------ |
| `immutable-code`   | 100   | — (must be explicit)       | LUSD, BOLD                                             |
| `dao-governance`   | 85    | `decentralized`            | overrides: crvUSD, USDS, DAI, GHO, FRAX, DOLA          |
| `multisig`         | 55    | `centralized-dependent`    | Most CeFi-dep coins without explicit override          |
| `regulated-entity` | 40    | — (auto-promoted)          | Centralized issuers with verified regulatory oversight |
| `single-entity`    | 20    | `centralized`              | USDT, USDC, PYUSD                                      |
| `wrapper`          | 10    | — (must be explicit)       | syrupUSDC, Cap cUSD, USX, OUSD, FPI                    |

Resolution: `meta.governanceQuality ?? inferGovernanceQuality(meta.flags.governance)`. Override via `governanceQuality` field on `StablecoinMeta`.

**Auto-promotion to `regulated-entity`:** A `single-entity` coin is automatically promoted to `regulated-entity` (40) when all three conditions are met: `jurisdiction.regulator` is set, `jurisdiction.license` is set, and `proofOfReserves.type === "independent-audit"`. This recognizes that regulated, audited centralized issuers carry less governance risk than unregulated single entities.

**Chain infrastructure penalty** (threshold-based on combined `chainInfraScore`, applied to DAO and multisig governance — immutable-code, wrapper, and centralized issuers are exempt):

| Combined Score Range | Penalty |
| -------------------- | ------- |
| 80–100               | 0       |
| 60–79                | −10     |
| 40–59                | −25     |
| 20–39                | −40     |
| 0–19                 | −60     |

`immutable-code` is exempt because there is no governance to undermine — chain centralization cannot compromise non-existent governance keys. `wrapper` is exempt because its governance score already reflects inherited upstream governance. Centralized issuers (`single-entity`, `regulated-entity`) are exempt because their governance score already reflects the centralization.

#### Chain Infrastructure: Two-Axis Scoring

The chain infrastructure score combines **primary chain maturity** with **deployment model risk** via multiplicative scoring:

`chainInfraScore = CHAIN_TIER_SCORE[chainTier] × DEPLOYMENT_MULT[deploymentModel]`

**Chain tier** (where core minting/logic lives):

| Tier                 | Score |
| -------------------- | ----- |
| `ethereum`           | 100   |
| `stage1-l2`          | 66    |
| `mature-alt-l1`      | 45    |
| `established-alt-l1` | 20    |
| `unproven`           | 0     |

**Deployment model** (how the token extends to other chains):

| Model                | Multiplier | Description                                                        |
| -------------------- | ---------- | ------------------------------------------------------------------ |
| `single-chain`       | 1.00       | No multichain presence, or irrelevant bridged copies               |
| `canonical-bridge`   | 0.90       | Bridges via L2 canonical rollup bridges (inherits rollup security) |
| `native-multichain`  | 0.75       | Independent minting/redeeming on multiple chains                   |
| `third-party-bridge` | 0.60       | Bridges via CCIP, LayerZero, Wormhole, etc.                        |

**Combined score matrix:**

| Deployment Model   | ETH (100) | L2 (66) | Mature Alt-L1 (45) | Alt-L1 (20) | Unproven (0) |
| ------------------ | --------- | ------- | ------------------ | ----------- | ------------ |
| single-chain       | 100       | 66      | 45                 | 20          | 0            |
| canonical-bridge   | 90        | 59      | 41                 | 18          | 0            |
| native-multichain  | 75        | 50      | 34                 | 15          | 0            |
| third-party-bridge | 60        | 40      | 27                 | 12          | 0            |

Coins without overrides default to Ethereum + single-chain (score 100, penalty 0).

Examples: BOLD (immutable-code) = **100** (exempt from chain penalty). LUSD (immutable-code) = **100**. hyUSD (dao-governance, Solana → infra 45) = 85 − 25 = **60**. USDB (multisig, Blast L2) = 55 − 10 = **45**. cUSD (wrapper, Ethereum → infra 100) = **10** (wrapper exempt from chain penalty).

Chain penalty applies to `dao-governance` and `multisig` tiers. Exempt tiers: `immutable-code`, `wrapper`, `single-entity`, `regulated-entity`.

### Dependency Risk Details

**Universal scoring (v5.1):** All coins with upstream stablecoin dependencies get blended scores, regardless of governance type. Topological sort ensures every coin is scored after all its upstreams.

**Dependency derivation:** Dependencies are primarily derived from reserve composition data. Reserve slices with a `coinId` field (linking to a tracked stablecoin) are extracted by `deriveDependencies()` in `shared/lib/reserve-templates.ts` and converted to `DependencyWeight[]` (weight = `pct / 100`, type = `depType ?? "collateral"`). Weights come directly from reserve percentages when total dependency weight is <= 1, so non-stablecoin reserve slices contribute to the "self-backed" component of the score. If declared dependency weight exceeds 1, dependency weights are normalized by raw total and the self-backed fraction is zero. For coins whose reserves don't reference tracked stablecoins, the function falls back to the manual `dependencies` array on `StablecoinMeta`.

**Scoring:**

- **No dependencies**: `SELF_BACKED_SCORE_BY_GOVERNANCE[governance]` — varies by tier: `decentralized` = 90, `centralized-dependent` = 75, `centralized` = 95
- **With dependencies**: `score = sum((weight_i / normalizer) × upstream_score_i) + (1 − min(1, rawTotalWeight)) × SELF_BACKED_SCORE`, where `normalizer = rawTotalWeight` only when raw dependency weight exceeds 1 and is otherwise 1
- −10 penalty if any dependency scores below 75 (B-)
- Falls back to 70 if all dependency scores are unavailable; if only some upstream scores are unavailable, those missing weights are scored at 70 and still count as weak dependencies for the below-75 penalty

**Self-backed score by governance type:**

| Governance Type         | Self-Backed Score | Rationale                                                |
| ----------------------- | ----------------- | -------------------------------------------------------- |
| `decentralized`         | 90                | Own peg mechanisms (CDPs, LLAMMA) function independently |
| `centralized-dependent` | 75                | PSMs/arbitrage loops coupled to upstream infrastructure  |
| `centralized`           | 95                | Standalone RWA-backed, minimal coupling                  |

#### Dependency Type Ceilings

Each dependency relationship can be classified as `wrapper`, `mechanism`, or `collateral` (default). After the blended score is computed, a ceiling is applied based on the most critical upstream dependency.

| Type         | Meaning                                              | Ceiling            |
| ------------ | ---------------------------------------------------- | ------------------ |
| `wrapper`    | Thin layer around upstream (e.g., syrupUSDC -> USDC) | upstream_score - 3 |
| `mechanism`  | Critical to peg mechanism (e.g., DAI -> USDC PSM)    | upstream_score     |
| `collateral` | Standard collateral (default)                        | no ceiling         |

Formula: `final_score = min(blended_score, min_ceiling_from_wrapper_and_mechanism_deps)`

The ceiling ensures that a coin which fundamentally depends on an upstream stablecoin cannot score higher than that upstream, regardless of how well it performs on other factors.

**Examples:**

- **USDC at 95, DAI (mechanism dep):** blended = 82, ceiling = 95, final = **82** (no change -- blended already below ceiling)
- **USDC at 60, DAI (mechanism dep):** blended = 69.75, ceiling = 60, final = **60** (ceiling kicks in)
- **syrupUSDC (wrapper dep on USDC at 95):** ceiling = 95 - 3 = **92** (wrapper penalty reflects thin-layer risk)

## Grade Thresholds

Lowered 5 points in v4.0 to compensate for structural deflation from removing peg from the base. Lowered another 5 points in v5.1 to fix C-range overcrowding after blacklist/decentralization scoring adjustments.

| Grade | Min Score  |
| ----- | ---------- |
| A+    | 87         |
| A     | 83         |
| A-    | 80         |
| B+    | 75         |
| B     | 70         |
| B-    | 65         |
| C+    | 60         |
| C     | 55         |
| C-    | 50         |
| D     | 40         |
| F     | 0          |
| NR    | null score |

## Grade Colors

| Range         | Badge (Tailwind) | Radar (hex) |
| ------------- | ---------------- | ----------- |
| A (A+, A, A-) | emerald-500      | `#10b981`   |
| B (B+, B, B-) | blue-500         | `#3b82f6`   |
| C (C+, C, C-) | amber-500        | `#f59e0b`   |
| D             | orange-500       | `#f97316`   |
| F             | red-500          | `#ef4444`   |
| NR            | muted            | `#71717a`   |

## API

`GET /api/report-cards` — all coins graded with per-dimension breakdown and methodology metadata. Cache: standard (5-min edge).

`GET /api/redemption-backstops` — current redemption backstop and effective-exit dataset used by redeemable-asset detail views and report-card liquidity inputs. Cache: standard (`public, s-maxage=300, max-age=60`).

Response includes `cards` (array of `ReportCard` with `rawInputs` for client-side recomputation), `dependencyGraph` (forward edges for dependency traversal, including canonical `weight` and `type` metadata), `methodology` (version, weights, `pegMultiplierExponent`, thresholds), `inputFreshness` (DEX and redemption freshness used for score gating), `liquidityStale`, `redemptionStale`, and `updatedAt`. See [API Reference](./api-reference.md) for the full response shape.

`GET /api/safety-score-history` — per-coin Safety Score grade history timeline (`stablecoin` required, `days` optional). Backed by `safety_grade_history` event rows written daily by `snapshot-safety-grade-history`. Cache: slow (1-hour edge).

Implementation notes:

- Report cards and peg summary share peg-event derivation through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), so peg score/current deviation windows are computed once with identical logic in both endpoints.
- Report-card API responses and the grade-history cron both use `worker/src/lib/report-cards-snapshot.ts` (`buildReportCardsSnapshot()`), preventing scoring drift between live API and persisted history.

Key types:

- **`DependencyWeight`**: `{ id: string; weight: number; type?: "wrapper" | "mechanism" | "collateral" }` — upstream stablecoin ID, collateral fraction (0–1), and optional dependency ceiling semantics. Replaces the old `string[]` dependency format.
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `activeDepegBps`, `liquidityScore`, `effectiveExitScore`, `redemptionBackstopScore`, `redemptionRouteFamily`, `redemptionImmediateCapacityUsd`, `redemptionImmediateCapacityRatio`, `concentrationHhi`, `bluechipGrade`, `canBeBlacklisted`, `chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel`, `governanceTier`, `governanceQuality`, `dependencies`, `navToken`, `collateralFromLive`) — enables client-side stress test recomputation.

## Portfolio Analyzer & Stress Test

Collapsible panel on `/safety-scores` between the grade distribution bar and card grid. Two sections stacked vertically:

### Portfolio Analyzer

Users enter stablecoin holdings (coin + USD amount). Derived computations (all client-side):

- **Portfolio grade**: `sum(coinScore × coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded.
- **Portfolio radar**: Same weighted average per dimension. Displays via `ReportCardRadar` with a synthetic `ReportCard`.
- **Upstream exposure**: Walks `dependencies` using collateral weights. Direct CeFi holdings attribute 100% to themselves. Aggregates by upstream coin ID. Shows concentration warning when any single upstream exceeds 80%.

State: `usePortfolio` hook. Sources (priority): URL `?p=usdc-circle:50000,dai-makerdao:5000` → `localStorage` → empty. Shared links don't overwrite saved portfolio.

`localStorage` migration behavior: on read, holdings are validated, then IDs are migrated through the shared registries used by `src/lib/portfolio-codec.ts` (`REGISTRY_BY_ID` first, `REGISTRY_BY_LLAMA_ID` second). Unknown IDs are dropped, duplicate canonical IDs are merged by amount, and migrated data is written back once.

### Interactive Stress Test

Users simulate a grade downgrade for any upstream coin and watch cascading grade changes:

- **Coin selector**: Filtered to coins appearing as `from` in `dependencyGraph.edges`, sorted by dependent count.
- **Grade selector**: Only downgrades from the coin's current grade to F.
- **Recomputation**: `computeStressedGrades()` injects a synthetic score, walks all transitive downstream dependencies, and recomputes only the Dependency Risk dimension for affected downstream coins in dependency order. The current snapshot size is 274 cards (186 active tracked assets plus 88 cemetery entries; pre-launch tracked assets are excluded) × 5 dimensions, which remains comfortably sub-millisecond in practice.
- **Two display modes**: Portfolio mode (dollar-denominated, scoped to held coins in impact table) vs ecosystem mode (all affected coins with market cap).
- **Card grid simulation**: ALL affected coins show dashed amber borders + "Simulated" badge regardless of portfolio mode. Unaffected cards dimmed. Sticky banner with clear button.

State: `useStressTest` hook. URL sync: `?stress=usdc-circle&grade=D`.

Legacy symbol-based tokens are still accepted only when the symbol is unique across tracked metadata. Ambiguous symbols are rejected instead of silently resolving to the wrong asset.

## Frontend

- **Grid page**: `src/app/safety-scores/client.tsx` — filterable/sortable grid of non-defunct grade cards with grade distribution bar, core settlement rail strip/sort affordance, portfolio/stress panel integration, simulation mode
- **Portfolio & stress panel**: `src/components/stress-test-panel.tsx` — collapsible panel with holdings editor, portfolio grade/radar/exposure, stress test controls + impact table
- **Detail card**: `src/components/report-card.tsx` — full radar chart + dimension breakdown; the mobile grade strip wraps and keeps the score-breakdown disclosure on its own row so the chart keeps usable width. The title and key opaque dimensions (`Resilience`, `Dependency Risk`) now expose contextual methodology hints, and the card footer links directly back to the Safety Score methodology / changelog.
- **Detail timeline**: `src/components/stablecoin-detail/safety-score-history-section.tsx` — per-coin grade transition timeline (seed row + changes) shown under the Safety Score section on `/stablecoin/[id]`
- **Mini card**: `src/components/report-card-mini.tsx` — compact grid tile with simulation support (dashed border, before→after grade, "Simulated" badge) and a "Core rail" marker for objectively qualified settlement rails; the radar stage now uses a width-driven aspect ratio so the grid cards do not carry excess vertical dead space
- **Radar chart**: `src/components/radar-chart.tsx` — hexagonal Recharts radar with `ReportCardRadar` (single) and `CompareRadar` (multi-coin overlay); `ReportCardRadar` automatically switches to short axis labels on very narrow containers
- **Hooks**: `src/hooks/api-hooks.ts` (`useReportCards`, `useSafetyScoreHistory`), `src/hooks/use-portfolio.ts` (portfolio state + browser persistence), `src/hooks/use-stress-test.ts` (stress test state + recomputation)

## Key Files

| File                                                                | Purpose                                                                                                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/lib/report-cards.ts`                                        | Pure grading engine: dimension scorers, weights, thresholds, colors, `computeStressedGrades()`                                                        |
| `worker/src/lib/report-cards-snapshot.ts`                           | Shared report-card snapshot builder used by API + grade-history cron                                                                                  |
| `worker/src/api/report-cards.ts`                                    | API handler: serves shared snapshot response with freshness headers                                                                                   |
| `worker/src/cron/snapshot-safety-grade-history.ts`                  | Daily grade-history event snapshot writer (`safety_grade_history`)                                                                                    |
| `worker/src/api/safety-score-history.ts`                            | History endpoint for per-coin grade transitions                                                                                                       |
| `src/components/stress-test-panel.tsx`                              | Combined portfolio analyzer + stress test collapsible panel                                                                                           |
| `src/components/report-card.tsx`                                    | Full detail card with radar                                                                                                                           |
| `src/components/stablecoin-detail/safety-score-history-section.tsx` | Stablecoin detail grade-history timeline UI                                                                                                           |
| `src/components/report-card-mini.tsx`                               | Compact grid tile with simulation mode support                                                                                                        |
| `src/components/radar-chart.tsx`                                    | Recharts radar visualization                                                                                                                          |
| `src/app/safety-scores/client.tsx`                                  | Full page with filtering, sorting, grade distribution, simulation mode                                                                                |
| `src/hooks/api-hooks.ts`                                            | TanStack Query hook exports for `useReportCards()` and `useSafetyScoreHistory()`                                                                      |
| `src/hooks/use-portfolio.ts`                                        | Portfolio holdings state + browser persistence; delegates codec and exposure math to `src/lib/portfolio-codec.ts` and `src/lib/portfolio-analysis.ts` |
| `src/hooks/use-stress-test.ts`                                      | Stress test state, `computeStressedGrades` invocation, impact calculation                                                                             |
