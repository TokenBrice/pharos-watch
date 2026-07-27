export const CAPABILITY_STATES = [
  "unreviewed",
  "incubating",
  "invest",
  "maintain",
  "consolidate",
  "retiring",
  "retired",
] as const;

export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export interface CapabilityDefinition {
  id: string;
  name: string;
  purpose: string;
  strategicRationale: string;
  routes: string[];
  codePaths: string[];
  analyticsEvents: string[];
  apiRoutes: string[];
  cronJobs: string[];
  decision: {
    state: CapabilityState;
    reviewedAt: string | null;
    reviewAfter: string;
    rationale: string;
  };
}

const INITIAL_REVIEW = {
  state: "unreviewed" as const,
  reviewedAt: null,
  reviewAfter: "2026-07-19",
  rationale: "Initial lifecycle review pending; no owner decision has been recorded yet.",
};

export const CAPABILITY_REGISTRY: readonly CapabilityDefinition[] = [
  {
    id: "stablecoin-core",
    name: "Stablecoin core",
    purpose: "Maintain the canonical stablecoin directory, profiles, taxonomy, screener, and core market context.",
    strategicRationale:
      "This is Pharos's foundational public data surface. Usage informs investment priorities, but low traffic alone cannot justify retirement.",
    routes: ["/", "/stablecoin/", "/stablecoins/", "/screener/"],
    codePaths: [
      "src/app/page.tsx",
      "src/app/stablecoin",
      "src/app/stablecoins",
      "src/app/screener",
      "src/components/stablecoin-detail",
      "shared/lib/supply.ts",
    ],
    analyticsEvents: ["contract_copied"],
    apiRoutes: ["stablecoins", "peg-summary", "supply-history"],
    cronJobs: [
      "sync-stablecoins",
      "sync-stablecoin-charts",
      "sync-fx-rates",
      "snapshot-supply",
      "snapshot-chain-supply",
    ],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "depeg-monitoring",
    name: "Depeg monitoring",
    purpose: "Detect, explain, and archive depegs through the tracker, DEWS, resolver, and event history.",
    strategicRationale:
      "Live stability monitoring is a core trust and safety promise, so reliability and evidence quality matter alongside audience size.",
    routes: ["/depeg/"],
    codePaths: [
      "src/app/depeg",
      "src/components/depeg-control-board.tsx",
      "src/components/depeg-feed.tsx",
      "src/components/depeg-history.tsx",
      "src/components/depeg-tracker-table.tsx",
      "src/components/dews-detail.tsx",
      "worker/src/cron/depeg-detection",
      "worker/src/cron/dews",
      "worker/src/cron/compute-dews.ts",
      "worker/src/cron/compute-depeg-resolver.ts",
      "worker/src/api/depeg-events.ts",
      "worker/src/api/depeg-resolver.ts",
    ],
    analyticsEvents: [],
    apiRoutes: ["depeg-events", "events", "stress-signals"],
    cronJobs: ["compute-dews", "compute-depeg-resolver"],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "safety-scores",
    name: "Safety Scores",
    purpose: "Publish evidence-backed stablecoin risk assessments, histories, and systemic stress analysis.",
    strategicRationale:
      "Safety assessment is a major Pharos differentiator and public-interest surface; methodology integrity outweighs raw traffic.",
    routes: ["/safety-scores/"],
    codePaths: [
      "src/app/safety-scores",
      "shared/lib/safety-score-v9",
      "shared/data/safety-score-v9",
      "worker/src/cron/prepare-safety-score-v9-input.ts",
      "worker/src/cron/snapshot-safety-grade-history.ts",
      "worker/src/api/report-cards-v9.ts",
    ],
    analyticsEvents: ["stress_test_run"],
    apiRoutes: ["report-cards"],
    cronJobs: ["prepare-safety-score-v9-input", "compute-safety-score-v9", "snapshot-safety-grade-history"],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "yield-liquidity",
    name: "Yield and liquidity intelligence",
    purpose:
      "Help users evaluate stablecoin yield opportunities, exit liquidity, source risk, and historical outcomes.",
    strategicRationale:
      "This is a decision-oriented product surface with meaningful differentiation, but it carries a large provider and maintenance footprint.",
    routes: ["/yield/", "/liquidity/", "/stablecoin/*/yield/"],
    codePaths: [
      "src/app/yield",
      "src/app/liquidity",
      "shared/lib/yield-scoring.ts",
      "worker/src/cron/yield-sync",
      "worker/src/cron/dex-discovery",
      "worker/src/cron/dex-liquidity",
      "worker/src/cron/sync-yield-data.ts",
      "worker/src/cron/sync-yield-supplemental.ts",
    ],
    analyticsEvents: ["yield_row_action", "yield_exported"],
    apiRoutes: ["yield-rankings", "yield-history", "dex-liquidity"],
    cronJobs: [
      "sync-dex-discovery",
      "sync-cl-exit-depth",
      "sync-dex-liquidity",
      "sync-yield-data",
      "sync-yield-supplemental",
      "fetch-tbill-rate",
      "yield-coverage-audit",
    ],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "compare-portfolio",
    name: "Compare and portfolio",
    purpose: "Support side-by-side stablecoin analysis, saved holdings, presets, exports, and sharing.",
    strategicRationale:
      "These are high-intent decision tools whose value should be judged by completed actions rather than pageviews alone.",
    routes: ["/compare/", "/portfolio/"],
    codePaths: [
      "src/app/compare",
      "src/app/portfolio",
      "src/lib/compare-config.ts",
      "src/lib/compare-derive.ts",
      "src/lib/compare-pages.ts",
      "src/lib/compare-selection-insights.ts",
      "src/lib/portfolio-codec.ts",
    ],
    analyticsEvents: ["comparison_created", "comparison_exported", "portfolio_coin_added", "portfolio_shared"],
    apiRoutes: [],
    cronJobs: [],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "compliance-controls",
    name: "Compliance and control monitoring",
    purpose: "Track regulatory posture, freeze authority, blacklist interventions, and issuer control evidence.",
    strategicRationale:
      "This is a public-interest transparency capability; search demand and evidence coverage are more relevant than frequent repeat interaction.",
    routes: ["/compliance/", "/freezewatch/", "/blacklist/"],
    codePaths: [
      "src/app/compliance",
      "src/app/freezewatch",
      "src/app/blacklist",
      "src/components/freezewatch",
      "worker/src/cron/blacklist",
      "worker/src/cron/sync-blacklist.ts",
      "worker/src/api/blacklist.ts",
      "worker/src/api/blacklist-summary.ts",
    ],
    analyticsEvents: [],
    apiRoutes: ["blacklist"],
    cronJobs: ["sync-blacklist"],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "flows-stability",
    name: "Flows and Stability Index",
    purpose: "Explain mint and burn activity, supply flows, and aggregate stablecoin market stability.",
    strategicRationale:
      "The capability connects market-level monitoring to asset-level issuance evidence and supports external API consumers.",
    routes: ["/flows/", "/stability-index/"],
    codePaths: [
      "src/app/flows",
      "src/app/stability-index",
      "src/lib/mint-burn-timeframes.ts",
      "worker/src/cron/stability-index.ts",
      "worker/src/cron/sync-mint-burn.ts",
      "worker/src/cron/mint-burn-growth-watchdog.ts",
      "worker/src/api/mint-burn-events.ts",
      "worker/src/api/mint-burn-flows.ts",
      "worker/src/api/stability-index.ts",
    ],
    analyticsEvents: [],
    apiRoutes: ["stability-index", "mint-burn-flows", "mint-burn-events"],
    cronJobs: [
      "stability-index",
      "sync-mint-burn",
      "sync-mint-burn-extended",
      "snapshot-psi",
      "mint-burn-growth-watchdog",
    ],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "telegram",
    name: "Telegram bot",
    purpose: "Deliver personalized stablecoin monitoring, watchlists, alerts, recaps, and mini-app controls.",
    strategicRationale:
      "Telegram is Pharos's retained-alert distribution surface and should be evaluated on activation, retention, and delivery reliability.",
    routes: ["/pharoswatchbot/"],
    codePaths: [
      "src/app/pharoswatchbot",
      "worker/src/api/telegram-store",
      "worker/src/cron/telegram-pending",
      "worker/src/cron/dispatch-telegram-alerts.ts",
      "worker/src/cron/telegram-recap-planner.ts",
      "worker/src/api/telegram-webhook.ts",
    ],
    analyticsEvents: [],
    apiRoutes: [],
    cronJobs: [
      "dispatch-telegram-alerts",
      "telegram-personalized-recap-planner",
      "telegram-degradation-watchdog",
      "telegram-disambiguation-cleanup",
      "telegram-pulse-snapshot",
      "telegram-inactive-cleanup",
      "telegram-retention-cleanup",
    ],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "public-api",
    name: "Public API",
    purpose: "Provide stable, documented machine access to Pharos data with self-serve key issuance.",
    strategicRationale:
      "The API supports external integrations and amplifies every product data surface beyond website traffic.",
    routes: ["/api/", "/about/api/"],
    codePaths: [
      "src/app/api",
      "src/app/about/api",
      "src/lib/api-key-self-serve.ts",
      "shared/lib/api-endpoints",
      "worker/src/api/api-key-requests",
      "worker/src/api/api-keys.ts",
    ],
    analyticsEvents: [],
    apiRoutes: [
      "stablecoins",
      "depeg-events",
      "events",
      "supply-history",
      "report-cards",
      "stability-index",
      "peg-summary",
      "stress-signals",
      "yield-rankings",
      "yield-history",
    ],
    cronJobs: [],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "upcoming",
    name: "Upcoming stablecoins",
    purpose: "Track pre-launch stablecoins, milestone progress, and promotion into active coverage.",
    strategicRationale:
      "Early launch intelligence extends Pharos beyond retrospective tracking and feeds launch-alert workflows.",
    routes: ["/upcoming/"],
    codePaths: ["src/app/upcoming", "src/components/upcoming-client.tsx", "src/components/upcoming-horizon-hero.tsx"],
    analyticsEvents: [],
    apiRoutes: [],
    cronJobs: [],
    decision: { ...INITIAL_REVIEW },
  },
  {
    id: "learning-content",
    name: "Learning content",
    purpose: "Explain stablecoin mechanisms, terminology, and historical failures through durable editorial content.",
    strategicRationale:
      "Educational content builds search discovery and makes Pharos methodology understandable to non-specialist users.",
    routes: ["/learn/"],
    codePaths: ["src/app/learn"],
    analyticsEvents: [],
    apiRoutes: [],
    cronJobs: [],
    decision: { ...INITIAL_REVIEW },
  },
] as const;
