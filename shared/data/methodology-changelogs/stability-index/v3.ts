import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const STABILITY_INDEX_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.6",
    title: "Core-market aggregate universe",
    date: "2026-07-15",
    effectiveAt: 1784073600,
    summary:
      "PSI now measures the core stablecoin market without counting parent-linked variants or investment products as independent monetary supply.",
    impact: [
      "The live and historical PSI universes include active core stablecoins, active cash equivalents, and PSI-only shadow assets",
      "Tracked variants remain readable on their detail and browse surfaces but no longer contribute market cap, trend, depeg severity, breadth, or DEWS stress breadth to PSI",
      "Stable-value investment products remain tracked for research while staying outside the ecosystem monetary aggregate",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.5",
    title: "Exact DEWS generation dependency",
    date: "2026-06-19",
    effectiveAt: 1781902800,
    summary:
      "PSI now reads the exact DEWS generation advertised by the published-generation pointer instead of selecting latest rows at or before that timestamp.",
    impact: [
      "Retained stale DEWS rows for assets absent from the current published generation no longer fail PSI freshness",
      "Stress breadth is computed from a single coherent DEWS generation rather than a mix of current rows and older retained latest rows",
      "The no-pointer fallback remains bounded by the recent scan window and the existing staleness gate",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.4",
    title: "Fail-closed DEWS freshness dependency",
    date: "2026-06-06",
    effectiveAt: 1780755098,
    summary:
      "PSI now requires a non-empty, fresh latest DEWS row set before publishing a new sample, preventing stale or wiped stress signals from being treated as zero stress breadth.",
    impact: [
      "The 30-minute cron skips PSI sample publication when latest DEWS rows are absent, missing computed_at, or older than two compute-dews intervals",
      "DEWS stress breadth is now computed from warning-band rows only after dependency freshness is proven across the latest DEWS row set",
      "Public PSI remains anchored to the last valid stored sample instead of publishing a healthier fresh score from stale or absent early-warning inputs",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.3",
    title: "Active-only PSI universe",
    date: "2026-05-14",
    effectiveAt: 1778716800,
    summary:
      "PSI eligibility now resolves to active tracked stablecoins plus PSI-only shadow assets, excluding pre-launch and frozen tracked rows from live PSI denominators and repair scopes.",
    impact: [
      "Pre-launch tracked assets no longer enter the PSI-eligible registry before launch",
      "Frozen tracked archives remain available on readable public detail surfaces but are excluded from live PSI computation",
      "PSI-only shadow assets remain included for historical continuity and admin replay repairs",
    ],
    commits: [],
    reconstructed: false,
  },
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
    summary: "Added DEWS-derived stress breadth as an explicit PSI component to capture broad non-depeg stress.",
    impact: [
      "Formula changed to: 100 - severity - breadth - stressBreadth + trend",
      "New stressBreadth cap of 5 points",
      "Cron now reads latest DEWS bands (ALERT/WARNING/DANGER) to derive stress breadth",
    ],
    commits: ["dcdefde"],
    reconstructed: true,
  },
];
