import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-07-27", to: "2026-08-02" },
  headline:
    "Safety Score V9 goes live with mechanism-backed coin pages, a wave-7/8 evidence drain, and five new FX pegs.",
  fieldNotes:
    "The V9 safety model finally left the shadows: it became the active score, the preview scaffolding came down, and coin pages now explain each grade by naming the evidence and the party responsible for it. Behind that visible change sat weeks of unglamorous drainage — dozens of mechanism packets verified across vendors, DEX pipelines bounded to their memory budgets, and publication taught to hold rather than guess when an input goes dark.",
  summary: [
    {
      label: "V9 goes live",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Safety Score V9 is now the active production model. Shadow scoring is retired, the frontend reads the typed V9 payload, and the V9.0 release ships with published V9.02 responsibility rules for evidence ownership.",
    },
    {
      label: "Explainable coin pages",
      tag: "design",
      description:
        "Coin pages now justify each score with causal attribution and evidence ownership, surface mechanism-review findings inline, and give pillar breakdowns clearer hierarchy plus a new collateralization module.",
    },
    {
      label: "Mechanism evidence drain",
      tag: "coverage",
      href: "/methodology/scoring-changelog/",
      description:
        "Wave-7 and wave-8 research landed 42 new mechanism overlays and drained a 41-item integration tail, each cross-verified across vendors (GROK, KIMI) and ratified against a documented mechanism-overlay evidence standard.",
    },
    {
      label: "DEX execution reliability",
      tag: "infra",
      href: "/methodology/liquidity-score-changelog/",
      description:
        "Exact-exit measurement expanded to Optimism, Balancer, and pinned Solana CLMM, while DEX staging was bounded to its memory budget via chunked transactions, amortized persistence, and recovered UniV4 and SunSwap batches.",
    },
    {
      label: "Fail-closed publication",
      tag: "infra",
      description:
        "Publication now holds rather than guesses — V9 input is skipped after a failed DEX stage, producer holds baseline by identity, transition caches survive rollout, and report-card failures stay isolated to one asset.",
    },
    {
      label: "Wider coverage",
      tag: "coverage",
      href: "/methodology/depeg-resolver-changelog/",
      description:
        "The FX peg feed added KES, GHS, COP, CLP, and PEN; DDRv4 shipped for depeg-duration resolution; and coverage grew with the XOFm Mento redemption backstop, DUSD Makina reserves, and CHFAU aggregate on-chain supply.",
    },
    {
      label: "Pipeline hardening",
      tag: "infra",
      description:
        "CI moved from exhaustive PR validation to adaptive checks, 156 D1 migrations were squashed into the baseline, drift checks were calibrated against live Cloudflare, and the new Pharos logo rolled to production.",
    },
  ],
  stats: { totalCommits: 181 },
  commits: [
    { hash: "eefa5435", message: "Cut the in-flow mechanism review to a lead and use the full card width (#770)" },
    { hash: "ee052da7", message: "Fix stale report-card publication guard" },
    { hash: "5999720c", message: "Roll new Pharos logo to production (#768)" },
    { hash: "fd8b0494", message: "fix(deps): unblock Pages build after Radix Slot update" },
    { hash: "318b1f60", message: "Batch security integrity fixes and dependency updates (#766)" },
    { hash: "9042c478", message: "Release wave-2 unknown-reduction: research curation, overlay drain, producer activation, control-path admission (#761)" },
    { hash: "e88a9485", message: "Release DUSD tracking enhancement (#758)" },
    { hash: "e9380c8a", message: "Release DDRv4 (#757)" },
    { hash: "c7c01fe1", message: "Require only the single edge rate-limit rule the plan provides (#756)" },
    { hash: "5ea2d360", message: "Squash D1 migrations 0072-0227 into the baseline (#755)" },
    { hash: "7efe77bf", message: "Ratify live Cloudflare posture in the drift manifest (#754)" },
    { hash: "42963816", message: "Calibrate account-state drift checker against live Cloudflare (#752)" },
    { hash: "cee591b2", message: "Log post-deploy acceptance probe results (#751)" },
    { hash: "b498f2bf", message: "Release V9 decomposition and reliability hardening (#750)" },
    { hash: "4be32c16", message: "Release local state to production (#745)" },
    { hash: "99c5e9a6", message: "Release local state to production" },
    { hash: "03f042d3", message: "Complete DUSD V9 mechanism evidence (#742)" },
    { hash: "36c94f8c", message: "Release DUSD Makina reserve coverage (#741)" },
    { hash: "07a12d03", message: "Release JSON-LD and protocol refresh follow-up" },
    { hash: "6fefe92f", message: "Release V9 finalization batch" },
  ],
};
