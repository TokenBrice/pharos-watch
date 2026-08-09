import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-13", to: "2026-04-19" },
  headline:
    "Pricing pipeline v5.0 lands, 40+ new risk-coverage entries across backstops/blacklist/reserves, and /funding launches.",
  summary: [
    {
      label: "Pricing pipeline v5.0",
      tag: "feature",
      description:
        "Every fetcher returns FetcherOutcome for breaker discipline, Curve/Chainlink staleness guards tighten, upstream-observed timestamps propagate from Bitstamp/Coinbase/Curve, and no-candidate circuit recovery generalizes.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "DEWS v5.95 contagion amplifier",
      tag: "feature",
      description:
        "Cross-asset contagion amplifier (clamped [1.0, 1.2]) joins the DEWS blend, a backtest harness validates detection rate + lead time on curated anchors, and /api/stress-signals surfaces amplifier breakdown.",
      href: "/methodology/depeg-changelog/",
    },
    {
      label: "Mint-burn flows v6.0",
      tag: "feature",
      description:
        "LayerZero/CCIP/CCTP bridges tag as bridge_transfer, atomic roundtrips require 0.5% tolerance, USDC and EURC get CCTP detection, and the Bank Run Gauge reweights by canonical-chain mcap rather than global supply.",
      href: "/methodology/mint-burn-flow-changelog/",
    },
    {
      label: "Redemption backstops v3.99",
      tag: "coverage",
      description:
        "Adds the flat/RWA issuer batch (USDon, USDsui, BRLV, USDGLO, AUDM, Alloy aUSDT) on top of the prior route expansion, capacity clamping to supply, fee-score breakpoints, and documented fail-closed fallbacks for falcon/frxusd.",
      href: "/methodology/",
    },
    {
      label: "Blacklist tracker v3.91 → v3.95",
      tag: "coverage",
      description:
        "14+ new coins (FIDD, FRXUSD, XUSD, JPYC, USDA/USAT/AEUR, EURCV, NUSD, TUSD, USDP, USDQ, AID, TGBP). Tron ledger mirror, EURC mirror-zero suppression fix, and a new per-coin detail block with stats, chart, and event feed.",
      href: "/methodology/blacklist-tracker-changelog/",
    },
    {
      label: "Reserves + Liquidity v5.4 + cron hygiene",
      tag: "infra",
      description:
        "10+ new reserve adapters (lisusd-lista, ebusd, mim-abracadabra, usdh, usdat-saturn, buck, buidl-chainlink-nav); Liquidity v5.4 pool dedupe + direct-CEX orderbook depth; cron retuned (reserves 1h→4h, blacklist 1h→6h).",
      href: "/methodology/liquidity-score-changelog/",
    },
    {
      label: "Digest on Opus 4.7 + Telegram /status",
      tag: "feature",
      description:
        "Daily digest streams from Opus 4.7 with week-over-week deltas, Momentum Candidates, forward-look cue, and opening/tone guards. Telegram adds /status <ticker>, snooze inline keyboard, and worsening-delta depeg triggers.",
    },
    {
      label: "Detail-page UX remediation",
      tag: "design",
      description:
        "Detail hero consolidated with HeroSignalsRail (Safety/Peg/Liquidity/DEWS), full scrollspy nav coverage, shared Breadcrumb + expanded command palette, and home snapshot gets methodology tooltips + always-visible PSI deltas.",
    },
  ],
  stats: { totalCommits: 680 },
  commits: [
    { hash: "f1fe6aed", message: "docs: reconcile loop 3 audit findings" },
    { hash: "a979e0ae", message: "docs: reconcile loop 2 audit findings" },
    { hash: "f6a9f74f", message: "docs: reconcile loop 1 audit findings" },
    { hash: "6824fa3a", message: "docs: resolve final verification drift" },
    { hash: "2d277420", message: "docs: deepen documentation source alignment" },
    { hash: "5ded1e10", message: "docs: reconcile project documentation with code" },
    { hash: "42a2a8f1", message: "fix(status): align freshness budgets with cron cadence" },
    { hash: "7eafc7d9", message: "fix(reserves): include pendingUsdc in OpenEden component-total validation" },
    { hash: "059aedeb", message: "docs: audit and correct project documentation (#84)" },
    { hash: "2f64fe58", message: "docs(ops): document WAF rate-limiting rule for api.pharos.watch (#83)" },
    { hash: "03c41ad8", message: "docs: run second verification pass" },
    { hash: "d8fd0bc3", message: "chore(worker): bump compatibility_date to 2026-04-18 (#82)" },
    { hash: "b6ec63b4", message: "docs: keep methodology copy within hotspot budget" },
    { hash: "601d5384", message: "/agents/ cleanup" },
    { hash: "9367d179", message: "docs: update route contracts and agent map" },
    { hash: "680a1fbf", message: "docs: refresh methodology and data model docs" },
    { hash: "2614b046", message: "docs: align api and operations references" },
    { hash: "90381e15", message: "review-followup(detail-blacklist): render empty-chart hint, fix skeleton height, expand test coverage" },
    { hash: "ec4db767", message: "docs: document detail-page blacklist block and new summary fields" },
    { hash: "62be8b38", message: "feat(detail): add per-coin blacklist activity block with stats, chart, and feed" },
  ],
};
