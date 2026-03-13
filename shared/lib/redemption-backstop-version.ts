import { createMethodologyVersion } from "./methodology-version";

const redemptionBackstop = createMethodologyVersion({
  currentVersion: "1.0",
  changelogPath: "/methodology/#safety-scores",
  changelog: [
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

/** Reconstructed changelog data. */
export const REDEMPTION_BACKSTOP_CHANGELOG = redemptionBackstop.changelog;

/** Resolve Redemption Backstop methodology version active at a given Unix timestamp (seconds). */
export const getRedemptionBackstopVersionAt = redemptionBackstop.getVersionAt;
