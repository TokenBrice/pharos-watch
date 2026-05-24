import type { RedemptionBackstopEntry } from "@shared/types";
import type {
  CoverageBreakdownItem,
  CoverageRow,
  CoverageStatus,
} from "@/lib/coverage-types";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createPresetStatus,
  createStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

const REDEMPTION_ROUTE_STATUS_PRESETS = {
  "offchain-issuer": {
    kind: "offchain-issuer",
    label: "Issuer",
    tone: "amber",
    available: true,
    sortRank: 2,
    detail: "Issuer or institutional redemption path is modeled.",
  },
  "psm-swap": {
    kind: "psm-swap",
    label: "PSM",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Protocol swap or PSM-style redemption floor is modeled.",
  },
  "queue-redeem": {
    kind: "queue-redeem",
    label: "Queue",
    tone: "violet",
    available: true,
    sortRank: 1,
    detail: "Queued protocol redemption path is modeled.",
  },
  "collateral-redeem": {
    kind: "collateral-redeem",
    label: "Collat.",
    tone: "sky",
    available: true,
    sortRank: 3,
    detail: "Direct collateral redemption path is modeled.",
    spokenLabel: "Collateral redeem",
  },
  "stablecoin-redeem": {
    kind: "stablecoin-redeem",
    label: "Stable",
    tone: "emerald",
    available: true,
    sortRank: 3,
    detail: "Direct stablecoin redemption path is modeled.",
    spokenLabel: "Stablecoin redeem",
  },
  "basket-redeem": {
    kind: "basket-redeem",
    label: "Basket",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail: "Basket redemption path is modeled.",
  },
  modeled: {
    kind: "modeled",
    label: "Modeled",
    tone: "rose",
    available: true,
    sortRank: 1,
    detail: "Redemption-backstop route is modeled.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveRedemption(
  entry: RedemptionBackstopEntry | null | undefined,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Redemption backstop");
  }

  if (!entry) {
    return createStatus(
      "none",
      "Not Covered",
      "slate",
      false,
      0,
      "No modeled redemption-backstop route is currently configured.",
      "Not covered",
    );
  }

  const routeStatus = entry.routeStatus ?? "unknown";
  if (
    entry.resolutionState === "impaired" ||
    routeStatus === "degraded" ||
    routeStatus === "paused" ||
    routeStatus === "cohort-limited"
  ) {
    return createStatus(
      "impaired",
      "Impaired",
      "amber",
      false,
      1,
      entry.routeStatusReason ??
        "A redemption route is configured, but current market or route-availability evidence contradicts strong redemption coverage.",
      "Impaired route",
    );
  }

  if (entry.resolutionState !== "resolved") {
    return createStatus(
      "configured-unrated",
      "Config.",
      "amber",
      false,
      1,
      "A redemption route is configured, but the current snapshot could not resolve a usable score.",
      "Configured, unrated",
    );
  }

  if (entry.modelConfidence === "low") {
    return createStatus(
      "modeled-heuristic",
      "Heur.",
      "amber",
      false,
      1,
      "A redemption route is modeled, but the current snapshot is still heuristic / low-confidence and does not count as strong redemption coverage.",
      "Heuristic route",
    );
  }

  if (
    entry.capacitySemantics === "eventual-only" ||
    entry.score == null ||
    entry.effectiveExitScore == null
  ) {
    return createStatus(
      "resolved-unscored",
      "Resolved",
      "violet",
      false,
      1,
      "A redemption route is resolved for context, but it is eventual-only or otherwise lacks current scored redemption coverage.",
      "Resolved, unscored",
    );
  }

  return createPresetStatus(
    REDEMPTION_ROUTE_STATUS_PRESETS[entry.routeFamily] ?? REDEMPTION_ROUTE_STATUS_PRESETS.modeled,
  );
}

function formatRedemption(
  _rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = (kind: string) => breakdownMap.get(kind) ?? 0;
  return [
    breakdownItem("modeled-heuristic", "heuristic", get("modeled-heuristic")),
    breakdownItem("resolved-unscored", "resolved", get("resolved-unscored")),
    breakdownItem("configured-unrated", "configured", get("configured-unrated")),
    breakdownItem("impaired", "impaired", get("impaired")),
    breakdownItem("offchain-issuer", "issuer", get("offchain-issuer")),
    breakdownItem("psm-swap", "psm", get("psm-swap")),
    breakdownItem("queue-redeem", "queue", get("queue-redeem")),
    breakdownItem("collateral-redeem", "collateral", get("collateral-redeem")),
    breakdownItem("stablecoin-redeem", "stable", get("stablecoin-redeem")),
    breakdownItem("basket-redeem", "basket", get("basket-redeem")),
    breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", get(DATA_UNAVAILABLE_KIND)),
  ];
}

const REDEMPTION_KINDS: readonly string[] = [
  "offchain-issuer",
  "psm-swap",
  "queue-redeem",
  "collateral-redeem",
  "stablecoin-redeem",
  "basket-redeem",
  "modeled",
  "modeled-heuristic",
  "resolved-unscored",
  "configured-unrated",
  "impaired",
  "none",
  DATA_UNAVAILABLE_KIND,
] as const;

const REDEMPTION_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Issuer / PSM / Queue / Collat. / Stable / Basket",
    description: "The modeled redemption-backstop route family counted as strong redemption coverage.",
    kinds: [
      "offchain-issuer",
      "psm-swap",
      "queue-redeem",
      "collateral-redeem",
      "stablecoin-redeem",
      "basket-redeem",
      "modeled",
    ],
  },
  {
    term: "Heur.",
    description:
      "A redemption route is modeled, but the current capacity evidence is still heuristic / low-confidence and does not count as strong coverage.",
    kinds: ["modeled-heuristic"],
  },
  {
    term: "Config.",
    description: "A redemption route is configured, but the current snapshot could not resolve a usable score.",
    kinds: ["configured-unrated"],
  },
  {
    term: "Resolved",
    description:
      "A redemption route is resolved for context, but is eventual-only or otherwise not current scored redemption coverage.",
    kinds: ["resolved-unscored"],
  },
  {
    term: "Impaired",
    description:
      "A redemption route is configured, but current market or route-availability evidence contradicts strong redemption coverage.",
    kinds: ["impaired"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: REDEMPTION_KINDS,
  legendItems: REDEMPTION_LEGEND,
  resolve: resolveRedemption,
  formatBreakdown: formatRedemption,
});

export const resolveRedemptionCoverage = coverageFeature.resolve;
export const formatRedemptionBreakdown = coverageFeature.formatBreakdown;
export const REDEMPTION_STATUS_KINDS = coverageFeature.statusKinds;
export const REDEMPTION_LEGEND_ITEMS = coverageFeature.legendItems;
