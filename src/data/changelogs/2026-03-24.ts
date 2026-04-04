import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-03-17", to: "2026-03-24" },
  summary: [
    { label: "Broader coverage", description: "DUSD, USSD, USBD added, live reserves expanded to 114 coins" },
    { label: "Stronger pipelines", description: "Fewer data gaps across pricing, DEX liquidity, yield, and more" },
    { label: "Pre-launch asset pages", description: "Detail views, /upcoming, milestone tracking, and launch alerts" },
    { label: "Richer stablecoin pages", description: "Collateral context, rewritten summaries" },
    { label: "Cleaner UI", description: "Refined layouts, standardized charts, better tables and error states" },
    { label: "More visible risk reasoning", description: "PSI replay, DEX confidence signals, safety score calculator" },
    { label: "Reliability improvements", description: "Across crons, deploys, and test coverage" },
  ],
  stats: { totalCommits: 247 },
  commits: [
    { hash: "e423064", message: "fix(ci): pass API key to smoke-ui static export proxy" },
    { hash: "dc0cc73", message: "fix: make recordApiKeyAudit module-private" },
    { hash: "9cb783c", message: "feat(auth): enforce API key authentication on protected endpoints" },
  ],
};
