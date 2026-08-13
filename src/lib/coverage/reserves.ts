import { getReserveDisplayBadgeKindForAdapter } from "@shared/lib/live-reserve-display";
import { getReserves } from "@shared/lib/reserve-templates";
import type { StablecoinMeta } from "@shared/types";
import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createBreakdownCounter,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  statusKindsFromPresets,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const RESERVES_STATUS_PRESETS = {
  live: {
    kind: "live",
    label: "Score-grade",
    tone: "emerald",
    available: true,
    sortRank: 4,
    detail: "The current report-card snapshot used a fresh independent live reserve snapshot for collateral scoring.",
    spokenLabel: "Score-grade live reserve",
  },
  "live-configured": {
    kind: "live-configured",
    label: "Configured",
    tone: "amber",
    available: false,
    sortRank: 1,
    detail:
      "A live reserve adapter is configured, but the current report-card snapshot did not use it for collateral scoring.",
    spokenLabel: "Configured reserve view",
  },
  checking: {
    kind: "checking",
    label: "Checking",
    tone: "amber",
    available: false,
    sortRank: 0,
    detail: "Live reserve sync is configured, but current live reserve freshness has not loaded yet.",
    spokenLabel: "Checking live reserve sync",
  },
  "curated-validated": {
    kind: "curated-validated",
    label: "Curated-Validated",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Detail-page reserve composition uses a reviewed reserve baseline kept current through live validation.",
    spokenLabel: "Curated validated",
  },
  proof: {
    kind: "proof",
    label: "Proof",
    tone: "violet",
    available: true,
    sortRank: 2,
    detail:
      "Detail-page reserve composition is backed by a proof, attestation, or liveness path rather than a full live reserve mix.",
  },
  curated: {
    kind: "curated",
    label: "Curated",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail: "Reserve composition is manually curated in stablecoin metadata.",
  },
  estimated: {
    kind: "estimated",
    label: "Estimated",
    tone: "amber",
    available: true,
    sortRank: 1,
    detail: "Reserve composition falls back to a classification-based estimate.",
  },
  unavailable: {
    kind: "unavailable",
    label: "None",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No reserve-composition view is currently available.",
    spokenLabel: "No reserves view",
  },
} satisfies Record<string, CoverageStatusPreset>;

/**
 * Minimal coin shape for reserve coverage resolution. Server callers carry the
 * full `liveReservesConfig`; client-registry callers carry only the derived
 * `liveReserveAdapter` key (the full config is not shipped to the client).
 */
type ReserveCoverageCoinMeta = Pick<StablecoinMeta, "reserves" | "flags" | "collateralQuality"> & {
  liveReservesConfig?: StablecoinMeta["liveReservesConfig"];
  liveReserveAdapter?: NonNullable<StablecoinMeta["liveReservesConfig"]>["adapter"];
};

function resolveReserve(
  coin: ReserveCoverageCoinMeta,
  liveReserveFresh: boolean | null = null,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Reserve view");
  }
  const liveReserveAdapter = coin.liveReserveAdapter ?? coin.liveReservesConfig?.adapter;
  if (liveReserveAdapter) {
    // Scoring provenance and the detail-page display badge are orthogonal.
    // Some independently scored feeds intentionally use a proof-style badge.
    if (liveReserveFresh === true) {
      return createPresetStatus(RESERVES_STATUS_PRESETS.live);
    }

    const badgeKind = getReserveDisplayBadgeKindForAdapter(liveReserveAdapter);
    if (badgeKind === "live") {
      if (liveReserveFresh === null) {
        return createPresetStatus(RESERVES_STATUS_PRESETS.checking);
      }

      return createPresetStatus(RESERVES_STATUS_PRESETS["live-configured"]);
    }

    if (badgeKind === "curated-validated") {
      return createPresetStatus(RESERVES_STATUS_PRESETS["curated-validated"]);
    }

    return createPresetStatus(RESERVES_STATUS_PRESETS.proof);
  }

  const reserves = getReserves(coin);
  if (!reserves) {
    return createPresetStatus(RESERVES_STATUS_PRESETS.unavailable);
  }

  if (reserves.estimated) {
    return createPresetStatus(RESERVES_STATUS_PRESETS.estimated);
  }

  return createPresetStatus(RESERVES_STATUS_PRESETS.curated);
}

function formatReserves(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("live", "score-grade", get("live")),
    breakdownItem("live-configured", "configured", get("live-configured")),
    breakdownItem("checking", "checking", get("checking")),
    breakdownItem("curated-validated", "curated-validated", get("curated-validated")),
    breakdownItem("proof", "proof", get("proof")),
    breakdownItem("curated", "curated", get("curated")),
    breakdownItem("estimated", "estimated", get("estimated")),
  ];
}

const RESERVES_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Score-grade",
    description:
      "Fresh independent live reserve data was used by the current report-card snapshot for collateral scoring.",
    kinds: ["live"],
  },
  {
    term: "Configured",
    description:
      "A reserve view or live reserve adapter exists, but the current report-card snapshot did not use it for collateral scoring.",
    kinds: ["live-configured"],
  },
  {
    term: "Checking",
    description:
      "Reserve coverage is configured, but report-card freshness data is still loading or unavailable.",
    kinds: ["checking"],
  },
  {
    term: "Curated-Validated",
    description: "A reviewed reserve baseline is kept current through live validation.",
    kinds: ["curated-validated"],
  },
  {
    term: "Proof",
    description: "Reserve view is backed by proof, attestation, or liveness evidence rather than a full live mix.",
    kinds: ["proof"],
  },
  {
    term: "Curated / Estimated",
    description: "Reserve composition is manually curated or falls back to classification-based estimates.",
    kinds: ["curated", "estimated"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(RESERVES_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: RESERVES_LEGEND,
  resolve: resolveReserve,
  formatBreakdown: formatReserves,
});
