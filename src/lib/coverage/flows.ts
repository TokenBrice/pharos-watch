import type { MintBurnCoverageStatus } from "@shared/types";
import type { CoverageStatus } from "@/lib/coverage-types";
import {
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  definePresetCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const FLOW_STATUS_PRESETS = {
  full: {
    kind: "full",
    label: "Full",
    tone: "emerald",
    available: true,
    sortRank: 4,
    detail: "Configured issuance-chain mint/burn tracking has full 30-day baseline coverage.",
  },
  "partial-history": {
    kind: "partial-history",
    label: "Partial",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Configured issuance-chain mint/burn tracking exists, but the full history window is not yet complete.",
  },
  lagging: {
    kind: "lagging",
    label: "Lagging",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Configured issuance-chain mint/burn tracking exists, but sync progress is currently lagging.",
  },
  bootstrapping: {
    kind: "bootstrapping",
    label: "Bootstr.",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Configured issuance-chain mint/burn tracking is configured, but coverage is still bootstrapping.",
    spokenLabel: "Bootstrapping",
  },
  unknown: {
    kind: "unknown",
    label: "Unknown",
    tone: "amber",
    available: true,
    sortRank: 1,
    detail: "Configured issuance-chain mint/burn tracking exists, but current chain-head metadata is unavailable.",
  },
  disabled: {
    kind: "disabled",
    label: "Disabled",
    tone: "rose",
    available: false,
    sortRank: 0,
    detail: "Mint/burn tracking is configured in principle but currently disabled.",
  },
  none: {
    kind: "none",
    label: "Not Covered",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No issuance-chain mint/burn flow tracking is currently configured.",
    spokenLabel: "Not covered",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveFlow(
  flowCoverageStatus: MintBurnCoverageStatus | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Mint/burn flow");
  }

  return createPresetStatus(FLOW_STATUS_PRESETS[flowCoverageStatus ?? "none"] ?? FLOW_STATUS_PRESETS.none);
}

const FLOWS_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Full / Partial / Lagging / Bootstr.",
    description: "Mint/burn flow coverage maturity and sync state for configured assets.",
    kinds: ["full", "partial-history", "lagging"],
  },
  {
    term: "Bootstr.",
    description: "Tracking is configured, but the history window is still building.",
    kinds: ["bootstrapping"],
  },
  {
    term: "Unknown",
    description: "Tracking is configured, but the latest chain-head metadata is missing, so current lag cannot be trusted.",
    kinds: ["unknown"],
  },
  {
    term: "Disabled",
    description: "Mint/burn tracking is configured in principle but currently disabled.",
    kinds: ["disabled"],
  },
] as const;

export const coverageFeature = definePresetCoverageFeature({
  presets: FLOW_STATUS_PRESETS,
  extraStatusKinds: [DATA_UNAVAILABLE_KIND],
  breakdown: [
    { key: "full", label: "full" },
    { key: "partial-history", label: "partial" },
    { key: "lagging", label: "lagging" },
    { key: "bootstrapping", label: "bootstrapping" },
    { key: "unknown", label: "unknown" },
    { key: DATA_UNAVAILABLE_KIND, label: "data n/a" },
  ],
  legendItems: FLOWS_LEGEND,
  resolve: resolveFlow,
});
