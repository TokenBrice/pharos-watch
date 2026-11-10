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

const PRICE_STATUS_PRESETS = {
  tracked: {
    kind: "tracked",
    label: "Tracked",
    tone: "emerald",
    available: true,
    sortRank: 3,
    detail: "Live peg monitoring, peg score coverage, and depeg-event history are available.",
  },
  "price-only": {
    kind: "price-only",
    label: "Price only",
    tone: "sky",
    available: true,
    sortRank: 2,
    detail: "NAV-priced token. Price tracking is available, but peg/depeg logic is not applicable.",
  },
  missing: {
    kind: "missing",
    label: "Missing",
    tone: "rose",
    available: false,
    sortRank: 0,
    detail: "No peg-summary row is currently available for this asset.",
  },
} satisfies Record<string, CoverageStatusPreset>;

function resolvePrice(
  coin: Pick<StablecoinMeta, "flags">,
  hasPegCoverage: boolean,
  consensusSources?: string[],
  priceConfidence?: string,
  currentPriceUnavailable = false,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Price and depeg");
  }

  if (currentPriceUnavailable) {
    const status = createPresetStatus(PRICE_STATUS_PRESETS.missing);
    status.detail = "No observed market price is available for this asset.";
    return status;
  }

  if (coin.flags.navToken) {
    return createPresetStatus(PRICE_STATUS_PRESETS["price-only"]);
  }

  if (hasPegCoverage) {
    const status = createPresetStatus(PRICE_STATUS_PRESETS.tracked);
    if (consensusSources !== undefined) {
      status.sourceCount = consensusSources.length;
      status.sourceNames = consensusSources;
    }
    if (priceConfidence !== undefined) {
      status.priceConfidence = priceConfidence;
    }
    return status;
  }

  return createPresetStatus(PRICE_STATUS_PRESETS.missing);
}

/**
 * One observed-depth population for the Price row and the Source-target tile:
 * a row counts when its price depth is observed (Tracked with a reported
 * `sourceCount`) or Missing (uncovered, counted as zero sources). NAV
 * price-only and Data n/a rows stay outside both denominators.
 */
export function countsTowardPriceDepth(row: CoverageRow): boolean {
  const status = row.statuses.price;
  return (
    status.kind !== DATA_UNAVAILABLE_KIND &&
    status.kind !== "price-only" &&
    (status.sourceCount != null || status.kind === "missing")
  );
}

function formatPrice(
  rows: readonly CoverageRow[],
  breakdownMap: ReadonlyMap<string, number>,
): CoverageBreakdownItem[] {
  const get = createBreakdownCounter(breakdownMap);
  const items: CoverageBreakdownItem[] = [
    breakdownItem("tracked", "tracked", get("tracked")),
    breakdownItem("price-only", "price-only", get("price-only")),
  ];
  const unavailable = get(DATA_UNAVAILABLE_KIND);
  if (unavailable > 0) {
    items.push(breakdownItem(DATA_UNAVAILABLE_KIND, "data n/a", unavailable));
  }

  // Source-depth distribution. Only publish it when every tracked row reported a
  // source count: otherwise the remainder is unknown depth, not the `tracked`
  // bucket's rows folded into an observed-depth claim.
  let deep = 0; // 5+ sources
  let mid = 0; // 3-4 sources
  let shallow = 0; // 0-2 sources
  for (const row of rows) {
    const count = row.statuses.price.sourceCount;
    if (count == null) continue;
    if (count >= 5) deep++;
    else if (count >= 3) mid++;
    else shallow++;
  }
  const tracked = get("tracked");
  if (tracked > 0 && deep + mid + shallow === tracked) {
    items.push(breakdownItem("sources-5-plus", "5+ sources:", deep));
    items.push(breakdownItem("sources-3-4", "3-4:", mid));
    items.push(breakdownItem("sources-1-2", "0-2:", shallow));
  }
  return items;
}

const PRICE_LEGEND: readonly CoverageLegendItem[] = [
  {
    term: "Tracked",
    description: "Price and depeg monitoring are available. Source count appears when the price pipeline reports it.",
    kinds: ["tracked"],
  },
  {
    term: "Price only",
    description: "NAV-priced asset with price coverage, but no peg or depeg tracking.",
    kinds: ["price-only"],
  },
  {
    term: "Missing",
    description: "No observed market price is currently available for this asset.",
    kinds: ["missing"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: [...statusKindsFromPresets(PRICE_STATUS_PRESETS), DATA_UNAVAILABLE_KIND],
  legendItems: PRICE_LEGEND,
  resolve: resolvePrice,
  formatBreakdown: formatPrice,
});
