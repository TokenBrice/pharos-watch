import type { RedemptionBackstopEntry } from "@shared/types";
import type { RedemptionRouteFamily } from "@shared/types";
import type { CoverageBreakdownItem, CoverageRow, CoverageStatus } from "@/lib/coverage-types";
import { REDEMPTION_MODELED_ROUTE_DISPLAY, REDEMPTION_ROUTE_FAMILY_DISPLAY } from "@/lib/redemption-backstop-labels";
import {
  breakdownItem,
  createDataUnavailableStatus,
  createBreakdownCounter,
  createPresetStatus,
  createStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  type CoverageLegendItem,
  type CoverageStatusPreset,
} from "./shared";

function routeFamilyPreset(kind: RedemptionRouteFamily): CoverageStatusPreset {
  const display = REDEMPTION_ROUTE_FAMILY_DISPLAY[kind];
  return {
    kind,
    label: display.coverageLabel,
    tone: display.coverageTone,
    available: true,
    sortRank: display.coverageSortRank,
    detail: display.coverageDetail,
    ...(display.coverageSpokenLabel ? { spokenLabel: display.coverageSpokenLabel } : {}),
  };
}

const REDEMPTION_ROUTE_STATUS_PRESETS = {
  "offchain-issuer": routeFamilyPreset("offchain-issuer"),
  "psm-swap": routeFamilyPreset("psm-swap"),
  "queue-redeem": routeFamilyPreset("queue-redeem"),
  "collateral-redeem": routeFamilyPreset("collateral-redeem"),
  "stablecoin-redeem": routeFamilyPreset("stablecoin-redeem"),
  "basket-redeem": routeFamilyPreset("basket-redeem"),
  modeled: {
    kind: "modeled",
    label: REDEMPTION_MODELED_ROUTE_DISPLAY.coverageLabel,
    tone: REDEMPTION_MODELED_ROUTE_DISPLAY.coverageTone,
    available: true,
    sortRank: REDEMPTION_MODELED_ROUTE_DISPLAY.coverageSortRank,
    detail: REDEMPTION_MODELED_ROUTE_DISPLAY.coverageDetail,
  },
} satisfies Record<RedemptionRouteFamily | "modeled", CoverageStatusPreset>;

function resolveRedemption(entry: RedemptionBackstopEntry | null | undefined, dataAvailable = true): CoverageStatus {
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

  if (entry.capacitySemantics === "eventual-only" || entry.score == null || entry.effectiveExitScore == null) {
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
  const get = createBreakdownCounter(breakdownMap);
  return [
    breakdownItem("modeled-heuristic", "heuristic", get("modeled-heuristic")),
    breakdownItem("resolved-unscored", "resolved", get("resolved-unscored")),
    breakdownItem("configured-unrated", "configured", get("configured-unrated")),
    breakdownItem("impaired", "impaired", get("impaired")),
    breakdownItem(
      "offchain-issuer",
      REDEMPTION_ROUTE_FAMILY_DISPLAY["offchain-issuer"].coverageBreakdownLabel,
      get("offchain-issuer"),
    ),
    breakdownItem("psm-swap", REDEMPTION_ROUTE_FAMILY_DISPLAY["psm-swap"].coverageBreakdownLabel, get("psm-swap")),
    breakdownItem(
      "queue-redeem",
      REDEMPTION_ROUTE_FAMILY_DISPLAY["queue-redeem"].coverageBreakdownLabel,
      get("queue-redeem"),
    ),
    breakdownItem(
      "collateral-redeem",
      REDEMPTION_ROUTE_FAMILY_DISPLAY["collateral-redeem"].coverageBreakdownLabel,
      get("collateral-redeem"),
    ),
    breakdownItem(
      "stablecoin-redeem",
      REDEMPTION_ROUTE_FAMILY_DISPLAY["stablecoin-redeem"].coverageBreakdownLabel,
      get("stablecoin-redeem"),
    ),
    breakdownItem(
      "basket-redeem",
      REDEMPTION_ROUTE_FAMILY_DISPLAY["basket-redeem"].coverageBreakdownLabel,
      get("basket-redeem"),
    ),
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
