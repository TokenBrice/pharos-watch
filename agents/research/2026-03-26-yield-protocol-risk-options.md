# Yield Protocol-Risk Options

Date: 2026-03-26

## Problem Statement

The current yield stack adjusts APY for stablecoin safety, but not for the safety of the protocol actually realizing the yield.

Repo-state confirmation:

- `shared/lib/yield-scoring.ts` computes PYS from `apy30d`, `safetyScore`, and APY variance only.
- `worker/src/cron/yield-sync/evaluation.ts` sources `safetyScore` exclusively from the stablecoin report-card snapshot.
- `worker/src/cron/yield-sync/types.ts` has a transient `project?: string` on `ResolvedYield`, but that protocol identity is not persisted into `yield_data`, `yield_history`, or rankings provenance in `worker/src/cron/yield-sync/publication.ts`.

Result: a safe asset earning through a riskier venue can still look safer than it should, because the venue risk is invisible to PYS and `yieldToRisk`.

## What “Good” Looks Like

An acceptable fix should:

- avoid Pharos manually reviewing and scoring protocols wherever possible
- map cleanly to the protocol identity already present in yield sources
- support automated refresh in Worker-friendly budgets
- expose provenance and freshness
- degrade gracefully when coverage is partial

## External Sources Surveyed

### 1. Exponential DeFi

Official sources:

- `https://exponential.fi/learn/risk-rating`
- `https://exponential.fi/protocols`
- example protocol page: `https://exponential.fi/protocols/infinifi/30e2e0f4-b510-435e-9770-16d21dddc2a4`

What it provides:

- protocol-level risk ratings
- pool-level risk ratings
- qualitative breakdowns by protocol code quality, maturity, and design
- dependency-aware framing across assets, protocols, and chains

What I verified:

- The public protocol directory exposes structured JSON via Next.js data routes.
- Protocol pages also expose structured JSON with:
  - an overall protocol risk label (`Best`, `Average`, etc.)
  - category breakdowns
  - per-pool risk labels (`B`, `C`, etc.)
- The protocol directory includes `defi_llama_id`, which is a strong join key for Pharos because the yield stack already depends on DeFiLlama protocol slugs/projects.
- Live comparison against the current repo allowlist found:
  - `27 / 63` allowlisted lending protocols match Exponential exactly via live DeFiLlama protocol ID crosswalk
  - `29 / 63` look reachable with a small alias layer

Strengths:

- Best semantic fit for the blindspot: it rates the protocol and, in many cases, the actual opportunity.
- Clean join path via `defi_llama_id`.
- Structured public data is easier to operationalize than pure HTML scraping.
- Covers some Pharos-native yield protocols too, not just classic lending markets.

Weaknesses:

- I did not find an official public API product page; current access is via public site data routes.
- Coverage is partial on the current long-tail allowlist.
- Some anti-bot behavior exists without a browser-like user agent, so this is still a scraping-style dependency unless a formal data agreement exists.

Assessment:

- Most promising public source today.
- Strong candidate for a Phase 1 protocol-risk overlay.
- Better if Pharos can get explicit permission or partner/API access.

### 2. DeFiSafety

Official sources:

- `https://defisafety.com/documentation-09`
- `https://defisafety.com/`
- example review: `https://defisafety.com/app/pqrs/582`

What it provides:

- independent protocol process-quality reviews
- transparent scoring methodology
- protocol-level numeric scores
- structured review details including chain/category metadata and hack history fields

What I verified:

- Public protocol review pages expose structured Next.js JSON.
- Example: Compound III review page exposes `finalScore`, `overallScore`, `hackHistory`, chain list, and section-by-section question scoring.
- The home page currently reports `340` protocol reviews across `24` chains.
- The home page currently surfaces recent reviews including `TermMax` and `Euler V2`, which are directly relevant to the current allowlist.

Strengths:

- Methodology is transparent and focused on software/process quality.
- Numeric scores are easy to normalize into a Pharos-side scale.
- Strong independence from Pharos.

Weaknesses:

- Discovery/join is weaker than Exponential. Public URLs are keyed by internal PQR IDs, not DeFiLlama IDs/slugs.
- Review cadence looks slower and more editorial than market-data style feeds.
- Coverage on the long tail is uncertain without either:
  - a commercial/API relationship, or
  - a curated local map from protocol slug to DeFiSafety review ID

Assessment:

- Very strong signal quality.
- Better as a licensed/API partner or curated-map integration than as a fully automatic public-web crawl.
- Best candidate if Pharos wants a conservative, methodology-heavy protocol score rather than an opportunity/risk-market view.

### 3. CertiK Skynet

Official source:

- `https://api.certik-skynet.com/public-docs/methodology/security-score-methods`

What it provides:

- official API product
- project-level security scoring
- methodology including audit history, incidents, bug bounty, governance strength, centralization risk, and more

Strengths:

- Official API surface is a major operational advantage.
- Broad and continuously refreshed project coverage is likely better than boutique review products.
- Includes incident/bounty/governance dimensions that matter for protocol risk.

Weaknesses:

- The documented score is broader than protocol code risk. It also includes market and community factors.
- That makes the headline score a weaker fit for Pharos than a pure protocol-risk input.
- Likely enterprise/commercial access.

Assessment:

- Good fallback or supplement.
- If used, Pharos should prefer a security-oriented subscore or alert set over the top-level blended score.

### 4. De.Fi API

Official source:

- `https://docs.de.fi/api/api`

What it provides:

- `scannerProject`: issues found, security score, similar contracts, onchain governance info for a contract
- `rekts`: exploit database
- `opportunities`: yield-opportunity data

Strengths:

- Official API.
- Useful security and exploit surfaces.
- Contract-level analysis can work for exact vault/market addresses when protocol-level coverage is missing.

Weaknesses:

- Primary join unit is the smart contract, not the protocol.
- Contract scans do not map cleanly to “protocol risk” without Pharos deciding which contracts represent the venue.
- Better for supplementing a protocol source than for replacing one.

Assessment:

- Good fallback/supplemental source.
- Not ideal as the main protocol-risk layer for Yield Intelligence.

### 5. DefiLlama Metadata

Official source:

- `https://api-docs.defillama.com/`

What it provides:

- protocol/category metadata
- TVL
- audit count
- yields pool project slugs

What I verified:

- `/protocols` exposes fields such as `slug`, `category`, `audits`, `chains`, `tvl`, `change_1d`, `change_7d`, `url`, `twitter`.

Strengths:

- Already in Pharos’ stack.
- Excellent join layer.
- Free and operationally easy.

Weaknesses:

- Not a safety assessment.
- `audits` count is too weak to stand in for protocol risk.

Assessment:

- Useful as identity/mapping glue and a weak fallback feature.
- Not sufficient as the primary fix.

## Most Promising Implementation Options

### Option A. Exponential as Primary Protocol-Risk Overlay

Recommended rank: `#1`

Why this is strongest:

- closest semantic match to the actual blindspot
- pool-level and protocol-level risk are both available
- public structured data exists now
- DeFiLlama ID crosswalk makes joining realistic

Recommended rollout:

1. Persist protocol identity first.
2. Add protocol-risk freshness/provenance to rankings and detail surfaces.
3. Do not change PYS immediately.
4. After coverage and calibration are acceptable, add a protocol-aware ranking variant or blend protocol risk into PYS.

Repo changes needed:

- add first-class protocol identity to yield rows:
  - `sourceProtocolSlug`
  - `sourceProtocolName`
  - `sourceProtocolProvider`
- persist that identity from `ResolvedYield.project` and explicit config for non-DL sources
- create a new daily or 6-hour cache sync, for example `yield:protocol-risk:v1`
- add `protocolRisk` to rankings provenance and `altSources`

Best initial use:

- UI badge and warning surface
- sortable secondary metric
- provenance only, not immediate methodology change

### Option B. DeFiSafety as Primary Protocol Score

Recommended rank: `#2`

Why it is good:

- transparent, independent, structured, numeric
- philosophically aligned with “don’t assess it ourselves”

Why it is second:

- join/discovery is harder
- coverage automation is weaker without a vendor relationship
- review latency is slower

Best use:

- high-trust protocol score synced daily
- especially attractive if Pharos can get API/licensing or a stable review-index export

### Option C. Hybrid: Exponential Primary, DeFiSafety Fallback, CertiK/De.Fi Supplemental

Recommended rank: `#3`

Why:

- best long-run coverage and resilience
- lets Pharos separate:
  - opportunity/pool risk
  - protocol/process quality
  - incident/alert context

Tradeoff:

- materially more complex
- should not be the first implementation unless protocol-risk becomes a major product surface

Best use:

- second-phase architecture after a single-provider MVP lands cleanly

### Option D. CertiK or De.Fi as API-First Fallback

Recommended rank: `#4`

Why:

- official APIs
- likely broader live coverage than boutique providers

Why not higher:

- poorer semantic fit as the main score
- requires more Pharos-side interpretation, which moves back toward “we are assessing protocols ourselves”

Best use:

- fallback coverage
- warnings/alerts/incidents/admin-control overlays

### Option E. Pharos-Derived Proxy from DefiLlama + Audits + Hacks + Bounties

Recommended rank: `#5`

Why:

- easy to automate

Why it is last:

- it directly contradicts the preference to avoid assessing protocols in-house
- high design burden
- high methodology debt

Best use:

- only as a sparse fallback when no external score exists
- if used at all, keep it clearly labeled as a weak proxy

## Recommended Product Strategy

### Phase 1: Resolve The Blindspot Without Touching PYS

Add protocol-risk as a distinct field and surface it visibly.

Why:

- solves the user-information problem immediately
- avoids forcing a methodology change before coverage is good enough
- lets you observe coverage gaps and provider drift in production

Suggested output:

- `protocolRiskProvider`
- `protocolRiskScore` or `protocolRiskGrade`
- `protocolRiskLabel`
- `protocolRiskObservedAt`
- `protocolRiskSourceUrl`
- `protocolRiskConfidence`
- `protocolRiskCoverageMode` (`exact`, `aliased`, `manual-map`, `missing`)

### Phase 2: Add A Conservative Score Integration

Once coverage is good enough, the cleanest integration is conservative capping, not a loose weighted average.

Most coherent pattern:

- map external protocol risk onto a 0–100 scale
- compute `effectiveSafety = min(stablecoinSafety, protocolSafetyMapped)`

Why this is better than a weighted average:

- it preserves the intuition that a safe asset inside a weaker venue should not look safer than the venue
- it avoids inventing an arbitrary blend between two different methodologies

Alternative:

- leave PYS unchanged and publish a second ranking:
  - `protocolAdjustedPys`

That is safer if you want a long observation period before modifying the headline methodology.

## Repo-Specific Implementation Notes

### 1. Persist Protocol Identity

Current issue:

- `ResolvedYield.project` exists, but the persisted/public shapes drop it.

Needed:

- persist a stable protocol key into `yield_data` and `yield_history`
- include it in rankings response and provenance

For non-DeFiLlama-native sources, add explicit config in `yield-config.ts`, for example:

- `protocolRiskTarget: "ethena"`
- `protocolRiskTarget: "maple"`
- `protocolRiskTarget: "ondo-yield-assets"`

### 2. Split Identity From Scoring

Do not make the first sync responsible for both:

- mapping protocol identity
- deciding final score influence

Instead:

- first solve identity and storage
- then layer provider-specific risk snapshots on top
- only then decide whether ranking changes are justified

### 3. Treat Coverage As A First-Class Constraint

Recommended publish behavior:

- when protocol risk is present, show it
- when missing, do not silently synthesize one
- expose explicit missing-coverage provenance

This matters because partial protocol coverage is inevitable at launch.

### 4. Prefer Daily Protocol-Risk Refresh Over Hourly

These sources are not price feeds.

A daily or 6-hour refresh is enough and fits the Worker budget better than tying protocol-risk discovery to the hourly yield publisher.

## Recommendation

If the goal is to resolve the blindspot without turning Pharos into a protocol rating agency:

1. Start with `Exponential` as the first implementation target.
2. Add protocol identity as a first-class persisted field in Yield Intelligence.
3. Ship protocol-risk as a visible overlay before changing PYS.
4. Explore `DeFiSafety` as either:
   - a premium/partner-quality fallback, or
   - the longer-run “high-trust protocol score” if licensing/API access is available.
5. Use `CertiK` and/or `De.Fi` only as supplemental fallback/alert layers unless you can access a cleaner security-only subscore.

## Source Links

- Exponential Risk Ratings: `https://exponential.fi/learn/risk-rating`
- Exponential Protocol Directory: `https://exponential.fi/protocols`
- Example Exponential protocol page: `https://exponential.fi/protocols/infinifi/30e2e0f4-b510-435e-9770-16d21dddc2a4`
- DeFiSafety methodology: `https://defisafety.com/documentation-09`
- DeFiSafety home: `https://defisafety.com/`
- Example DeFiSafety review: `https://defisafety.com/app/pqrs/582`
- CertiK Skynet methodology: `https://api.certik-skynet.com/public-docs/methodology/security-score-methods`
- De.Fi API docs: `https://docs.de.fi/api/api`
- DefiLlama API docs: `https://api-docs.defillama.com/`
