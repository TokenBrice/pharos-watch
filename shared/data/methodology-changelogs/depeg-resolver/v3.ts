import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V3: readonly MethodologyChangelogEntry[] = [
  {
    version: "3.01",
    title: "Live Context Input Wiring",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "Wired Stage 1's documented live-context inputs into the Worker DDR precompute path.",
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
