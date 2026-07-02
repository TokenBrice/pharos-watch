# Safety Scores

Multi-dimensional risk grades (A+ through F) for every tracked stablecoin. The API normally serves the cron-published report-card snapshot and computes the same response shape on read only when that snapshot is missing, invalid, or pinned to an older Safety Score methodology generation.

The stablecoin registry currently contains 408 tracked metadata entries. Report-card snapshots score the 364 active tracked assets plus the 88 cemetery assets; frozen-archive tracked entries are emitted as stub `F` cards, while pre-launch entries remain outside the snapshot until they launch.

## Methodology Versioning

- **Current methodology version:** `v8.13`
- **Runtime/version source:** `shared/lib/methodology-versions/safety-score.ts`
- **Public changelog route:** `/methodology/scoring-changelog/`
- **Version timeline:** [report-cards-timeline.md](./report-cards-timeline.md)

## Overall Grade (v8.13)

Four-step computation:

1. **Base score**: weighted average of 4 base dimensions (each 0-100). NR dimensions have their weight redistributed proportionally among rated ones. Requires at least 2 rated base dimensions; otherwise overall = NR.
2. **Peg multiplier**: `final = base × (pegScore / 100) ^ 0.40`. Coins with good pegs (90+) barely affected (~4% penalty). Coins with broken pegs get sharply penalized (pegScore 10 -> 60% penalty). pegScore = NR (pure NAV tokens with no configured peg reference) -> multiplier 1.0 (no penalty). pegScore = 0 -> multiplier 0.
3. **No-liquidity penalty**: `final × 0.9` when the Liquidity / Exit dimension is NR (no DEX or redemption-backstop signal at all). No free pass — as coverage matures, absence of any exit signal is increasingly suspicious. Implemented via `NO_LIQUIDITY_PENALTY = 0.9` in `shared/lib/report-card-core.ts`.
4. **Active depeg cap**: coins with a severe ongoing depeg are hard-capped after the no-liquidity penalty. `activeDepegBps` is the open event's absolute peak deviation, not the latest spot deviation. Active depegs >= 2500 bps (25%+) cap at F (39), >= 1000 bps (10%+) cap at D (49).

Cemetery coins get a permanent F.

Current-version note: v8.13 tightens Dependency Risk live-reserve derivation: when a score-grade live reserve snapshot has no mapped tracked-asset links at all, Dependency Risk falls back to curated reserve links or manual dependencies before treating the asset as live-unmapped/self-backed. Partial live mappings remain authoritative, so unmapped remainder inside a mapped live snapshot still counts as self-backed / non-stablecoin reserve share. The v8.12 bridge-route blend, v8.11 oracle provenance and branch handling, v8.0 Mint Authority blend, v7.29 liquidity/redemption rules, and v7.291 degraded-input history guard carry forward unchanged.

## Yield Source-Risk Boundary

Yield Intelligence source-risk evidence is not a report-card input in the current methodology. `sourceRisk.*` fields can affect the Pharos Yield Score (PYS), opportunity-level tranche Safety Scores, and same-confidence yield source arbitration, but they do not change the underlying stablecoin's Safety Score, Resilience, or Dependency Risk dimensions here. External lending opportunities and structured-tranche rows belong to opportunity scoring, not the base stablecoin report card.

Any future use of yield source-risk that affects Safety Score, Resilience, Dependency Risk, or the overall grade must ship as a report-card methodology change with the corresponding `docs/report-cards.md` and `docs/report-cards-timeline.md` updates. Until then there are no hidden yield source-risk penalties, caps, or score modifiers in report-card scoring.

## Mint Authority Boundary

Mint Authority review produces the Mint Authority Score (MAS methodology `v1.2`) from reviewed mint path, weakest mint-capable controller, quantitative bounds, authority posture, evidence confidence, inheritance, and time-decayed incident caps. Detail pages may show the score, band, component breakdown, primary controls, source links, and incident callouts when compact review data exists; pages without reviewed data omit the section or show `NR` where aggregate surfaces require a value. The homepage table and `/screener/` may sort, display, export, or filter the same standalone score and review buckets so users can inspect who can create or route durable supply.

As of Safety Score v8.0 the Mint Authority Score feeds the **Decentralization** dimension through a penalty-only blend (see Decentralization Details) and is exposed in report-card raw inputs as `mintAuthorityScore`. The remaining boundary is still strict: the score does not create selector exclusions, does not feed Resilience, Liquidity, Peg Stability, or Dependency Risk, and does not change any default ranking outside what the Decentralization dimension propagates. A missing or unresolved review (`NR`) never penalizes any Safety Score surface. Any further expansion of mint-authority data into other dimensions requires a new Safety Score methodology/version change and timeline entry.

## Dimensions

### Base dimensions (weighted sum)

| Dimension            | Weight | Source                                                                        | Scoring                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Liquidity / Exit** | 30%    | `liquidityScore` + `redemptionBackstopScore`                                  | Uses `effectiveExitScore`, which preserves DEX liquidity as the floor and lets direct redemption quality help when present                                                                                                                                                                                                                                                                                                   |
| **Resilience**       | 20%    | Token metadata (2 sub-factors)                                                | Average of collateral quality and custody model; blacklist capability is reported descriptively but does not affect the score                                                                                                                                                                                                                                                                                                |
| **Decentralization** | 15%    | Governance quality + chain infrastructure + CDP oracle setup + bridge-route risk + mint authority | `GovernanceQuality` tiers: `immutable-code` → 100, `dao-governance` → 85, `multisig` → 55, `regulated-entity` → 40, `single-entity` → 20. Resolvable wrappers inherit the wrapped asset score with a wrapper-kind haircut; unresolved wrappers fall back to 10. Threshold-based chain infrastructure penalty, then the branch-aware penalty-only CDP oracle blend (v8.11), the reviewed bridge-route blend (v8.12), and finally the penalty-only Mint Authority blend (v8.0) |
| **Dependency Risk**  | 25%    | Upstream stablecoin scores                                                    | No deps → varies by governance (decentralized: 90, centralized-dependent: 75, centralized: 95). With deps → blended score (upstream × weight + self-backed), −10 if any < 75, plus wrapper/mechanism ceilings                                                                                                                                                                                                                |

### Peg Stability (multiplier)

| Source                      | Scoring                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pegScore` from peg summary | Applied as `(pegScore/100)^0.40` multiplier to base score. Pure NAV tokens stay neutral; configured NAV wrappers can inherit peg risk from a referenced base stablecoin. Active open-event peaks >= 2500 bps cap overall at F; >= 1000 bps cap at D |

### Peg Stability Details

- Direct passthrough of `computePegScore()` output (see [Depeg Detection Pipeline](./depeg-detection.md) for the composite formula)
- v5.5 peg fairness fixes apply automatically: tracking window is capped to coin age (`coinTrackingStart()`), per-event magnitude floors prevent brief severe depegs from being under-penalized, and active-depeg penalties are steeper
- PegScore can use a durable first valid-price observation as its age anchor when a priced asset lacks both a curated launch date and `supply_history`, so report cards no longer stay NR solely because a priced non-NAV asset has not written a supply snapshot. The 7-day minimum tracking requirement still applies.
- The report-card peg dimension does not apply a second active-depeg cap before the multiplier; final D/F active-depeg caps are applied after the peg multiplier from the open event's peak deviation.
- Pure NAV fund-share tokens (yield-accruing, price-appreciating) receive NR — multiplier 1.0, no penalty
- Configured NAV wrappers over a stablecoin inherit peg stability from a referenced base asset; their own appreciating share price is ignored for peg scoring and active-depeg caps
- Yield-bearing annotation added to detail text

### Liquidity / Exit Details

- The public DEX liquidity dataset stays unchanged and fully market-based (see [DEX Liquidity Score](./dex-liquidity.md))
- Report cards use `effectiveExitScore`, not raw `liquidityScore`
- `effectiveExitScore` uses the Redemption Backstop v4 capacity-aware best-path model:
  - redemption contribution is scaled by current executable capacity versus modeled exit size (`min(max(supply × 5%, $100k), $25M)`) and by model confidence
  - the 10% diversification bonus applies only when the redemption route is plausibly independent from the DEX path (`independent-issuer-rail`)
- If only DEX liquidity exists, `effectiveExitScore = liquidityScore`
- If only eligible current-capacity redemption exists, `effectiveExitScore` uses the capacity/confidence-adjusted redemption score
- Documented offchain-issuer eventual exits remain visible but do not replace missing DEX liquidity without current executable capacity.
- Redemption uplift is only used when the redemption route is resolved, above the low-confidence / heuristic tier, and not currently impaired by route-availability evidence
- Eventual-only redemption routes remain visible in the dimension detail. They do not replace missing DEX liquidity, but documented-bound offchain issuer routes can add a capped primary-market exit bonus when DEX liquidity is already available
- Queue-like redemption routes can improve Liquidity / Exit when resolved and current, but their redemption contribution is capped before the best-path blend so delayed exits cannot behave like instant liquidity
- During severe active depegs (`activeDepegBps >= 2500`), redemption uplift requires live-direct dynamic permissionless redemption capacity with atomic or immediate settlement; static, documented-bound, live-proxy, issuer/API, queue, and estimated routes stay visible but do not uplift Liquidity / Exit until live-open evidence returns
- Live reserve redemption telemetry can further constrain scoring: nested `freshnessKind: "unverified"` fails closed unless route-specific lower-bound approval exists, proxy/queue capacity kinds cannot qualify as severe-depeg live-direct evidence, and adapter-emitted daily limits, queue depth, settlement delay, minimum size, and holder eligibility can lower the usable capacity score
- Low-confidence redemption routes stay visible in the dimension detail, but they do not improve the Safety Score liquidity score
- Formula-based routes with live on-chain fee telemetry can use the current redemption fee bps for cost scoring while remaining labeled as formula models
- When DEX liquidity is stale (age beyond `CRON_INTERVALS["sync-dex-liquidity"] * 2`), the last-known score still feeds effective-exit scoring; staleness is surfaced via `liquidityStale` and `inputFreshness.dexLiquidity.stale` so consumers can warn on age without losing the dimension. Scoring only falls back to redemption-only or `NR` when no DEX snapshot exists at all
- When the current redemption-backstop snapshot is stale or missing (defined here as missing or older than twice the 4-hourly redemption sync cadence), report cards suppress redemption inputs for Safety Score liquidity; the dimension falls back to the last-known DEX liquidity snapshot when one exists, with DEX staleness surfaced via `liquidityStale` and `inputFreshness.dexLiquidity.stale`, or `NR` when no DEX snapshot exists
- If the DEX liquidity snapshot loader fails outright at read time, `/api/report-cards` degrades in place: the (empty) map is used, so coins with no DEX coverage still `NR` as before
- If a redemption route is configured but currently unrated, the dimension stays `NR` without pretending the route is absent; the detail string calls out the configured-but-unrated state explicitly
- High concentration (HHI > 0.5) remains descriptive context, not an extra penalty
- See [Redemption Backstops](./redemption-backstops.md) for redemption component scoring and route-family caps

### Core Settlement Rail Strip

The Safety Scores grid has a product-facing "Core settlement rails" strip for very large, broadly deployed assets. It is not a methodology dimension and does not change grades. The gate requires all of the following from the current report-card/list payload: market cap at least `$25B`, at least `10` chains, Peg Stability at least `90`, Liquidity / Exit at least `60`, Dependency Risk at least `90`, no dependencies, and a high- or medium-confidence `offchain-issuer` redemption route. Other route families can still support Liquidity / Exit, but they do not satisfy the issuer-exit rail label.

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

| Value    | Condition                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Yes      | `canBeBlacklisted: true` (explicit), reviewed direct-freeze evidence, or unsuppressed `governance === "centralized"` |
| Possible | Explicit `canBeBlacklisted: "possible"` override for a direct token/vault freeze, blacklist, or pause surface        |
| Upstream | Any reserve, backing, custody, parent-asset path, or curated upstream review that can freeze or block value upstream |
| No       | None of the above                                                                                                    |

`"inherited"` is the internal value displayed as `Upstream`. It is not accepted by the `canBeBlacklisted` direct-override field, which remains `boolean | "possible"`, but curated `blacklistabilityReview.reviewedStatus: "inherited"` can pin an upstream-only review when no direct holder-token freeze surface is identified. Admin mint authority is reviewed separately in the Mint Authority module and no longer creates a FreezeWatch tier by itself. The inherited tier covers reserve-side stablecoins, custodied wrappers, issuer-seizable tokenized collateral, custody/CEX rails, tracked parent-asset exposures, and backing/redemption rails regardless of weight. This is an any-reserve policy: once a reserve/backing/custody/parent path resolves to a freezeable upstream asset, it is classified as Upstream rather than Possible even if the matched slice is small. `"possible"` is reserved for curated direct token/vault controls whose freeze surface exists at the holder-facing asset rather than only in upstream collateral.

#### Collateral Quality: Reserve-Derived Scoring (v3.3)

For coins with curated reserve compositions, collateral quality is computed as a weighted average of per-slice risk scores:

#### Live Reserve Passthrough (v5.8, tightened in v6.2, v6.5, and v6.6)

Three reserve-related labels mean different things:

| Label                    | Meaning                                                                                                                                                | Score impact                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Reserve view             | The stablecoin detail page can show a reserve composition from live sync, curated validation, proof/liveness, curated metadata, or estimated templates | Informational unless the feed also satisfies the score-grade live reserve rules                                     |
| Score-grade live reserve | The current report-card snapshot used a fresh, clean, independent live reserve snapshot for collateral quality                                         | Can replace curated collateral slices in the Resilience dimension and, when slices carry `coinId`, dependency links |
| Redemption telemetry     | A live reserve adapter emitted current redemption capacity, fee, freshness, or route status                                                            | Can feed Redemption Backstop capacity or fee scoring; does not automatically change collateral quality              |

For coins with live reserve sync (`liveReservesConfig`), the collateral quality score
can use the 4-hourly live snapshot from `reserve_composition` instead of curated
`StablecoinMeta.reserves`, but only when the snapshot is both authoritative and
independent:

- authoritative = fresh (< 48h), non-empty, and matched to `reserve_sync_state.last_success_at`
- clean = `reserve_sync_state.last_status === "ok"`; warning-bearing `degraded` snapshots stay visible on reserve detail/status surfaces but do not drive scoring
- independent = adapter `evidenceClass` is `independent`
- scoring-eligible freshness = a verified timestamp-backed snapshot or `freshnessMode === "not-applicable"`; `freshnessMode === "unverified"` stays detail-visible but does not drive scoring, even if older metadata includes a legacy freshness-approval flag
- timestamp-backed dashboard/disclosure feeds can qualify only when the adapter preserves a trustworthy upstream `sourceTimestamp` and the adapter's source-age policy still marks it fresh
- direct one-bucket on-chain reserve proofs can qualify when they are registered as independent (for example LUSD's dedicated `liquity-v1` adapter); generic liveness probes do not qualify just because they are on-chain
- `validated-static` feeds (for example `curated-validated` and `attestation-pdf-index`) and `weak-live-probe` feeds (for example `single-asset`, `solstice-attestation`, and `river-protocol-info`) remain authoritative for reserve detail/status surfaces, but they do not override curated collateral scoring
- the live reserve registry now enforces an explicit per-adapter freshness contract, so latest-state on-chain proofs, timestamp-backed disclosures, and explicitly unverified dashboard feeds cannot silently drift into undocumented freshness semantics

This keeps reserve displays broad while keeping collateral scoring strict.

The `collateralFromLive` flag in `RawDimensionInputs` indicates which collateral source was used.
The `dependencyFromLive` flag indicates that the Dependency Risk input came from
the same score-grade live reserve snapshot. Live slices with `coinId` links are
converted to dependency weights; live slices without `coinId` stay as implicit
self-backed / non-stablecoin reserve share instead of reviving older curated
stablecoin-link percentages. If a score-grade live snapshot contains no mapped
`coinId` links at all, Dependency Risk falls back to curated reserve links or
manual dependencies before preserving an empty `live-unmapped` dependency set.

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
curated data updates. Any matched live or curated reserve exposure maps to
Upstream; reserve-driven freeze risk is not routed through Possible and no
majority-weight threshold is applied.

The resolver now converges to a fixed point across the tracked coin set rather
than relying on a single order-sensitive pass, so cyclic reserve graphs do not
produce traversal-dependent blacklist statuses. When no live reserves exist,
curated `StablecoinMeta.reserves` are used as fallback, and the same reserve-name
heuristics are applied there as well. The collateral drift alert (>15pt
divergence) helps operators detect when curated metadata needs updating for
other scoring dimensions.

| Reserve Risk Tier | Score | Description                         | Examples                                                                                                                  |
| ----------------- | ----- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `very-low`        | 100   | No/minimal counterparty risk        | Government securities, cash, repos, physical gold/silver, ETH, canonical WETH                                             |
| `low`             | 75    | Stablecoin/tokenized layer          | USDC, BUIDL, USYC, ETH LSTs, other stablecoins                                                                            |
| `medium`          | 50    | Wrapped/structured market exposure  | wBTC, tokenized gold, transparent spot/wrapped market exposure, tokenized ETFs                                            |
| `high`            | 25    | Active strategy / volatile exposure | SOL, BNB, TRX, alt-chain tokens, externally managed market-neutral or basis books, LP/private-deal/perp strategy reserves |
| `very-high`       | 5     | Governance/exotic/opaque            | Governance tokens, algorithmic mechanisms, sanctioned assets                                                              |

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

| Backing + Governance                      | Chain Tier | Deployment Model | Collateral Quality | Custody Model           |
| ----------------------------------------- | ---------- | ---------------- | ------------------ | ----------------------- |
| `rwa-backed` + `centralized`              | ethereum   | single-chain     | rwa                | institutional-regulated |
| `rwa-backed` + `centralized-dependent`    | ethereum   | single-chain     | rwa                | institutional-regulated |
| `crypto-backed` + `decentralized`         | ethereum   | single-chain     | native             | onchain                 |
| `crypto-backed` + `centralized-dependent` | ethereum   | single-chain     | eth-lst            | onchain                 |
| `algorithmic` + any                       | ethereum   | single-chain     | native             | onchain                 |

Explicit overrides exist for coins where defaults are incorrect (e.g. HYUSD on Solana, USDe with CEX custody, BOLD with third-party bridge).

Data sources: `collateralQuality`, `custodyModel` optional fields on `StablecoinMeta`. `canBeBlacklisted` field (falls back to governance type). Reserve compositions on `StablecoinMeta.reserves`.

### Decentralization Details

Score from `GovernanceQuality` tier (v5.1), with chain infrastructure penalty for protocols on less decentralized chains, a branch-aware CDP-only oracle setup blend (v8.11, introduced in v8.1), a reviewed bridge-route risk blend (v8.12), and a penalty-only Mint Authority blend (v8.0). The coarse 3-level `GovernanceType` is replaced by a 6-tier quality classification that can be explicitly overridden per coin.

**Governance Quality Tiers:**

| Tier               | Score                       | Default for GovernanceType | Examples                                                                   |
| ------------------ | --------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| `immutable-code`   | 100                         | — (must be explicit)       | LUSD, BOLD                                                                 |
| `dao-governance`   | 85                          | `decentralized`            | overrides: crvUSD, USDS, DAI, GHO, FRAX, DOLA                              |
| `multisig`         | 55                          | `centralized-dependent`    | Most CeFi-dep coins without explicit override                              |
| `regulated-entity` | 40                          | — (auto-promoted)          | Centralized issuers with verified regulatory oversight                     |
| `single-entity`    | 20                          | `centralized`              | USDT, USDC, PYUSD                                                          |
| `wrapper`          | parent-derived, fallback 10 | — (must be explicit)       | yBOLD, sBOLD, sfrxUSD; unresolved wrappers fall back to syrupUSDC-style 10 |

Resolution: `meta.governanceQuality ?? inferGovernanceQuality(meta.flags.governance)`. Override via `governanceQuality` field on `StablecoinMeta`.

**Auto-promotion to `regulated-entity`:** A `single-entity` coin is automatically promoted to `regulated-entity` (40) when all three conditions are met: `jurisdiction.regulator` is set, `jurisdiction.license` is set, and `proofOfReserves.type === "independent-audit"`. This recognizes that regulated, audited centralized issuers carry less governance risk than unregulated single entities.

**Wrapper inheritance:** When a `wrapper` asset has a single resolvable tracked wrapped asset, Decentralization inherits the wrapped asset's **pre-blend** Decentralization score and applies the wrapper-kind haircut used by Dependency Risk ceilings: legacy and savings wrappers `−3`, strategy-vault and risk-absorption variants `−5`, and bond-maturity variants `−8`. Parent-linked examples: yBOLD and sBOLD inherit from BOLD; sfrxUSD inherits from frxUSD. Wrappers without a resolvable tracked parent keep the conservative fallback score of 10.

**Chain infrastructure penalty** (threshold-based on combined `chainInfraScore`, applied to DAO and multisig governance — immutable-code, wrapper, and centralized issuers are exempt):

| Combined Score Range | Penalty |
| -------------------- | ------- |
| 80–100               | 0       |
| 60–79                | −10     |
| 40–59                | −25     |
| 20–39                | −40     |
| 0–19                 | −60     |

`immutable-code` is exempt because there is no governance to undermine — chain centralization cannot compromise non-existent governance keys. `wrapper` is exempt because resolvable wrappers inherit the wrapped asset's chain-adjusted Decentralization score, while unresolved wrappers keep a conservative fallback. Centralized issuers (`single-entity`, `regulated-entity`) are exempt because their governance score already reflects the centralization.

**CDP oracle setup blend (v8.1/v8.11):** crypto-backed CDP assets can carry reviewed `oracleRisk` metadata. When present on a direct non-variant CDP, Decentralization applies a penalty-only blend after governance and chain infrastructure but before bridge-route and Mint Authority scoring: `score = min(score, round(score x 0.75 + oracleScore x 0.25))` (`ORACLE_RISK_BLEND_WEIGHT = 0.25` in `shared/lib/report-card-governance.ts`). This applies even to immutable-code CDPs because liquidation and redemption safety still depend on the collateral price-feed path. Missing oracle reviews are neutral rather than punitive. The current oracle tiers are:

| Tier                      | Score | Meaning                                                                                                     |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------- |
| `oracleless-or-internal`  | 100   | The CDP design does not depend on an external liquidation oracle, or uses internal deterministic accounting |
| `redundant-with-failover` | 95    | Multiple reviewed feeds, validation/failover, and a documented failure mode                                 |
| `medianized-with-delay`   | 85    | Medianized feeds with an explicit delay or security module                                                  |
| `standard-external`       | 75    | Standard external price feeds without a stronger reviewed failover profile                                  |
| `single-source-or-laggy`  | 45    | Single-source, lag-prone, or weakly-fresh feeds                                                             |
| `opaque-or-unknown`       | 20    | Oracle setup is opaque, unresolved, or not source-verified                                                  |

Since v8.11, `oracleRisk` profiles can include `reviewedAt`, `reviewer`, `confidence`, source links, and optional `branches[]` rows keyed by collateral branch or chain. If branches are present, scoring uses the lowest-scoring branch/profile tier as the oracle score. Report-card payloads also expose a display-only `oracleRisk` object with summary, sources, selected branch, and inherited parent context for wrappers/variants; raw scoring fields stay limited to `rawInputs.oracleRiskTier` and `rawInputs.oracleRiskScore`, and tracked variants with resolvable parents use the inherited parent oracle display instead of a duplicate direct blend. `npm run check:oracle-risk-coverage` reports missing/incomplete/stale direct non-variant CDP oracle reviews without failing, and `npm run check:oracle-risk-coverage:enforce` now runs in the `validate:prebuild` merge gate, failing on any missing or incomplete profile so a new crypto-backed CDP cannot silently skip oracle scoring (staleness stays advisory to avoid a time-based gate failure). `npm run calibrate:oracle-risk-score -- --report agents/oracle-risk-score-calibration.md` prints the direct non-variant CDP Decentralization movement table for blend/tier recalibration.

Initial reviewed metadata covers USDS (`medianized-with-delay`) and BOLD (`redundant-with-failover`), with BOLD split into WETH, wstETH, and rETH branches. Other CDPs stay unchanged until a reviewed profile is curated.

**Bridge-route risk blend (v8.12):** any asset can carry reviewed `bridgeRouteRisk` metadata when durable supply depends on cross-chain mint, lockbox, attestation, issuer-burn/mint, or liquidity/intent routes. When present, Decentralization applies a penalty-only blend after the CDP oracle step and before Mint Authority: `score = min(score, round(score x 0.80 + bridgeRouteScore x 0.20))` (`BRIDGE_ROUTE_RISK_BLEND_WEIGHT = 0.20` in `shared/lib/report-card-governance.ts`). Missing bridge-route reviews are neutral. Strong issuer-native and canonical routes cannot lift the dimension, but weak external lock/mint, liquidity, intent, or opaque routes can drag it down. The current tiers are:

| Tier                         | Score | Meaning                                                                                      |
| ---------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `single-chain-or-native`     | 100   | No material bridge route, or issuance is native to the relevant chain                        |
| `issuer-native-burn-mint`    | 90    | Issuer-operated burn/mint route with explicit settlement or attestation controls             |
| `canonical-rollup-bridge`    | 85    | Canonical rollup bridge or equivalent base-layer route                                       |
| `issuer-native-lock-mint`    | 80    | Issuer-operated lock/mint route with reviewed controls                                       |
| `external-validated-network` | 65    | External validator or messaging network with reviewed validation assumptions                 |
| `liquidity-or-intent-route`  | 55    | Liquidity-network, solver, or intent route where market/route execution is material          |
| `external-lock-mint`         | 40    | External lock/mint bridge, lockbox, OFT, or synthetic route with third-party control surface |
| `opaque-or-unknown`          | 20    | Route is unresolved, opaque, or lacks source-verified controls                               |

L2BEAT Interop protocol data is an evidence source and queue generator for this review. The live report-card engine does not fetch L2BEAT; it consumes only curated `bridgeRouteRisk` metadata with reviewer, confidence, source, and optional protocol evidence.

**Mint Authority blend (v8.0):** as the final stage, a rated Mint Authority Score applies a penalty-only blend: `score = min(score, round(score x 0.65 + MAS x 0.35))` (`MAS_BLEND_WEIGHT = 0.35` in `shared/lib/report-card-governance.ts`). The blend can only drag the dimension down — privileged-mint risk undermines a decentralization claim, but a clean mint topology never makes a centralized issuer decentralized. Coins without a rated MAS (`NR`) are unchanged, and there is no separate confidence gate because the MAS confidence caps (verified 100 / probable 90 / manual-review 85) already encode evidence quality. Wrappers inherit the parent's pre-Mint Authority score so the drag applies exactly once per coin (the wrapper's own MAS already folds the parent's mint risk), and a wrapper is additionally capped at its parent's final blended score. When the drag binds, the report card shows a `Mint authority` detail row with the MAS, band, and delta.

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

Examples: BOLD (immutable-code) = **100** (exempt from chain penalty). yBOLD (strategy-vault wrapper over BOLD) = 100 − 5 = **95**. sfrxUSD (savings wrapper over frxUSD) inherits frxUSD Decentralization − 3. LUSD (immutable-code) = **100**. hyUSD (dao-governance, Solana → infra 45) = 85 − 25 = **60**. USDB (multisig, Blast L2) = 55 − 10 = **45**.

Chain penalty applies to `dao-governance` and `multisig` tiers. Exempt tiers: `immutable-code`, `wrapper`, `single-entity`, `regulated-entity`.

### Dependency Risk Details

**Universal scoring (v5.1):** All coins with upstream stablecoin dependencies get blended scores, regardless of governance type. Topological sort ensures every coin is scored after all its upstreams.

**Dependency derivation:** Dependencies are primarily derived from reserve composition data. Reserve slices with a `coinId` field (linking to a tracked stablecoin) are extracted by `deriveEffectiveDependencies()` in `shared/lib/dependency-derivation.ts` and converted to `DependencyWeight[]` (weight = `pct / 100`, type = `depType ?? "collateral"`). When score-grade live reserve slices contain mapped tracked links, they are the dependency source for that snapshot; otherwise the resolver falls back to curated `StablecoinMeta.reserves`, then to the manual `dependencies` array when curated reserves have no tracked links. If a score-grade live snapshot exists but contains no mapped tracked links, that curated/manual fallback is used before the resolver keeps an empty `live-unmapped` dependency set. Weights come directly from reserve percentages when total dependency weight is <= 1, so non-stablecoin or unmapped live reserve slices inside a partially mapped live snapshot contribute to the "self-backed" component of the score. If declared dependency weight exceeds 1, dependency weights are normalized by raw total and the self-backed fraction is zero.

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

| Type         | Meaning                                              | Ceiling                                                                                                                                                                               |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrapper`    | Thin layer around upstream (e.g., syrupUSDC -> USDC) | legacy wrapper: `upstream_score - 3`; tracked savings variant: `-3`; tracked strategy-vault variant: `-5`; tracked risk-absorption variant: `-5`; tracked bond-maturity variant: `-8` |
| `mechanism`  | Critical to peg mechanism (e.g., DAI -> USDC PSM)    | upstream_score                                                                                                                                                                        |
| `collateral` | Standard collateral (default)                        | no ceiling                                                                                                                                                                            |

Formula: `final_score = min(blended_score, min_ceiling_from_wrapper_and_mechanism_deps)`

The ceiling ensures that a coin which fundamentally depends on an upstream stablecoin cannot score higher than that upstream, regardless of how well it performs on other factors.

**Examples:**

- **USDC at 95, DAI (mechanism dep):** blended = 82, ceiling = 95, final = **82** (no change -- blended already below ceiling)
- **USDC at 60, DAI (mechanism dep):** blended = 69.75, ceiling = 60, final = **60** (ceiling kicks in)
- **syrupUSDC (legacy wrapper dep on USDC at 95):** ceiling = 95 - 3 = **92**
- **sUSDai (strategy-vault dep on USDai at 80):** ceiling = 80 - 5 = **75**
- **bUSD0 (bond-maturity dep on USD0 at 95):** ceiling = 95 - 8 = **87**

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

The common read path uses the cron-published `report-cards:snapshot` cache row. That D1 value is a private generation/methodology-pinned envelope carrying the public response payload; if the cache generation or Safety Score methodology version no longer matches the deployed worker, the API rejects the row and computes the same public response shape on read until the cron republishes.

`GET /api/redemption-backstops` — current redemption backstop and effective-exit dataset used by redeemable-asset detail views and report-card liquidity inputs. Cache: standard (`public, s-maxage=300, max-age=60`).

Response includes `cards` (array of `ReportCard` with `rawInputs` for client-side recomputation), `dependencyGraph` (forward edges for dependency traversal, including canonical `weight` and `type` metadata), `methodology` (version, weights, `pegMultiplierExponent`, thresholds), `inputFreshness` (DEX and redemption freshness used for score gating), `liquidityStale`, `redemptionStale`, and `updatedAt`. See [API Reference](./api-reference.md) for the full response shape.

`GET /api/safety-score-history` — per-coin Safety Score grade history timeline (`stablecoin` required, `days` optional). Backed by `safety_grade_history` event rows written daily by `snapshot-safety-grade-history`. Cache: slow (1-hour edge).

Implementation notes:

- Report cards and peg summary share peg-event derivation through `worker/src/lib/peg-analytics.ts` (`derivePegAnalyticsSnapshot()`), so peg score/current deviation windows are computed with identical logic in both endpoints. The quarter-hourly `publish-report-card-cache` pass is the only writer of the producer-published `peg-analytics` D1 cache row; `/api/peg-summary` accepts it for up to 30 minutes (2x producer cadence) and falls back to direct compute on a miss or stale row.
- Report-card API responses and the grade-history cron both use `worker/src/lib/report-cards-snapshot.ts` (`buildReportCardsSnapshot()`), preventing scoring drift between live API and persisted history.
- The compact `report_card_cache` score map includes `methodologyVersion` plus `degradedInputs` metadata (`inputsStale`, `liquidityStale`, `redemptionStale`, and `staleInputs`) so lightweight consumers such as Chain Health reject stale-methodology scores and degrade freshness when cached scores were computed from stale report-card inputs.
- `snapshot-safety-grade-history` still writes the compact report-card cache during degraded-input runs, but suppresses `safety_grade_history` seed and grade-transition inserts when `liquidityStale`, `redemptionStale`, or the corresponding `inputFreshness.*.stale` flags are active.

Key types:

- **`DependencyWeight`**: `{ id: string; weight: number; type?: "wrapper" | "mechanism" | "collateral" }` — upstream stablecoin ID, collateral fraction (0–1), and optional dependency ceiling semantics. Replaces the old `string[]` dependency format.
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `activeDepegBps`, `depegEventCount`, `lastEventAt`, `liquidityScore`, `effectiveExitScore`, `redemptionBackstopScore`, `redemptionRouteFamily`, `redemptionModelConfidence`, `redemptionUsedForLiquidity`, `redemptionImmediateCapacityUsd`, `redemptionImmediateCapacityRatio`, `concentrationHhi`, `bluechipGrade`, `canBeBlacklisted`, `chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel`, `governanceTier`, `governanceQuality`, `mintAuthorityScore`, `oracleRiskTier`, `oracleRiskScore`, `bridgeRouteRiskTier`, `bridgeRouteRiskScore`, `dependencies`, `variantParentId`, `variantKind`, `navToken`, `collateralFromLive`, `dependencyFromLive`) — enables client-side stress test recomputation.
- **`ReportCard.oracleRisk`**: Optional display payload for reviewed or inherited oracle setup context (`tier`, `score`, `label`, `summary`, provenance, sources, selected branch, branch rows, and `inheritedFrom`). It is presentation evidence; scoring uses the raw oracle fields inside Decentralization.
- **`ReportCard.bridgeRouteRisk`**: Optional display payload for reviewed bridge-route context (`tier`, `score`, `label`, `summary`, provenance, protocol evidence, and sources`). It is presentation evidence; scoring uses the raw bridge-route fields inside Decentralization.

## Portfolio Analyzer & Stress Test

Collapsible panel on `/safety-scores` between the headline stats and the controls/card grid. Two sections stacked vertically:

### Portfolio Analyzer

Users enter stablecoin holdings (coin + USD amount). Derived computations (all client-side):

- **Portfolio grade**: `sum(coinScore × coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded.
- **Portfolio radar**: Same weighted average per dimension. Displays via `ReportCardRadar` with a synthetic `ReportCard`.
- **Upstream exposure**: Walks `dependencies` using collateral weights. Direct CeFi holdings attribute 100% to themselves. Aggregates by upstream coin ID. Shows concentration warning when any single upstream exceeds 80%.

State: `usePortfolio` hook. Sources (priority): URL `?p=usdc-circle:50000,dai-makerdao:5000` → `localStorage` → empty. Shared links don't overwrite saved portfolio.

Portfolio holdings now accept canonical IDs only. On read, `src/lib/portfolio-codec.ts` validates holdings, drops unknown or non-canonical IDs, merges duplicate canonical IDs by amount, and writes the cleaned state back once after a successful read.

### Interactive Stress Test

Users simulate a grade downgrade for any upstream coin and watch cascading grade changes:

- **Coin selector**: Filtered to coins appearing as `from` in `dependencyGraph.edges`, sorted by dependent count.
- **Grade selector**: Only downgrades from the coin's current grade to F.
- **Recomputation**: `computeStressedGrades()` injects a synthetic score, walks all transitive downstream dependencies, and recomputes only the Dependency Risk dimension for affected downstream coins in dependency order. The current snapshot size is 463 cards (364 active tracked assets plus 88 cemetery entries plus 11 frozen archives; pre-launch tracked assets are excluded) × 5 dimensions, which remains comfortably sub-millisecond in practice.
- **Two display modes**: Portfolio mode (dollar-denominated, scoped to held coins in impact table) vs ecosystem mode (all affected coins with market cap).
- **Card grid simulation**: ALL affected coins show dashed amber borders + "Simulated" badge regardless of portfolio mode. Unaffected cards dimmed. Sticky banner with clear button.

State: `useStressTest` hook. URL sync: `?stress=usdc-circle&grade=D`.

## Frontend

- **Grid page**: `src/app/safety-scores/client.tsx` — filterable/sortable grid of non-defunct grade cards with core settlement rail strip/sort affordance, portfolio/stress panel integration, simulation mode, and headline safety stats. Core settlement rail membership is a frontend view-model classification and specifically requires a reviewed offchain issuer exit route.
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
| `src/app/safety-scores/client.tsx`                                  | Full page with filtering, sorting, headline safety stats, and simulation mode                                                                          |
| `src/hooks/api-hooks.ts`                                            | TanStack Query hook exports for `useReportCards()` and `useSafetyScoreHistory()`                                                                      |
| `src/hooks/use-portfolio.ts`                                        | Portfolio holdings state + browser persistence; delegates codec and exposure math to `src/lib/portfolio-codec.ts` and `src/lib/portfolio-analysis.ts` |
| `src/hooks/use-stress-test.ts`                                      | Stress test state, `computeStressedGrades` invocation, impact calculation                                                                             |
