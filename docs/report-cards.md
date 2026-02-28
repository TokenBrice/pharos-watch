# Risk Lab

Multi-dimensional risk grades (A+ through F) for every tracked stablecoin. Computed on-demand by the API from live data.

## Overall Grade (v5.3)

Two-step computation:

1. **Base score**: weighted average of 4 base dimensions (each 0–100). NR dimensions have their weight redistributed proportionally among rated ones. Requires at least 2 rated base dimensions; otherwise overall = NR.
2. **Peg multiplier**: `final = base × (PSI / 100) ^ 0.20`. Coins with good pegs (90+) barely affected (~2% penalty). Coins with broken pegs get properly penalized (PSI 10 → 37% penalty). PSI = NR (NAV tokens) → multiplier 1.0 (no penalty). PSI = 0 → multiplier 0.

Cemetery coins get a permanent F.

## Dimensions

### Base dimensions (weighted sum)

| Dimension | Weight | Source | Scoring |
|-----------|--------|--------|---------|
| **Liquidity** | 30% | `liquidityScore` from DEX liquidity | Passthrough (composite score already factors pool quality, diversity, durability) |
| **Resilience** | 20% | Token metadata (3 sub-factors) | Weighted avg of collateral quality, custody model, and blacklist capability |
| **Decentralization** | 15% | Governance quality + chain infrastructure | `GovernanceQuality` tiers: `dao-governance` → 85, `multisig` → 55, `regulated-entity` → 40, `single-entity` → 20, `wrapper` → 10. Threshold-based penalty from combined chain infrastructure score |
| **Dependency Risk** | 25% | Upstream stablecoin scores | No deps → 95. With deps → blended score (upstream × weight + self-backed), −10 if any < 75. Self-backed varies by governance (90/75/95) |

### Peg Stability (multiplier)

| Source | Scoring |
|--------|---------|
| `pegScore` from peg summary | Applied as `(PSI/100)^0.20` multiplier to base score. NAV tokens → 1.0 (no penalty) |

### Peg Stability Details

- Direct passthrough of `computePegScore()` output (see `docs/stability-index.md` for the composite formula)
- NAV tokens (yield-accruing, price-appreciating) receive NR — multiplier 1.0, no penalty
- Yield-bearing annotation added to detail text

### Liquidity Details

- Direct passthrough of DEX liquidity composite score (see `docs/dex-liquidity.md`)
- The composite already weighs TVL depth, volume, pool quality, durability, pair diversity, and cross-chain breadth
- High concentration (HHI > 0.5) noted in detail text but no additional penalty applied

### Resilience Details

3-factor weighted average (each sub-factor 1/3 of the resilience score). Chain infrastructure is scored exclusively in the Decentralization dimension to avoid double-counting.

| Sub-factor | Scoring | Tiers |
|---|---|---|
| **Collateral Quality** | Reserve-derived weighted score (see below) | 0–100 from curated reserve compositions, or enum fallback |
| **Custody Model** | Who holds collateral? | On-chain (100), Institutional custodian (50), CEX/off-exchange (0) |
| **Blacklist Capability** | Can issuer freeze funds? | Not blacklistable (100), Possible (66), Blacklistable (33) |

#### Collateral Quality: Reserve-Derived Scoring (v3.3)

For coins with curated reserve compositions, collateral quality is computed as a weighted average of per-slice risk scores:

| Reserve Risk Tier | Score | Description | Examples |
|---|---|---|---|
| `very-low` | 100 | No/minimal counterparty risk | Government securities, cash, repos, physical gold/silver |
| `low` | 75 | Stablecoin/tokenized layer | USDC, BUIDL, USYC, other stablecoins |
| `medium` | 50 | Wrapped/bridged/structured | wBTC, LSTs, delta-neutral strategies, tokenized ETFs |
| `high` | 25 | Volatile native assets | SOL, BNB, TRX, alt-chain tokens |
| `very-high` | 5 | Governance/exotic/opaque | Governance tokens, algorithmic mechanisms, sanctioned assets |

**Formula:** `score = round(Σ(slice_pct × tier_score) / Σ(slice_pct))`

**Display thresholds:** ≥88 → "Very low risk", ≥62 → "Low risk", ≥37 → "Medium risk", ≥15 → "High risk", <15 → "Very high risk"

Reserve compositions are maintained in `StablecoinMeta.reserves` as arrays of `{ name, pct, risk }` slices.

#### Collateral Quality: Enum Fallback

For coins without curated reserves, the legacy enum-based scoring is used:

| Enum Value | Score |
|---|---|
| `native` | 100 |
| `eth-lst` | 66 |
| `rwa` | 50 |
| `alt-lst` | 20 |
| `exotic` | 0 |

**Default inference:** When sub-factor fields aren't explicitly set on `StablecoinMeta`, defaults are inferred from `backing` + `governance`:

| Backing + Governance | Chain Tier | Deployment Model | Collateral Quality | Custody Model |
|---|---|---|---|---|
| `rwa-backed` + `centralized` | ethereum | single-chain | rwa | institutional |
| `rwa-backed` + `centralized-dependent` | ethereum | single-chain | rwa | institutional |
| `crypto-backed` + `decentralized` | ethereum | single-chain | native | onchain |
| `crypto-backed` + `centralized-dependent` | ethereum | single-chain | eth-lst | onchain |
| `algorithmic` + any | ethereum | single-chain | native | onchain |

Explicit overrides exist for ~25 coins where defaults are incorrect (e.g. HYUSD on Solana, USDe with CEX custody, BOLD with third-party bridge).

Data sources: `collateralQuality`, `custodyModel` optional fields on `StablecoinMeta`. `canBeBlacklisted` field (falls back to governance type). Reserve compositions on `StablecoinMeta.reserves`.

### Decentralization Details

Score from `GovernanceQuality` tier (v5.1), with chain infrastructure penalty for protocols on less decentralized chains. The coarse 3-level `GovernanceType` is replaced by a 6-tier quality classification that can be explicitly overridden per coin.

**Governance Quality Tiers:**

| Tier | Score | Default for GovernanceType | Examples |
|---|---|---|---|
| `immutable-code` | 100 | — (must be explicit) | LUSD, BOLD |
| `dao-governance` | 85 | `decentralized` | crvUSD; overrides: USDS, DAI, GHO, FRAX, DOLA |
| `multisig` | 55 | `centralized-dependent` | Most CeFi-dep coins without explicit override |
| `regulated-entity` | 40 | — (auto-promoted) | Centralized issuers with verified regulatory oversight |
| `single-entity` | 20 | `centralized` | USDT, USDC, PYUSD |
| `wrapper` | 10 | — (must be explicit) | syrupUSDC, Cap cUSD, USX, OUSD, FPI |

Resolution: `meta.governanceQuality ?? inferGovernanceQuality(meta.flags.governance)`. Override via `governanceQuality` field on `StablecoinMeta`.

**Auto-promotion to `regulated-entity`:** A `single-entity` coin is automatically promoted to `regulated-entity` (40) when all three conditions are met: `jurisdiction.regulator` is set, `jurisdiction.license` is set, and `proofOfReserves.type === "independent-audit"`. This recognizes that regulated, audited centralized issuers carry less governance risk than unregulated single entities.

**Chain infrastructure penalty** (threshold-based on combined `chainInfraScore`, applied to DAO and multisig governance only — immutable-code and centralized issuers are exempt):

| Combined Score Range | Penalty |
|---|---|
| 80–100 | 0 |
| 50–79 | −15 |
| 15–49 | −50 |
| 0–14 | −65 |

`immutable-code` is exempt because there is no governance to undermine — chain centralization cannot compromise non-existent governance keys. Centralized issuers (`single-entity`, `regulated-entity`) are exempt because their governance score already reflects the centralization.

#### Chain Infrastructure: Two-Axis Scoring

The chain infrastructure score combines **primary chain maturity** with **deployment model risk** via multiplicative scoring:

`chainInfraScore = CHAIN_TIER_SCORE[chainTier] × DEPLOYMENT_MULT[deploymentModel]`

**Chain tier** (where core minting/logic lives):

| Tier | Score |
|------|-------|
| `ethereum` | 100 |
| `stage1-l2` | 66 |
| `established-alt-l1` | 20 |
| `unproven` | 0 |

**Deployment model** (how the token extends to other chains):

| Model | Multiplier | Description |
|-------|-----------|-------------|
| `single-chain` | 1.00 | No multichain presence, or irrelevant bridged copies |
| `canonical-bridge` | 0.85 | Bridges via L2 canonical rollup bridges (inherits rollup security) |
| `third-party-bridge` | 0.60 | Bridges via CCIP, LayerZero, Wormhole, etc. |
| `native-multichain` | 0.40 | Independent minting/redeeming on multiple chains |

**Combined score matrix:**

| Deployment Model | ETH (100) | L2 (66) | Alt-L1 (20) | Unproven (0) |
|------------------|-----------|---------|-------------|--------------|
| single-chain | 100 | 66 | 20 | 0 |
| canonical-bridge | 85 | 56 | 17 | 0 |
| third-party-bridge | 60 | 40 | 12 | 0 |
| native-multichain | 40 | 26 | 8 | 0 |

Coins without overrides default to Ethereum + single-chain (score 100, penalty 0).

Examples: BOLD (immutable-code) = **100** (no chain penalty). LUSD (immutable-code) = **100**. hyUSD (dao-governance, Solana → infra 20) = 85 − 50 = **35**. USDB (multisig, Blast L2) = 55 − 15 = **40**. cUSD (wrapper) = **10** (no chain penalty).

### Dependency Risk Details

**Universal scoring (v5.1):** All coins with upstream stablecoin dependencies get blended scores, regardless of governance type. Topological sort ensures every coin is scored after all its upstreams.

**Dependency derivation:** Dependencies are primarily derived from reserve composition data. Reserve slices with a `coinId` field (linking to a tracked stablecoin) are extracted by `deriveDependencies()` in `src/lib/reserve-templates.ts` and converted to `DependencyWeight[]` (weight = `pct / 100`, type = `depType ?? "collateral"`). Weights come directly from reserve percentages and are not renormalized, so non-stablecoin reserve slices contribute to the "self-backed" component of the score. For coins whose reserves don't reference tracked stablecoins, the function falls back to the manual `dependencies` array on `StablecoinMeta` (7 coins currently use this fallback).

**Scoring:**
- **No dependencies**: 95 (any governance tier)
- **With dependencies**: `score = sum(weight_i × upstream_score_i) + (1 − totalWeight) × SELF_BACKED_SCORE`
- −10 penalty if any dependency scores below 75 (B-)
- Falls back to 70 if dependency scores unavailable

**Self-backed score by governance type:**

| Governance Type | Self-Backed Score | Rationale |
|---|---|---|
| `decentralized` | 90 | Own peg mechanisms (CDPs, LLAMMA) function independently |
| `centralized-dependent` | 75 | PSMs/arbitrage loops coupled to upstream infrastructure |
| `centralized` | 95 | Standalone RWA-backed, minimal coupling |

#### Dependency Type Ceilings

Each dependency relationship can be classified as `wrapper`, `mechanism`, or `collateral` (default). After the blended score is computed, a ceiling is applied based on the most critical upstream dependency.

| Type | Meaning | Ceiling |
|------|---------|---------|
| `wrapper` | Thin layer around upstream (e.g., syrupUSDC -> USDC) | upstream_score - 3 |
| `mechanism` | Critical to peg mechanism (e.g., DAI -> USDC PSM) | upstream_score |
| `collateral` | Standard collateral (default) | no ceiling |

Formula: `final_score = min(blended_score, min_ceiling_from_wrapper_and_mechanism_deps)`

The ceiling ensures that a coin which fundamentally depends on an upstream stablecoin cannot score higher than that upstream, regardless of how well it performs on other factors.

**Examples:**

- **USDC at 95, DAI (mechanism dep):** blended = 82, ceiling = 95, final = **82** (no change -- blended already below ceiling)
- **USDC at 60, DAI (mechanism dep):** blended = 69.75, ceiling = 60, final = **60** (ceiling kicks in)
- **syrupUSDC (wrapper dep on USDC at 95):** ceiling = 95 - 3 = **92** (wrapper penalty reflects thin-layer risk)

## Grade Thresholds

Lowered 5 points in v4.0 to compensate for structural deflation from removing peg from the base. Lowered another 5 points in v5.1 to fix C-range overcrowding after blacklist/decentralization scoring adjustments.

| Grade | Min Score |
|-------|-----------|
| A+ | 87 |
| A | 83 |
| A- | 80 |
| B+ | 75 |
| B | 70 |
| B- | 65 |
| C+ | 60 |
| C | 55 |
| C- | 50 |
| D | 40 |
| F | 0 |
| NR | null score |

## Grade Colors

| Range | Badge (Tailwind) | Radar (hex) |
|-------|-------------------|-------------|
| A (A+, A, A-) | emerald-500 | `#10b981` |
| B (B+, B, B-) | blue-500 | `#3b82f6` |
| C (C+, C, C-) | amber-500 | `#f59e0b` |
| D | orange-500 | `#f97316` |
| F | red-500 | `#ef4444` |
| NR | muted | `#71717a` |

## API

`GET /api/report-cards` — all coins graded with per-dimension breakdown and methodology metadata. Cache: standard (5-min edge).

Response includes `cards` (array of `ReportCard` with `rawInputs` for client-side recomputation), `dependencyGraph` (forward edges for dependency traversal), `methodology` (version, weights, thresholds), and `updatedAt`. See `docs/api-reference.md` for full response shape.

Key types:
- **`DependencyWeight`**: `{ id: string; weight: number }` — upstream stablecoin ID + collateral fraction (0–1). Replaces the old `string[]` dependency format.
- **`RawDimensionInputs`**: Raw scoring inputs per card (`pegScore`, `activeDepeg`, `liquidityScore`, `concentrationHhi`, `bluechipGrade`, `canBeBlacklisted`, `chainTier`, `deploymentModel`, `collateralQuality`, `custodyModel`, `governanceTier`, `governanceQuality`, `dependencies`, `navToken`, etc.) — enables client-side stress test recomputation.

## Portfolio Analyzer & Stress Test

Collapsible panel on `/safety-scores` between the grade distribution bar and card grid. Two sections stacked vertically:

### Portfolio Analyzer

Users enter stablecoin holdings (coin + USD amount). Derived computations (all client-side):

- **Portfolio grade**: `sum(coinScore × coinAmount) / sum(coinAmount)` for rated coins. NR coins excluded.
- **Portfolio radar**: Same weighted average per dimension. Displays via `ReportCardRadar` with a synthetic `ReportCard`.
- **Upstream exposure**: Walks `dependencies` using collateral weights. Direct CeFi holdings attribute 100% to themselves. Aggregates by upstream coin ID. Shows concentration warning when any single upstream exceeds 80%.

State: `usePortfolio` hook. Sources (priority): URL `?p=usdc:50000,dai:5000` → `localStorage` → empty. Shared links don't overwrite saved portfolio.

### Interactive Stress Test

Users simulate a grade downgrade for any upstream coin and watch cascading grade changes:

- **Coin selector**: Filtered to coins appearing as `from` in `dependencyGraph.edges`, sorted by dependent count.
- **Grade selector**: Only downgrades from the coin's current grade to F.
- **Recomputation**: `computeStressedGrades()` injects a synthetic score, recomputes only the Dependency Risk dimension for affected downstream coins. ~142 coins × 5 dimensions = <1ms, no debouncing needed.
- **Two display modes**: Portfolio mode (dollar-denominated, scoped to held coins in impact table) vs ecosystem mode (all affected coins with market cap).
- **Card grid simulation**: ALL affected coins show dashed amber borders + "Simulated" badge regardless of portfolio mode. Unaffected cards dimmed. Sticky banner with clear button.

State: `useStressTest` hook. URL sync: `?stress=usdc&grade=D`.

## Frontend

- **Grid page**: `src/app/safety-scores/client.tsx` — filterable/sortable grid of grade cards with grade distribution bar, portfolio/stress panel integration, simulation mode
- **Portfolio & stress panel**: `src/components/stress-test-panel.tsx` — collapsible panel with holdings editor, portfolio grade/radar/exposure, stress test controls + impact table
- **Detail card**: `src/components/report-card.tsx` — full radar chart + dimension breakdown
- **Mini card**: `src/components/report-card-mini.tsx` — compact grid tile with simulation support (dashed border, before→after grade, "Simulated" badge)
- **Radar chart**: `src/components/radar-chart.tsx` — hexagonal Recharts radar with `ReportCardRadar` (single) and `CompareRadar` (multi-coin overlay)
- **Hooks**: `src/hooks/use-report-cards.ts` (TanStack Query), `src/hooks/use-portfolio.ts` (portfolio state + localStorage + URL sync), `src/hooks/use-stress-test.ts` (stress test state + recomputation)

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/report-cards.ts` | Pure grading engine: dimension scorers, weights, thresholds, colors, `computeStressedGrades()` |
| `worker/src/api/report-cards.ts` | API handler: data loading, topological sort computation, `rawInputs`, `dependencyGraph`, response |
| `src/components/stress-test-panel.tsx` | Combined portfolio analyzer + stress test collapsible panel |
| `src/components/report-card.tsx` | Full detail card with radar |
| `src/components/report-card-mini.tsx` | Compact grid tile with simulation mode support |
| `src/components/radar-chart.tsx` | Recharts radar visualization |
| `src/app/safety-scores/client.tsx` | Full page with filtering, sorting, grade distribution, simulation mode |
| `src/hooks/use-report-cards.ts` | TanStack Query hook |
| `src/hooks/use-portfolio.ts` | Portfolio holdings state, localStorage persistence, URL sync, upstream exposure |
| `src/hooks/use-stress-test.ts` | Stress test state, `computeStressedGrades` invocation, impact calculation |
