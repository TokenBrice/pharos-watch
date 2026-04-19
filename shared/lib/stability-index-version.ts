import { createMethodologyVersion } from "./methodology-version";

const psi = createMethodologyVersion({
  currentVersion: "3.2",
  changelogPath: "/methodology/stability-index-changelog/",
  changelog: [
  {
    version: "3.2",
    title: "Fail-closed depeg input availability",
    date: "2026-03-23",
    effectiveAt: 1774256400,
    summary:
      "PSI no longer publishes a fresh sample when the active-depeg input query is unavailable, preventing false continuity from an incomplete core dependency.",
    impact: [
      "The 30-minute cron now returns degraded and skips the sample when `depeg_events` cannot be queried",
      "Only already-open depegs missing a current stablecoins price may use the replay-safe `price_cache` fallback; table-level depeg input loss is no longer treated as an empty event set",
      "Public PSI remains anchored to the last valid stored sample instead of silently publishing from partial core inputs",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.1",
    title: "Open-depeg replay-price fallback",
    date: "2026-03-23",
    effectiveAt: 1774224000,
    summary:
      "Active depegs now stay in PSI when the current stablecoins snapshot temporarily loses a usable price but a recent replay-safe price-cache entry still exists.",
    impact: [
      "Severity and breadth now fall back to the last replay-safe positive `price_cache` value for already-open depegs when the current stablecoins snapshot price is missing",
      "Replay fallback is capped to recent cache entries (6-hour TTL) rather than unbounded historical prices",
      "Prevents transient contributor/sample omissions during price-validation churn without changing the PSI formula, caps, or bands",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.0",
    title: "DEWS stress breadth component",
    date: "2026-03-01",
    effectiveAt: 1772379888,
    summary:
      "Added DEWS-derived stress breadth as an explicit PSI component to capture broad non-depeg stress.",
    impact: [
      "Formula changed to: 100 - severity - breadth - stressBreadth + trend",
      "New stressBreadth cap of 5 points",
      "Cron now reads latest DEWS bands (ALERT/WARNING/DANGER) to derive stress breadth",
    ],
    commits: ["dcdefde"],
    reconstructed: true,
  },
  {
    version: "2.1",
    title: "Trend hardening and retention safety",
    date: "2026-02-27",
    effectiveAt: 1772186337,
    summary:
      "Hardened trend input handling and operationalized rolling retention for PSI samples.",
    impact: [
      "NaN/Infinity trend values now treated as 0 before clamp",
      "No formula change, but edge-case score corruption prevented",
      "Sample retention/pruning standardized to 90 days",
    ],
    commits: ["76aa8c6", "74aa1cd"],
    reconstructed: true,
  },
  {
    version: "2.0",
    title: "Removed freezes, rebalanced caps",
    date: "2026-02-26",
    effectiveAt: 1772069915,
    summary:
      "Major methodology revision removing freezes and reallocating penalty capacity.",
    impact: [
      "Removed freezes component from formula",
      "Severity cap increased 60 -> 68",
      "Breadth cap increased 15 -> 17",
      "Formula became: 100 - severity - breadth + trend",
    ],
    commits: ["bc2cfcf"],
    reconstructed: true,
  },
  {
    version: "1.3",
    title: "Sample architecture and 24h average model",
    date: "2026-02-26",
    effectiveAt: 1772066100,
    summary:
      "PSI moved to sample-first storage with daily snapshots and 24h average surfaced as the primary displayed signal.",
    impact: [
      "Introduced stability_index_samples table and daily snapshot aggregation",
      "API and UI switched to emphasize 24h average PSI",
      "Historical backfill path adjusted for peak-deviation realism",
    ],
    commits: ["9508e29", "ad75f4f"],
    reconstructed: true,
  },
  {
    version: "1.2",
    title: "15-minute chained compute + depeg depreciation/dedup",
    date: "2026-02-25",
    effectiveAt: 1772057625,
    summary:
      "Operational and methodological upgrade to live 15-minute PSI with chronic-depeg depreciation and per-coin deduplication.",
    impact: [
      "PSI compute moved to chained 15-minute cron after stablecoin sync",
      "Introduced chronic-depeg depreciation (grace 30d, decay 120d, floor 25%)",
      "Active depegs deduped per coin (worst current bps, earliest start for age)",
    ],
    commits: ["8acaa7d", "a79049d", "2dfb975", "615256a"],
    reconstructed: true,
  },
  {
    version: "1.1",
    title: "Current deviation semantics",
    date: "2026-02-25",
    effectiveAt: 1772039501,
    summary:
      "Severity began using live current deviation rather than event peak deviation for active depegs.",
    impact: [
      "Live severity became recovery-sensitive instead of peak-anchored",
      "Backfill behavior later diverged and was subsequently tuned",
    ],
    commits: ["14c75e7"],
    reconstructed: true,
  },
  {
    version: "1.0",
    title: "Initial PSI release",
    date: "2026-02-25",
    effectiveAt: 1772012043,
    summary:
      "Launched PSI compute, API, cron persistence, and frontend integration.",
    impact: [
      "Initial formula: 100 - severity - breadth - freezes + trend",
      "Initial caps: severity 60, breadth 15, freezes 10",
      "Condition bands introduced",
    ],
    commits: ["c4c7caa", "c21a6bd", "5eaf440", "6b3e7e5", "a3f2b53"],
    reconstructed: true,
  },
  ],
});

/** Canonical PSI methodology version (no "v" prefix). */
export const PSI_METHODOLOGY_VERSION = psi.currentVersion;

/** Display-ready PSI methodology version (with "v" prefix). */
export const PSI_METHODOLOGY_VERSION_LABEL = psi.versionLabel;

/** Public changelog route for PSI methodology history. */
export const PSI_METHODOLOGY_CHANGELOG_PATH = psi.changelogPath;

/** Reconstructed changelog data. */
export const PSI_METHODOLOGY_CHANGELOG = psi.changelog;

/** Resolve PSI methodology version active at a given Unix timestamp (seconds). */
export const getPsiMethodologyVersionAt = psi.getVersionAt;
