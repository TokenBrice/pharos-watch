import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.04",
    title: "Rollout Coverage Boundary Review",
    date: "2026-06-29",
    effectiveAt: 1782741600,
    summary:
      "DDRR now treats rollout-active incidents whose reliable recovery or terminal evidence predates the DDRv2 public prediction contract as pre-lock coverage outcomes instead of live missed-lock debt.",
    impact: [
      "Coverage classification for incidents already active when DDRv2 was enabled is floored at the DDRv2 public-contract effective timestamp",
      "Historical terminal evidence before that boundary becomes terminal_before_prediction, not missed_lock_terminal",
      "The reviewer engine advances to ddr-reviewer-v3 so cached review snapshots are rebuilt under the corrected public audit contract",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.03",
    title: "DDRR-Calibrated Stage 1 Terminality",
    date: "2026-06-29",
    effectiveAt: 1782691200,
    summary:
      "Uses reviewed DDRR outcomes to calibrate Stage 1 terminality: recent compromised/unbacked mint incidents now feed K1, while static very-high reserve concentration becomes severe K2 only when paired with a severe below-peg fingerprint or observed dependency impairment.",
    impact: [
      "Recent registry-reviewed mint-authority incidents can make K1 supply weaponization fire even when daily supply history misses the mint path",
      "Very-high-risk reserve concentration is elevated by default and severe only with a severe/catastrophic below-peg break or a frozen/dead dependency",
      "Stage 2 duration remains on duration-landmark-v1 because the DDRR duration sample is still too small and clustered for a fitted retune",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.02",
    title: "Close-gap Tail Grouping and Superseded Alias Review",
    date: "2026-06-19",
    effectiveAt: 1781827200,
    summary:
      "DDR incident grouping now treats live reopens inside the documented close-gap merge window as the same canonical incident even when the original start is days old, and DDRR follows superseded duplicate aliases to the current source event.",
    impact: [
      "Sealed live tails can be adopted when they reopen within 6 hours of the prior current source event closing",
      "Duplicate sealed incidents can be superseded through append-only errata and lineage while downstream reads resolve to the canonical incident key",
      "DDRR evaluates repaired canonical predictions against the effective current source event instead of scoring an older closed fragment as recovered",
      "The APXUSD June 2026 duplicate prediction is invalidated and treated as an alias of the unresolved June 2 incident",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.01",
    title: "Live Context Input Wiring",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary: "Wired Stage 1's documented live-context inputs into the Worker DDR precompute path.",
    impact: [
      "Uses fresh DEWS sub-signals to derive bank-run and blacklist-surge inputs for K5 and K3",
      "Uses the same 7-day DEX TVL baseline selection as the liquidity API for K5 exit-collapse checks",
      "Hydrates the latest Safety Score history row so R5 mean-reversion anchors and related context use live report-card data",
      "Marks DDR runs degraded when these required context-source queries fail instead of scoring with silently absent inputs",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "3.0",
    title: "Forecast Readiness Contract",
    date: "2026-06-04",
    effectiveAt: 1780531200,
    summary:
      "Added the shared DDR forecast-readiness contract for readiness-gated locks with immutable public metadata.",
    impact: [
      "Introduces the readiness-72h-v1 forecast-readiness version and a strict early-lock threshold",
      "Publishes row-level readiness components and reasons as forecast readiness, not a probability or confidence label",
      "Adds optional/defaulted lock trigger, readiness, and 72h backstop metadata to the public contract while preserving legacy rows",
      "Includes new immutable readiness metadata in public row hash payloads when present",
    ],
    commits: [],
    reconstructed: false,
  },
];
