import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-13", to: "2026-04-17" },
  headline:
    "UX/UI remediation: sharper copy, cleaner hierarchy, full scrollspy coverage, and a rebuilt detail hero.",
  summary: [
    {
      label: "Market Snapshot clarity",
      tag: "design",
      description:
        "Methodology tooltips on every snapshot cell (Total Mcap, Peg Status, DEX Volume, Net Mint/Burn), always-visible PSI 24h/7d/30d delta pills, semantic DEWS severity color, and a new Last-refreshed line beneath the card.",
    },
    {
      label: "Hero consolidation on detail pages",
      tag: "design",
      description:
        "Desktop hero no longer duplicates the Safety Score card — the right column is now a HeroSignalsRail (Safety, Peg, Liquidity, DEWS) that jumps to the real section anchors. Hero chips severity-ordered. Classification line promoted to three taxonomy pills.",
    },
    {
      label: "Complete scrollspy coverage",
      tag: "design",
      description:
        "LongformScrollspyNav now includes Price, Reserves, Flows, Yield, and a terminal Explore pill in addition to the existing Safety/Overview/Market/Liquidity/History set. All anchor ids stable.",
    },
    {
      label: "Explore Next rebalance",
      tag: "design",
      description:
        "Three columns at xl+ (Taxonomy | Trackers | Compare+Related), two at lg, stacked below with Compare first. Primary 'Open comparison' button with a secondary 'Read the one-page brief' text link. Related pills cap at 4 with a 'See all peers' overflow.",
    },
    {
      label: "Shared Breadcrumb + expanded command palette",
      tag: "design",
      description:
        "New src/components/breadcrumb.tsx shared primitive with aria-current on the last entry. Command palette adds Copy current URL, Open today's digest, Open methodology, and Open API docs alongside the existing theme toggle.",
    },
    {
      label: "Homepage section rhythm",
      tag: "design",
      description:
        "Zone bands get more contrast in dark mode. Peg Browse Strip ↔ Stablecoin Table rhythm increased. Daily Digest preview gets an orientation caption. Upcoming Stablecoins reframed as a Watchlist. Research Surfaces compacts Peg Diversity + Non-USD Share into a 2-col grid at lg+.",
    },
    {
      label: "Copy sharpening and microcopy",
      tag: "design",
      description:
        "New route-oriented masthead tagline (visible from md upward). Chip labels updated: FREEZABLE replaces BLACKLISTABLE on the detail hero, DEWS pill uses severity tokens, stale-data banner deduplicates the 'Affected:' line.",
    },
    {
      label: "Sidebar default + Telegram relocation",
      tag: "design",
      description:
        "TRACK group expanded by default; Telegram moved from PRIMARY_NAV_ITEMS into the TRACK group alongside Upcoming. Primary nav is now Dashboard, Stability Index, Safety Scores, Risk-Adjusted Yield.",
    },
    {
      label: "Design invariants regression test",
      tag: "infra",
      description:
        "New Vitest check guards against Newsreader/font-serif bleed into dashboard panels. Allowed carve-outs: AI summary on detail pages and the Digest surfaces.",
    },
  ],
  stats: { totalCommits: 18 },
  commits: [
    { hash: "3559c29c", message: "test(design): guard against Newsreader/serif bleed into dashboard panels" },
    { hash: "26f1766f", message: "polish(mobile): header tagline, radar label, stale banner dedupe" },
    { hash: "8eeff3ec", message: "feat(shell): breadcrumb component; expanded palette; TRACK default; Telegram move" },
    { hash: "57cadac6", message: "refactor(detail): rebalance Explore Next; clarify compare hierarchy" },
    { hash: "f6edc4f8", message: "feat(detail): complete scrollspy nav coverage" },
    { hash: "23981fcb", message: "refactor(detail): consolidate hero; severity-order chips; dedup flow tiles" },
    { hash: "8a235708", message: "refactor(home): tighten section transitions and research density" },
    { hash: "86fc0199", message: "feat(home): market snapshot tooltips, always-visible PSI deltas, semantic DEWS color" },
    { hash: "a91518e3", message: "fix(home): first-session callout sits above KPI bar at <lg" },
    { hash: "ca147946", message: "refactor(home): soften KPI snapshot dividers; align cell heights" },
    { hash: "5bd0879b", message: "refactor(home): elevate masthead tagline; expose at tablet widths" },
    { hash: "90ff0fa4", message: "refactor(homepage): remove residual abbreviations in mobile KPI tiles" },
    { hash: "71befd61", message: "refactor(detail): relabel blacklistable chip as freezable" },
    { hash: "4fa5921a", message: "refactor(detail): clarify DEWS signal chip" },
    { hash: "72c72407", message: "refactor(detail): annotate Bluechip rating badge" },
    { hash: "8b2627ea", message: "refactor(homepage): add tooltip clarifying peg status ratio" },
    { hash: "7fc3dc97", message: "refactor(homepage): clarify depeg/supply highlights copy" },
    { hash: "f8a77aec", message: "refactor(homepage): clarify KPI bar copy and units" },
  ],
};
