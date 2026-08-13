---
title: "Methodology: How Pharos Grades Stablecoins"
canonical: "https://pharos.watch/methodology/"
description: "Full methodology behind Pharos safety grades, peg scores, liquidity scores, PSI, DEWS, yield intelligence, and contagion tests."
---

# Methodology

## Pricing Pipeline Methodology

Every score Pharos computes starts with a price. The pricing pipeline collects live quotes from aggregators, exchanges, oracles, on-chain pools, protocol redemption feeds, FX references, and enrichment fallbacks.

Pharos clusters sources by pairwise agreement, publishes the highest-confidence median, and keeps source provenance attached so downstream depeg, safety, liquidity, and PSI calculations can reason about data quality. Soft consensus can be challenged by large DEX pools, while protocol redemption prices override market data only for assets where the redemption path is the more authoritative mark.

Freshness is explicit. Upstream-observed timestamps are preferred over local collection time, stale sources are excluded or downgraded, and replay-safe cache continuity is used only when it preserves a confirmed signal without inventing a new one.

Fallback enrichment is bounded. CoinMarketCap, Jupiter, DexScreener, audited low-volume CoinGecko rows, exact-address providers, and reviewed protocol or exact-pool routes fill gaps for long-tail assets, but each pass has request budgets, identity checks, circuit breakers, freshness and depth requirements, corroboration checks, and plausibility gates so weak prices cannot silently become high-confidence consensus or false fixed-peg depegs. Persistent active-price gaps are scheduled ahead of breadth-oriented refresh work, and exact-address fairness cursors rotate only inside priority cohorts. DexScreener single-token discovery uses its complete pool-list endpoint while multi-address pricing keeps the separate batch-token endpoint. Exact reviewed pool identities take precedence over lower-fidelity derived duplicates so executable quote evidence stays attached to the physical pool. Thin executable routes can be admitted with fallback confidence for display when they pass the same severe-downside and temporal-jump corroboration guardrails as other soft sources, while remaining ineligible to drive depeg state or replay-safe cache continuity by themselves. AZND guard rejections stay explicit coverage gaps without counting as provider outages, while thrown or timed-out route work still fails its circuit.

Price coverage is evaluated independently from row publication. A stablecoin can remain visible with supply and lifecycle data while its unusable price degrades cron and public health; the incident remains explicit instead of blocking the full cache or being hidden behind a nominal peg fill.


## Stability Index Methodology

The Pharos Stability Index (PSI) compresses stress across active core stablecoins and cash equivalents into a 0-100 condition score. Tracked variants and stable-value investments stay browsable but are excluded from the monetary aggregate. PSI starts at 100, subtracts penalties for severity, breadth, and stress breadth, then adds a clamped trend term before mapping the result into condition bands from BEDROCK to MELTDOWN.

Severity captures how bad current deviations are. Breadth captures how many assets are involved. Stress breadth captures how many stablecoins are elevated in DEWS. Trend captures whether the system is getting better or worse over the current window: negative trend reduces the score, while positive trend can offset part of the penalty.

PSI is deliberately conservative: one small depeg should not move the entire market condition, but simultaneous broad stress should pull the index down even if no single coin dominates the tape.


## Safety Scores Grading Methodology

Safety Score V9 is the active identity-aware model. It evaluates Backing (40%), Exit (35%), and Economic Control (25%) through bounded aggregation, then applies peg behavior, structural ceilings, evidence sufficiency, track record, dependencies, and wrapper-local risk.

Exit selects the strongest exact same-notional route and may add independent backup credit equal to min(10, 100 - primary route score) multiplied by backup route score / 100. The card shows the selected route, backup credit, and actual stress-request completion separately. The standalone DEX market score and redemption route score are not the V9 Exit score.

V9 distinguishes measured adverse evidence from issuer non-disclosure, unsupported methodology, missing integration, and transient producer failure. Bounded gaps can remain rateable under explicit ceilings; an unbounded required fact remains NR, and F is reserved for causally attributed measured danger.

Responsibility follows causal provenance instead of the nearest processing stage. An explicit reason-level owner is authoritative; inherited reserve gaps, unavailable upstream pillars, and missing parent scores carry every originating owner downstream. Every attributed root receives a causal-root-qualified score path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and ownership never becomes part of fact identity. Applicable but unpublished mechanism metrics remain issuer-undisclosed rather than measured-adverse. A reviewed external exit output whose identity is known but cannot be valued is attributed to producer failure, while an issuer-undisclosed settlement asset stays issuer-undisclosed; neither becomes scoreable. Date-only dispositions enter replay only after their reviewed UTC day. Partial control reviews retain the controls that were actually reviewed while unresolved surfaces remain bounded and fail closed. Subthreshold unrecognized chain-label supply pools are tolerated by the bridge-materiality proof and no longer surface as public evidence-responsibility facts; material unmatched bridge supply still fails closed. Coverage that no supported adapter can observe is unsupported methodology rather than producer failure: deployment census coverage is reported per chain instead of all or nothing, an exit surface whose census remainder is unsupported reports unsupported route evidence, and an unreviewed dependency set on an asset with no live-reserve adapter is unsupported rather than failed. Since methodology 9.2, a populated DEX exit surface is complete for gap accounting once its budgeted score-eligible routes are observed; leftover target-construction and reviewed model-limit gates on other recognised venues are not a data-feed failure. Exact-route scoring completeness stays strict. An asset with no usable price whose tracked peg record is already adverse is measured adverse, while a clean record with no usable price stays a quiet observation and its deviation is never coerced to zero. These are provenance and evidence-retention changes: pillar weights, score math, and grade thresholds are unchanged.

Governance access posture treats reviewed global mint-domain contracts as immutable when they have no privileged capabilities, no applicable cap, no claim-impairment path, and access-only scope. A contract address alone is protocol machinery, not evidence of a concentrated administrator; deployment-scoped bridge controls remain separate.

Publication is fail-closed. Stale or unavailable score-bearing producers and material infrastructure-attributed deterioration hold the last accepted V9 ratings. Isolated producer failures do not freeze the publication while at least 90% of active assets remain unaffected. Active consumers expose held status and never recompute or fall back to V8. V8.17 remains documented as historical methodology.


## Mint Authority Score

Mint authority measures how much durable stablecoin supply can be created, authorized, expanded, or routed by privileged mint paths.

Since methodology v9.1 it is graded once, by the Safety Score V9 Economic Control pillar. The mint component starts from a derived posture (cap semantics, claim impairment, reconciliation, supervision), then applies resolved-incident age decay, a key-custody penalty that MPC or HSM attestation waives, a multisig quorum ladder, and a small Safe module modifier.

Missing or unresolved review data returns NR and never implies safety. The score shown on detail pages, the homepage table, the screener, and coverage breakdowns is that same component, so the mint column and the letter grade can no longer disagree. Mint route family is deliberately not priced separately: the cap and claim semantics already price it.


## Infrastructure Tagging

Infrastructure tags identify stablecoins that share issuance frameworks, protocol mechanisms, or operational dependencies. Examples include Liquity v1, Liquity v2, and M0.

Tags help Pharos group related assets without pretending they are the same stablecoin. They support navigation, taxonomy pages, comparison context, and dependency-aware risk review.

Infrastructure tags do not override the underlying governance, backing, peg, collateral, or report-card inputs. They are descriptive metadata used to expose shared machinery.


## Liquidity Score

The Liquidity Score measures how safely a stablecoin can exit through decentralized markets. It combines TVL depth, volume activity, pool quality, durability, and pair diversity into a 0-100 score.

TVL depth uses log-scale scoring so small assets can improve without requiring blue-chip depth, while very deep pools still receive credit. Volume rewards active markets. Pool quality adjusts for mechanism type, pool balance, pair quality, and risky counterparties. Durability measures persistence across observations, and pair diversity penalizes concentration in one venue or one unstable route.

Discovery is source-aware. Pharos stages pools from DefiLlama, direct protocol APIs, CoinGecko on-chain data, GeckoTerminal, DexScreener, and curated DEX sources, then deduplicates by exact pool identity or conservative derived identity. Thin, stale, or identity-poor pools remain visible for diagnostics but do not receive the same scoring weight as durable high-quality venues. Secondary discovery rows with non-finite, negative, or impossible pool TVL are rejected before they can enter scoring.


## Redemption Backstop Route Score

The standalone Redemption Backstop score rates an issuer or protocol redemption route from 0 to 100. It composes access (20%), settlement (15%), execution certainty (15%), capacity (25%), output-asset quality (15%), and cost (10%), then applies route-family, eligibility, delay, queue, minimum-redemption, severe-depeg, freshness, and evidence constraints.

Its modeled capacity request is 5% of supply, floored at $100,000 and capped at $25 million. Capacity blends percent-of-supply coverage with absolute executable dollars so a small percentage can still receive bounded credit without pretending it satisfies the full holder request.

This route score is separate from Safety Score V9 Exit. The two share reviewed route-scoring primitives, but V9 re-evaluates exact same-notional evidence under its own stress request, evidence ceilings, danger interlocks, and independent-backup policy.


## Mint/Burn Flow Scoring

Mint/burn flow scoring tracks issuance and redemption pressure across supported token contracts. Pharos classifies transfers into mint, burn, bridge-mint, bridge-burn, atomic roundtrip, and ignored noise so the gauge reflects meaningful supply movement instead of mechanical churn.

The score compares recent net flow against trailing closed-day baselines, distinguishes canonical-chain activity from bridge effects, and flags pressure shifts when risky outflows and safer inflows diverge.

Coverage is intentionally explicit. Unsupported chains, deferred configs, null-price repair, and stale lanes are surfaced as metadata rather than hidden behind a clean-looking aggregate. Quiet assets retain mature coverage from completed block-scan evidence even after old event rows age out.


## Yield Intelligence

Yield Intelligence resolves stablecoin yield from direct on-chain reads, curated pools, protocol APIs, price-derived NAV movement, and rate-derived sources. The pipeline prefers precise sources and only uses fallback tiers when identity and exposure remain unambiguous.

Pharos computes effective yield by comparing APY against the relevant cash or peg benchmark, then combines source-risk-adjusted yield efficiency with sustainability to produce a Pharos Yield Score (PYS). High APY is not automatically good: unstable rates, weak safety scores, low TVL, source-risk penalties, or ambiguous exposure reduce the recommendation quality.

External opportunities — lending markets, fixed-yield products, and structured tranches — are scored at the market level. The underlying stablecoin's Safety Score is one input to an opportunity-level safety score that also weighs reviewed venue risk, market size, observed utilization, and access or withdrawal constraints. Missing critical market evidence produces NR rather than a precise-looking score, and the underlying coin's own Report Card is never altered.

Warnings explain why a venue is risky, missing, stale, modeled, or benchmark-adjusted so yield pages do not promote fragile opportunities as clean income. Calculation mode is separate from evidence class: deterministic proxy math is still estimated evidence. Expired or critically incomplete evidence remains visible as NR context but cannot carry an exact current PYS, and new history points retain the versioned formula inputs needed for exact recomputation.


## PegScore and Depeg Early Warning Score (DEWS)

PegScore measures historical peg quality from time-at-peg and event severity. The tracking window starts at a reviewed replay-coverage date when one exists, otherwise it is capped by asset age or the earliest durable observation. Pharos also publishes a coverage-aware recent 90-day companion without treating unobserved days as stable.

DEWS is a forward-looking stress score. It combines price deviation, source divergence, liquidity erosion, pool imbalance, supply velocity, blacklist activity, mint/burn pressure, and yield anomalies into a 0-100 warning signal.

Pending depegs require source-family-aware corroboration before promotion. Pharos treats contradictory evidence as a reason to hold or reject an event, not as weak support, and it records canonical source keys behind every confirmed mutation.


## Depeg Duration Resolver

When Pharos confirms an active depeg, the Depeg Duration Resolver (DDR) answers two questions at the public forecast lock: will it come back, and if so, when. Stage 1 emits an ordinal Resolution Outlook (Recovery Likely, At Risk, Recovery Unlikely, or Insufficient Signal) from transparent kill signals and recovery anchors over the coin's structure and the depeg's fingerprint. It is a calibrated mechanistic rubric, not fitted machine learning, because the terminal-label corpus is too thin to train a supervised classifier.

DDRv4 uses a forecast-readiness-or-72h contract. Active confirmed incidents show live facts before lock, then the first healthy run with readiness score strictly greater than 0.75 freezes exactly one official prediction or no-call for the canonical incident. If readiness never triggers first, the first healthy run at or after 72h seals through the backstop. Health failures defer the lock rather than creating no-calls or predictions.

Stage 2 runs only when Stage 1 is not terminal-leaning. It is an empirical landmark-survival estimate over the clean corpus of recovered incidents, conditioned on the depeg's structural stratum (depth, direction, structural class, and peg currency) most-dependable-first. It reports a median time-to-repeg with a typical range (15th-85th percentile) plus per-horizon resolution-likelihood cells, support-gated and Wilson-bounded so thin cells show their support state instead of a fabricated number.

The Depeg Duration Resolver Reviewer (DDRR) scores frozen first-published predictions against later canonical depeg-event outcomes and reports coverage accountability for no-calls, pre-lock recoveries, terminal-before-lock outcomes, missed locks, publication retries/failures, data-quality gaps, invalidated rows, and legacy sticky 24h outcomes. Rollout-active incidents that predate the DDRv2 public contract use that boundary for fair coverage classification. Recovery-likelihood accuracy and duration error use only scoreable public predictions.

DDR consumes the same confirmed depeg events as the detection pipeline; it does not run its own detection. Forecast readiness is a publication trigger, not a probability or confidence level, and DDR is not investment advice or a credit rating.


## Blacklist Tracker Methodology

The blacklist tracker monitors issuer-controlled freeze, blocklist, account-pause, and token-destruction events across supported centralized stablecoin contracts.

Events are normalized by chain, stablecoin, action type, native amount, USD amount, and amount-status provenance. Recoverable amount gaps are queued for repair, while permanently unavailable rows remain auditable without polluting public aggregates.

Frozen-total summaries use last-known successful freeze-ledger snapshots. New snapshots are contract/config scoped so same-symbol deployments do not overwrite each other; legacy rows can fall back to older address identity until remediated.

Blacklist exposure uses the four-status report-card model: Yes, Upstream, Possible, and No. Upstream applies when a token has no direct Yes/Possible freeze control and strictly more than half of reserves are exposed to Yes, Upstream, or Possible upstream assets or rails.


## Chain Health Score

Chain Health Score evaluates how healthy each chain's stablecoin stack is. It combines supply-weighted Safety Score quality, chain environment, stablecoin concentration, peg stability, and RWA/crypto backing diversity.

The score is computed from current stablecoin data and only a fresh, accepted V9 publication rather than a separate opaque dataset. Missing, held, stale, or invalid V9 leaves Safety quality and the composite NR; there is no V8 or stale-score fallback. A chain with large supply but one dominant issuer, weak backing, poor peg behavior, or narrow backing diversity can score below a smaller but more diversified chain.

Chain Health is intended as market-structure context: it helps users understand whether a chain's stablecoin liquidity is deep, resilient, and diversified enough to support activity during stress.
