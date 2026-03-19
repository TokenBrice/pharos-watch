import { createMethodologyVersion } from "./methodology-version";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "1.1",
  changelogPath: "/methodology/#safety-scores-methodology",
  changelog: [
    {
      version: "1.1",
      title: "Fee-source coverage expansion",
      date: "2026-03-20",
      effectiveAt: 1773961200,
      summary:
        "Expanded redemption-fee coverage with docs-backed fixed fees, conditional fee descriptions, and clearer handling of issuer routes without a single public fee schedule.",
      impact: [
        "Redemption backstop entries now expose a fee description alongside bounded fee bps when available",
        "Multiple assets now carry docs-backed fixed fee inputs instead of generic unknown-fee handling",
        "Routes without a single public numeric fee now surface explicit variable or undisclosed fee descriptions instead of false precision",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "1.0",
      title: "Initial redemption backstop scoring",
      date: "2026-02-28",
      effectiveAt: 1772272800,
      summary:
        "First operational release of the redemption backstop scoring framework with effective-exit assessment.",
      impact: [
        "Introduced per-stablecoin redemption route configs with access, settlement, execution, and output-asset scoring",
        "Effective-exit score combined capacity utilization with weighted route-family scores",
        "Report card safety dimension now includes redemption backstop component",
      ],
      commits: [],
      reconstructed: true,
    },
  ],
});

/** Canonical Redemption Backstop methodology version (no "v" prefix). */
export const REDEMPTION_BACKSTOP_VERSION = redemptionBackstop.currentVersion;

/** Display-ready Redemption Backstop methodology version (with "v" prefix). */
export const REDEMPTION_BACKSTOP_VERSION_LABEL = redemptionBackstop.versionLabel;

/** Public methodology route for Redemption Backstop methodology. */
export const REDEMPTION_BACKSTOP_METHODOLOGY_PATH = redemptionBackstop.changelogPath;

/** Resolve Redemption Backstop methodology version active at a given Unix timestamp (seconds). */
const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;
