import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-06-22", to: "2026-06-28" },
  headline:
    "A redesigned homepage and global top-nav with a new Whyte typeface, plus a worker-hardening rollout and reserve work.",
  fieldNotes:
    "The week's most visible change is the front door: the sidebar gives way to a product-intent global top-nav, and the homepage is rebuilt around a dashboard workbench with compact tables and a tighter Market Pulse. A new Whyte typeface and flat, unified shells set the tone. Beneath the surface, the harder work was structural: the worker pipeline gained a job ledger and repair runner, a brittle reserve feed was retired, and benchmark and price sources got failover.",
  summary: [
    {
      label: "Homepage & nav redesign",
      tag: "design",
      description:
        "A global top-nav replaces the retired sidebar and the homepage is rebuilt around a dashboard workbench with compact tables and a tighter Market Pulse, set in a new Whyte display typeface with flat, unified card shells.",
    },
    {
      label: "Worker hardening rollout",
      tag: "infra",
      description:
        "A structural worker-hardening rollout adds a job-attempt ledger and gated repair runner, per-provider execution budgets, tighter cron-lease observability, and a status page exposing canary counts and dependency health.",
    },
    {
      label: "Reserve feed integrity",
      tag: "infra",
      description:
        "The usdo-openeden live feed is suspended after its issuer gateway blocked Worker egress, falling back to curated data; a stale AZND source is removed and live-reserve finalization is bounded under the cron cap.",
    },
    {
      label: "Exit liquidity & redemption",
      tag: "feature",
      href: "/methodology/liquidity-score-changelog/",
      description:
        "Tier 1+2 redemption-backstop confidence upgrades land, Morpho and Yearn V3 vaults gain exit-capacity telemetry, and inactive DEX pools are excluded from global liquidity scoring so depth reflects only live venues.",
    },
    {
      label: "Benchmark & price resilience",
      tag: "infra",
      href: "/methodology/pricing-pipeline-changelog/",
      description:
        "The GBP SONIA benchmark fails over to the FRED IUDZOS2 mirror with an ALFRED fallback, USD EFFR source order is hardened, and backfill and mint-burn heal stale commodity prices and null amounts from history.",
    },
    {
      label: "Methodology & data corrections",
      tag: "coverage",
      description:
        "A scoring-weighted doc-vs-code audit corrects drift across the corpus, sUSD is frozen for SIP-423, AUSD and msUSD reserve summaries are fixed, and the pre-launch board refreshes with trUSD's live mainnet contracts.",
    },
  ],
  stats: { totalCommits: 247 },
  commits: [
    { hash: "7533c27b", message: "data: weekly pre-launch update (2026-06-28)" },
    { hash: "19f83918", message: "fix(worker): harden fetch body timeout coverage" },
    { hash: "43b42dee", message: "fix(worker): scope DEX canary to latest publication" },
    { hash: "d90c0167", message: "chore(data): refresh public stablecoin artifacts" },
    { hash: "3c6f1e12", message: "chore(stablecoins): refresh curated coin metadata" },
    { hash: "7717d69e", message: "chore: refresh generated release metadata" },
    { hash: "5a36243f", message: "chore: enable worker hardening shadow telemetry" },
    { hash: "36c9fca3", message: "chore: fix discovery gate findings" },
    { hash: "98b1817f", message: "docs: clarify display font token resolution note" },
    { hash: "889d4eaf", message: "chore: refresh generated metadata timestamps" },
    { hash: "9a08304b", message: "style: enforce body-scoped display font token" },
    { hash: "8193ae0a", message: "docs: align typography documentation with Whyte font rollout" },
    { hash: "082991da", message: "chore: update sitemap route timestamps" },
    { hash: "1fcdcbda", message: "style: standardize editorial typography classes" },
    { hash: "7ec87ad4", message: "feat(font): add Whyte install path and display font plumbing" },
    { hash: "f8181fa8", message: "Tune contagion graph shell baseline" },
    { hash: "eb4b88ef", message: "Simplify card and control styling tokens" },
    { hash: "9e2c7a0f", message: "Standardize flow visual components" },
    { hash: "376c7a3f", message: "Refine start-here page surfaces" },
    { hash: "368b6f7b", message: "Harmonize shared component visual shells" },
  ],
};
