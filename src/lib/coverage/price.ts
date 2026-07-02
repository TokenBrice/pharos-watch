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
  createStatus,
  DATA_UNAVAILABLE_KIND,
  defineCoverageFeature,
  type CoverageLegendItem,
} from "./shared";

function resolvePrice(
  coin: Pick<StablecoinMeta, "flags">,
  hasPegCoverage: boolean,
  consensusSources?: string[],
  priceConfidence?: string,
  dataAvailable = true,
): CoverageStatus {
  if (!dataAvailable) {
    return createDataUnavailableStatus("Price and depeg");
  }

  if (coin.flags.navToken) {
    return createStatus(
      "price-only",
      "Price only",
      "sky",
      true,
      2,
      "NAV-priced token. Price tracking is available, but peg/depeg logic is not applicable.",
    );
  }

  if (hasPegCoverage) {
    const status = createStatus(
      "tracked",
      "Tracked",
      "emerald",
      true,
      3,
      "Live peg monitoring, peg score coverage, and depeg-event history are available.",
    );
    if (consensusSources !== undefined) {
      status.sourceCount = consensusSources.length;
      status.sourceNames = consensusSources;
    }
    if (priceConfidence !== undefined) {
      status.priceConfidence = priceConfidence;
    }
    return status;
  }

  return createStatus(
    "missing",
    "Missing",
    "rose",
    false,
    0,
    "No peg-summary row is currently available for this asset.",
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

  // Source-depth distribution
  let deep = 0; // 5+ sources
  let mid = 0; // 3-4 sources
  let shallow = 0; // 1-2 sources
  for (const row of rows) {
    const count = row.statuses.price.sourceCount;
    if (count == null) continue;
    if (count >= 5) deep++;
    else if (count >= 3) mid++;
    else shallow++;
  }
  if (deep + mid + shallow > 0) {
    items.push(breakdownItem("sources-5-plus", "5+ sources:", deep));
    items.push(breakdownItem("sources-3-4", "3-4:", mid));
    items.push(breakdownItem("sources-1-2", "1-2:", shallow));
  }
  return items;
}

const PRICE_KINDS: readonly string[] = [
  "tracked",
  "price-only",
  "missing",
  DATA_UNAVAILABLE_KIND,
] as const;

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
    description: "No peg-summary row is currently available for this asset.",
    kinds: ["missing"],
  },
] as const;

export const coverageFeature = defineCoverageFeature({
  statusKinds: PRICE_KINDS,
  legendItems: PRICE_LEGEND,
  resolve: resolvePrice,
  formatBreakdown: formatPrice,
});
