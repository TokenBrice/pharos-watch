import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.9",
    title: "Publish-safe retention and deterministic adapter quarantine",
    date: "2026-03-24",
    effectiveAt: 1774310403,
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
    effectiveAt: 1774310402,
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
    effectiveAt: 1774310401,
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
    effectiveAt: 1774310400,
    summary:
      "Yield coverage widened through new deterministic Treasury fallbacks plus a broader but still curated lending auto-discovery set for long-tail assets.",
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
];
