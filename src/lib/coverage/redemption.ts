import type { RedemptionBackstopEntry } from "@shared/types";
import type { RedemptionRouteFamily } from "@shared/types";
import type { CoverageStatus } from "@/lib/coverage-types";
import { REDEMPTION_MODELED_ROUTE_DISPLAY, REDEMPTION_ROUTE_FAMILY_DISPLAY } from "@/lib/redemption-backstop-labels";
import {
  createDataUnavailableStatus,
  createPresetStatus,
  DATA_UNAVAILABLE_KIND,
  definePresetCoverageFeature,
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

/** Route-independent resolution states. Kept apart so the route table above keeps proving family exhaustiveness. */
const REDEMPTION_STATE_STATUS_PRESETS = {
  impaired: {
    kind: "impaired",
    label: "Impaired",
    tone: "amber",
    available: false,
    sortRank: 1,
    detail:
      "A redemption route is configured, but current market or route-availability evidence contradicts strong redemption coverage.",
    spokenLabel: "Impaired route",
  },
  "configured-unrated": {
    kind: "configured-unrated",
    label: "Config.",
    tone: "amber",
    available: false,
    sortRank: 1,
    detail: "A redemption route is configured, but the current snapshot could not resolve a usable score.",
    spokenLabel: "Configured, unrated",
  },
  "modeled-heuristic": {
    kind: "modeled-heuristic",
    label: "Heur.",
    tone: "amber",
    available: false,
    sortRank: 1,
    detail:
      "A redemption route is modeled, but the current snapshot is still heuristic / low-confidence and does not count as strong redemption coverage.",
    spokenLabel: "Heuristic route",
  },
  "resolved-unscored": {
    kind: "resolved-unscored",
    label: "Resolved",
    tone: "violet",
    available: false,
    sortRank: 1,
    detail:
      "A redemption route is resolved for context, but it is eventual-only or otherwise lacks current scored redemption coverage.",
    spokenLabel: "Resolved, unscored",
  },
  none: {
    kind: "none",
    label: "Not Covered",
    tone: "slate",
    available: false,
    sortRank: 0,
    detail: "No modeled redemption-backstop route is currently configured.",
    spokenLabel: "Not covered",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolveRedemption(entry: RedemptionBackstopEntry | null | undefined, dataAvailable = true): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Redemption backstop");
  }

  if (!entry) {
    return createPresetStatus(REDEMPTION_STATE_STATUS_PRESETS.none);
  }

  const routeStatus = entry.routeStatus ?? "unknown";
  if (
    entry.resolutionState === "impaired" ||
    routeStatus === "degraded" ||
    routeStatus === "paused" ||
    routeStatus === "cohort-limited"
  ) {
    const impaired = createPresetStatus(REDEMPTION_STATE_STATUS_PRESETS.impaired);
    return { ...impaired, detail: entry.routeStatusReason ?? impaired.detail };
  }

  if (entry.resolutionState !== "resolved") {
    return createPresetStatus(REDEMPTION_STATE_STATUS_PRESETS["configured-unrated"]);
  }

  if (entry.modelConfidence === "low") {
    return createPresetStatus(REDEMPTION_STATE_STATUS_PRESETS["modeled-heuristic"]);
  }

  if (entry.capacitySemantics === "eventual-only" || entry.score == null) {
    return createPresetStatus(REDEMPTION_STATE_STATUS_PRESETS["resolved-unscored"]);
  }

  return createPresetStatus(
    REDEMPTION_ROUTE_STATUS_PRESETS[entry.routeFamily] ?? REDEMPTION_ROUTE_STATUS_PRESETS.modeled,
  );
}

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

export const coverageFeature = definePresetCoverageFeature({
  presets: { ...REDEMPTION_ROUTE_STATUS_PRESETS, ...REDEMPTION_STATE_STATUS_PRESETS },
  extraStatusKinds: [DATA_UNAVAILABLE_KIND],
  breakdown: [
    { key: "modeled-heuristic", label: "heuristic" },
    { key: "resolved-unscored", label: "resolved" },
    { key: "configured-unrated", label: "configured" },
    { key: "impaired", label: "impaired" },
    { key: "offchain-issuer", label: REDEMPTION_ROUTE_FAMILY_DISPLAY["offchain-issuer"].coverageBreakdownLabel },
    { key: "psm-swap", label: REDEMPTION_ROUTE_FAMILY_DISPLAY["psm-swap"].coverageBreakdownLabel },
    { key: "queue-redeem", label: REDEMPTION_ROUTE_FAMILY_DISPLAY["queue-redeem"].coverageBreakdownLabel },
    {
      key: "collateral-redeem",
      label: REDEMPTION_ROUTE_FAMILY_DISPLAY["collateral-redeem"].coverageBreakdownLabel,
    },
    { key: "stablecoin-redeem", label: REDEMPTION_ROUTE_FAMILY_DISPLAY["stablecoin-redeem"].coverageBreakdownLabel },
    { key: "basket-redeem", label: REDEMPTION_ROUTE_FAMILY_DISPLAY["basket-redeem"].coverageBreakdownLabel },
    { key: DATA_UNAVAILABLE_KIND, label: "data n/a" },
  ],
  legendItems: REDEMPTION_LEGEND,
  resolve: resolveRedemption,
});
