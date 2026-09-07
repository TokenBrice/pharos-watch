import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-08-31", to: "2026-09-06" },
  headline:
    "Global navigation and the depeg route are rebuilt while the browser registry drops from 1.52 MB to 247 KB.",
  fieldNotes:
    "Most of the week went into what the browser downloads and how readers move through the site. The registry stopped shipping every coin's evidence to every list surface, detail pages moved to viewport-gated lanes, and seven watchdog crons collapsed into one sentinel. Navigation was rebuilt around a quick rail instead of nested accordions. V9 curation turned open questions into named controllers, then corrected two evaluator defects that had been scoring as missing evidence.",
  summary: [
    {
      label: "V9 evidence closures",
      tag: "feature",
      description:
        "Safety Score V9 moved 9.45 to 9.461: an external validator quorum now counts as a named authority, and evaluator defects on bridge joins and commodity exits were corrected without adding evidence.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Exact exit measurement",
      tag: "feature",
      description:
        "Liquidity Score 6.2 and 6.3 pin the LUSD/3Crv metapool for on-chain get_dy_underlying quotes and collapse Curve registry aliases by address; exact Uniswap V4 pool identities were recovered from DefiLlama.",
      href: "/methodology/liquidity-score-changelog/",
    },
    {
      label: "Navigation and depeg rebuild",
      tag: "design",
      description:
        "Global navigation became a quick rail plus four disclosure menus with real hover intent, mobile categories drill down instead of expanding accordions, and the depeg route was rebuilt around a signature hero.",
    },
    {
      label: "Lighter first load",
      tag: "infra",
      description:
        "The browser stablecoin registry split into a 247 KB list plus per-coin detail projections, down from 1.52 MB. The immutable shell separated from the interactive provider, and below-fold detail lanes now load on viewport.",
    },
    {
      label: "Worker cost diet",
      tag: "infra",
      description:
        "One cron sentinel replaced seven watchdog jobs, telemetry writes dropped to 60 second heartbeats, /api/health serves the 15-minute snapshot with operator fields on /api/status, and V9 capture bodies moved to R2.",
    },
    {
      label: "Digest publication",
      tag: "feature",
      description:
        "A quarantine registry stops a retracted daily claim from re-entering the weekly recap, editions moved to Opus 5 at a bounded ceiling for 36% less spend per day, and a watchdog covers Telegram media and the weekly X post.",
    },
    {
      label: "Coverage and pricing",
      tag: "coverage",
      description:
        "Pricing 6.215 added canonical sUSDS and sUSDe vault NAV coverage, redemption backstop 4.42 requires current depeg evidence for market-implied impairment, and Lisk, Asset Chain and Chiliz entered the chain registry.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "Repo gates and routing",
      tag: "infra",
      description:
        "One PR lane manifest feeds both check:pr and the GitHub workflow, coverage shards derive from import ownership, API reference sections generate from OpenAPI, and agent routing collapsed to 16 mappings.",
    },
  ],
  stats: { totalCommits: 187 },
  commits: [
    { hash: "c8c229c9", message: "fix(dex): publish measurement targets only after accepted liquidity" },
    { hash: "26c56988", message: "fix(status): reduce V9 projection allocation and expose probe progress" },
    { hash: "32272a49", message: "fix(cron): gate V9 shadow on a settled compiler identity" },
    { hash: "561f3262", message: "fix(pricing): preserve hourly observations through publication" },
    { hash: "358ee118", message: "fix(yield): retry transient D1 overload during retention" },
    { hash: "67aa84d6", message: "fix(reserves): recover verified reports and on-chain observations" },
    { hash: "d40058f3", message: "docs(safety-score): record remaining Maple NAV admission prerequisites" },
    { hash: "a7fa4998", message: "test(safety-score): verify the admitted XAUT custody review" },
    { hash: "9b5ba072", message: "docs(safety-score): accept 25 verified production fact closures" },
    { hash: "3371272c", message: "fix(safety-score): identify five Nest representation controllers" },
    { hash: "f9a98466", message: "docs(safety-score): preserve the parallel Backing review outcomes" },
    { hash: "5e185cb6", message: "fix(safety-score): record XAUT custody recovery limitations" },
    { hash: "71168d46", message: "fix(safety-score): identify remaining sfrxUSD representation controllers" },
    { hash: "dee44d5e", message: "fix(safety-score): pin BRL1 August reserves and custody evidence" },
    { hash: "40efb990", message: "test(safety-score): track the reviewed bridge-controller inventory" },
    { hash: "ff42c59b", message: "docs(safety-score): preserve bridge and exact-pool review outcomes" },
    { hash: "86d78ff1", message: "fix(dex): recover exact Uniswap V4 pool identities from DefiLlama" },
    { hash: "ce8710fc", message: "fix(safety-score): identify sfrxUSD bridge controllers on 19 chains" },
    { hash: "e889542a", message: "fix(reserves): admit AUDX's reviewed July assurance report" },
    { hash: "18b2566c", message: "docs(safety-score): record reviewed reduction campaign decisions" },
  ],
};
