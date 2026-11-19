import { deriveSupplyFromMarketCap } from "@/lib/stablecoin-detail-derive";
import { normalizeStablecoinLiveSummary } from "@shared/lib/stablecoin-live-summary";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinLiveSummarySchema } from "@shared/types/stablecoin-live-summary";
import type { StablecoinLiveSummary } from "@shared/types/stablecoin-live-summary";
import type { FrozenSnapshot } from "@shared/lib/stablecoins/frozen-snapshots";
/**
 * Project a frozen coin's archived list row (captured at freeze time) into the same compact
 * summary. Supply is observed at `capturedAt`; a row that no longer satisfies the summary
 * schema yields `null` so the page keeps its live-query behavior instead of inventing fields.
 */
export function projectFrozenSnapshotLiveSummary(snapshot: FrozenSnapshot): StablecoinLiveSummary | null {
  const row = snapshot.peggedAssetRow;
  const parsed = StablecoinLiveSummarySchema.safeParse({
    price: row.price ?? null,
    priceSource: row.priceSource ?? null,
    priceConfidence: row.priceConfidence ?? null,
    priceUpdatedAt: row.priceUpdatedAt ?? null,
    priceObservedAt: row.priceObservedAt ?? row.priceUpdatedAt ?? null,
    priceObservedAtMode: row.priceObservedAtMode,
    priceSyncedAt: row.priceSyncedAt,
    ...(row.nominalPriceReference ? { nominalPriceReference: row.nominalPriceReference } : {}),
    consensusSources: row.consensusSources,
    agreeSources: row.agreeSources,
    supplyObservedAt: Math.floor(Date.parse(snapshot.capturedAt) / 1000),
    circulating: row.circulating,
    circulatingPrevDay: row.circulatingPrevDay,
    circulatingPrevWeek: row.circulatingPrevWeek,
    circulatingPrevMonth: row.circulatingPrevMonth,
    nativeSupply: { current: null, prevWeek: null, prevMonth: null },
  });
  if (!parsed.success) return null;

  const summary = normalizeStablecoinLiveSummary(parsed.data);
  const current = row.circulatingNative === undefined && summary.priceSource !== "missing"
    ? deriveSupplyFromMarketCap(getCirculatingRawOrNull(summary), summary.price)
    : row.circulatingNative;
  summary.nativeSupply.current = typeof current === "number" && Number.isFinite(current) && current >= 0 ? current : null;
  return summary;
}
