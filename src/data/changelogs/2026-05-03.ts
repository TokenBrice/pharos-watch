import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-27", to: "2026-05-03" },
  headline:
    "PharosVille v1 ships, frozen lifecycle lands with USR + BUCK archived, and a 10-phase audit remediation closes.",
  summary: [
    {
      label: "Pharosville v1",
      tag: "design",
      description:
        "Pharosville v1 launch: a pixel-art harbor where the Pharos data comes to life, with chains as harbors, stablecoins as ships, and DEWS alert tiers as sea zones.",
    },
    {
      label: "Frozen lifecycle",
      tag: "feature",
      description:
        "USR (Resolv) and BUCK become the first frozen archives. Frozen banner + chart footers, command-palette/compare/cemetery surfaces, OG/sitemap retention, cron writes excluded, PSI excludes frozen.",
    },
    {
      label: "Audit remediation: 10 phases",
      tag: "security",
      description:
        "Phases 2-10 close: refactor splits (env contracts, contagion graph, dex discovery, taxonomy, fallback, depeg), shell-safe git refs, validated D1 usage payloads, KYC blacklist hardening, Node 24 baseline.",
    },
    {
      label: "Per-coin catalog migration",
      tag: "infra",
      description:
        "Stablecoin metadata moves from monolithic JSON shells to per-coin files with a generated aggregate; loaders, docs, lifecycle references, and tests follow.",
    },
    {
      label: "Coverage and redemption modeling",
      tag: "coverage",
      description:
        "MYRC and KRWQ join coverage (MYR + KRW peg support); pmUSD gets a redemption backstop via sUSDS PSM; catalog refreshes after the crvUSD GHO PegKeeper update.",
    },
    {
      label: "Mint/burn cleanup + DEX resilience",
      tag: "infra",
      description:
        "Legacy mint/burn sync fallback removed, D1 rows-read cut, homepage events count chip restored via O(1) sqlite_sequence read; DEX liquidity degrades cleanly on source outages.",
    },
    {
      label: "Funding page polish",
      tag: "feature",
      description:
        "Funding KPI card now shows <1% donor share and prior-month coverage; 12 new donations from this week's funding-update sweep.",
    },
  ],
  stats: { totalCommits: 255 },
  commits: [
    { hash: "beb436d1", message: "feat(funding): show <1% and prior-month coverage in KPI card" },
    { hash: "f3e08d0e", message: "feat(promo): advertise PharosVille across pharos-watch surfaces" },
    { hash: "0f81e63f", message: "data(funding): add 12 new donation(s) via funding-update" },
    { hash: "e00f95ec", message: "fix(data): regenerate catalog after crvusd GHO PegKeeper update" },
    { hash: "a5d3a5ea", message: "fix(data): add sUSDS PSM mechanism dependency for pmUSD" },
    { hash: "635b562e", message: "feat(backstop): add pmUSD PSM redemption backstop (psm-swap via sUSDS)" },
    { hash: "75873892", message: "chore(deps): sync lockfile with worker viem/workers-types bumps (#105)" },
    { hash: "1e22d0b2", message: "fix(worker): degrade dex liquidity on source outages" },
    { hash: "e5c2ed43", message: "test: avoid gitleaks fixture false positives" },
    { hash: "891b20d5", message: "docs(changelog): record BUCK freeze" },
    { hash: "ad6398ab", message: "feat(stablecoin): freeze BUCK" },
    { hash: "9def4e4c", message: "fix admin stress signals" },
    { hash: "a767f7e7", message: "fix: avoid unnecessary worker promotion" },
    { hash: "309fed76", message: "chore: remove host pharosville surface" },
    { hash: "2028ad70", message: "chore: add pharosville api contract (#98)" },
    { hash: "327cb3c7", message: "chore: update runtime repo identity (#97)" },
    { hash: "30a78107", message: "chore: update repo links to pharos-watch" },
    { hash: "bd263546", message: "feat(pharosville): add ethereum harbor hub" },
    { hash: "c5e07e03", message: "docs(pharosville): document observatory revamp target and asset budget" },
    { hash: "acb0dbcb", message: "feat(pharosville): dense maritime observatory revamp with shoreline detail" },
  ],
};
