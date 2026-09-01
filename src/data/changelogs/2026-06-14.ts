import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-06-07", to: "2026-06-14" },
  headline:
    "Safety Score v8.0 folds in mint authority, report cards score chain and oracle risk, and a depeg control board ships.",
  fieldNotes:
    "The week's spine was scoring: mint authority finally counts toward decentralization in Safety Score v8.0, and report cards learned to weigh chain and oracle risk, each backed by on-chain verification rather than assertion. Around that, reserves and redemption gained real evidence, the depeg view became a working control board, and a long platform pass folded the app's tables and helpers into shared foundations. Plenty shipped; most of it quietly load-bearing.",
  summary: [
    {
      label: "Safety Score v8.0",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Mint authority joins the Decentralization factor as a penalty-only blend, backed by on-chain verification of the issuer registry. Caps now decay, multiple incidents are supported, and the score shows on coin pages.",
    },
    {
      label: "Chain & oracle risk",
      tag: "feature",
      href: "/methodology/chain-health-changelog/",
      description:
        "Report cards now fold in L2BEAT chain risk and CDP oracle risk, with new bridge-route and enriched oracle risk profiles. The Decentralization compute is deduped and now enforces oracle coverage.",
    },
    {
      label: "Reserves & redemption",
      tag: "coverage",
      description:
        "Reserve views ship for 11 active coins, eight more become evidence-bearing attestation feeds, and 30 redemption routes gain live reserve-sync capacity. Redemption reaches v4.11 with documented same-day buffers.",
    },
    {
      label: "Yield & compliance",
      tag: "coverage",
      href: "/methodology/yield-changelog/",
      description:
        "Yield coverage expands via the Wave 1 source-roster (v8.23), and GBP, JPY, and AUD benchmarks move to direct central-bank sources. A broad MiCA and GENIUS data pass refreshes compliance metadata across the registry.",
    },
    {
      label: "Depeg control board",
      tag: "feature",
      href: "/methodology/depeg-changelog/",
      description:
        "The depeg table becomes an interactive control board with filtering, sorting, and severity signals. Displayed deviation is now gated on peg-reference authority (DEWS v6.08), and repair-required events are quarantined.",
    },
    {
      label: "Verification passport",
      tag: "design",
      description:
        "The coin detail hero becomes a verification passport: visas for Issued, MiCA, GENIUS, and track record, and the contract wall becomes labeled rows with inline verify actions. An MRZ experiment was reverted.",
    },
    {
      label: "Search, a11y & performance",
      tag: "infra",
      description:
        "Per-chain OG cards ship for 107 chain pages, detail pages gain FAQ and Article JSON-LD, and a hydrated-state axe lane plus screen-reader tables raise accessibility. Critical CSS inlines and the CSP drops unsafe-eval.",
    },
    {
      label: "Platform consolidation",
      tag: "infra",
      description:
        "A shared table system replaces bespoke tables with common shells, controls, and skeletons. Code-health Waves 1 to 4 dedupe helpers, prune dead exports, name magic numbers, and tidy worker and scoring internals.",
    },
  ],
  stats: { totalCommits: 591 },
  commits: [
    { hash: "47dfa7a7", message: "chore(generated): refresh docs metadata" },
    { hash: "f3d419ca", message: "fix(worker): aggregate ftUSD on-chain supply" },
    { hash: "edac1e25", message: "fix(worker): track reUSD mints from token transfers" },
    { hash: "e553779b", message: "fix(dex): retain unsupported-chain Curve pools" },
    { hash: "18e5d4a6", message: "fix(worker): backfill Royco vault supply from chain" },
    { hash: "bcb52dea", message: "test(stablecoins): sync Royco static projections" },
    { hash: "3c49e10c", message: "chore(generated): refresh release metadata" },
    { hash: "f534cad3", message: "feat(stablecoins): add Royco eEARN and autoUSD" },
    { hash: "d67f7763", message: "docs: align config examples and data-flow map" },
    { hash: "62f2210f", message: "docs: align operator and status runbooks with source" },
    { hash: "f5c60d08", message: "test(gate): extend remaining load-sensitive timeouts" },
    { hash: "ce110d3c", message: "chore(generated): refresh docs metadata" },
    { hash: "5f82dcfa", message: "chore(generated): refresh sitemap dates" },
    { hash: "77dc6ba9", message: "chore(agent): add reusable Claude workflows" },
    { hash: "5d98e4db", message: "chore(ci): refresh validation baselines" },
    { hash: "e54f47cd", message: "fix(detail): align view model import and test timeouts" },
    { hash: "769e97d3", message: "fix(scripts): tolerate Bitstamp audit fetch failures" },
    { hash: "3f4eb977", message: "fix(worker): avoid coercing non-error objects" },
    { hash: "1408d629", message: "docs: sync audit findings with source" },
    { hash: "e3b93f6d", message: "docs: refresh code-health tracking" },
  ],
};
