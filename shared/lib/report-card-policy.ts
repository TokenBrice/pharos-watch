import type {
  CustodyModel,
  ReserveSlice,
  ReserveRisk,
  StablecoinMeta,
} from "../types";
import type { StablecoinClientMeta } from "../types/stablecoin-client-meta";
import { roundScore } from "./math";

const RESERVE_QUALITY_SCORE: Record<ReserveRisk, number> = {
  "very-low": 100,
  low: 75,
  medium: 50,
  high: 25,
  "very-high": 5,
};

export function computeCollateralQualityFromReserves(reserves: readonly Pick<ReserveSlice, "pct" | "risk">[]): number {
  const totalPct = reserves.reduce((sum, reserve) => sum + reserve.pct, 0);
  if (totalPct === 0) return 0;
  const weighted = reserves.reduce((sum, reserve) => sum + reserve.pct * (RESERVE_QUALITY_SCORE[reserve.risk] ?? 0), 0);
  return roundScore(weighted / totalPct);
}

/** Authored custody wins; only structural onchain classes retain a default. */
export function resolveCustodyModel(meta: StablecoinClientMeta): CustodyModel {
  if (meta.custodyModel != null) return meta.custodyModel;
  // RWA-backed centralized classes need whole-book institutional evidence.
  return meta.flags.backing === "rwa-backed" && meta.flags.governance !== "decentralized"
    ? "unknown"
    : "onchain";
}

/**
 * A live adapter's reviewed composition and a separately sourced report keep
 * independent dates. This does not make the report assurance for those rows.
 */
export function hasIndependentLiveCompositionDates(
  meta: Pick<StablecoinMeta, "liveReservesConfig" | "reserveReview" | "proofOfReserves">,
): boolean {
  const review = meta.reserveReview;
  const report = meta.proofOfReserves?.latestReport;
  return meta.liveReservesConfig != null &&
    review?.compositionSource === "live-adapter" &&
    review.compositionAsOf != null &&
    review.confidence === "verified" &&
    review.sources.length > 0 &&
    report?.periodEnd != null &&
    report.publishedAt != null &&
    report.confidence !== "unknown" &&
    report.sources.length > 0;
}

/** Only an explicit independently accessed observation separates report and composition clocks. */
export function hasIndependentReserveObservationDates(
  meta: Pick<StablecoinMeta, "reserveReview" | "proofOfReserves">,
): boolean {
  const review = meta.reserveReview;
  if (!review || review.confidence !== "verified" || review.reportScopeId != null) return false;
  return review.observations?.some(row =>
    row.confidence === "verified" && row.sources.length > 0 &&
    (row.kind === "standing-structure" ||
      (review.compositionAsOf != null && row.kind === "portfolio-observation" &&
        new Date(row.observedAtSec * 1000).toISOString().slice(0, 10) === review.compositionAsOf)),
  ) === true;
}
