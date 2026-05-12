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
  createStatus,
  type CoverageLegendItem,
} from "./shared";

export function resolveReserveCoverage(
  coin: StablecoinMeta,
  liveReserveFresh: boolean | null = true,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Reserve view");
  }
  if (coin.liveReservesConfig) {
    const badgeKind = getReserveDisplayBadgeKindForAdapter(coin.liveReservesConfig.adapter);
    if (badgeKind === "live") {
      if (liveReserveFresh === null) {
        return createStatus(
          "checking",
          "Checking",
          "amber",
          false,
          0,
          "Live reserve sync is configured, but current live reserve freshness has not loaded yet.",
          "Checking live reserve sync",
        );
      }

      if (!liveReserveFresh) {
        return createStatus(
          "live-configured",
          "Configured",
          "amber",
          false,
          1,
          "A live reserve adapter is configured, but the current report-card snapshot did not use it for collateral scoring.",
          "Configured reserve view",
        );
      }

      return createStatus(
        "live",
        "Score-grade",
        "emerald",
        true,
        4,
        "The current report-card snapshot used a fresh independent live reserve snapshot for collateral scoring.",
        "Score-grade live reserve",
      );
    }

    if (badgeKind === "curated-validated") {
      return createStatus(
        "curated-validated",
        "Curated-Validated",
        "sky",
        true,
        3,
        "Detail-page reserve composition uses a reviewed reserve baseline kept current through live validation.",
        "Curated validated",
      );
    }

    return createStatus(
      "proof",
      "Proof",
      "violet",
      true,
      2,
      "Detail-page reserve composition is backed by a proof, attestation, or liveness path rather than a full live reserve mix.",
    );
  }

  const reserves = getReserves(coin);
  if (!reserves) {
    return createStatus(
      "unavailable",
      "None",
      "slate",
      false,
      0,
      "No reserve-composition view is currently available.",
      "No reserves view",
    );
  }

  if (reserves.estimated) {
    return createStatus(
      "estimated",
      "Estimated",
      "amber",
      true,
      1,
      "Reserve composition falls back to a classification-based estimate.",
    );
  }

  return createStatus(
    "curated",
    "Curated",
    "sky",
    true,
    2,
    "Reserve composition is manually curated in stablecoin metadata.",
  );
}

export function formatReservesBreakdown(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = (kind: string) => breakdownMap.get(kind) ?? 0;
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

export const RESERVES_STATUS_KINDS: readonly string[] = [
  "live",
  "live-configured",
  "checking",
  "curated-validated",
  "proof",
  "curated",
  "estimated",
  "unavailable",
  "data-unavailable",
] as const;

export const RESERVES_LEGEND_ITEMS: readonly CoverageLegendItem[] = [
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
