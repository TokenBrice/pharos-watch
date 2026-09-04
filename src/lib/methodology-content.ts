export type MethodologySectionContent = {
  id: string;
  title: string;
  markdown: string;
  markdownParagraphs: readonly string[];
};

function defineMethodologySectionContent({
  id,
  title,
  markdownParagraphs,
}: {
  id: string;
  title: string;
  markdownParagraphs: readonly string[];
}): MethodologySectionContent {
  return {
    id,
    title,
    markdownParagraphs,
    markdown: [`## ${title}`, ...markdownParagraphs].join("\n\n") + "\n",
  };
}

export const LIFECYCLE_PHASES_SECTION_CONTENT = defineMethodologySectionContent({
  id: "lifecycle-phases-methodology",
  title: "Stablecoin Lifecycle Phases",
  markdownParagraphs: [
    "Every tracked stablecoin sits in one of five lifecycle phases: active, pre-launch, quarantined, delisted, or frozen. The phase controls which surfaces ingest, score, and display the coin. It is a data-collection lifecycle policy, not a scoring methodology — per-domain version constants (Safety Scores, Liquidity, PegScore + DEWS, PSI, Yield, Mint/Burn Flow, Pricing Pipeline, Blacklist Tracker, Chain Health) are unaffected when a coin transitions between phases.",
    "Active coins receive full data collection and contribute according to listing class. Pre-launch coins have dedicated upcoming profiles but no live data. Quarantined records are temporarily withheld after a reviewed lack of positive supply or market-cap coverage; delisted records failed listing scope. Both retain static profiles without new provider collection. Frozen coins retain historical archive data in the cemetery. Missing price coverage and genuine depegs remain active monitoring problems rather than reasons to hide an asset through lifecycle state.",
  ],
});

export const PRICING_PIPELINE_SECTION_CONTENT = defineMethodologySectionContent({
  id: "pricing-pipeline-methodology",
  title: "Pricing Pipeline Methodology",
  markdownParagraphs: [
    "Every score Pharos computes starts with a price. The pricing pipeline collects live quotes from aggregators, exchanges, oracles, on-chain pools, protocol redemption feeds, FX references, and enrichment fallbacks.",
    "Pharos clusters sources by pairwise agreement, publishes the highest-confidence median, and keeps source provenance attached so downstream depeg, safety, liquidity, and PSI calculations can reason about data quality. Soft consensus can be challenged by large DEX pools; challenger snapshots retain qualifying protocol diversity before applying their TVL coverage cap so a dominant venue cannot hide a smaller independent corroborator. Protocol redemption prices override market data only for assets where the redemption path is the more authoritative mark.",
    "Freshness is explicit. Upstream-observed timestamps are preferred over local collection time, stale sources are excluded or downgraded, and replay-safe cache continuity is used only when it preserves a confirmed signal without inventing a new one.",
    "Fallback enrichment is bounded. CoinMarketCap, Jupiter, DexScreener, audited low-volume CoinGecko rows, exact-address providers, and reviewed protocol or exact-pool routes fill gaps for long-tail assets, but each pass has request budgets, identity checks, circuit breakers, freshness and depth requirements, corroboration checks, and plausibility gates so weak prices cannot silently become high-confidence consensus or false fixed-peg depegs. Persistent active-price gaps are scheduled ahead of breadth-oriented refresh work, exact-address fairness cursors rotate only inside priority cohorts, and eligible exact reviewed CoinGecko Onchain overrides reserve one bounded network request before ordinary network round-robin. DexScreener single-token discovery uses its complete pool-list endpoint while multi-address pricing keeps the separate batch-token endpoint. Exact reviewed pool identities take precedence over lower-fidelity derived duplicates so executable quote evidence stays attached to the physical pool. Thin executable routes can be admitted with fallback confidence for display when they pass the same severe-downside and temporal-jump corroboration guardrails as other soft sources, while remaining ineligible to drive depeg state or replay-safe cache continuity by themselves. AZND guard rejections stay explicit coverage gaps without counting as provider outages, while thrown or timed-out route work still fails its circuit.",
    "Price coverage is evaluated independently from row publication. A stablecoin can remain visible with supply and lifecycle data while its unusable price degrades cron and public health; the incident remains explicit instead of blocking the full cache or being hidden behind a nominal peg fill.",
  ],
});

export const STABILITY_INDEX_SECTION_CONTENT = defineMethodologySectionContent({
  id: "stability-index-methodology",
  title: "Stability Index Methodology",
  markdownParagraphs: [
    "The Pharos Stability Index (PSI) compresses stress across active core stablecoins and cash equivalents into a 0-100 condition score. Tracked variants and stable-value investments stay browsable but are excluded from the monetary aggregate. PSI starts at 100, subtracts penalties for severity, breadth, and stress breadth, then adds a clamped trend term before mapping the result into condition bands from BEDROCK to MELTDOWN.",
    "Severity captures how bad current deviations are. Breadth captures how many assets are involved. Stress breadth captures how many stablecoins are elevated in DEWS. Trend captures whether the system is getting better or worse over the current window: negative trend reduces the score, while positive trend can offset part of the penalty.",
    "PSI is deliberately conservative: one small depeg should not move the entire market condition, but simultaneous broad stress should pull the index down even if no single coin dominates the tape.",
  ],
});

export const SAFETY_SCORES_SECTION_CONTENT = defineMethodologySectionContent({
  id: "safety-scores-methodology",
  title: "Safety Scores Grading Methodology",
  markdownParagraphs: [
    "Safety Score V9 is the active identity-aware model. It evaluates Backing (40%), Exit (35%), and Economic Control (25%) through bounded aggregation, then applies peg behavior, structural ceilings, evidence sufficiency, track record, dependencies, and wrapper-local risk.",
    "Exit selects the strongest exact same-notional route and may add independent backup credit equal to min(10, 100 - primary route score) multiplied by backup route score / 100. The card shows the selected route, backup credit, and actual stress-request completion separately. The standalone DEX market score and redemption route score are not the V9 Exit score.",
    "Since methodology 9.44, a fully observed issuer or protocol route with zero or immaterial executable capacity remains the attributable primary evidence and scores zero instead of being discarded as unsupported. Its capacity, completion, confidence, and binding cap remain visible, and a zero Exit pillar states that no viable exit path was measured. Atomic protocol routes follow their reviewed settlement fact rather than being treated as inherently delayed.",
    "Since methodology 9.45, an open request/settle route whose settlement completion bound is unproven is a bounded evidence gap, not a measured zero: Exit floors at the bounded-unknown score under the exit-unverified ceiling with a visible warning.",
    "Since methodology 9.4, a favorable faster-settlement term receives credit only when the exact delay has a review date and source; a conservative correction can still lower credit without asserting a favorable promise. Curated settlement and cost terms can therefore move Exit in either direction. A route whose same-notional capacity, settlement, or cost is not established publishes a bounded terms gap: supported partial evidence remains visible, but generated fallback values receive no primary or backup credit, and ordinary uncertainty does not become measured danger.",
    "V9 distinguishes measured adverse evidence from issuer non-disclosure, unsupported methodology, missing integration, and transient producer failure. Bounded gaps can remain rateable under explicit ceilings; an unbounded required fact remains NR, and F is reserved for causally attributed measured danger.",
    "Live reserve percentages are scoring weights, not identities. A namespace-qualified stable source key joins an adapter-owned reserve category to reviewed classification and dependency metadata across rebalancing or label changes. Explicit keys must match uniquely and otherwise fail closed; historical unkeyed captures retain a unique normalized-name compatibility join.",
    "Since methodology 9.4, reserve classification remains current for 365 days while composition uses a 31-day window plus a fixed 7-day reporting grace. Both gates apply before reviewed facts reach live adapter rows, so current percentages cannot preserve an expired classification and a durable classification cannot extend stale percentages.",
    "Since methodology 9.31, curated collateral links share the reserve-envelope admission gate. When no live reserve slices exist and the curated composition is stale or otherwise inadmissible, the dependency overlay publishes no curated basket edges; the existing reserve-envelope gap carries the bounded consequence instead of an unrelated unreviewed-dependency reason. Admissible curated reviews, live-derived edges, and manual dependency reviews remain unchanged.",
    "Responsibility follows causal provenance instead of the nearest processing stage. An explicit reason-level owner is authoritative; inherited reserve gaps, unavailable upstream pillars, and missing parent scores carry every originating owner downstream. Every attributed root receives a causal-root-qualified score path even when it is the only root, so adding another root cannot rename an existing public fact; only unattributed fallbacks retain aggregate base paths, and ownership never becomes part of fact identity. Applicable but unpublished mechanism metrics remain issuer-undisclosed rather than measured-adverse. A reviewed external exit output whose identity is known but cannot be valued is attributed to producer failure, while an issuer-undisclosed settlement asset stays issuer-undisclosed; neither becomes scoreable. Date-only dispositions enter replay only after their reviewed UTC day. Partial control reviews retain the controls that were actually reviewed while unresolved surfaces remain bounded and fail closed. Subthreshold unrecognized chain-label supply pools are tolerated by the bridge-materiality proof and no longer surface as public evidence-responsibility facts; material unmatched bridge supply still fails closed. Coverage that no supported adapter can observe is unsupported methodology rather than producer failure: deployment census coverage is reported per chain instead of all or nothing, an exit surface whose census remainder is unsupported reports unsupported route evidence, and an unreviewed dependency set on an asset with no live-reserve adapter is unsupported rather than failed. Since methodology 9.2, a populated DEX exit surface is complete for gap accounting once its budgeted score-eligible routes are observed; leftover target-construction and reviewed model-limit gates on other recognised venues are not a data-feed failure. Exact-route scoring completeness stays strict. An asset with no usable price whose tracked peg record is already adverse is measured adverse, while a clean record with no usable price stays a quiet observation and its deviation is never coerced to zero. These are provenance and evidence-retention changes: pillar weights, score math, and grade thresholds are unchanged.",
    "Since methodology 9.461, two evaluator mapping defects are corrected without adding evidence. Reviewed-native selected supply rows no longer enter the bridge-exposure completeness join: evaluateV9SubthresholdUnresolvedBridgeJoins excludes them from bridgeControlsByDeployment, while the route predicate and native-liability boundary keep native controls as umbrella facts and exclude native route ids from bridgeClaimControls. On replay of capture-20260904-1100.json at clock 1788509806, this corrected a wrong join and closed 9 facts (nonmaterial-bridge-supply-unmatched on ausd-agora, pyusd-paypal, reusd-re-protocol, usbd-bima, fusd-finchain, cusd-celo, frxusd-frax, usdy-ondo-finance, plus missing-bridge-route-rows on fusd-finchain), with 0 replacements and exactly 1 mover: fusd-finchain NR -> 46/D. Floors, the completeness predicate, and unknownBridgeShare are unchanged; Pharos learned nothing new.",
    "The same 9.461 replay corrects a second evaluator defect: offchain-issuer commodity routes whose outputAssetType is bluechip-collateral (physical GOLD/SILVER delivery) now resolve as unresolved-asset rather than fiat. Removing the synthetic $1 physical-bar valuation ADDED 5 facts (unresolved-exit-output and missing-runtime-route-evidence on gldt-gold-dao, paxg-paxos, xnk-kinka) and moved 2 grades: gldt-gold-dao 47/D -> NR and xnk-kinka 41/D -> 39/F. This is an honest loss of false coverage, not newly learned adverse evidence. The affected asset set is cgo-comtech, dgld-gold-token-sa, ggbr-goldfish-gold, gldt-gold-dao, gldy-streamex, kag-kinesis, kau-kinesis, paxg-paxos, pgold-pleasing, xagm-matrixdock, xaum-matrixdock, xaut-tether, xnk-kinka. Producer-side repairs in these waves cannot manifest until a real producer cycle runs.",
    "Since methodology 9.4, stale issuer- or parent-published evidence is attributed as published-evidence-expired when its publisher provenance is explicit, rather than being described as issuer non-disclosure. Unknown provenance still fails closed under the existing responsibility. The new value changes attribution and public explanation, not score arithmetic.",
    "Shared-dependency evidence is priced per asset. When several reviewed assets depend on one critical control identity, each asset's common-mode signal is resolved from its own member facts. A reviewed member whose control observation is bounded-unknown stays measured-adverse, because an unverified critical controller cannot make a shared failure domain safer; a missing, stale, or unresolved member remains an integration gap. Evidence confidence is high only when the receiving asset's own member facts are known, so a shared-control gap never lifts the published score of the asset that carries it or of its peers.",
    "Since methodology 9.25 the published primary-exit posture is derived from every route the Exit pillar credits, not only from routes that clear the strict score-eligibility bar. Reviewed issuer, protocol, and eventual redemption routes carry economic weight in Exit, so a posture that ignored them could report no exit for an asset whose Exit score rested on one. The posture now separates three kinds of absence rather than collapsing them onto the negative: a reviewed exit surface observed complete with zero routes reports none, an unobserved surface or one whose credited routes resolve no access fact reports undisclosed, and credited routes with unresolved access facts report unknown. Undisclosed is published as an explicit not-disclosed state instead of being dropped, because an evidence gap must not read as a clean result. The posture change itself moves no score: pillar weights, score math, grade thresholds, and every published score and grade are unchanged by it. "
      + "The same release corrects the mirror-image defect in Economic Control, where a missing reserve-reconciliation cadence was read as evidence of a periodic one because the sentinel values are non-empty strings. "
      + "An issuer that publishes no reconciliation is now graded unknown rather than periodic, which withholds a rating from two assets and lowers a third; a reviewed reconciliation still supersedes the inference, so the gap is closable by curation.",
    "Governance access posture treats reviewed global mint-domain contracts as immutable when they have no privileged capabilities, no applicable cap, no claim-impairment path, and access-only scope. A contract address alone is protocol machinery, not evidence of a concentrated administrator; deployment-scoped bridge controls remain separate.",
    "Methodology 9.4 applies the current oracle-applicability distinction to stale pre-9.17 reviews: the absence of borrower liquidation branches does not make a top-level mint, redemption, NAV, or exchange-rate authority non-applicable. Verified adverse oracle evidence remains measured adverse, unresolved applicability remains bounded, and a genuinely price-insensitive mechanism remains neutral.",
    "Methodology 9.4 also makes control scope follow the liability a control can reach. A proved deployment-local control contributes a proportional exposure adjustment only with a complete reconciled liability partition; root-reaching, contradictory, or unresolved controls retain global hard-cap treatment. A control that still binds Economic Control retains its causal attribution, and a scope correction alone cannot turn an unchanged measured D or F into NR. Common-control thresholds count independent root liabilities, so wrappers and derivatives do not manufacture another affected asset and same-issuer controllers remain diagnostic. Chain maturity is a dated five-gate review requiring 36 months of continuous production history, a 365-day liveness record, permissionless participation or at least 21 independently operated block producers or finality members, no unilateral instant change path (with L2s at Stage 1 or later and at least a 7-day holder exit), and documented bridge or data-availability dependencies with a holder exit. Cardano, Gnosis, Hedera, Rootstock, Sui, Conflux, and Kaia are the seven newly admitted chains; Celo remains excluded.",
    "Reviewed incidents are routed into the control, wrapper-local, operational, or peg component that owns the risk, with root-claim, deployment, integration-only, or holder-exit scope. Active, mitigated, and resolved evidence therefore changes an existing component without creating a fourth pillar or charging an event beyond the affected liability.",
    "Publication is fail-closed. Stale or unavailable score-bearing producers and material infrastructure-attributed deterioration hold the last accepted V9 ratings. Isolated producer failures do not freeze the publication while at least 90% of active assets remain unaffected. Active consumers expose held status and never recompute or fall back to V8. V8.17 remains documented as historical methodology.",
  ],
});

export const MINT_AUTHORITY_SCORE_SECTION_CONTENT = defineMethodologySectionContent({
  id: "mint-authority-score",
  title: "Mint Authority Score",
  markdownParagraphs: [
    "Mint authority measures how much durable stablecoin supply can be created, authorized, or expanded on the canonical native-issuance deployment or deployments.",
    "Since methodology v9.1 it is graded once, by the Safety Score V9 Economic Control pillar. The mint component starts from a derived posture (cap semantics, claim impairment, reconciliation, supervision), then applies resolved-incident age decay, a key-custody penalty that MPC or HSM attestation waives, a multisig quorum ladder, and a small Safe module modifier.",
    "Representations and cross-chain machinery are assessed separately by Bridge Risk at deployment scope. A shared controller may appear in both domains for distinct powers, but a bridge capability never becomes global Mint Authority risk. Missing or unresolved review data returns NR and never implies safety.",
    "Since methodology 9.3 a derived none-resolved posture scores the mint component at 100: it states that no reviewed control can mint, authorize minting, or expand issuance on this component's scope, so no headroom is reserved above it. The motivating LUSD and BOLD case proves that absence outright on immutable, owner-renounced deployments. Oracle and bridge tier tables are independent calibrations and keep their existing values.",
    "Since methodology 9.24 a reviewed absence is scored as the fact it is rather than as missing evidence. An inventory whose every reviewed route is native issuance is not bridge-exposed, even where structured controls govern those canonical deployments; a reviewed representation route keeps Bridge Risk applicable regardless. A bridge review with an incomplete materiality picture keeps the routes it did review when the supply it could not attribute is immaterial, and still fails closed when that residual is material or unmeasured. A reviewed no-local-issuance exception scores the mint component as none-resolved only when the displaced risk is carried elsewhere: an inherited claim must compile a serial-claim edge to its parent, and an external-only representation must carry a reviewed route inventory covering every authored deployment. Absence is never inferred, and any authored control keeps the mint review in force.",
  ],
});

export const INFRASTRUCTURE_SECTION_CONTENT = defineMethodologySectionContent({
  id: "infrastructure-methodology",
  title: "Infrastructure Tagging",
  markdownParagraphs: [
    "Infrastructure tags identify stablecoins that share issuance frameworks, protocol mechanisms, or operational dependencies. Examples include Liquity v1, Liquity v2, and M0.",
    "Tags help Pharos group related assets without pretending they are the same stablecoin. They support navigation, taxonomy pages, comparison context, and dependency-aware risk review.",
    "Infrastructure tags do not override the underlying governance, backing, peg, collateral, or report-card inputs. They are descriptive metadata used to expose shared machinery.",
  ],
});

export const LIQUIDITY_SECTION_CONTENT = defineMethodologySectionContent({
  id: "liquidity-methodology",
  title: "Liquidity Score",
  markdownParagraphs: [
    "The Liquidity Score measures how safely a stablecoin can exit through decentralized markets. It combines TVL depth, volume activity, pool quality, durability, and pair diversity into a 0-100 score.",
    "TVL depth uses log-scale scoring so small assets can improve without requiring blue-chip depth, while very deep pools still receive credit. Volume rewards active markets. Pool quality adjusts for mechanism type, pool balance, pair quality, and risky counterparties. Durability measures persistence across observations, and pair diversity penalizes concentration in one venue or one unstable route.",
    "Discovery is source-aware. Pharos stages pools from DefiLlama, direct protocol APIs, CoinGecko on-chain data, GeckoTerminal, DexScreener, and curated DEX sources, then deduplicates by exact pool identity or conservative derived identity. Since v6.0, concentrated Raydium pools are classified from DefiLlama's pool metadata, so the same physical Solana pool is never counted from both DefiLlama and the direct Raydium API. Thin, stale, or identity-poor pools remain visible for diagnostics but do not receive the same scoring weight as durable high-quality venues. Secondary discovery rows with non-finite, negative, or impossible pool TVL are rejected before they can enter scoring.",
  ],
});

export const REDEMPTION_BACKSTOP_SECTION_CONTENT = defineMethodologySectionContent({
  id: "redemption-backstop-methodology",
  title: "Redemption Backstop Route Score",
  markdownParagraphs: [
    "The standalone Redemption Backstop score rates an issuer or protocol redemption route from 0 to 100. It composes access (20%), settlement (15%), execution certainty (15%), capacity (25%), output-asset quality (15%), and cost (10%), then applies route-family, eligibility, delay, queue, minimum-redemption, severe-depeg, freshness, and evidence constraints.",
    "Its modeled capacity request is 5% of supply, floored at $100,000 and capped at $25 million. Capacity blends percent-of-supply coverage with absolute executable dollars so a small percentage can still receive bounded credit without pretending it satisfies the full holder request.",
    "Since v4.39, a measured route scores zero when executable capacity is zero or below both the 1% completion and $100,000 absolute breakpoints; missing capacity remains unrated, and the same materiality gate applies to the eventual-redeemability headline. Reviewed settlement overrides are shared by the standalone row and V9, with favorable corrections subject to the 365-day evidence window. Reserve-sync routes publish full-supply eventual capacity only when dated route evidence explicitly opts into that claim.",
    "Since v4.4, an open route with an unproven settlement completion bound publishes unestablished capacity and remains unrated rather than being scored zero.",
    "Since v4.42, market-implied degradation on an open live downside incident requires a fresh authoritative current signed deviation at or below -2500 bps. The incident's historical peak does not establish present severity: when current evidence is stale, missing, cached, untrusted, or lacks an authoritative peg reference, the route publishes unknown / market-implied and remains impaired with its score withheld; a fresh non-severe deviation releases only this overlay without closing the incident.",
    "This route score is separate from Safety Score V9 Exit. The two share reviewed route-scoring primitives, but V9 re-evaluates exact same-notional evidence under its own stress request, evidence ceilings, danger interlocks, and independent-backup policy.",
  ],
});

export const MINT_BURN_FLOW_SECTION_CONTENT = defineMethodologySectionContent({
  id: "mint-burn-flow-methodology",
  title: "Mint/Burn Flow Scoring",
  markdownParagraphs: [
    "Mint/burn flow scoring tracks issuance and redemption pressure across supported token contracts. Pharos classifies transfers into mint, burn, bridge-mint, bridge-burn, atomic roundtrip, and ignored noise so the gauge reflects meaningful supply movement instead of mechanical churn.",
    "The score compares recent net flow against trailing closed-day baselines, distinguishes canonical-chain activity from bridge effects, and flags pressure shifts when risky outflows and safer inflows diverge.",
    "Coverage is intentionally explicit. Unsupported chains, deferred configs, null-price repair, and stale lanes are surfaced as metadata rather than hidden behind a clean-looking aggregate. Quiet assets retain mature coverage from completed block-scan evidence even after old event rows age out.",
  ],
});

export const YIELD_SECTION_CONTENT = defineMethodologySectionContent({
  id: "yield-intelligence-methodology",
  title: "Yield Intelligence",
  markdownParagraphs: [
    "Yield Intelligence resolves stablecoin yield from direct on-chain reads, curated pools, protocol APIs, price-derived NAV movement, and rate-derived sources. The pipeline prefers precise sources and only uses fallback tiers when identity and exposure remain unambiguous.",
    "Pharos computes effective yield by comparing APY against the relevant cash or peg benchmark, then combines source-risk-adjusted yield efficiency with sustainability to produce a Pharos Yield Score (PYS). High APY is not automatically good: unstable rates, weak safety scores, low TVL, source-risk penalties, or ambiguous exposure reduce the recommendation quality.",
    "External opportunities — lending markets, fixed-yield products, and structured tranches — are scored at the market level. The underlying stablecoin's Safety Score is one input to an opportunity-level safety score that also weighs reviewed venue risk, market size, observed utilization, and access or withdrawal constraints. Missing critical market evidence produces NR rather than a precise-looking score, and the underlying coin's own Report Card is never altered.",
    "Warnings explain why a venue is risky, missing, stale, modeled, or benchmark-adjusted so yield pages do not promote fragile opportunities as clean income. Calculation mode is separate from evidence class: deterministic proxy math is still estimated evidence. Expired or critically incomplete evidence remains visible as NR context but cannot carry an exact current PYS, and new history points retain the versioned formula inputs needed for exact recomputation.",
  ],
});

export const PEGSCORE_DEWS_SECTION_CONTENT = defineMethodologySectionContent({
  id: "pegscore-dews-methodology",
  title: "PegScore and Depeg Early Warning Score (DEWS)",
  markdownParagraphs: [
    "PegScore measures historical peg quality from time-at-peg and event severity. The tracking window starts at a reviewed replay-coverage date when one exists, otherwise it is capped by asset age or the earliest durable observation. Pharos also publishes a coverage-aware recent 90-day companion without treating unobserved days as stable.",
    "DEWS is a forward-looking stress score. It combines price deviation, source divergence, liquidity erosion, pool imbalance, supply velocity, blacklist activity, mint/burn pressure, and yield anomalies into a 0-100 warning signal.",
    "Pending depegs require source-family-aware corroboration before promotion. Pharos treats contradictory evidence as a reason to hold or reject an event, not as weak support, and it records canonical source keys behind every confirmed mutation.",
  ],
});

export const BLACKLIST_SECTION_CONTENT = defineMethodologySectionContent({
  id: "blacklist-tracker-methodology",
  title: "Blacklist Tracker Methodology",
  markdownParagraphs: [
    "The blacklist tracker monitors issuer-controlled freeze, blocklist, account-pause, and token-destruction events across supported centralized stablecoin contracts.",
    "Events are normalized by chain, stablecoin, action type, native amount, USD amount, and amount-status provenance. Recoverable amount gaps are queued for repair, while permanently unavailable rows remain auditable without polluting public aggregates.",
    "Frozen-total summaries use last-known successful freeze-ledger snapshots. New snapshots are contract/config scoped so same-symbol deployments do not overwrite each other; legacy rows can fall back to older address identity until remediated.",
    "Blacklist exposure uses the four-status report-card model: Yes, Upstream, Possible, and No. Upstream applies when a token has no direct Yes/Possible freeze control and strictly more than half of reserves are exposed to Yes, Upstream, or Possible upstream assets or rails.",
  ],
});

export const DEPEG_RESOLVER_SECTION_CONTENT = defineMethodologySectionContent({
  id: "depeg-resolver-methodology",
  title: "Depeg Duration Resolver",
  markdownParagraphs: [
    "When Pharos confirms an active depeg, the Depeg Duration Resolver (DDR) answers two questions at the public forecast lock: will it come back, and if so, when. Stage 1 emits an ordinal Resolution Outlook (Recovery Likely, At Risk, Recovery Unlikely, or Insufficient Signal) from transparent kill signals and recovery anchors over the coin's structure and the depeg's fingerprint. It is a calibrated mechanistic rubric, not fitted machine learning, because the terminal-label corpus is too thin to train a supervised classifier.",
    "DDRv4 uses a forecast-readiness-or-72h contract. Active confirmed incidents show live facts before lock, then the first healthy run with readiness score strictly greater than 0.75 freezes exactly one official prediction or no-call for the canonical incident. If readiness never triggers first, the first healthy run at or after 72h seals through the backstop. Health failures defer the lock rather than creating no-calls or predictions.",
    "Stage 2 runs only when Stage 1 is not terminal-leaning. It is an empirical landmark-survival estimate over the clean corpus of recovered incidents, conditioned on the depeg's structural stratum (depth, direction, structural class, and peg currency) most-dependable-first. It reports a median time-to-repeg with a typical range (15th-85th percentile) plus per-horizon resolution-likelihood cells, support-gated and Wilson-bounded so thin cells show their support state instead of a fabricated number.",
    "The Depeg Duration Resolver Reviewer (DDRR) scores frozen first-published predictions against later canonical depeg-event outcomes and reports coverage accountability for no-calls, pre-lock recoveries, terminal-before-lock outcomes, missed locks, publication retries/failures, data-quality gaps, invalidated rows, and legacy sticky 24h outcomes. Rollout-active incidents that predate the DDRv2 public contract use that boundary for fair coverage classification. Recovery-likelihood accuracy and duration error use only scoreable public predictions.",
    "DDR consumes the same confirmed depeg events as the detection pipeline; it does not run its own detection. Forecast readiness is a publication trigger, not a probability or confidence level, and DDR is not investment advice or a credit rating.",
  ],
});

export const CHAIN_HEALTH_SECTION_CONTENT = defineMethodologySectionContent({
  id: "chain-health-score",
  title: "Chain Health Score",
  markdownParagraphs: [
    "Chain Health Score evaluates how healthy each chain's stablecoin stack is. It combines supply-weighted Safety Score quality, chain environment, stablecoin concentration, peg stability, and RWA/crypto backing diversity.",
    "The score is computed from current stablecoin data and only a fresh, accepted V9 publication rather than a separate opaque dataset. Missing, held, stale, or invalid V9 leaves Safety quality and the composite NR; there is no V8 or stale-score fallback. A chain with large supply but one dominant issuer, weak backing, poor peg behavior, or narrow backing diversity can score below a smaller but more diversified chain.",
    "Chain Health is intended as market-structure context: it helps users understand whether a chain's stablecoin liquidity is deep, resilient, and diversified enough to support activity during stress.",
  ],
});

export const METHODOLOGY_INDEX_SECTION_CONTENT = [
  PRICING_PIPELINE_SECTION_CONTENT,
  STABILITY_INDEX_SECTION_CONTENT,
  SAFETY_SCORES_SECTION_CONTENT,
  MINT_AUTHORITY_SCORE_SECTION_CONTENT,
  INFRASTRUCTURE_SECTION_CONTENT,
  LIQUIDITY_SECTION_CONTENT,
  REDEMPTION_BACKSTOP_SECTION_CONTENT,
  MINT_BURN_FLOW_SECTION_CONTENT,
  YIELD_SECTION_CONTENT,
  PEGSCORE_DEWS_SECTION_CONTENT,
  DEPEG_RESOLVER_SECTION_CONTENT,
  BLACKLIST_SECTION_CONTENT,
  CHAIN_HEALTH_SECTION_CONTENT,
] as const;
