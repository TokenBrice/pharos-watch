import {
  createMethodologyVersion,
} from "./methodology-version";

const yieldMethodology = createMethodologyVersion({
  currentVersion: "5.3",
  changelogPath: "/methodology/yield-changelog/",
  changelog: [
  {
    version: "5.3",
    title: "Non-USD Yield Scoping and Exact-Pool Commodity Overrides",
    date: "2026-03-26",
    effectiveAt: 1774785600,
    summary:
      "Yield Intelligence now exposes a shareable non-USD ranking scope on `/yield`, and commodity coverage can use curated exact-pool DeFiLlama venues without relaxing the generic gold/silver discovery guardrails.",
    impact: [
      "The `/yield` page now supports peg-scoped ranking views, including a `non-usd` preset that groups the live EUR, CHF, SGD, MXN, and commodity rows into one visible universe",
      "Tier-2 DeFiLlama ingestion now preserves exact curated non-stablecoin pool UUIDs in addition to native pool IDs and wrapper symbols",
      "A new exact-pool override lane can publish assets like `xaut-tether` from a named venue when the UUID, project, chain, and symbol all match and the APY/TVL quality gates pass",
      "Generic gold/silver auto-discovery remains disabled, preventing mixed baskets such as Multipli's RWAUSDI pool from being misclassified as single-asset commodity yield sources",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.2",
    title: "Address-First Identity, Explicit Coverage, and Publish-Consistent History",
    date: "2026-03-26",
    effectiveAt: 1774778400,
    summary:
      "Yield resolution now matches by chain and address before symbol fallbacks, every yield-bearing asset has explicit manifest coverage or an intentional gap, and published history is bounded to the latest rankings snapshot.",
    impact: [
      "DeFiLlama discovery, variant matching, and protocol-native adapters now prefer chain+address identity and drop ambiguous symbol-only candidates instead of attaching them to the first matching coin",
      "Protocol-native source keys now use full chain-aware identifiers (Morpho, Pendle, Yearn, Kong, Beefy, Compound, Aave) and source-link matching understands prefixed and chain-qualified labels",
      "Yield manifest coverage now includes explicit price-derived fallbacks and intentional gaps, so assets like cetes-etherfuse and usg-tangent are no longer invisible to coverage reporting",
      "Warning heuristics and published `medianApy` now share the same TVL-weighted 30d benchmark",
      "yield-history no longer advances past the latest published yield-rankings snapshot when DB writes and cache publication diverge",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Yield Infrastructure Automation",
    date: "2026-03-26",
    effectiveAt: 1774771200,
    summary:
      "Chain-scoped Layer 3 symbol matching prevents cross-chain false positives in auto-lending discovery, variant symbol auto-scanner detects new wrapper tokens (advisory mode), and monthly yield coverage audit cron provides protocol expansion recommendations.",
    impact: [
      "Chain-scoped matching adds optional chainFilter to findBestLendingPool, derived from coin contract deployments",
      "Variant scanner detects sXXX/stXXX/wXXX prefix and SAVE/VAULT/EARN/STAKE suffix patterns in DL pools",
      "Monthly coverage audit cron (1st of month, 06:00 UTC) flags unmatched high-TVL pools and missing protocols",
      "Protocol recommendations classify missing protocols as high-confidence (>$10M, 3+ pools) or review-needed",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Yield Coverage Expansion — Protocol-Native API Wave",
    date: "2026-03-25",
    effectiveAt: 1774684800,
    summary:
      "Major yield coverage expansion: 10 protocol-native adapters (Hashnote USYC, Ondo oracle, Morpho GraphQL, Pendle REST, Yearn Kong GraphQL, Beefy REST, Aave V3 on-chain, Compound V3 on-chain, BIMA Earn), USTB + thBILL promoted to on-chain ERC-4626, cusd-cap flagged yield-bearing, 19 new lending protocols added, TVL floor lowered for smaller ecosystems, DeFiLlama yield history backfill for instant 365-day charts.",
    impact: [
      "10 protocol-native adapters provide direct yield data, reducing DeFiLlama intermediation",
      "Aave V3 + Compound V3 direct on-chain supply rates across Ethereum, Arbitrum, and Base",
      "Kong adapter covers 2,083 ERC-4626 vaults (Yearn + Morpho + Spark + Fluid + others)",
      "USTB + thBILL upgraded from T-bill proxy to actual on-chain ERC-4626 exchange rate reads",
      "DeFiLlama yield history backfill gives instant 365-day charts for newly tracked coins",
      "Expanded lending protocol allowlist with 19 new protocols (Wildcat $235M, Tectonic $100M, etc.)",
      "cusd-cap flagged as yield-bearing with stCUSD savings wrapper ($68M TVL)",
      "Lower TVL floor ($25K) captures Solana/Sui/Aptos/Cardano/Stacks lending markets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.11",
    title: "Protocol-native BIMA savings fallback for USBD",
    date: "2026-03-24",
    effectiveAt: 1774418400,
    summary:
      "USBD now resolves through BIMA's public earn API when DeFiLlama has no usable sUSBD wrapper pool, closing the remaining native-yield coverage gap without introducing a hand-set rate.",
    impact: [
      "usbd-bima now emits a protocol-native `BIMA savings (sUSBD)` source row sourced from BIMA's published `/api/earn/pools` feed",
      "Yield arbitration treats protocol-owned earn APIs as curated sources rather than misclassifying them as on-chain or DeFiLlama data",
      "The about page and source-link registry now expose BIMA's earn surface as an official yield-source reference",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.10",
    title: "Richer freshness provenance and curated lending source links",
    date: "2026-03-24",
    effectiveAt: 1774407600,
    summary:
      "Yield rankings provenance now carries source-observation and comparison-anchor timing for derived sources, and the lending allowlist now has curated source-link coverage for all supported protocols.",
    impact: [
      "Price-derived and on-chain rankings now expose the age of their actual observation inputs instead of always presenting as fresh at sync time",
      "Derived-source provenance now includes comparison-anchor timing so older anchors are visible to downstream consumers",
      "All allowlisted lending protocols now resolve to curated source links instead of falling back to coin-level websites or nulls",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.9",
    title: "Publish-safe retention and deterministic adapter quarantine",
    date: "2026-03-24",
    effectiveAt: 1774404000,
    summary:
      "Yield publication now preflights rankings payloads before mutating live rows, degraded runs retain prior rows instead of destructively pruning, and the two known-bad generic deterministic vault probes were quarantined from Tier 1 coverage.",
    impact: [
      "Rankings publication is now validated before live row mutation, reducing DB/cache divergence risk on schema or publish-guard failures",
      "Degraded runs retain prior current rows by skipping destructive cleanup instead of deleting rows while upstream inputs are impaired",
      "dUSD and reUSD were removed from the generic ERC-4626 deterministic adapter set until protocol-specific readers exist, reducing false confidence in Tier 1 coverage",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.8",
    title: "Explicit edge-case overrides for remaining high-signal lending markets",
    date: "2026-03-24",
    effectiveAt: 1774360200,
    summary:
      "A final selective pass added deterministic lending overrides for the remaining high-signal exact-symbol markets that were still blocked only by report-card coverage gaps or sub-C safety gating.",
    impact: [
      "Polaris pUSD now resolves through a deterministic Silo v2 lending market override, fixing the prior bypass-only configuration gap",
      "USDX, USDO, and USDM now use deterministic exact-symbol lending overrides rather than waiting on the generic dynamic discovery path",
      "These explicit overrides bypass the normal C- safety gate only for a short named list of high-TVL or protocol-native edge cases, preserving the broader global discovery standard",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.7",
    title: "Early NAV fallback support and deeper long-tail lending coverage",
    date: "2026-03-24",
    effectiveAt: 1774357200,
    summary:
      "Yield coverage widened again through lower but still curated lending floors, two additional protocol families, and price-derived fallbacks that can bootstrap younger NAV tokens before day 30.",
    impact: [
      "Auto-discovered lending opportunities now accept single-asset pools down to $100K TVL and 0.10% APY, capturing still-meaningful long-tail markets without opening full dust-pool coverage",
      "The curated lending allowlist now includes More Markets and SmarDex USDN, while Polaris pUSD can bypass the report-card gate through an explicit vetted edge-case override",
      "Price-derived APY now annualizes from the oldest available price anchor between 7 and 45 days instead of requiring a strict 30-day sample, improving early coverage for newer NAV tokens",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.6",
    title: "Rate-derived treasury expansion and broader lending discovery",
    date: "2026-03-24",
    effectiveAt: 1774346400,
    summary:
      "Yield coverage widened through new deterministic Treasury fallbacks plus a broader but still curated lending auto-discovery set for long-tail safe assets.",
    impact: [
      "USYC and thBILL now participate in rate-derived Treasury fallback coverage alongside the existing BUIDL/USTB/YLDS/mTBILL/OUSG set",
      "Auto-discovered lending coverage now recognizes additional curated protocol slugs already present in live DeFiLlama data, including Loopscale, Vesper, Lista Lending, Liqwid, Overnight, Lagoon, and NAVI Lending",
      "The lending auto-discovery TVL floor was reduced from $1.0M to $0.5M to capture still-meaningful long-tail lending markets without opening the door to dust pools",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.5",
    title: "Fail-closed source validation and retained-market benchmark continuity",
    date: "2026-03-23",
    effectiveAt: 1774263600,
    summary:
      "Yield sync now treats broken direct-source payloads and total deterministic on-chain outages as degraded inputs, while retained Treasury benchmarks preserve the last market-derived rate across fallback streaks.",
    impact: [
      "Direct DeFiLlama yield fetches now degrade on invalid payloads or zero relevant stablecoin pools instead of being treated as a benign empty set",
      "Runs now degrade when all configured deterministic on-chain sources fail in the same cycle, exposing that outage in rankings provenance",
      "Retained `risk_free_rate` fallbacks preserve the last market-derived benchmark fields across degraded streaks, and rankings-cache publication now blocks on severe shrink versus the prior cache",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.4",
    title: "On-chain rate bootstrapping and pipeline hardening",
    date: "2026-03-20",
    effectiveAt: 1774022400,
    summary:
      "Fixed a bootstrapping deadlock preventing all 13 Tier 1 vault configs from computing on-chain APY, plus DRY and performance improvements.",
    impact: [
      "On-chain rate configs now emit a seed row when no previous exchange rate exists, breaking the bootstrapping deadlock that prevented Tier 1 APY computation since launch",
      "buildOnChainSourceKey consolidated from 3 duplicate definitions into a single shared export",
      "Pool pre-filter set allocations promoted from per-call to module-level for improved DL pool ingestion performance",
      "Live safety hydration coverage ratio now uses active card count instead of total card count for accurate degradation detection",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.3",
    title: "Wrapper-preserving ingestion and hydration hardening",
    date: "2026-03-19",
    effectiveAt: 1773878400,
    summary:
      "Yield ingestion now preserves wrapper-relevant pools through pre-filtering, separates deterministic history from curated pools, and hardens public hydration paths against partial safety or warning data.",
    impact: [
      "DeFiLlama pool ingestion now retains single-exposure wrapper pools that are explicitly relevant via native or variant config even when upstream `stablecoin` flags are false",
      "Deterministic on-chain rows now use `onchain:<stablecoinId>` source keys so previous-rate lookups and source-aware history cannot collide with curated pool UUIDs",
      "Live `/api/yield-rankings` safety hydration keeps rows with `DEFAULT_SAFETY_SCORE` / `NR` when report-card coverage is incomplete instead of dropping yield coverage",
      "Retained benchmark fallbacks stay marked as degraded, and malformed stored `warning_signals` payloads no longer fail `yield-history` requests",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.2",
    title: "Source-aware history and confidence-weighted arbitration",
    date: "2026-03-10",
    effectiveAt: 1773100800,
    summary:
      "Yield rankings now preserve per-source history, retain benchmark provenance, and prefer higher-confidence sources when multiple candidates disagree.",
    impact: [
      "yield_history now persists per-source rows with best-source markers instead of a single mixed best series",
      "7d and 30d APY metrics are computed from source-specific history, preventing source-switch contamination",
      "Rankings now include provenance for benchmark freshness, safety coverage, source-switch state, and selection reasoning",
      "Cross-source arbitration can reject divergent discovered or fallback sources when canonical sources disagree materially",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.1",
    title: "Conservative LUSD Stability Pool source",
    date: "2026-03-07",
    effectiveAt: 1772884800,
    summary:
      "LUSD gained a deterministic B.Protocol / Liquity Stability Pool source that estimates only the LQTY incentive stream and labels that limitation explicitly.",
    impact: [
      "Added direct on-chain LUSD source using Liquity Stability Pool deposits and CommunityIssuance totals",
      "APR converts projected LQTY emissions to USD using CoinGecko spot price and excludes ETH liquidation gains by design",
      "LUSD can now surface both B.Protocol Stability Pool and auto-discovered lending alternatives in the same ranking payload",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "Multi-source rankings and alternative-source transparency",
    date: "2026-03-03",
    effectiveAt: 1772559178,
    summary:
      "Yield rankings moved from single-source rows to per-source modeling, so each coin can expose both native and wrapper yield paths.",
    impact: [
      "yield_data primary key changed to (stablecoin_id, source_key) with per-source rows",
      "is_best now marks the highest-APY source per coin; non-best alternatives are retained",
      "Tier 2 matching aggregates all valid sources (native map, wrapper map, symbol fallback)",
      "/api/yield-rankings now includes altSources[] and UI exposes +N alternative source details",
    ],
    commits: ["b94e042"],
    reconstructed: true,
  },
  {
    version: "3.3",
    title: "Coverage ratchet: deterministic overrides + address-aware discovery",
    date: "2026-03-03",
    effectiveAt: 1772529534,
    summary:
      "Auto-discovered lending coverage expanded with stricter quality gates, deterministic overrides, and contract-address fallback matching for symbol drift.",
    impact: [
      "Auto-discovery added minimum APY/TVL filters and expanded protocol allowlist coverage",
      "Deterministic pool overrides introduced for hard-to-match symbols (including explicit safety bypass handling)",
      "findBestLendingPool now falls back to underlying token address matches when symbol matching fails",
      "Price-derived fallback explicitly extended to BUIDL when no usable on-chain or DL source exists",
    ],
    commits: ["d9bf617", "39f3f95", "2a45230", "ce2293d"],
    reconstructed: true,
  },
  {
    version: "3.2",
    title: "Inherited blacklistability alignment for inline safety scoring",
    date: "2026-03-02",
    effectiveAt: 1772459422,
    summary:
      "Yield sync safety scoring switched to shared blacklistability logic (including reserve inheritance), improving parity with report-card safety behavior.",
    impact: [
      "Resilience inputs in inline safety computation now use shared isBlacklistable() logic",
      "Risk penalties in PYS better reflect inherited blacklist exposure",
      "Reduced divergence between yield-page safety grades and safety-scores page outputs",
    ],
    commits: ["595f176"],
    reconstructed: true,
  },
  {
    version: "3.1",
    title: "Auto-discovery hardening and finite-math safeguards",
    date: "2026-03-01",
    effectiveAt: 1772386997,
    summary:
      "Post-launch hardening pass improved reliability of discovered yield rows and prevented non-finite volatility values from polluting persisted rankings.",
    impact: [
      "NAV tokens were included in inline safety scoring instead of defaulting to implicit NR behavior",
      "Yield sync now reuses cached DeFiLlama pools from DEX sync to reduce upstream fetch failures",
      "Non-finite 30-day APY volatility values are sanitized before D1 writes",
    ],
    commits: ["2e2a0aa", "9decd36", "4402307"],
    reconstructed: true,
  },
  {
    version: "3.0",
    title: "Automatic lending-opportunity discovery",
    date: "2026-03-01",
    effectiveAt: 1772380525,
    summary:
      "Yield Intelligence expanded beyond explicitly yield-bearing tokens by automatically discovering best lending pools for safer non-yield-bearing coins.",
    impact: [
      "Added allowlist-based auto-discovery pass over DeFiLlama lending pools",
      "Eligibility gated by safety score threshold before pool selection",
      "Introduced defillama-auto source type and lending-opportunity yield classification",
    ],
    commits: ["2b1a551"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Warning-signal telemetry and fxUSD native mapping",
    date: "2026-03-01",
    effectiveAt: 1772380127,
    summary:
      "Yield rows gained warning-signal state for anomaly detection, while deterministic pool coverage expanded with fxUSD native yield mapping.",
    impact: [
      "warning_signals persistence added with spike/divergence/trend/reward/TVL-outflow checks",
      "Signal detection now uses market-median APY and prior TVL context per coin",
      "Tier-2 deterministic source map added explicit fxUSD Stability Pool coverage",
    ],
    commits: ["dcdefde", "35f8021"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Wave-1 coverage expansion and numerical hardening",
    date: "2026-03-01",
    effectiveAt: 1772378501,
    summary:
      "Wave-1 expanded native/wrapper mappings and tightened core PYS stability math to avoid edge-case distortion.",
    impact: [
      "Added wave-1 variant/pool mappings for additional native-yield stablecoins",
      "Near-zero mean handling in stability/variance math prevents coefficient-of-variation blowups",
      "Safety fallback and finite-value guards were formalized for ranking writes",
    ],
    commits: ["f5ecd72", "6b327eb"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Launch-audit corrections for APY windowing and display",
    date: "2026-03-01",
    effectiveAt: 1772375700,
    summary:
      "Early launch audit corrected APY window semantics and cleaned up yield stability presentation/lookup behavior.",
    impact: [
      "7-day APY switched to timestamp-window filtering instead of proportional sample slicing",
      "Tier-1 previous exchange-rate reads were reused from cached lookup state",
      "Yield stability display normalized as a true 0-100 percentage in UI components",
    ],
    commits: ["873842c"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial Yield Intelligence release",
    date: "2026-03-01",
    effectiveAt: 1772370812,
    summary:
      "Launched Yield Intelligence schema, cron computation pipeline, API surface, and dashboard integration.",
    impact: [
      "Introduced three-tier APY resolution (on-chain rate, DeFiLlama pool, NAV price-derived fallback)",
      "Launched PYS model (risk penalty + variance sustainability multiplier + scaling factor)",
      "Added yield_data/yield_history tables and public yield-rankings/yield-history API handlers",
    ],
    commits: ["0709a1d", "569664e", "22695dc", "81ba632", "0e7b8b3"],
    reconstructed: true,
  },
  ],
});

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION = yieldMethodology.currentVersion;

/** Display-ready Yield Intelligence methodology version (with "v" prefix). */
export const YIELD_METHODOLOGY_VERSION_LABEL = yieldMethodology.versionLabel;

/** Public changelog route for Yield Intelligence methodology history. */
export const YIELD_METHODOLOGY_CHANGELOG_PATH = yieldMethodology.changelogPath;

/** Reconstructed changelog data. */
export const YIELD_METHODOLOGY_CHANGELOG = yieldMethodology.changelog;
