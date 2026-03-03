/** Canonical Pharos Stability Index methodology version (no "v" prefix). */
export const PSI_METHODOLOGY_VERSION = "3.0";

/** Display-ready PSI methodology version (with "v" prefix). */
export const PSI_METHODOLOGY_VERSION_LABEL = `v${PSI_METHODOLOGY_VERSION}`;

/** Public changelog route for PSI methodology version history. */
export const PSI_METHODOLOGY_CHANGELOG_PATH = "/methodology/stability-index-changelog/";

export interface PsiMethodologyChangelogEntry {
  version: string;
  title: string;
  date: string; // YYYY-MM-DD
  effectiveAt: number; // Unix seconds (UTC)
  summary: string;
  scoreImpact: readonly string[];
  commits: readonly string[];
  reconstructed: boolean;
}

/**
 * Reconstructed PSI methodology timeline from git commit history.
 *
 * Notes:
 * - Effective timestamps use commit timestamps (UTC) of methodology-impacting changes.
 * - Entries marked reconstructed=true were inferred from commit history because PSI did
 *   not ship with an explicit changelog/version policy from day one.
 */
export const PSI_METHODOLOGY_CHANGELOG: readonly PsiMethodologyChangelogEntry[] = [
  {
    version: "3.0",
    title: "DEWS stress breadth component",
    date: "2026-03-01",
    effectiveAt: 1772379888,
    summary:
      "Added DEWS-derived stress breadth as an explicit PSI component to capture broad non-depeg stress.",
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
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
    scoreImpact: [
      "Initial formula: 100 - severity - breadth - freezes + trend",
      "Initial caps: severity 60, breadth 15, freezes 10",
      "Condition bands introduced",
    ],
    commits: ["c4c7caa", "c21a6bd", "5eaf440", "6b3e7e5", "a3f2b53"],
    reconstructed: true,
  },
] as const;

const PSI_VERSION_WINDOWS_ASC = [...PSI_METHODOLOGY_CHANGELOG]
  .map((entry) => ({ version: entry.version, effectiveAt: entry.effectiveAt }))
  .sort((a, b) => a.effectiveAt - b.effectiveAt);

/** Resolve PSI methodology version active at a given Unix timestamp (seconds). */
export function getPsiMethodologyVersionAt(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return PSI_METHODOLOGY_VERSION;

  let resolved = PSI_VERSION_WINDOWS_ASC[0]?.version ?? PSI_METHODOLOGY_VERSION;
  for (const window of PSI_VERSION_WINDOWS_ASC) {
    if (unixSeconds >= window.effectiveAt) {
      resolved = window.version;
    } else {
      break;
    }
  }
  return resolved;
}

export function toPsiMethodologyVersionLabel(version: string): string {
  return `v${version}`;
}
