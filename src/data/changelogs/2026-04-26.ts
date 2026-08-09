import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-04-20", to: "2026-04-26" },
  headline:
    "Harbor and canal metaphors redraw /chains and /liquidity, public /api/* goes keyed-only, and tracked coverage hits 215.",
  summary: [
    {
      label: "Visualization metaphors",
      tag: "design",
      description:
        "/chains becomes a nautical harbor chart with ships scaled by supply, /liquidity turns into a canal with mitre lock gates and chain basins, and the PSI hero gets a lighthouse mini-scene.",
    },
    {
      label: "Alt-pegs world atlas",
      tag: "design",
      description:
        "Alt-pegs hub gains a docked world map with country-fill colors driven by peg taxonomy, a celestial band for Gold/Silver/CPI, fullscreen inspection mode, and a non-USD market structure route.",
    },
    {
      label: "Coverage and variants framework",
      tag: "coverage",
      description:
        "Tracked coverage grows from 191 to 215 across a flat RWA issuer batch, risk-wrapper assets, and a redemption-modeling pass; a new variants framework links wrappers to parents with inherited blacklist status.",
    },
    {
      label: "/api/* keyed-only",
      tag: "security",
      description:
        "Public /api/* lane is removed in favor of X-API-Key on every request; /_site-data/* is gated on Origin/Referer headers, with a tested 401 floor and a narrow exempt carve-out for feedback/og/health.",
    },
    {
      label: "Pipeline correctness hardening",
      tag: "infra",
      description:
        "Reserve/chart/yield-rankings cache validators, freshness sentinels, supply-history validation, malformed payload handling, abort-signal propagation, cron lane isolation, and onchain-only detail fallback.",
    },
    {
      label: "Tier 1 refactor wave",
      tag: "infra",
      description:
        "Repo-wide dedup: shared isRecord/CircuitRecord/admin-gates, GradeBadge and DetailSectionTitle primitives, error boundaries, dead layouts, retired legacy stablecoin routes, and frontend module splits.",
    },
  ],
  stats: { totalCommits: 423 },
  commits: [
    { hash: "458e143d", message: "fix(twitter): cap digest tweet at one cashtag" },
    { hash: "66dbb08c", message: "docs(lighthouse): handoff for the next agent picking up the work" },
    { hash: "0c75750c", message: "feat(lighthouse): wire phase 6 layers + relocate anchor; rebaseline" },
    { hash: "e21e46ca", message: "feat(lighthouse): boat aura wiring + resilience-tier structural variation" },
    { hash: "ce3ef672", message: "feat(lighthouse): denser starfield + moonpath glitter" },
    { hash: "a1253933", message: "feat(lighthouse): atmosphere — vignette, beam-on-water, horizon silhouettes" },
    { hash: "e391ab7c", message: "feat(lighthouse): fix off-screen harbours + 2x lighthouse + 2x boats" },
    { hash: "92f85b35", message: "docs(lighthouse): visual review + paletteRgba helper" },
    { hash: "e5c0f0cf", message: "chore(lighthouse): merge-gate fixups (CSR bailout, hotspot ratchet, doc paths)" },
    { hash: "49cdf235", message: "test(lighthouse): playwright visual regression under reduced-motion" },
    { hash: "5b9b7f03", message: "docs(lighthouse): retrospective + architecture deltas" },
    { hash: "ba4f065e", message: "feat(lighthouse): wire canvas 2d harbor scene end-to-end" },
    { hash: "4d3ea245", message: "feat(lighthouse): canvas 2d scene components (sky, water, lamps, sprites, layers)" },
    { hash: "f5cf3590", message: "feat(lighthouse): replace legacy routes with new shell + canvas placeholder" },
    { hash: "93341a87", message: "feat(lighthouse): unified sr-only a11y ledger" },
    { hash: "bb84f745", message: "chore(lighthouse): lint guard for hex literals outside palette" },
    { hash: "1dbc07d8", message: "fix(lighthouse): resolve type imports + use registry for boat-style flags" },
    { hash: "345e8f36", message: "feat(lighthouse): SceneData adapter (hooks-agnostic)" },
    { hash: "ea586829", message: "docs(lighthouse): fix plan inconsistencies discovered during phase 1" },
    { hash: "be4977d8", message: "feat(lighthouse): anchor 25-color palette + tint helpers" },
  ],
};
