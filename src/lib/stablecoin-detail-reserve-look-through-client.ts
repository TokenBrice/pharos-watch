import type { ReserveRisk, StablecoinMeta } from "@shared/types";
import { projectReserveQualityClientSummary } from "@/lib/stablecoin-detail-reserve-quality-client";

/** One reviewed slice of the wrapped parent's basket, bounded to what the look-through visual draws. */
export interface ReserveLookThroughSliceClientRow {
  key: string;
  name: string;
  pct: number;
  risk: ReserveRisk;
  obligor: string | null;
  assetClassLabel: string | null;
}

/**
 * The parent basket behind a wrapper whose whole reviewed composition is one
 * slice of that parent (sUSDe = 100% USDe staking vault shares). Projected at
 * build time because the client registry does not carry other coins' reserves.
 */
export interface ReserveLookThroughClientSummary {
  parentId: string;
  parentSymbol: string;
  /** The parent's own reserve review date; the wrapper's footer date does not cover these slices. */
  parentReviewedAt: string | null;
  slices: ReserveLookThroughSliceClientRow[];
}

/**
 * Joinable only when the coin's reviewed composition is exactly one slice that
 * the review links to a tracked coin as a `wrapper` dependency, and that coin
 * has reviewed slices of its own. One hop: a parent that is itself a wrapper
 * is drawn as its own reviewed slice, not chased further.
 */
export function projectReserveLookThroughClientSummary(
  coin: StablecoinMeta,
  parentById: ReadonlyMap<string, StablecoinMeta> | undefined,
): ReserveLookThroughClientSummary | null {
  const slices = coin.reserves ?? [];
  if (coin.reserveReview?.scope != null && coin.reserveReview.scope !== "full-composition") return null;
  const slice = slices.length === 1 ? slices[0] : undefined;
  if (!slice || !parentById) return null;
  if (slice.depType !== "wrapper" || !slice.coinId || slice.coinId === coin.id) return null;

  const parent = parentById.get(slice.coinId);
  const parentSlices = parent?.reserves ?? [];
  if (!parent || !parentSlices.some((row) => Number.isFinite(row.pct) && row.pct > 0)) return null;
  if (parent.reserveReview?.scope != null && parent.reserveReview.scope !== "full-composition") return null;

  const quality = projectReserveQualityClientSummary(parent);
  const rows: ReserveLookThroughSliceClientRow[] = quality
    ? quality.slices.map((row) => ({
        key: row.key,
        name: row.name,
        pct: row.pct,
        risk: row.risk,
        obligor: row.obligor,
        assetClassLabel: row.assetClassLabel,
      }))
    : parentSlices.map((row, index) => ({
        key: `${row.name}:${index}`,
        name: row.name,
        pct: row.pct,
        risk: row.risk,
        obligor: row.issuerOrObligor ?? null,
        assetClassLabel: null,
      }));

  return {
    parentId: parent.id,
    parentSymbol: parent.symbol,
    parentReviewedAt: parent.reserveReview?.reviewedAt ?? null,
    slices: rows,
  };
}
